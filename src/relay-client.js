'use strict';
// WorldLink Relay Client
// Connects a gateway to a relay server using pure-HTTP long-polling.
// Zero external dependencies — uses only Node.js built-ins.

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

function createRelayClient({ relayUrl, worldId, worldName, localPort, onPeerJoined }) {
  const base    = relayUrl.replace(/\/+$/, '');
  const useHttps = base.startsWith('https://');
  let myToken   = null;
  let stopped   = false;
  let registered = false;

  // requestId → { resolve, reject, timer }  for in-flight relayed requests
  const pending = new Map();

  // ── Low-level HTTP helper ─────────────────────────────────────────────────
  function httpReq(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const u   = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const buf = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
      const req = lib.request({
        hostname: u.hostname,
        port:     u.port || (useHttps ? 443 : 80),
        path:     u.pathname + u.search,
        method:   opts.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(buf ? { 'Content-Length': buf.length } : {}),
        },
        timeout: opts.timeout || 30000,
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch { resolve({ _raw: d }); }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('relay request timeout')); });
      req.on('error', reject);
      if (buf) req.write(buf);
      req.end();
    });
  }

  // ── Forward a request to the local gateway ───────────────────────────────
  function localRequest(method, path, bodyStr, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const buf = bodyStr ? Buffer.from(bodyStr) : null;
      const req = http.request({
        hostname: '127.0.0.1',
        port:     localPort,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(buf ? { 'Content-Length': buf.length } : {}),
          ...extraHeaders,
        },
        timeout: 20000,
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('local forward timeout')); });
      req.on('error', reject);
      if (buf) req.write(buf);
      req.end();
    });
  }

  // ── Send a response back through the relay ───────────────────────────────
  async function relayRespond(to, requestId, status, body) {
    await httpReq(`${base}/relay/send`, {
      method: 'POST',
      body:   { token: myToken, to, type: 'response', requestId, status, body },
    });
  }

  // ── Dispatch an incoming relayed request to the local gateway ────────────
  async function handleForwardedRequest(msg) {
    let bodyStr = msg.body || null;

    // Rewrite sourceHost in connect payloads so the local gateway stores the
    // peer's address as relay://<worldId> — enabling reverse-connect through relay.
    if (msg.path === '/worldlink/connect' && bodyStr) {
      try {
        const parsed = JSON.parse(bodyStr);
        if (parsed.sourceHost !== undefined) {
          parsed.sourceHost = `relay://${msg.from}`;
          bodyStr = JSON.stringify(parsed);
        }
      } catch {}
    }

    const extraHeaders = { 'x-via-relay': msg.from };
    if (msg.authToken) extraHeaders['Authorization'] = `Bearer ${msg.authToken}`;

    try {
      const result = await localRequest(msg.method, msg.path, bodyStr, extraHeaders);
      await relayRespond(msg.from, msg.requestId, result.status, result.body);
    } catch (e) {
      await relayRespond(msg.from, msg.requestId, 502, JSON.stringify({ error: e.message }));
    }
  }

  // ── Handle a single message from the relay ───────────────────────────────
  async function handleMessage(msg) {
    if (msg.type === 'peer_joined') {
      onPeerJoined && onPeerJoined({ worldId: msg.worldId, worldName: msg.worldName });
      return;
    }

    if (msg.type === 'peer_left') {
      return; // gateway heartbeats handle offline detection
    }

    if (msg.type === 'response') {
      const p = pending.get(msg.requestId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.requestId);
        p.resolve({ status: msg.status, body: msg.body });
      }
      return;
    }

    // It's a forwarded request — process it and send the response back
    if (msg.requestId && msg.method && msg.path) {
      handleForwardedRequest(msg).catch(() => {});
    }
  }

  // ── Long-poll loop ───────────────────────────────────────────────────────
  async function pollLoop() {
    while (!stopped) {
      if (!myToken) { await new Promise(r => setTimeout(r, 2000)); continue; }
      try {
        const res = await httpReq(`${base}/relay/poll?token=${myToken}`, { timeout: 30000 });
        if (res.error === 'Unknown token — re-register') {
          // Token was evicted — re-register
          await register().catch(() => {});
          continue;
        }
        for (const msg of (res.messages || [])) {
          handleMessage(msg).catch(() => {});
        }
      } catch {
        if (!stopped) await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  // ── Register with the relay ───────────────────────────────────────────────
  async function register() {
    const res = await httpReq(`${base}/relay/register`, {
      method: 'POST',
      body:   { worldId, worldName },
    });
    if (!res.token) throw new Error('relay register failed: ' + JSON.stringify(res));
    myToken    = res.token;
    registered = true;

    // Initial peers — try to connect to each
    for (const peer of (res.peers || [])) {
      onPeerJoined && onPeerJoined(peer);
    }

    return res;
  }

  // ── Public: make an outbound request to a remote peer via the relay ──────
  // Returns Promise<{ status: number, body: string }>
  function request(toWorldId, method, path, bodyObj, authToken) {
    return new Promise((resolve, reject) => {
      if (!myToken) { reject(new Error('Not registered with relay')); return; }
      const requestId = `rreq_${crypto.randomBytes(8).toString('hex')}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`WorldLink relay request timed out (${path})`));
      }, 20000);

      pending.set(requestId, { resolve, reject, timer });

      httpReq(`${base}/relay/send`, {
        method: 'POST',
        body: {
          token:     myToken,
          to:        toWorldId,
          requestId,
          method,
          path,
          body:      bodyObj !== undefined ? JSON.stringify(bodyObj) : null,
          authToken: authToken || null,
        },
      }).catch(e => {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(e);
      });
    });
  }

  async function start() {
    await register();
    pollLoop(); // fire-and-forget — runs until stop()
  }

  function stop() { stopped = true; }

  return { start, stop, request, getToken: () => myToken };
}

module.exports = { createRelayClient };
