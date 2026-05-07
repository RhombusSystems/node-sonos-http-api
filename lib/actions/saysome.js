'use strict';
const tryDownloadTTS = require('../helpers/try-download-tts');
const subsetAnnouncement = require('../helpers/subset-announcement');
const settings = require('../../settings');

let port;

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
    throw new Error('saysome requires at least one room in the comma-separated list');
  }
  return rooms;
}

function saySome(player, values) {
  let rooms;
  try {
    rooms = parseRooms(values[0]);
  } catch (err) {
    return Promise.reject(err);
  }

  let text;
  try {
    text = decodeURIComponent(values[1]);
  } catch (err) {
    if (err instanceof URIError) {
      err.message = `phrase ${values[1]} could not be URI decoded; check %xx encoding`;
    }
    return Promise.reject(err);
  }

  let announceVolume;
  let language;

  // Mirror sayall.js arg shape: values[2] is volume if numeric, else language;
  // values[3] is then volume when values[2] is language.
  if (/^\d+$/i.test(values[2])) {
    announceVolume = values[2];
  } else {
    language = values[2];
    announceVolume = values[3] || settings.announceVolume || 40;
  }

  return tryDownloadTTS(text, language)
    .then((result) => {
      const uri = `http://${player.system.localEndpoint}:${port}${result.uri}`;
      return subsetAnnouncement(player.system, rooms, uri, announceVolume, result.duration);
    });
}

module.exports = function (api) {
  port = api.getPort();
  api.registerAction('saysome', saySome);
};
