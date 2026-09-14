'use strict';
// Pure Node.js UPnP IGD port mapping — zero external dependencies.
// Asks the local router to open a port and return the public IP.

const dgram = require('dgram');
const http  = require('http');
const { URL } = require('url');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

// ── SSDP discovery ─────────────────────────────────────────────────
function ssdpSearch(serviceType, timeoutMs) {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg  = Buffer.from(
      `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      `MAN: "ssdp:discover"\r\nMX: 2\r\nST: ${serviceType}\r\n\r\n`
    );
    const done = loc => {
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(loc || null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on('message', buf => {
      const m = buf.toString().match(/^LOCATION:\s*(.+)$/im);
      if (m) done(m[1].trim());
    });
    sock.on('error', () => done(null));
    sock.bind(0, () => {
      sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR, err => { if (err) done(null); });
    });
  });
}

// ── HTTP helpers ───────────────────────────────────────────────────
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const u   = new URL(url);
      const req = http.get({ hostname: u.hostname, port: parseInt(u.port) || 80, path: u.pathname + u.search, timeout: timeoutMs }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function soapPost(controlUrl, action, ns, bodyXml, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const payload = Buffer.from(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${bodyXml}</s:Body></s:Envelope>`
      );
      const u   = new URL(controlUrl);
      const req = http.request({
        hostname: u.hostname, port: parseInt(u.port) || 80, path: u.pathname,
        method: 'POST', timeout: timeoutMs,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'SOAPAction': `"${ns}#${action}"`,
          'Content-Length': payload.length,
        },
      }, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    } catch (e) { reject(e); }
  });
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
}

function findControlUrl(xml, location, svcType) {
  const escaped = svcType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = xml.match(new RegExp(`<serviceType>${escaped}</serviceType>[\\s\\S]*?<controlURL>([^<]+)</controlURL>`, 'i'));
  if (!m) return null;
  const p = m[1].trim();
  if (p.startsWith('http')) return p;
  const u = new URL(location);
  return `${u.protocol}//${u.host}${p.startsWith('/') ? p : '/' + p}`;
}

// ── Discovery ──────────────────────────────────────────────────────
async function findGateway() {
  const searchTypes = [
    'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    'urn:schemas-upnp-org:service:WANIPConnection:1',
    'upnp:rootdevice',
  ];
  let location = null;
  for (const st of searchTypes) {
    location = await ssdpSearch(st, 2500);
    if (location) break;
  }
  if (!location) return null;

  let xml;
  try { xml = await httpGet(location, 4000); } catch (_) { return null; }

  for (const svc of WAN_SERVICES) {
    const controlUrl = findControlUrl(xml, location, svc);
    if (controlUrl) return { controlUrl, ns: svc };
  }
  return null;
}

// ── Public API ─────────────────────────────────────────────────────

// Open a port mapping. Returns { publicIp, publicUrl, controlUrl, ns } or null.
async function openPort(localIp, port) {
  try {
    const gw = await findGateway();
    if (!gw) return null;
    const { controlUrl, ns } = gw;

    const ipXml  = await soapPost(controlUrl, 'GetExternalIPAddress', ns, `<u:GetExternalIPAddress xmlns:u="${ns}"/>`, 5000);
    const pubIp  = tag(ipXml, 'NewExternalIPAddress');
    if (!pubIp || pubIp === '0.0.0.0') return null;

    await soapPost(controlUrl, 'AddPortMapping', ns, `\
<u:AddPortMapping xmlns:u="${ns}">
  <NewRemoteHost></NewRemoteHost>
  <NewExternalPort>${port}</NewExternalPort>
  <NewProtocol>TCP</NewProtocol>
  <NewInternalPort>${port}</NewInternalPort>
  <NewInternalClient>${localIp}</NewInternalClient>
  <NewEnabled>1</NewEnabled>
  <NewPortMappingDescription>WorldLink :${port}</NewPortMappingDescription>
  <NewLeaseDuration>0</NewLeaseDuration>
</u:AddPortMapping>`, 5000);

    return { publicIp: pubIp, publicUrl: `http://${pubIp}:${port}`, controlUrl, ns };
  } catch (_) {
    return null;
  }
}

// Best-effort cleanup on shutdown.
async function closePort(controlUrl, ns, port) {
  try {
    await soapPost(controlUrl, 'DeletePortMapping', ns, `\
<u:DeletePortMapping xmlns:u="${ns}">
  <NewRemoteHost></NewRemoteHost>
  <NewExternalPort>${port}</NewExternalPort>
  <NewProtocol>TCP</NewProtocol>
</u:DeletePortMapping>`, 3000);
  } catch (_) {}
}

module.exports = { openPort, closePort };
