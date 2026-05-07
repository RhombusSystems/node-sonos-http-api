'use strict';
const path = require('path');
const settings = require('../../settings');
const subsetAnnouncement = require('../helpers/subset-announcement');
const fileDuration = require('../helpers/file-duration');

let port;

const LOCAL_PATH_LOCATION = path.join(settings.webroot, 'clips');

function parseRooms(roomsCsv) {
  let decoded;
  try {
    decoded = decodeURIComponent(roomsCsv);
  } catch (err) {
    if (err instanceof URIError) {
      err.message = `roomsCsv ${roomsCsv} could not be URI decoded; check %xx encoding`;
    }
    throw err;
  }
  const rooms = decoded.split(',').map((r) => r.trim()).filter(Boolean);
  if (rooms.length === 0) {
    throw new Error('clipsome requires at least one room in the comma-separated list');
  }
  return rooms;
}

function playClipOnSubset(player, values) {
  let rooms;
  try {
    rooms = parseRooms(values[0]);
  } catch (err) {
    return Promise.reject(err);
  }

  const clipFileName = values[1];
  if (!clipFileName) {
    return Promise.reject(new Error('clipsome: missing clip filename'));
  }

  let announceVolume = settings.announceVolume || 40;
  if (/^\d+$/i.test(values[2])) {
    announceVolume = values[2];
  }

  return fileDuration(path.join(LOCAL_PATH_LOCATION, clipFileName))
    .then((duration) => {
      const uri = `http://${player.system.localEndpoint}:${port}/clips/${clipFileName}`;
      return subsetAnnouncement(player.system, rooms, uri, announceVolume, duration);
    });
}

module.exports = function (api) {
  port = api.getPort();
  api.registerAction('clipsome', playClipOnSubset);
};
