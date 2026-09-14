'use strict';
// WorldLink Relay Server
// A pure-HTTP long-poll message broker. Lets gateways behind NAT reach each other
// by connecting outbound to a shared relay. Zero external dependencies.

const http   = require('http');
const crypto = require('crypto');

const POLL_TIMEOUT_MS = 25000; // hold long-poll up to 25s before returning empty
const PEER_TTL_MS     = 60000; // remove peers not seen for 60s

function createRelayServer(port = 9000) {
  // token → { worldId, worldName, token, queue:[], waiters:[], lastSeen }
  const peers = new Map();
  // worldId → token  (lookup index)
  const index = new Map();

  function byToken(token)   { return peers.get(token) || null; }
  function byWorldId(wid)   { const t = index.get(wid); return t ? peers.get(t) : null; }

  // Deliver a message to a peer. If they're long-polling, flush immediately.
  function deliver(toWorldId, msg) {
    const peer = byWorldId(toWorldId);
    if (!peer) return false;
    peer.lastSeen = Date.now();
    if (peer.waiters.length) {
      const w = peer.waiters.shift();
      clearTimeout(w.timer);
      w.res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      w.res.end(JSON.stringify({ messages: [msg] }));
    } else {
      peer.queue.push(msg);
    }
    return true;
  }

  // Notify all connected peers (except sender) of an event
  function broadcast(except, msg) {
    for (const [, p] of peers) {
      if (p.worldId !== except) deliver(p.worldId, msg);
    }
  }

  // Periodic cleanup of stale peers
  setInterval(() => {
    const now = Date.now();
    for (const [token, peer] of peers) {
      if (now - peer.lastSeen > PEER_TTL_MS && !peer.waiters.length) {
        peers.delete(token);
        index.delete(peer.worldId);
        broadcast(peer.worldId, { type: 'peer_left', worldId: peer.worldId });
        console.log(`[relay] − ${peer.worldName} (expired)`);
      }
    }
  }, 15000);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    function json(status, obj) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(obj));
    }

    function parseBody() {
      return new Promise(resolve => {
        let d = '';
        req.on('data', c => d += c);
        req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      });
    }

    if (req.method === 'OPTIONS') { json(200, {}); return; }

    // ── GET /relay/health ────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/relay/health') {
      json(200, { ok: true, peers: peers.size });
      return;
    }

    // ── GET /relay/peers ─────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/relay/peers') {
      json(200, { peers: [...peers.values()].map(p => ({ worldId: p.worldId, worldName: p.worldName })) });
      return;
    }

    // ── POST /relay/register  { worldId, worldName } ─────────────────
    if (req.method === 'POST' && url.pathname === '/relay/register') {
      parseBody().then(b => {
        const { worldId, worldName } = b;
        if (!worldId) { json(400, { error: 'worldId required' }); return; }

        // Reuse existing token for the same worldId (handles gateway restarts)
        const existing = byWorldId(worldId);
        const token    = existing ? existing.token : `rlt_${crypto.randomBytes(20).toString('hex')}`;
        const peer     = { worldId, worldName: worldName || worldId, token, queue: existing?.queue || [], waiters: [], lastSeen: Date.now() };
        peers.set(token, peer);
        index.set(worldId, token);

        console.log(`[relay] + ${peer.worldName} (${worldId.slice(0, 16)}…)`);

        // Tell the new peer about everyone else
        const others = [...peers.values()].filter(p => p.worldId !== worldId).map(p => ({ worldId: p.worldId, worldName: p.worldName }));
        // Tell everyone else about the new peer
        broadcast(worldId, { type: 'peer_joined', worldId, worldName: peer.worldName });

        json(200, { ok: true, token, peers: others });
      });
      return;
    }

    // ── GET /relay/poll?token=xxx  (long-poll) ───────────────────────
    if (req.method === 'GET' && url.pathname === '/relay/poll') {
      const peer = byToken(url.searchParams.get('token'));
      if (!peer) { json(401, { error: 'Unknown token — re-register' }); return; }
      peer.lastSeen = Date.now();

      if (peer.queue.length) {
        const messages = peer.queue.splice(0, 20);
        json(200, { messages });
        return;
      }

      // Block until a message arrives or timeout
      const timer = setTimeout(() => {
        const idx = peer.waiters.findIndex(w => w.timer === timer);
        if (idx !== -1) peer.waiters.splice(idx, 1);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ messages: [] }));
      }, POLL_TIMEOUT_MS);

      peer.waiters.push({ res, timer });
      return;
    }

    // ── POST /relay/send  { token, to, ...msg } ──────────────────────
    if (req.method === 'POST' && url.pathname === '/relay/send') {
      parseBody().then(b => {
        const { token, to, ...msg } = b;
        const sender = byToken(token);
        if (!sender) { json(401, { error: 'Unknown token' }); return; }
        sender.lastSeen = Date.now();
        const ok = deliver(to, { ...msg, from: sender.worldId });
        json(200, { ok });
      });
      return;
    }

    json(404, { error: 'Not found' });
  });

  function start() {
    server.listen(port, '0.0.0.0', () => {
      console.log(`\n  WorldLink Relay`);
      console.log(`  ─────────────────────────────────────`);
      console.log(`  Port     : ${port}`);
      console.log(`  Health   : http://localhost:${port}/relay/health`);
      console.log(`  Peers    : http://localhost:${port}/relay/peers`);
      console.log(`  ─────────────────────────────────────`);
      console.log(`  Share this with your pod (use public IP):`);
      console.log(`  http://<your-public-ip>:${port}`);
      console.log(`  ─────────────────────────────────────\n`);
    });
    return server;
  }

  return { start };
}

module.exports = { createRelayServer };
