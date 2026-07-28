'use strict';
const logger = require('sonos-discovery/lib/helpers/logger');
const isRadioOrLineIn = require('../helpers/is-radio-or-line-in');
const { refreshSystemState, getCurrentVolume, probeReachable } = require('./refresh-state-via-soap');
const waitForClipEnd = require('./wait-for-clip-end');

// deadUuids: players known-unreachable from the pre-announce probe. They are
// excluded from restore presets — applyPreset addresses every listed player
// directly, so restoring a preset that names a dead speaker would fail the
// whole preset and leave the healthy members un-restored.
function saveZones(zones, deadUuids) {
  const backupPresets = [];
  zones.forEach((zone) => {
    const coordinator = zone.coordinator;
    if (deadUuids.has(coordinator.uuid)) {
      // The zone's transport source of truth is unreachable — there is no
      // reliable way to restore this group. Skip it rather than guess.
      logger.warn(`subsetAnnouncement: skipping backup of zone ${coordinator.roomName} (coordinator unreachable)`);
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

  logger.trace('subsetAnnouncement backup presets', backupPresets);
  return backupPresets.sort((a, b) => {
    return a.players.length < b.players.length;
  });
}

function findPlayer(system, name) {
  return system.players.find((p) => p.roomName === name);
}

function subsetIsGrouped(system, coordinatorUuid, subsetNames) {
  const zone = system.zones.find((z) => z.coordinator && z.coordinator.uuid === coordinatorUuid);
  if (!zone) return false;
  const memberNames = new Set(zone.members.map((m) => m.roomName));
  return subsetNames.every((n) => memberNames.has(n));
}

function subsetAnnouncement(system, roomNames, uri, volume, duration) {
  if (!Array.isArray(roomNames) || roomNames.length === 0) {
    return Promise.reject(new Error('subsetAnnouncement requires at least one room name'));
  }

  let resolved;
  try {
    resolved = roomNames.map((name) => {
      const player = findPlayer(system, name);
      if (!player) throw new Error(`Unknown Sonos room: ${name}`);
      return player;
    });
  } catch (err) {
    return Promise.reject(err);
  }

  // Snapshot accuracy fix: this deployment can't deliver UPnP events back to
  // the API across the speaker VLANs, so coordinator.state / .avTransportUri
  // / member.state.volume are all empty by default. Refresh per-zone state
  // via direct SOAP queries before snapshotting so saveAll captures the real
  // "what was playing" — otherwise restore writes empty back and the office
  // goes silent after the announcement. See refresh-state-via-soap.js.
  //
  // Synchronous from the API caller's perspective (subsetAnnouncement already
  // returns a Promise); cost is ~1 round-trip per zone × 4 SOAP queries per
  // coordinator, all parallelized → typical wall-clock ~200-500ms.
  //
  // The reachability probe runs in parallel (both are read-only SOAP, so a
  // healthy fleet pays no extra latency). One dead speaker in the preset
  // rejects the whole applyPreset call (EHOSTUNREACH aborts the group), so
  // unreachable rooms are dropped up front and the announcement proceeds on
  // whatever subset is actually alive.
  return Promise.all([
    refreshSystemState(system).catch((err) => {
      logger.warn(`subsetAnnouncement: refreshSystemState failed (proceeding with cached state): ${err.message}`);
    }),
    probeReachable(resolved),
  ]).then(([, reachable]) => {
    const live = resolved.filter((p) => reachable.has(p.uuid));
    const dead = resolved.filter((p) => !reachable.has(p.uuid));
    if (live.length === 0) {
      throw new Error(`subsetAnnouncement: all requested rooms unreachable: ${resolved.map((p) => p.roomName).join(', ')}`);
    }
    if (dead.length > 0) {
      logger.warn(`subsetAnnouncement: dropping unreachable rooms [${dead.map((p) => p.roomName)}] — announcing to [${live.map((p) => p.roomName)}]`);
    }
    return _subsetAnnouncementCore(system, live, new Set(dead.map((p) => p.uuid)), uri, volume, duration);
  });
}

function restorePresets(system, backupPresets, t) {
  let restoreFailures = 0;
  return backupPresets.reduce((promise, preset, idx) => {
    return promise.then(() => {
      const coordName = preset.players[0].roomName;
      logger.warn(`subsetAnnouncement: restore[${idx}] coord=${coordName} ${t()}`);
      return system.applyPreset(preset).catch((err) => {
        restoreFailures += 1;
        logger.warn(`subsetAnnouncement: restore[${idx}] coord=${coordName} FAILED (continuing) — ${err.message}`);
      });
    });
  }, Promise.resolve()).then(() => restoreFailures);
}

function _subsetAnnouncementCore(system, resolved, deadUuids, uri, volume, duration) {
  // Blast-radius limit: only snapshot (and later restore) zones that share a
  // member with the announced subset. Grouping the subset breaks exactly
  // those zones — e.g. if an announced room is currently grouped with a
  // non-announced room, pulling it into the announce group disturbs that
  // whole zone, so the zone is saved+restored even though only part of it is
  // announced. Zones with zero overlap (their music keeps playing — see
  // pauseOthers:false below) are never touched by the restore.
  const subsetUuids = new Set(resolved.map((p) => p.uuid));
  const affectedZones = system.zones.filter((z) =>
    (z.members || []).some((m) => m && subsetUuids.has(m.uuid)));
  const backupPresets = saveZones(affectedZones, deadUuids);

  // Coordinator = first subset member; deterministic across calls.
  const coordinator = resolved[0];
  const subsetNames = resolved.map((p) => p.roomName);
  const affectedRooms = affectedZones.map((z) => z.coordinator.roomName);

  const allPlayers = [{ roomName: coordinator.roomName, volume }];
  for (const p of resolved) {
    if (p.uuid === coordinator.uuid) continue;
    allPlayers.push({ roomName: p.roomName, volume });
  }

  const preset = {
    uri,
    players: allPlayers,
    playMode: { repeat: false },
    // Never pause non-announced zones: the announced players' transports are
    // replaced by applyPreset's setAVTransport anyway, and everything else in
    // the office should keep playing through the announcement.
    pauseOthers: false,
    state: 'STOPPED'
  };

  // Pre-install topology listener so we don't miss the change between
  // applyPreset resolving and us starting to wait. Single-room subset
  // skips the listener (no grouping work needed).
  const groupedPromise = subsetNames.length === 1
    ? Promise.resolve()
    : new Promise((resolve) => {
        const safety = setTimeout(() => {
          logger.warn('subsetAnnouncement: topology wait timed out after 3000ms; proceeding');
          resolve();
        }, 3000);
        const onTopologyChanged = () => {
          if (subsetIsGrouped(system, coordinator.uuid, subsetNames)) {
            clearTimeout(safety);
            return resolve();
          }
          system.once('topology-change', onTopologyChanged);
        };
        system.once('topology-change', onTopologyChanged);
      });

  const t0 = Date.now();
  const t = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
  let restoreStarted = false;

  logger.warn(`subsetAnnouncement: start rooms=[${subsetNames}] coord=${coordinator.roomName} duration=${duration}ms affectedZones=[${affectedRooms}]`);

  return system.applyPreset(preset)
    .then(() => {
      logger.warn(`subsetAnnouncement: applyPreset resolved ${t()}`);
      if (subsetIsGrouped(system, coordinator.uuid, subsetNames)) {
        logger.warn(`subsetAnnouncement: subset already grouped ${t()}`);
        return;
      }
      return groupedPromise;
    })
    .then(() => {
      logger.warn(`subsetAnnouncement: pre-play ${t()} — calling coordinator.play()`);
      coordinator.play();
      // Transport-state events never arrive on this VLAN — poll the real
      // state via SOAP so the clip plays to actual completion instead of
      // being cut by a fixed duration-based timer. See wait-for-clip-end.js.
      return waitForClipEnd(coordinator, duration);
    })
    .then(({ reason, elapsedMs }) => {
      logger.warn(`subsetAnnouncement: clip wait done (${reason}, ${elapsedMs}ms) ${t()} — starting restore (${backupPresets.length} presets)`);
    })
    .then(() => {
      // Respect manual volume changes made during the clip: we set every
      // subset player to exactly `announceVol`, so any different reading now
      // means a human touched the knob — keep their value instead of the
      // pre-announcement snapshot.
      const announceVol = parseInt(volume, 10);
      return Promise.all(resolved.map((p) =>
        getCurrentVolume(p).then((v) => ({ player: p, v })).catch(() => null)
      )).then((results) => {
        for (const r of results) {
          if (!r || !Number.isFinite(r.v) || r.v === announceVol) continue;
          logger.warn(`subsetAnnouncement: ${r.player.roomName} volume changed mid-clip (${announceVol} -> ${r.v}); keeping user value`);
          backupPresets.forEach((bp) => bp.players.forEach((entry) => {
            if (entry.roomName === r.player.roomName) entry.volume = r.v;
          }));
        }
      });
    })
    .then(() => {
      restoreStarted = true;
      return restorePresets(system, backupPresets, t).then((restoreFailures) => {
        if (restoreFailures > 0) {
          logger.warn(`subsetAnnouncement: ${restoreFailures}/${backupPresets.length} restore presets failed (wedged peers); audio played, continuing.`);
        }
      });
    })
    .then(() => {
      logger.warn(`subsetAnnouncement: DONE ${t()}`);
    })
    .catch((err) => {
      logger.warn(`subsetAnnouncement: FAILED ${t()} — ${err.message}`);
      logger.error(err.stack);
      if (restoreStarted) throw err;
      // The announce chain died before the normal restore ran — applyPreset
      // may have partially regrouped/retuned the affected zones. Put them
      // back best-effort so a failed announcement doesn't leave the office
      // wedged, then surface the original error to the caller.
      logger.warn(`subsetAnnouncement: attempting post-failure restore of ${backupPresets.length} presets`);
      return restorePresets(system, backupPresets, t).then(
        () => { throw err; },
        () => { throw err; }
      );
    });
}

module.exports = subsetAnnouncement;
