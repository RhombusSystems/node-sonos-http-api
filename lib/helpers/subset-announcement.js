'use strict';
const logger = require('sonos-discovery/lib/helpers/logger');
const isRadioOrLineIn = require('../helpers/is-radio-or-line-in');

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

  const backupPresets = saveAll(system);

  // Coordinator = first subset member; deterministic across calls.
  const coordinator = resolved[0];
  const subsetNames = resolved.map((p) => p.roomName);

  const allPlayers = [{ roomName: coordinator.roomName, volume }];
  for (const p of resolved) {
    if (p.uuid === coordinator.uuid) continue;
    allPlayers.push({ roomName: p.roomName, volume });
  }

  const preset = {
    uri,
    players: allPlayers,
    playMode: { repeat: false },
    pauseOthers: true,
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

  let abortTimer;
  const restoreTimeout = duration + 2000;
  const t0 = Date.now();
  const t = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

  logger.warn(`subsetAnnouncement: start rooms=[${subsetNames}] coord=${coordinator.roomName} duration=${duration}ms`);

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
      return new Promise((resolve) => {
        const transportChange = (state) => {
          logger.warn(`subsetAnnouncement: transport state=${state.playbackState} ${t()}`);
          if (state.playbackState === 'STOPPED') {
            return resolve();
          }
          coordinator.once('transport-state', transportChange);
        };
        setTimeout(() => {
          coordinator.once('transport-state', transportChange);
        }, duration / 2);

        abortTimer = setTimeout(() => {
          logger.warn(`subsetAnnouncement: abortTimer fired (${restoreTimeout}ms) ${t()}`);
          resolve();
        }, restoreTimeout);
      });
    })
    .then(() => {
      logger.warn(`subsetAnnouncement: play wait done ${t()} — starting restore (${backupPresets.length} presets)`);
      clearTimeout(abortTimer);
    })
    .then(() => {
      return backupPresets.reduce((promise, preset, idx) => {
        return promise.then(() => {
          logger.warn(`subsetAnnouncement: restore[${idx}] coord=${preset.players[0].roomName} ${t()}`);
          return system.applyPreset(preset);
        });
      }, Promise.resolve());
    })
    .then(() => {
      logger.warn(`subsetAnnouncement: DONE ${t()}`);
    })
    .catch((err) => {
      logger.warn(`subsetAnnouncement: FAILED ${t()} — ${err.message}`);
      logger.error(err.stack);
      throw err;
    });
}

module.exports = subsetAnnouncement;
