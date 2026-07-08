'use strict';
const http = require('http');
const url = require('url');
const logger = require('sonos-discovery/lib/helpers/logger');

// Snapshot accuracy fix for VLAN-isolated deployments.
//
// In this deployment Sonos speakers can't push UPnP NOTIFY events back to the
// API because they live on different VLANs (10.1.4.x / 10.1.7.x / 10.1.11.x)
// than the host (server.js:16-19 documents this trade). The bundled fix only
// covers ZoneGroupTopology — synthesized via SOAP poll + injected NOTIFY at
// 127.0.0.1:3500. AVTransport state and per-player volume are NOT covered:
// the sonos-discovery Subscriber objects exist, the subscriptions are issued,
// but no events are delivered back, so `coordinator.state.playbackState`,
// `coordinator.avTransportUri`, `coordinator.avTransportUriMetadata`, and
// every member's `state.volume` stay at their initial "empty" defaults.
//
// Consequences for /clipsome and /clipall: `saveAll(system)` in
// subset-announcement.js and all-player-announcement.js builds
// `backupPresets` from the empty cache → restore writes empty back → the
// music that was playing when the announcement fired does NOT resume. From
// the office's perspective: announcement plays, then silence forever.
//
// This helper refreshes the cache for every zone via direct SOAP queries
// before `saveAll()` runs. It does NOT change the sonos-discovery library —
// it just writes back into the Player object properties that the existing
// `saveAll()` reads from, so the existing restore choreography works
// unchanged.
//
// SOAP calls per zone:
//   coordinator AVTransport GetMediaInfo     → avTransportUri / avTransportUriMetadata
//   coordinator AVTransport GetTransportInfo → state.playbackState
//   coordinator AVTransport GetPositionInfo  → state.trackNo / state.elapsedTime
//   coordinator AVTransport GetTransportSettings → state.playMode.repeat
//   every member RenderingControl GetVolume  → member.state.volume
//
// Best-effort: any per-zone failure logs warn but doesn't reject the outer
// promise — partial refresh is better than aborting the whole announcement.
// Total wall-clock cost is one ~5s round-trip per zone (queries run in
// parallel across zones).

const SOAP_TIMEOUT_MS = 4000;

const AV = '/MediaRenderer/AVTransport/Control';
const RC = '/MediaRenderer/RenderingControl/Control';
const AV_URN = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC_URN = 'urn:schemas-upnp-org:service:RenderingControl:1';

function soapRequest(playerBaseUrl, controlPath, serviceUrn, action, innerXml = '') {
  return new Promise((resolve, reject) => {
    const u = url.parse(playerBaseUrl + controlPath);
    const body =
      `<?xml version="1.0"?>` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
      `<u:${action} xmlns:u="${serviceUrn}">` +
      `<InstanceID>0</InstanceID>${innerXml}` +
      `</u:${action}></s:Body></s:Envelope>`;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"${serviceUrn}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: SOAP_TIMEOUT_MS,
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(chunks);
        } else {
          reject(new Error(`SOAP ${action} HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`SOAP ${action} timeout`)); });
    req.write(body);
    req.end();
  });
}

// Pull the first tag value out of a SOAP response body. Sonos wraps the
// response in <u:{action}Response>...</u:{action}Response> and the
// individual fields are direct children. Values may be empty strings.
function tag(body, name) {
  const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : null;
}

// Sonos position strings come back as "H:MM:SS" or "NOT_IMPLEMENTED". Parse
// to seconds (integer) or 0. Mirrors sonos-discovery/lib/helpers/parseTime.
function parseTimeStr(s) {
  if (!s || s === 'NOT_IMPLEMENTED') return 0;
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] | 0;
}

// Sonos PlayMode is one of: NORMAL, REPEAT_ALL, REPEAT_ONE, SHUFFLE,
// SHUFFLE_NOREPEAT. The state.playMode.repeat field uses 'all' / 'one' /
// 'none' (sonos-discovery REPEAT_MODE constants).
function parseRepeatMode(playMode) {
  if (!playMode) return 'none';
  if (playMode.indexOf('REPEAT_ALL') >= 0) return 'all';
  if (playMode === 'SHUFFLE') return 'all';   // SHUFFLE alone implies repeat-all in Sonos
  if (playMode.indexOf('REPEAT_ONE') >= 0) return 'one';
  return 'none';
}

// Refresh the AVTransport + per-member-volume cache for one zone.
//
// IMPORTANT: sonos-discovery's `Player.state` is a defineProperty getter that
// returns a `deepFreeze`d snapshot built fresh per access — writes to it
// silently no-op in non-strict mode and throw "Cannot assign to read only
// property" in strict mode (which this module is). The mutable internal
// state lives behind `Player._state` (also a getter that returns the
// internal mutable object). The notification handler in Player.js writes to
// the same closure-scoped variable that `_state` exposes. So we route every
// state field write through `_state`. Top-level Player fields like
// `avTransportUri` and `avTransportUriMetadata` are plain instance
// properties and can be assigned directly.
function refreshZone(zone) {
  const coord = zone.coordinator;
  if (!coord || !coord.baseUrl || !coord._state) {
    return Promise.resolve();
  }
  const baseUrl = coord.baseUrl;

  const coordCalls = Promise.all([
    soapRequest(baseUrl, AV, AV_URN, 'GetMediaInfo').then(body => {
      const uri = tag(body, 'CurrentURI');
      const meta = tag(body, 'CurrentURIMetaData');
      // avTransportUri / avTransportUriMetadata are plain instance fields
      // (Player.js:174-175); the notification handler writes to them
      // directly the same way (Player.js:264).
      if (uri !== null) coord.avTransportUri = uri;
      if (meta !== null) coord.avTransportUriMetadata = meta;
    }).catch(err => logger.warn(`refresh-state: ${coord.roomName} GetMediaInfo failed: ${err.message}`)),

    soapRequest(baseUrl, AV, AV_URN, 'GetTransportInfo').then(body => {
      const playback = tag(body, 'CurrentTransportState');
      if (playback) coord._state.playbackState = playback;
    }).catch(err => logger.warn(`refresh-state: ${coord.roomName} GetTransportInfo failed: ${err.message}`)),

    soapRequest(baseUrl, AV, AV_URN, 'GetPositionInfo').then(body => {
      const trackStr = tag(body, 'Track');
      const relTime = tag(body, 'RelTime');
      if (trackStr) {
        const n = parseInt(trackStr, 10);
        if (Number.isFinite(n)) coord._state.trackNo = n;
      }
      // Internally sonos-discovery tracks position as `relTime` + `stateTime`
      // and computes `elapsedTime` on the fly in `getState()`. Match that
      // contract — set `relTime` (seconds) + `stateTime` (Date.now()) so
      // saveAll's `state.elapsedTime` (the snapshot computed from these)
      // reflects current position.
      if (relTime) coord._state.relTime = parseTimeStr(relTime);
      coord._state.stateTime = Date.now();
    }).catch(err => logger.warn(`refresh-state: ${coord.roomName} GetPositionInfo failed: ${err.message}`)),

    soapRequest(baseUrl, AV, AV_URN, 'GetTransportSettings').then(body => {
      const pm = tag(body, 'PlayMode');
      if (pm && coord._state.playMode) {
        coord._state.playMode.repeat = parseRepeatMode(pm);
      }
    }).catch(err => logger.warn(`refresh-state: ${coord.roomName} GetTransportSettings failed: ${err.message}`)),
  ]);

  const memberCalls = (zone.members || []).map((member) => {
    if (!member || !member.baseUrl || !member._state) return Promise.resolve();
    return soapRequest(member.baseUrl, RC, RC_URN, 'GetVolume', '<Channel>Master</Channel>')
      .then(body => {
        const v = tag(body, 'CurrentVolume');
        if (v !== null) {
          const n = parseInt(v, 10);
          if (Number.isFinite(n)) {
            // Volume lives on each member's own internal state; the
            // notification handler routes through `_setVolume()` which
            // writes to the same closure-scoped state variable. Direct
            // `_state.volume` assignment is equivalent and avoids depending
            // on whether `_setVolume` is exposed on every Player instance.
            member._state.volume = n;
          }
        }
      })
      .catch(err => logger.warn(`refresh-state: ${member.roomName} GetVolume failed: ${err.message}`));
  });

  return Promise.all([coordCalls, ...memberCalls]).then(() => {});
}

function refreshSystemState(system) {
  if (!system || !Array.isArray(system.zones) || system.zones.length === 0) {
    return Promise.resolve();
  }
  const started = Date.now();
  return Promise.all(system.zones.map(refreshZone)).then(() => {
    logger.info(`refresh-state: ${system.zones.length} zones refreshed in ${Date.now() - started}ms`);
  });
}

// Direct SOAP reads for the announcement helpers. Both bypass the (event-fed,
// therefore stale on this VLAN) Player cache and ask the speaker itself.

// Resolves to 'PLAYING' | 'TRANSITIONING' | 'STOPPED' | 'PAUSED_PLAYBACK' |
// null (unparseable response). Rejects on transport/HTTP errors.
function getTransportState(player) {
  return soapRequest(player.baseUrl, AV, AV_URN, 'GetTransportInfo')
    .then(body => tag(body, 'CurrentTransportState'));
}

// Resolves to an integer volume or null (unparseable). Rejects on
// transport/HTTP errors.
function getCurrentVolume(player) {
  return soapRequest(player.baseUrl, RC, RC_URN, 'GetVolume', '<Channel>Master</Channel>')
    .then(body => {
      const v = tag(body, 'CurrentVolume');
      if (v === null) return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    });
}

module.exports = { refreshSystemState, getTransportState, getCurrentVolume };
