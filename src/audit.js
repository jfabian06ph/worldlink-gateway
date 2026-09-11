const fs = require('fs');

let _file = '.worldlink-audit.jsonl';

function setFile(f) { _file = f; }

function write(event) {
  try { fs.appendFileSync(_file, JSON.stringify({ ...event, _ts: Date.now() }) + '\n'); } catch {}
}

function read(n = 100) {
  try {
    return fs.readFileSync(_file, 'utf8').trim().split('\n')
      .filter(Boolean).slice(-n)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

module.exports = { setFile, write, read };
