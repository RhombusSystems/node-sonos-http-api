'use strict';
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const fileDuration = require('../helpers/file-duration');
const settings = require('../../settings');
const logger = require('sonos-discovery/lib/helpers/logger');

const API_HOST = 'api.elevenlabs.io';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

// EBU R128 loudnorm targets — keep in sync with
// ~/jarvis/integrations/elevenlabs/client.py LOUDNORM_TARGET_*. Raw ElevenLabs
// mp3 output measures around -23 LUFS / LRA 7, which Sonos's per-clip DSP
// audibly rides ("starts strong, drops, comes back up"). Single-pass dynamic
// loudnorm flattens it to a steady, podcast-loud level (-12 LUFS) so every
// announcement clearly cuts through ambient office noise.
const LOUDNORM_AF = 'loudnorm=I=-12:TP=-1.5:LRA=11';
const LOUDNORM_TIMEOUT_MS = 30000;

function loudnormInPlace(filepath) {
  return new Promise((resolve) => {
    const tmp = `${filepath}.norm.tmp`;
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', filepath,
      '-af', LOUDNORM_AF,
      '-ar', '44100', '-ac', '1',
      '-c:a', 'libmp3lame', '-b:a', '128k',
      '-f', 'mp3',
      tmp,
    ];
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok) {
        try { fs.renameSync(tmp, filepath); } catch (e) { logger.warn(`ElevenLabs loudnorm rename failed: ${e.message}`); }
      } else {
        try { fs.unlinkSync(tmp); } catch (_) { /* fine */ }
      }
      resolve();
    };
    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      logger.warn(`ElevenLabs loudnorm: ffmpeg spawn failed (${e.message}); keeping raw mp3`);
      return finish(false);
    }
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    const killer = setTimeout(() => {
      logger.warn('ElevenLabs loudnorm timed out; keeping raw mp3');
      try { proc.kill('SIGKILL'); } catch (_) { /* fine */ }
      finish(false);
    }, LOUDNORM_TIMEOUT_MS);
    proc.on('error', (e) => {
      clearTimeout(killer);
      logger.warn(`ElevenLabs loudnorm error: ${e.message}`);
      finish(false);
    });
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0 || !fs.existsSync(tmp)) {
        logger.warn(`ElevenLabs loudnorm rc=${code}: ${stderr.slice(0, 240)}`);
        return finish(false);
      }
      finish(true);
    });
  });
}

// Source of truth for the api_key is ~/.elevenlabs/credentials (Jarvis convention,
// shared with ~/jarvis/integrations/elevenlabs). Fallback to settings.json for
// older installs. voice/model overrides still come from settings.json so this
// device can pin a different announcer voice than the global default.
const CREDS_PATH = path.join(os.homedir(), '.elevenlabs', 'credentials');

function loadCreds() {
  try {
    const raw = fs.readFileSync(CREDS_PATH, 'utf8');
    const out = {};
    let inDefault = false;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith(';')) continue;
      const sec = t.match(/^\[([^\]]+)\]\s*$/);
      if (sec) { inDefault = sec[1].trim().toLowerCase() === 'default'; continue; }
      if (!inDefault) continue;
      const kv = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].trim();
    }
    return out;
  } catch (_) {
    return {};
  }
}

function elevenlabs(phrase, language) {
  const creds = loadCreds();
  const cfg = settings.elevenlabs || {};

  const apiKey =
    process.env.ELEVENLABS_API_KEY ||
    creds.api_key ||
    (cfg.auth && cfg.auth.apiKey);
  if (!apiKey) return Promise.resolve();

  const voiceId =
    (cfg.config && cfg.config.voiceId) ||
    creds.voice_id ||
    language;
  if (!voiceId) {
    logger.warn('ElevenLabs: no voiceId configured (set ~/.elevenlabs/credentials voice_id or settings.json voiceId)');
    return Promise.resolve();
  }

  const modelId = (cfg.config && cfg.config.modelId) || creds.model_id || DEFAULT_MODEL;
  const voiceSettings = {
    stability:         (cfg.config && cfg.config.stability)        != null ? cfg.config.stability        : 0.5,
    similarity_boost:  (cfg.config && cfg.config.similarityBoost)  != null ? cfg.config.similarityBoost  : 0.75,
    style:             (cfg.config && cfg.config.style)            != null ? cfg.config.style            : 0,
    use_speaker_boost: (cfg.config && cfg.config.useSpeakerBoost)  != null ? cfg.config.useSpeakerBoost  : true,
  };

  const phraseHash = crypto.createHash('sha1').update(phrase + voiceId).digest('hex');
  const filename = `elevenlabs-${phraseHash}.mp3`;
  const filepath = path.resolve(settings.webroot, 'tts', filename);
  const expectedUri = `/tts/${filename}`;

  // Return cached file if it exists
  try {
    fs.accessSync(filepath, fs.R_OK);
    return fileDuration(filepath).then(duration => ({ duration, uri: expectedUri }));
  } catch (_) {
    logger.info(`ElevenLabs: generating audio for "${phrase}"`);
  }

  const body = JSON.stringify({ text: phrase, model_id: modelId, voice_settings: voiceSettings });
  const options = {
    hostname: API_HOST,
    path: `/v1/text-to-speech/${voiceId}?output_format=${DEFAULT_OUTPUT_FORMAT}`,
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => errBody += c);
        res.on('end', () => reject(new Error(`ElevenLabs API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
        return;
      }
      const file = fs.createWriteStream(filepath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  })
    .then(() => loudnormInPlace(filepath))
    .then(() => fileDuration(filepath))
    .then(duration => ({ duration, uri: expectedUri }));
}

module.exports = elevenlabs;
