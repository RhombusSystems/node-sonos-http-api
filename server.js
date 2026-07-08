'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const auth = require('basic-auth');

// VLAN deployment: Sonos cannot push UPnP events back to this host, so every real
// event Subscriber is useless here AND a time-bomb — its renewal eventually fails,
// emits 'dead', and triggers SonosSystem.restart(), which orphans the port-3500
// NotificationListener (no dispose) and permanently crashes topologyChange with
// "undefined ... endpoint" at Player.js:211. Topology is fed by the SOAP NOTIFY
// injection below; per-zone state by refresh-state-via-soap.js. So stub Subscriber
// to a no-op before sonos-discovery captures the reference.
(function neutralizeUpnpSubscriber() {
  const util = require('util');
  const EventEmitter = require('events').EventEmitter;
  function NoopSubscriber(/* subscribeUrl, notificationUrl */) {
    EventEmitter.call(this);
    this.dispose = function dispose() {};
  }
  util.inherits(NoopSubscriber, EventEmitter);
  const subPath = require.resolve('sonos-discovery/lib/Subscriber');
  require(subPath);                            // ensure module is cached
  require.cache[subPath].exports = NoopSubscriber;
})();

const SonosSystem = require('sonos-discovery');
const logger = require('sonos-discovery/lib/helpers/logger');
const SonosHttpAPI = require('./lib/sonos-http-api.js');
const serveStatic = require('serve-static');
const settings = require('./settings');

const serve = new serveStatic(settings.webroot);
const discovery = new SonosSystem(settings);
const api = new SonosHttpAPI(discovery, settings);

// Sonos speakers are on separate VLANs (10.1.4.x, 10.1.11.x) so SSDP multicast
// and UPnP event subscriptions both fail — Pi can reach Sonos but Sonos cannot
// push events back. Fix: seed init via ssdp.emit, then poll topology via SOAP and
// inject a synthetic NOTIFY to the local NotificationListener (127.0.0.1:3500).
if (settings.devices && settings.devices.length > 0) {
  const ssdp = require('sonos-discovery/lib/sonos-ssdp');
  const origStart = ssdp.start.bind(ssdp);
  // Any speaker can serve GetZoneGroupState — rotate across all configured
  // devices so a single unreachable speaker (EHOSTUNREACH on the old fixed
  // seed was observed for hours) doesn't blind the whole topology feed.
  const SEED_IPS = settings.devices;
  let lastGoodIdx = 0;
  const NOTIFICATION_PORT = 3500;
  // Only pattern-matched by NotificationListener's /uuid:(.+)_sub/ regex, and
  // topologyChange ignores the extracted uuid entirely — stays valid no
  // matter which seed IP the topology was fetched from.
  const SEED_UUID = 'RINCON_B8E9373F016001400';

  const SOAP_BODY = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"></u:GetZoneGroupState></s:Body></s:Envelope>';

  function injectTopology(attempt) {
    attempt = attempt || 0;
    if (attempt >= SEED_IPS.length) {
      logger.error(`SOAP topology fetch failed on all ${SEED_IPS.length} seed IPs; retrying next cycle`);
      return;
    }
    const idx = (lastGoodIdx + attempt) % SEED_IPS.length;
    const seedIp = SEED_IPS[idx];
    const failover = (why) => {
      logger.warn(`SOAP topology fetch via ${seedIp} failed (${why}); trying next seed`);
      injectTopology(attempt + 1);
    };
    const req = http.request({
      hostname: seedIp, port: 1400, path: '/ZoneGroupTopology/Control',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': '"urn:schemas-upnp-org:service:ZoneGroupTopology:1#GetZoneGroupState"',
        'Content-Length': Buffer.byteLength(SOAP_BODY)
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const match = data.match(/<ZoneGroupState>([\s\S]*?)<\/ZoneGroupState>/);
        if (!match) return failover('response missing ZoneGroupState');
        lastGoodIdx = idx;
        const topologyXml = match[1];
        const notifyBody = `<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><ZoneGroupState>${topologyXml}</ZoneGroupState></e:property></e:propertyset>`;
        http.request({
          hostname: '127.0.0.1', port: NOTIFICATION_PORT, method: 'NOTIFY',
          headers: {
            'SID': `uuid:${SEED_UUID}_sub0000000001`,
            'Content-Type': 'text/xml',
            'Content-Length': Buffer.byteLength(notifyBody)
          }
        }, () => logger.info(`Injected Sonos topology via SOAP poll (seed ${seedIp})`))
          .on('error', () => {})
          .end(notifyBody);
      });
    });
    req.on('error', e => failover(e.message));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end(SOAP_BODY);
  }

  function seedDiscovery() {
    const seedIp = SEED_IPS[lastGoodIdx];
    logger.info(`Seeding Sonos discovery from static device ${seedIp}`);
    ssdp.emit('found', {
      household: 'static',
      location: `http://${seedIp}:1400/xml/device_description.xml`,
      ip: seedIp
    });
  }

  // Patch start so future restarts (subscriber death → restart()) also re-seed
  ssdp.start = function () {
    origStart();
    setTimeout(seedDiscovery, 200);
    setTimeout(injectTopology, 2000);
  };

  // Initial bootstrap — SonosSystem already called origStart and registered once('found')
  setTimeout(seedDiscovery, 200);
  setTimeout(injectTopology, 2000);

  // Poll topology every 30s to keep zone/player state fresh
  setInterval(injectTopology, 30000);
}

var requestHandler = function (req, res) {
  req.addListener('end', function () {
    serve(req, res, function (err) {

      // If error, route it.
      // This bypasses authentication on static files!
      //if (!err) {
      //  return;
      //}

      if (settings.auth) {
        var credentials = auth(req);

        if (!credentials || credentials.name !== settings.auth.username || credentials.pass !== settings.auth.password) {
          res.statusCode = 401;
          res.setHeader('WWW-Authenticate', 'Basic realm="Access Denied"');
          res.end('Access denied');
          return;
        }
      }

      // Enable CORS requests
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.headers['access-control-request-headers']) {
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers']);
      }

      if (req.method === 'OPTIONS') {
        res.end();
        return;
      }

      if (req.method === 'GET') {
        api.requestHandler(req, res);
      }
    });
  }).resume();
};

let server;

if (settings.https) {
  var options = {};
  if (settings.https.pfx) {
    options.pfx = fs.readFileSync(settings.https.pfx);
    options.passphrase = settings.https.passphrase;
  } else if (settings.https.key && settings.https.cert) {
    options.key = fs.readFileSync(settings.https.key);
    options.cert = fs.readFileSync(settings.https.cert);
  } else {
    logger.error("Insufficient configuration for https");
    return;
  }

  const secureServer = https.createServer(options, requestHandler);
  secureServer.listen(settings.securePort, function () {
    logger.info('https server listening on port', settings.securePort);
  });
}

server = http.createServer(requestHandler);

process.on('unhandledRejection', (err) => {
  logger.error(err);
});

let host = settings.ip;
server.listen(settings.port, host, function () {
  logger.info('http server listening on', host, 'port', settings.port);
});

server.on('error', (err) => {
  if (err.code && err.code === 'EADDRINUSE') {
    logger.error(`Port ${settings.port} seems to be in use already. Make sure the sonos-http-api isn't 
    already running, or that no other server uses that port. You can specify an alternative http port 
    with property "port" in settings.json`);
  } else {
    logger.error(err);
  }

  process.exit(1);
});


