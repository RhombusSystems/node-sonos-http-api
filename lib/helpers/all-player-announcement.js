'use strict';
const logger = require('sonos-discovery/lib/helpers/logger');
const isRadioOrLineIn = require('../helpers/is-radio-or-line-in');
const { refreshSystemState, getCurrentVolume } = require('./refresh-state-via-soap');
const waitForClipEnd = require('./wait-for-clip-end');

function saveAll(system) {
  const backupPresets = system.zones.map((zone) => {
    const coordinator = zone.coordinator;
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
      if (coordinator.uuid != player.uuid)
        preset.players.push({ roomName: player.roomName, volume: player.state.volume });
    });

    return preset;

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
  return refreshSystemState(system).catch((err) => {
    logger.warn(`announceAll: refreshSystemState failed (proceeding with cached state): ${err.message}`);
  }).then(() => {
    return _announceAllCore(system, uri, volume, duration);
  });
}

function _announceAllCore(system, uri, volume, duration) {
  // Save all players
  var backupPresets = saveAll(system);

  // find biggest group and all players
  const allPlayers = [];
  let biggestZone = {};
  system.zones.forEach(function (zone) {
    if (!biggestZone.members || zone.members.length > biggestZone.members.length) {
      biggestZone = zone;
    }
  });

  const coordinator = biggestZone.coordinator;

  allPlayers.push({ roomName: coordinator.roomName, volume });

  system.players.forEach(player => {
    if (player.uuid == coordinator.uuid) return;
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
      return backupPresets.reduce((promise, preset) => {
        logger.trace('Restoring preset', preset);
        return promise.then(() => system.applyPreset(preset));
      }, Promise.resolve());
    })
    .catch((err) => {
      logger.error(err.stack);
      throw err;
    });

}

module.exports = announceAll;
