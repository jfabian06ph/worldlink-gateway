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
  help:    cmdHelp,
};

const fn = commands[cmd];
if (!fn) {
  if (cmd) console.error(`Unknown command: ${cmd}\n`);
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}

fn().catch(e => { console.error(e.message); process.exit(1); });
