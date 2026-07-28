'use strict';
const logger = require('sonos-discovery/lib/helpers/logger');
const isRadioOrLineIn = require('../helpers/is-radio-or-line-in');
const { refreshSystemState, getCurrentVolume, probeReachable } = require('./refresh-state-via-soap');
const waitForClipEnd = require('./wait-for-clip-end');

// deadUuids: players known-unreachable from the pre-announce probe. They are
// excluded from restore presets — applyPreset addresses every listed player
// directly, so restoring a preset that names a dead speaker would fail the
// whole preset and leave the healthy members un-restored.
function saveAll(system, deadUuids) {
  const backupPresets = [];
  system.zones.forEach((zone) => {
    const coordinator = zone.coordinator;
    if (deadUuids.has(coordinator.uuid)) {
      logger.warn(`announceAll: skipping backup of zone ${coordinator.roomName} (coordinator unreachable)`);
      return;
    }
    const state = coordinator.state;
    const preset = {
      players: [
        { roomName: coordinator.roomName, volume: state.volume }
      ],
      state: state.playbackState,
      uri: coordinator.avTransportUri,
      metadata: coordinator.avTransportUriMetadata,
      playMode: {
        repeat: state.playMode.repeat
      }
    };

    if (!isRadioOrLineIn(preset.uri)) {
      preset.trackNo = state.trackNo;
      preset.elapsedTime = state.elapsedTime;
    }

    zone.members.forEach(function (player) {
      if (coordinator.uuid != player.uuid && !deadUuids.has(player.uuid))
        preset.players.push({ roomName: player.roomName, volume: player.state.volume });
    });

    backupPresets.push(preset);
  });

  logger.trace('backup presets', backupPresets);
  return backupPresets.sort((a,b) => {
    return a.players.length < b.players.length;
  });
}

function announceAll(system, uri, volume, duration) {
  // Snapshot accuracy fix: refresh per-zone state via SOAP before saveAll
  // captures the backup. See subset-announcement.js for the full rationale;
  // /clipall (this path) suffers the same broken-cache symptom as /clipsome.
  //
  // The reachability probe runs in parallel (both are read-only SOAP). One
  // dead speaker in the preset rejects the whole applyPreset call
  // (EHOSTUNREACH aborts the group), so unreachable players are dropped up
  // front and the announcement proceeds on whatever is actually alive.
  return Promise.all([
    refreshSystemState(system).catch((err) => {
      logger.warn(`announceAll: refreshSystemState failed (proceeding with cached state): ${err.message}`);
    }),
    probeReachable(system.players),
  ]).then(([, reachable]) => {
    const dead = system.players.filter((p) => !reachable.has(p.uuid));
    if (dead.length >= system.players.length) {
      throw new Error('announceAll: no reachable Sonos players');
    }
    if (dead.length > 0) {
      logger.warn(`announceAll: dropping unreachable players [${dead.map((p) => p.roomName)}]`);
    }
    return _announceAllCore(system, new Set(dead.map((p) => p.uuid)), uri, volume, duration);
  });
}

function restorePresets(system, backupPresets) {
  let restoreFailures = 0;
  return backupPresets.reduce((promise, preset, idx) => {
    return promise.then(() => {
      logger.trace('Restoring preset', preset);
      return system.applyPreset(preset).catch((err) => {
        restoreFailures += 1;
        logger.warn(`announceAll: restore[${idx}] coord=${preset.players[0].roomName} FAILED (continuing) — ${err.message}`);
      });
    });
  }, Promise.resolve()).then(() => restoreFailures);
}

function _announceAllCore(system, deadUuids, uri, volume, duration) {
  // Save all players
  var backupPresets = saveAll(system, deadUuids);

  // find biggest group (among zones with a reachable coordinator) and all
  // reachable players
  const allPlayers = [];
  let biggestZone = {};
  system.zones.forEach(function (zone) {
    if (deadUuids.has(zone.coordinator.uuid)) return;
    if (!biggestZone.members || zone.members.length > biggestZone.members.length) {
      biggestZone = zone;
    }
  });

  if (!biggestZone.coordinator) {
    return Promise.reject(new Error('announceAll: no zone with a reachable coordinator'));
  }

  const coordinator = biggestZone.coordinator;

  allPlayers.push({ roomName: coordinator.roomName, volume });

  system.players.forEach(player => {
    if (player.uuid == coordinator.uuid) return;
    if (deadUuids.has(player.uuid)) return;
    allPlayers.push({ roomName: player.roomName, volume });
  });

  const preset = {
    uri,
    players: allPlayers,
    playMode: {
      repeat: false
    },
    pauseOthers: true,
    state: 'STOPPED'
  };

  const oneGroupPromise = new Promise((resolve) => {
    // Safety timeout: topology events on this VLAN only come from the 30s
    // SOAP inject, so without a bound this wait can hang the announcement
    // forever. 3000ms matches the subset-announcement pre-play timing (part
    // of the Yodeck A/V sync tuning — keep them aligned).
    const safety = setTimeout(() => {
      logger.warn('announceAll: one-group wait timed out after 3000ms; proceeding');
      resolve();
    }, 3000);
    const onTopologyChanged = (topology) => {
      if (topology.length === 1) {
        clearTimeout(safety);
        return resolve();
      }
      // Not one group yet, continue listening
      system.once('topology-change', onTopologyChanged);
    };

    system.once('topology-change', onTopologyChanged);
  });

  let restoreStarted = false;

  return system.applyPreset(preset)
    .then(() => {
      if (system.zones.length === 1) return;
      return oneGroupPromise;
    })
    .then(() => {
      coordinator.play();
      // Transport-state events never arrive on this VLAN — poll the real
      // state via SOAP so the clip plays to actual completion instead of
      // being cut by a fixed duration-based timer. See wait-for-clip-end.js.
      return waitForClipEnd(coordinator, duration);
    })
    .then(({ reason, elapsedMs }) => {
      logger.warn(`announceAll: clip wait done (${reason}, ${elapsedMs}ms) — starting restore (${backupPresets.length} presets)`);
    })
    .then(() => {
      // Respect manual volume changes made during the clip: every player was
      // set to exactly `announceVol`, so a different reading now means a
      // human touched the knob — keep their value over the snapshot.
      const announceVol = parseInt(volume, 10);
      return Promise.all(system.players.map((p) =>
        getCurrentVolume(p).then((v) => ({ player: p, v })).catch(() => null)
      )).then((results) => {
        for (const r of results) {
          if (!r || !Number.isFinite(r.v) || r.v === announceVol) continue;
          logger.warn(`announceAll: ${r.player.roomName} volume changed mid-clip (${announceVol} -> ${r.v}); keeping user value`);
          backupPresets.forEach((bp) => bp.players.forEach((entry) => {
            if (entry.roomName === r.player.roomName) entry.volume = r.v;
          }));
        }
      });
    })
    .then(() => {
      restoreStarted = true;
      return restorePresets(system, backupPresets).then((restoreFailures) => {
        if (restoreFailures > 0) {
          logger.warn(`announceAll: ${restoreFailures}/${backupPresets.length} restore presets failed (wedged peers); audio played, continuing.`);
        }
      });
    })
    .catch((err) => {
      logger.error(err.stack);
      if (restoreStarted) throw err;
      // The announce chain died before the normal restore ran — applyPreset
      // may have partially regrouped/retuned zones. Put them back
      // best-effort so a failed announcement doesn't leave the office
      // wedged, then surface the original error to the caller.
      logger.warn(`announceAll: attempting post-failure restore of ${backupPresets.length} presets`);
      return restorePresets(system, backupPresets).then(
        () => { throw err; },
        () => { throw err; }
      );
    });

}

module.exports = announceAll;
