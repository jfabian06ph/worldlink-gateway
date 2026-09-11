const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');

const identity = require('./identity');
const audit    = require('./audit');
const execute  = require('./execute');

const STATUS_PAGE = path.join(__dirname, 'status-page', 'index.html');

function createGateway(opts = {}) {
  const {
    port        = parseInt(process.env.PORT || '7461'),
    dataDir     = process.cwd(),
    autoApprove = false,
  } = opts;

  const IDENTITY_FILE = path.join(dataDir, '.worldlink-identity.json');
  const CONFIG_FILE   = path.join(dataDir, '.worldlink-config.json');
  audit.setFile(path.join(dataDir, '.worldlink-audit.jsonl'));

  // ── Load identity + config ─────────────────────────────────────────
  let wlId  = null;
  let wlCfg = { worldName: 'My World', capabilities: [], trustedPeers: [], localOnly: true };
  try { wlId  = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')); } catch {}
  try { wlCfg = { ...wlCfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}

  // ── In-memory state ────────────────────────────────────────────────
  const sessions   = new Map(); // token → session
  const tasks      = new Map(); // taskId → task
  const artifacts  = new Map(); // artifactId → artifact
  const peers      = new Map(); // worldId → peer

  // ── Helpers ────────────────────────────────────────────────────────
  function verifyToken(token) {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s || !s.confirmed) return null;
    if (Math.floor(Date.now() / 1000) > s.expiresAt) { sessions.delete(token); return null; }
    return s;
  }

  function broadcast(event) {
    // Lite gateway: no persistent WebSocket clients — just log
    const label = event.type || 'event';
    console.log(`  [WorldLink] ${label}`, event.taskId || event.sourceWorld || event.worldId || '');
  }

  function wlFetch(url, fetchOpts = {}) {
    return new Promise((resolve, reject) => {
      const { method = 'GET', body, token } = fetchOpts;
      const parsed   = new URL(url.startsWith('http') ? url : `http://${url}`);
      const lib      = parsed.protocol === 'https:' ? https : http;
      const postData = body ? JSON.stringify(body) : null;
      const headers  = { 'Content-Type': 'application/json', 'Content-Length': postData ? Buffer.byteLength(postData) : 0 };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method, headers,
      }, resp => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ _raw: data }); } });
      });
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  }

  async function initiateConnection(host) {
    if (!wlId) throw new Error('Not initialized. Run: worldlink-gateway init');
    const base = host.startsWith('http') ? host : `http://${host}`;

    const manifest = await wlFetch(`${base}/worldlink/manifest`);
    if (!manifest.worldId) throw new Error(`No WorldLink manifest at ${host}`);

    const connectPayload = {
      sourceWorldId: wlId.worldId,
      sourcePublicKey: wlId.publicKey,
      requestedCapabilities: manifest.capabilities?.map(c => c.id) || [],
      nonce: crypto.randomBytes(16).toString('hex'),
      timestamp: Math.floor(Date.now() / 1000),
    };
    connectPayload.signature = identity.sign(connectPayload, wlId.privateKey);
    const connectResp = await wlFetch(`${base}/worldlink/connect`, { method: 'POST', body: connectPayload });
    if (!connectResp.sessionToken) throw new Error('Connection rejected: ' + (connectResp.error || 'unknown'));

    const challengeResponse = identity.signChallenge(connectResp.challenge, wlId.privateKey);
    await wlFetch(`${base}/worldlink/confirm`, {
      method: 'POST',
      body: { sessionToken: connectResp.sessionToken, challengeResponse, sourceWorldId: wlId.worldId },
    });

    peers.set(manifest.worldId, { manifest, status: 'online', sessionToken: connectResp.sessionToken, host: base, lastSeen: Date.now() });
    audit.write({ type: 'connection.established', targetWorld: manifest.worldId, timestamp: Math.floor(Date.now() / 1000) });
    broadcast({ type: 'connection.established', worldId: manifest.worldId });
    console.log(`  [WorldLink] Connected to "${manifest.worldName}" (${manifest.worldId})`);
    return { worldId: manifest.worldId, worldName: manifest.worldName, grantedCapabilities: connectResp.grantedCapabilities };
  }

  async function executeTask(task) {
    const { taskId, capability, sourceWorld } = task;
    task.status = 'running'; tasks.set(taskId, task);
    audit.write({ type: 'task.started', taskId, sourceWorld, capability, timestamp: Math.floor(Date.now() / 1000) });
    broadcast({ type: 'task.started', taskId, sourceWorld, capability });

    try {
      const output   = await execute.runTask(task);
      const artifactId = `wla_${crypto.randomUUID()}`;
      artifacts.set(artifactId, {
        artifactId, taskId, sourceWorld, type: 'response',
        content: { format: 'markdown', body: output },
        sizeBytes: Buffer.byteLength(output, 'utf8'),
        createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
        checksum: crypto.createHash('sha256').update(output).digest('hex'),
      });
      task.status = 'completed'; task.artifactId = artifactId; task.result = output;
      tasks.set(taskId, task);
      audit.write({ type: 'task.completed', taskId, artifactId, sourceWorld, timestamp: Math.floor(Date.now() / 1000) });
      broadcast({ type: 'task.completed', taskId, artifactId, sourceWorld });
      broadcast({ type: 'artifact.ready', taskId, artifactId, sourceWorld });
      console.log(`  [WorldLink] Task ${taskId.slice(0, 12)} completed → ${artifactId.slice(0, 12)}`);
    } catch (e) {
      task.status = 'failed'; task.error = e.message; tasks.set(taskId, task);
      audit.write({ type: 'task.failed', taskId, error: e.message, timestamp: Math.floor(Date.now() / 1000) });
      broadcast({ type: 'task.failed', taskId, sourceWorld, error: e.message });
      console.error(`  [WorldLink] Task ${taskId.slice(0, 12)} failed:`, e.message);
    }
  }

  // ── HTTP server ────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
    const json = (code, obj) => { res.writeHead(code, cors); res.end(JSON.stringify(obj, null, 2)); };
    const bearer = () => (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const body = () => new Promise(resolve => {
      let b = ''; req.on('data', c => b += c);
      req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
    });

    // ── Status page ────────────────────────────────────────────────
    if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(STATUS_PAGE, 'utf8'));
      } catch { res.writeHead(404); res.end('Status page not found'); }
      return;
    }

    if (!req.url.startsWith('/worldlink')) { res.writeHead(404); res.end('Not found'); return; }

    (async () => {

      // GET /worldlink/manifest
      if (req.method === 'GET' && req.url === '/worldlink/manifest') {
        if (!wlId) { json(503, { error: 'Not initialized. Run: worldlink-gateway init' }); return; }
        json(200, {
          worldId: wlId.worldId, worldName: wlCfg.worldName,
          clientType: 'lite', protocol: 'worldlink/1.0', status: 'online',
          publicKey: wlId.publicKey,
          capabilities: (wlCfg.capabilities || [])
            .filter(c => c.visibility !== 'trusted-only')
            .map(c => ({ id: c.id, description: c.description, requiresApproval: c.requiresApproval ?? true, permissions: c.permissions || ['message','task.request','artifact.receive'] })),
          permissionsSupported: ['message','task.request','artifact.receive','artifact.send','status.read'],
          uiAvailable: false,
        });
        return;
      }

      // POST /worldlink/connect
      if (req.method === 'POST' && req.url === '/worldlink/connect') {
        const b = await body();
        const { sourceWorldId, sourcePublicKey, requestedCapabilities = [], timestamp, signature } = b;
        if (!sourceWorldId || !sourcePublicKey) { json(400, { error: 'sourceWorldId and sourcePublicKey required' }); return; }
        if (timestamp && Math.abs(Date.now() - timestamp * 1000) > 300_000) { json(400, { error: 'Request expired' }); return; }
        if (signature && !identity.verify(b, signature, sourcePublicKey)) { json(401, { error: 'Invalid signature' }); return; }

        const trusted   = (wlCfg.trustedPeers || []).find(p => p.worldId === sourceWorldId);
        const available = (wlCfg.capabilities || []).filter(c => !requestedCapabilities.length || requestedCapabilities.includes(c.id));
        if (!available.length && !trusted) { json(403, { error: 'No matching capabilities for this world' }); return; }

        const sessionToken = `wl_${crypto.randomBytes(24).toString('hex')}`;
        const expiresAt    = Math.floor(Date.now() / 1000) + 3600;
        const challenge    = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionToken, {
          worldId: sourceWorldId, publicKey: sourcePublicKey,
          grantedCapabilities: available.map(c => c.id),
          trusted: !!trusted, expiresAt, challenge, confirmed: !!trusted,
        });
        audit.write({ type: 'connection.request', sourceWorld: sourceWorldId, timestamp: Math.floor(Date.now() / 1000) });
        json(200, { sessionToken, grantedCapabilities: available.map(c => c.id), expiresAt, challenge, destinationPublicKey: wlId?.publicKey });
        return;
      }

      // POST /worldlink/confirm
      if (req.method === 'POST' && req.url === '/worldlink/confirm') {
        const b = await body();
        const { sessionToken, challengeResponse, sourceWorldId } = b;
        const s = sessions.get(sessionToken);
        if (!s || s.worldId !== sourceWorldId) { json(401, { error: 'Invalid session' }); return; }
        if (!identity.verifyChallenge(s.challenge, challengeResponse, s.publicKey)) { json(401, { error: 'Challenge failed' }); return; }
        s.confirmed = true; sessions.set(sessionToken, s);
        peers.set(sourceWorldId, { ...(peers.get(sourceWorldId) || {}), status: 'online', sessionToken, lastSeen: Date.now() });
        audit.write({ type: 'connection.established', sourceWorld: sourceWorldId, timestamp: Math.floor(Date.now() / 1000) });
        json(200, { confirmed: true, sessionToken });
        return;
      }

      // POST /worldlink/task
      if (req.method === 'POST' && req.url === '/worldlink/task') {
        const s = verifyToken(bearer());
        if (!s) { json(401, { error: 'Invalid or expired session token' }); return; }
        const b = await body();
        const { capability, task = {} } = b;
        const cap = (wlCfg.capabilities || []).find(c => c.id === capability);
        if (!cap) { json(404, { error: `Capability '${capability}' not found` }); return; }
        if (!s.grantedCapabilities?.includes(capability)) { json(403, { error: 'Capability not granted' }); return; }

        const taskId = `wlt_${crypto.randomUUID()}`;
        const needsApproval = !autoApprove && cap.requiresApproval !== false;
        const record = {
          taskId, sourceWorld: s.worldId, capability,
          prompt: task.prompt || '', sharedContext: task.sharedContext || {},
          attachments: task.attachments || [], constraints: task.constraints || {},
          status: needsApproval ? 'pending-approval' : 'queued',
          createdAt: Date.now(), result: null, artifactId: null, error: null,
        };
        tasks.set(taskId, record);
        audit.write({ type: 'task.received', taskId, sourceWorld: s.worldId, capability, timestamp: Math.floor(Date.now() / 1000) });

        if (needsApproval) {
          console.log(`\n  [WorldLink] Task approval needed:`);
          console.log(`    From     : ${s.worldId}`);
          console.log(`    Capability: ${capability}`);
          console.log(`    Prompt   : ${(task.prompt || '').slice(0, 120)}`);
          console.log(`    Approve  : curl -X POST http://localhost:${port}/worldlink/approve/${taskId}`);
          console.log(`    Deny     : curl -X POST http://localhost:${port}/worldlink/deny/${taskId}\n`);
        } else {
          setImmediate(() => executeTask(record));
        }
        json(202, { taskId, status: record.status });
        return;
      }

      // GET /worldlink/task/:id
      if (req.method === 'GET' && req.url.startsWith('/worldlink/task/')) {
        const s = verifyToken(bearer());
        if (!s) { json(401, { error: 'Unauthorized' }); return; }
        const taskId = req.url.slice('/worldlink/task/'.length);
        const t = tasks.get(taskId);
        if (!t || t.sourceWorld !== s.worldId) { json(404, { error: 'Task not found' }); return; }
        json(200, { taskId: t.taskId, status: t.status, artifactId: t.artifactId, error: t.error });
        return;
      }

      // GET /worldlink/artifact/:id
      if (req.method === 'GET' && req.url.startsWith('/worldlink/artifact/')) {
        const s = verifyToken(bearer());
        if (!s) { json(401, { error: 'Unauthorized' }); return; }
        const artifactId = req.url.slice('/worldlink/artifact/'.length);
        const a = artifacts.get(artifactId);
        if (!a) { json(404, { error: 'Artifact not found or expired' }); return; }
        if (a.sourceWorld !== s.worldId) { json(403, { error: 'Not authorized' }); return; }
        if (Date.now() > a.expiresAt) { artifacts.delete(artifactId); json(410, { error: 'Artifact expired' }); return; }
        json(200, a);
        return;
      }

      // POST /worldlink/approve/:id  (CLI or curl)
      if (req.method === 'POST' && req.url.startsWith('/worldlink/approve/')) {
        const taskId = req.url.slice('/worldlink/approve/'.length);
        const t = tasks.get(taskId);
        if (!t) { json(404, { error: 'Task not found' }); return; }
        t.status = 'queued'; tasks.set(taskId, t);
        audit.write({ type: 'task.approved', taskId, timestamp: Math.floor(Date.now() / 1000) });
        setImmediate(() => executeTask(t));
        json(200, { ok: true, taskId });
        return;
      }

      // POST /worldlink/deny/:id
      if (req.method === 'POST' && req.url.startsWith('/worldlink/deny/')) {
        const taskId = req.url.slice('/worldlink/deny/'.length);
        const t = tasks.get(taskId);
        if (!t) { json(404, { error: 'Task not found' }); return; }
        t.status = 'denied'; tasks.set(taskId, t);
        audit.write({ type: 'task.denied', taskId, timestamp: Math.floor(Date.now() / 1000) });
        json(200, { ok: true, taskId });
        return;
      }

      // GET /worldlink/peers
      if (req.method === 'GET' && req.url === '/worldlink/peers') {
        const list = [];
        for (const [worldId, p] of peers) {
          list.push({ worldId, worldName: p.manifest?.worldName || worldId, status: p.status, host: p.host, capabilities: p.manifest?.capabilities?.map(c => c.id) || [], lastSeen: p.lastSeen });
        }
        for (const cfg of (wlCfg.trustedPeers || [])) {
          if (!peers.has(cfg.worldId)) list.push({ worldId: cfg.worldId, worldName: cfg.worldId, status: 'offline', host: cfg.host, capabilities: [], lastSeen: null });
        }
        json(200, { worldId: wlId?.worldId, worldName: wlCfg.worldName, peers: list });
        return;
      }

      // GET /worldlink/audit
      if (req.method === 'GET' && req.url === '/worldlink/audit') {
        json(200, { events: audit.read(100) });
        return;
      }

      // GET /worldlink/tasks  (all tasks — for status page)
      if (req.method === 'GET' && req.url === '/worldlink/tasks') {
        const list = [...tasks.values()].slice(-50).map(t => ({
          taskId: t.taskId, sourceWorld: t.sourceWorld, capability: t.capability,
          status: t.status, prompt: (t.prompt || '').slice(0, 100),
          createdAt: t.createdAt, artifactId: t.artifactId,
        }));
        json(200, { tasks: list });
        return;
      }

      // POST /worldlink/request  — outbound task to remote world
      if (req.method === 'POST' && req.url === '/worldlink/request') {
        const b = await body();
        const { targetWorldId, capability, prompt, sharedContext, attachments, conversationId } = b;
        const peer = peers.get(targetWorldId);
        if (!peer?.sessionToken) { json(404, { error: `Not connected to: ${targetWorldId}` }); return; }
        const cfg = (wlCfg.trustedPeers || []).find(p => p.worldId === targetWorldId);
        if (!cfg?.host && !peer.host) { json(404, { error: 'No host for this peer' }); return; }
        try {
          const result = await wlFetch(`${peer.host || cfg.host}/worldlink/task`, {
            method: 'POST', token: peer.sessionToken,
            body: { capability, task: { prompt, sharedContext, attachments, conversationId } },
          });
          audit.write({ type: 'task.sent', targetWorld: targetWorldId, capability, taskId: result.taskId, timestamp: Math.floor(Date.now() / 1000) });
          json(200, result);
        } catch (e) { json(502, { error: `Could not reach ${targetWorldId}: ${e.message}` }); }
        return;
      }

      // POST /worldlink/connect-peer  — initiate outbound connection
      if (req.method === 'POST' && req.url === '/worldlink/connect-peer') {
        const b = await body();
        const { host } = b;
        if (!host) { json(400, { error: 'host required' }); return; }
        try { json(200, await initiateConnection(host)); }
        catch (e) { json(502, { error: e.message }); }
        return;
      }

      // POST /worldlink/poll-artifact  — fetch artifact from remote world
      if (req.method === 'POST' && req.url === '/worldlink/poll-artifact') {
        const b = await body();
        const { targetWorldId, artifactId } = b;
        const peer = peers.get(targetWorldId);
        if (!peer?.sessionToken) { json(404, { error: 'Not connected to that world' }); return; }
        try {
          const artifact = await wlFetch(`${peer.host}/worldlink/artifact/${artifactId}`, { token: peer.sessionToken });
          json(200, { artifact });
        } catch (e) { json(502, { error: e.message }); }
        return;
      }

      json(404, { error: 'Unknown WorldLink endpoint' });
    })().catch(e => {
      console.error('[WorldLink] Error:', e.message);
      if (!res.headersSent) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'Internal error' })); }
    });
  });

  // ── Expire artifacts every 15 min ─────────────────────────────────
  setInterval(() => {
    const now = Date.now();
    for (const [id, a] of artifacts) if (now > a.expiresAt) artifacts.delete(id);
  }, 15 * 60 * 1000);

  // ── Auto-connect to configured trusted peers ───────────────────────
  async function autoConnect() {
    if (!wlId || !wlCfg.trustedPeers?.length) return;
    for (const p of wlCfg.trustedPeers) {
      if (!p.host) continue;
      try { await initiateConnection(p.host); }
      catch (e) {
        console.log(`  [WorldLink] Could not reach ${p.host}: ${e.message}`);
        peers.set(p.worldId || p.host, { status: 'offline', host: p.host, lastSeen: null });
      }
    }
  }

  function start() {
    server.listen(port, () => {
      console.log(`\n  WorldLink Gateway`);
      console.log(`  ─────────────────────────────────────`);
      if (wlId) {
        console.log(`  World    : ${wlCfg.worldName}`);
        console.log(`  ID       : ${wlId.worldId}`);
        console.log(`  Port     : ${port}`);
        console.log(`  Status   : http://localhost:${port}/`);
        console.log(`  Manifest : http://localhost:${port}/worldlink/manifest`);
        if (autoApprove) console.log(`  Mode     : AUTO-APPROVE (testing)`);
      } else {
        console.log(`  Not initialized. Run: worldlink-gateway init`);
      }
      console.log(`  ─────────────────────────────────────\n`);
      if (wlId) setTimeout(autoConnect, 1500);
    });
    return server;
  }

  return { start, initiateConnection, peers, tasks, artifacts, sessions };
}

module.exports = { createGateway };
