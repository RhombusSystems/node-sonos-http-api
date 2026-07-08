'use strict';
const logger = require('sonos-discovery/lib/helpers/logger');
const { getTransportState } = require('./refresh-state-via-soap');

// Clip-end detection for VLAN-isolated deployments.
//
// The stock announcement helpers wait for a `transport-state` STOPPED event,
// but on this VLAN speakers can't push UPnP events back to the API (see
// server.js Subscriber stub), so that event NEVER fires and the fixed
// `duration + 2000ms` abort timer always decided when to restore. If the
// speaker started playback late (clip fetch/buffering — "socket hang up"
// during the clip GET has been observed), the fixed timer truncated the
// clip tail.
//
// This waiter polls the coordinator's real transport state via SOAP instead:
//   phase 1: wait for PLAYING/TRANSITIONING (playback actually began).
//            If startGraceMs passes without ever seeing it and the speaker
//            reports STOPPED/PAUSED, resolve `never-started` — play() failed,
//            don't hold the restore hostage for the full ceiling.
//   phase 2: once PLAYING was seen, resolve `ended` on STOPPED (clip done)
//            or PAUSED_PLAYBACK (someone paused mid-clip — restore rather
//            than hang).
//   ceiling: resolve `ceiling` at durationMs + 30s no matter what.
//
// Poll errors are treated as "state unknown, keep polling" so a transient
// SOAP failure can't end the clip early. Never rejects.
//
// A/V sync note: pre-play timing (topology wait, play() call point) is
// unchanged by this module — clip start relative to the Yodeck video is
// identical. Only the restore moment moves: actual clip end + one poll
// interval instead of a fixed duration+2s from play().
function waitForClipEnd(coordinator, durationMs, opts = {}) {
  const pollMs = opts.pollMs || 2000;
  const startGraceMs = opts.startGraceMs || 10000;
  const ceilingMs = opts.ceilingMs || (durationMs + 30000);
  const t0 = Date.now();

  return new Promise((resolve) => {
    let sawPlaying = false;
    let lastKnown = null;
    let pollTimer = null;
    let done = false;

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(pollTimer);
      clearTimeout(ceilingTimer);
      resolve({ reason, elapsedMs: Date.now() - t0 });
    };

    const ceilingTimer = setTimeout(() => finish('ceiling'), ceilingMs);

    const poll = () => {
      if (done) return;
      getTransportState(coordinator)
        .then((state) => {
          if (state) lastKnown = state;
          if (state === 'PLAYING' || state === 'TRANSITIONING') {
            sawPlaying = true;
          } else if (sawPlaying && (state === 'STOPPED' || state === 'PAUSED_PLAYBACK')) {
            return finish('ended');
          } else if (!sawPlaying && Date.now() - t0 > startGraceMs &&
                     (lastKnown === 'STOPPED' || lastKnown === 'PAUSED_PLAYBACK')) {
            return finish('never-started');
          }
          pollTimer = setTimeout(poll, pollMs);
        })
        .catch((err) => {
          // State unknown this round — keep polling; the ceiling bounds us.
          logger.warn(`waitForClipEnd: ${coordinator.roomName} GetTransportInfo failed (${err.message}); continuing to poll`);
          pollTimer = setTimeout(poll, pollMs);
        });
    };

    poll();
  });
}

module.exports = waitForClipEnd;
