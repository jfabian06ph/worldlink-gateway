#!/usr/bin/env node
'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const readline = require('readline');
const http    = require('http');

const DATA_DIR       = process.cwd();
const IDENTITY_FILE  = path.join(DATA_DIR, '.worldlink-identity.json');
const CONFIG_FILE    = path.join(DATA_DIR, '.worldlink-config.json');

const [,, cmd, ...args] = process.argv;

function ask(rl, q) { return new Promise(res => rl.question(q, res)); }

function apiCall(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const headers  = { 'Content-Type': 'application/json' };
    if (postData) headers['Content-Length'] = Buffer.byteLength(postData);
    const port     = parseInt(process.env.WL_PORT || '7461');
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function cmdInit() {
  if (fs.existsSync(IDENTITY_FILE)) {
    console.log('Already initialized. Delete .worldlink-identity.json to re-init.');
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const name = (await ask(rl, 'World name [My World]: ')) || 'My World';
  const capsRaw = await ask(rl, 'Capabilities (comma-separated) [claude-task]: ');
  const autoApprove = (await ask(rl, 'Auto-approve tasks for testing? (y/N): ')).toLowerCase() === 'y';
  rl.close();

  const caps = (capsRaw || 'claude-task').split(',').map(c => c.trim()).filter(Boolean).map(c => ({
    id: c, description: `Execute ${c} tasks`, requiresApproval: !autoApprove,
  }));

  const { privateKey, publicKey } = require('crypto').generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const worldId = `wld_${crypto.randomBytes(12).toString('hex')}`;
  const identity = { worldId, publicKey, privateKey, createdAt: Date.now() };
  const config   = { worldName: name, capabilities: caps, trustedPeers: [], localOnly: true };

  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 });
  fs.writeFileSync(CONFIG_FILE,   JSON.stringify(config,   null, 2));

  console.log(`\n  WorldLink initialized!`);
  console.log(`  World    : ${name}`);
  console.log(`  ID       : ${worldId}`);
  console.log(`  Caps     : ${caps.map(c => c.id).join(', ')}`);
  console.log(`\n  Start with: worldlink-gateway start\n`);
}

async function cmdStart() {
  const port       = parseInt(process.env.WL_PORT || args[0] || '7461');
  const autoApprove = args.includes('--auto-approve') || args.includes('-y');
  const { createGateway } = require('../src/gateway');
  createGateway({ port, dataDir: DATA_DIR, autoApprove }).start();
}

async function cmdConnect() {
  const host = args[0];
  if (!host) { console.error('Usage: worldlink-gateway connect <host>'); process.exit(1); }
  try {
    const result = await apiCall('POST', '/worldlink/connect-peer', { host });
    if (result.error) { console.error('Error:', result.error); process.exit(1); }
    console.log(`Connected: ${result.worldName} (${result.worldId})`);
    console.log(`Capabilities: ${result.grantedCapabilities?.join(', ') || 'none'}`);
  } catch (e) {
    console.error('Could not reach gateway on port', process.env.WL_PORT || '7461');
    console.error(e.message);
  }
}

async function cmdStatus() {
  try {
    const result = await apiCall('GET', '/worldlink/peers');
    if (result.error) { console.error('Error:', result.error); process.exit(1); }
    console.log(`\n  ${result.worldName || 'World'} (${result.worldId || 'uninitialized'})`);
    const peers = result.peers || [];
    if (!peers.length) { console.log('  No peers connected.\n'); return; }
    console.log(`\n  Peers:`);
    for (const p of peers) {
      const since = p.lastSeen ? new Date(p.lastSeen).toLocaleTimeString() : 'never';
      console.log(`  ${p.status === 'online' ? '●' : '○'} ${p.worldName || p.worldId}  [${p.status}]  ${p.host || ''}  last: ${since}`);
    }
    console.log();
  } catch (e) {
    console.error('Could not reach gateway:', e.message);
  }
}

async function cmdRequest() {
  // worldlink-gateway request <worldId> <capability> "<prompt>"
  const [targetWorldId, capability, ...promptParts] = args;
  if (!targetWorldId || !capability) {
    console.error('Usage: worldlink-gateway request <worldId> <capability> "<prompt>"');
    process.exit(1);
  }
  const prompt = promptParts.join(' ');
  try {
    const result = await apiCall('POST', '/worldlink/request', { targetWorldId, capability, prompt, sharedContext: {} });
    if (result.error) { console.error('Error:', result.error); process.exit(1); }
    console.log(`Task submitted: ${result.taskId}`);
    console.log(`Status: ${result.status}`);
    if (result.status === 'pending-approval') {
      console.log(`\nWaiting for approval at the remote world. Poll with:`);
      console.log(`  worldlink-gateway poll ${targetWorldId} ${result.taskId}`);
    }
  } catch (e) {
    console.error('Could not reach gateway:', e.message);
  }
}

async function cmdApprove() {
  const [taskId] = args;
  if (!taskId) { console.error('Usage: worldlink-gateway approve <taskId>'); process.exit(1); }
  try {
    const result = await apiCall('POST', `/worldlink/approve/${taskId}`);
    if (result.error) { console.error('Error:', result.error); }
    else console.log(`Task ${taskId} approved.`);
  } catch (e) { console.error('Error:', e.message); }
}

async function cmdDeny() {
  const [taskId] = args;
  if (!taskId) { console.error('Usage: worldlink-gateway deny <taskId>'); process.exit(1); }
  try {
    const result = await apiCall('POST', `/worldlink/deny/${taskId}`);
    if (result.error) { console.error('Error:', result.error); }
    else console.log(`Task ${taskId} denied.`);
  } catch (e) { console.error('Error:', e.message); }
}

async function cmdBrain() {
  const sub = args[0];

  if (sub === 'add') {
    // worldlink-gateway brain add "summary" [--type X] [--scope X] [--importance 0.9] [--visibility pod]
    const summaryArg = args.find(a => !a.startsWith('--') && a !== 'add');
    if (!summaryArg) {
      console.error('Usage: worldlink-gateway brain add "<summary>" [--type decision|constraint|goal|context|fact] [--scope project:X] [--importance 0.5] [--visibility pod|self]');
      process.exit(1);
    }
    const flag = (name, def) => {
      const i = args.indexOf(`--${name}`);
      return i !== -1 ? args[i + 1] : def;
    };
    const payload = {
      summary:    summaryArg,
      type:       flag('type', 'fact'),
      scope:      flag('scope', 'global'),
      importance: parseFloat(flag('importance', '0.5')),
      visibility: [flag('visibility', 'self')],
      source:     'manual',
    };
    try {
      const result = await apiCall('POST', '/worldlink/brain', payload);
      if (result.error) { console.error('Error:', result.error); process.exit(1); }
      console.log(`\n  Memory saved`);
      console.log(`  ID         : ${result.id}`);
      console.log(`  Type       : ${result.type}`);
      console.log(`  Scope      : ${result.scope}`);
      console.log(`  Importance : ${result.importance}`);
      console.log(`  Visibility : ${result.visibility?.join(', ')}`);
      console.log(`  Summary    : ${result.summary}\n`);
    } catch (e) { console.error('Could not reach gateway:', e.message); }
    return;
  }

  if (sub === 'list') {
    const flag = (name) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : undefined; };
    const scope = flag('scope');
    const type  = flag('type');
    const qs    = new URLSearchParams();
    if (scope) qs.set('scope', scope);
    if (type)  qs.set('type', type);
    try {
      const result = await apiCall('GET', `/worldlink/brain?${qs}`);
      if (result.error) { console.error('Error:', result.error); process.exit(1); }
      const records = result.records || [];
      if (!records.length) { console.log('\n  No memory records.\n'); return; }
      console.log(`\n  WorldLink Memory (${records.length} records)\n`);
      for (const r of records) {
        const vis = r.visibility?.join(',') || 'self';
        console.log(`  ${r.id}  [${r.type}]  scope:${r.scope}  importance:${r.importance}  vis:${vis}`);
        console.log(`    ${r.summary}`);
        console.log(`    created: ${r.createdAt}  source: ${r.source}`);
        console.log();
      }
    } catch (e) { console.error('Could not reach gateway:', e.message); }
    return;
  }

  if (sub === 'remove') {
    const id = args[1];
    if (!id) { console.error('Usage: worldlink-gateway brain remove <id>'); process.exit(1); }
    try {
      const result = await apiCall('DELETE', `/worldlink/brain/${id}`);
      if (result.error) { console.error('Error:', result.error); process.exit(1); }
      console.log(`Removed: ${result.deleted}`);
    } catch (e) { console.error('Could not reach gateway:', e.message); }
    return;
  }

  if (sub === 'share' || sub === 'unshare') {
    const [, id, peerRef] = args;
    if (!id || !peerRef) {
      console.error(`Usage: worldlink-gateway brain ${sub} <id> <worldId-or-worldName>`);
      process.exit(1);
    }
    try {
      // Resolve peer name → worldId
      const peersRes = await apiCall('GET', '/worldlink/peers');
      const peers = peersRes.peers || [];
      const peer  = peers.find(p => p.worldId === peerRef || (p.worldName || '').toLowerCase() === peerRef.toLowerCase());
      if (!peer) {
        console.error(`No connected peer matching "${peerRef}". Run: worldlink-gateway status`);
        process.exit(1);
      }

      // Fetch current record
      const record = await apiCall('GET', `/worldlink/brain/${id}`);
      if (record.error) { console.error('Error:', record.error); process.exit(1); }

      const current = record.sharedWith || [];
      let next;
      if (sub === 'share') {
        next = current.includes(peer.worldId) ? current : [...current, peer.worldId];
      } else {
        next = current.filter(w => w !== peer.worldId);
      }

      const updated = await apiCall('PATCH', `/worldlink/brain/${id}`, { sharedWith: next });
      if (updated.error) { console.error('Error:', updated.error); process.exit(1); }
      const action = sub === 'share' ? 'Shared with' : 'Unshared from';
      console.log(`${action} ${peer.worldName || peer.worldId} (${peer.worldId})`);
      console.log(`sharedWith: ${updated.sharedWith?.join(', ') || '(none)'}`);
    } catch (e) { console.error('Could not reach gateway:', e.message); }
    return;
  }

  console.error(`
  worldlink-gateway brain — WorldLink Memory

  Subcommands:
    brain add "<summary>"           Add a memory record
      --type    decision|constraint|goal|context|fact  (default: fact)
      --scope   global|project:X|sprint:X              (default: global)
      --importance  0.0–1.0                            (default: 0.5)
      --visibility  self|pod                           (default: self)

    brain list                      List all memory records
      --scope   filter by scope
      --type    filter by type

    brain remove <id>               Delete a memory record
    brain share <id> <peer>         Share a record with a connected peer
    brain unshare <id> <peer>       Revoke sharing from a peer

  Examples:
    worldlink-gateway brain add "Use REST v2 for all new endpoints" --type decision --scope project:my-app --importance 0.9
    worldlink-gateway brain add "Node.js minimum version is 18+" --type constraint --scope global
    worldlink-gateway brain list --scope project:my-app
    worldlink-gateway brain remove mem_abc123
    worldlink-gateway brain share mem_abc123 karlo-android
    worldlink-gateway brain unshare mem_abc123 karlo-android
`);
}

async function cmdHelp() {
  console.log(`
  worldlink-gateway — WorldLink standalone gateway

  Commands:
    init                Initialize this world (generates keypair, writes config)
    start [port]        Start the gateway server (default port: 7461)
      --auto-approve    Auto-approve all incoming tasks (for testing)
    connect <host>      Connect to another world (e.g. http://localhost:7462)
    status              Show connected peers
    request <worldId> <cap> "<prompt>"  Send a task to a peer
    approve <taskId>    Approve a pending-approval task (local)
    deny <taskId>       Deny a pending-approval task (local)
    brain <sub>         Manage WorldLink Memory (add / list / remove)
    help                Show this help

  Environment:
    WL_PORT             Gateway port to connect to for commands (default: 7461)

  Example (fake Karlo test on port 7462):
    # Terminal 1 — start "Joseph" gateway on 7461
    mkdir ~/wl-joseph && cd ~/wl-joseph
    worldlink-gateway init
    worldlink-gateway start 7461

    # Terminal 2 — start "Karlo" gateway on 7462
    mkdir ~/wl-karlo && cd ~/wl-karlo
    worldlink-gateway init
    worldlink-gateway start 7462 --auto-approve

    # Terminal 3 — connect and send a task
    cd ~/wl-joseph
    worldlink-gateway connect http://localhost:7462
    worldlink-gateway request <karloWorldId> claude-task "List 3 benefits of TypeScript"
`);
}

const commands = {
  init:    cmdInit,
  start:   cmdStart,
  connect: cmdConnect,
  status:  cmdStatus,
  request: cmdRequest,
  approve: cmdApprove,
  deny:    cmdDeny,
  brain:   cmdBrain,
  help:    cmdHelp,
};

const fn = commands[cmd];
if (!fn) {
  if (cmd) console.error(`Unknown command: ${cmd}\n`);
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}

fn().catch(e => { console.error(e.message); process.exit(1); });
