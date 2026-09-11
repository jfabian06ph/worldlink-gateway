'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

function createBrainStore(dataDir) {
  const file = path.join(dataDir, '.worldlink-brain.jsonl');

  function load() {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  function save(records) {
    const out = records.map(r => JSON.stringify(r)).join('\n');
    fs.writeFileSync(file, out + (records.length ? '\n' : ''));
  }

  function add({ type = 'fact', summary, scope = 'global', importance = 0.5, source = 'manual', visibility = ['self'], sharedWith = [] }) {
    if (!summary) throw new Error('summary is required');
    const records = load();
    const record = {
      id:         'mem_' + crypto.randomBytes(6).toString('hex'),
      type,       // decision | constraint | goal | context | fact
      summary,
      scope,      // global | project:X | sprint:X
      importance, // 0.0–1.0
      source,     // manual | session-harvest
      visibility, // ['self'] | ['pod'] — who can query this
      sharedWith, // explicit worldIds that may read this record
      createdAt:  new Date().toISOString(),
      expiresAt:  null,
    };
    records.push(record);
    save(records);
    return record;
  }

  function list({ scope, type } = {}) {
    let records = load();
    if (scope) records = records.filter(r => r.scope === scope);
    if (type)  records = records.filter(r => r.type  === type);
    return records;
  }

  function get(id) {
    return load().find(r => r.id === id) || null;
  }

  function remove(id) {
    const records = load();
    const next = records.filter(r => r.id !== id);
    if (next.length === records.length) return false;
    save(next);
    return true;
  }

  function update(id, fields) {
    const records = load();
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return null;
    const allowed = ['type', 'summary', 'scope', 'importance', 'visibility', 'sharedWith', 'expiresAt'];
    for (const k of allowed) if (k in fields) records[idx][k] = fields[k];
    save(records);
    return records[idx];
  }

  // Records visible to a specific peer — used for GET /worldlink/brain/query
  function queryForPeer(worldId, { scope, query } = {}) {
    const records = load().filter(r => {
      if (r.sharedWith?.includes(worldId)) return true;
      if (r.visibility?.includes('pod')) return true;
      return false;
    });
    const scoped = scope ? records.filter(r => r.scope === scope) : records;
    if (!query) return scoped;
    const terms = query.toLowerCase().split(/\s+/);
    return scoped.filter(r => terms.some(t =>
      r.summary.toLowerCase().includes(t) || r.scope.toLowerCase().includes(t)
    ));
  }

  // Own brain records relevant to a task prompt — injected before claude runs
  function querySelf(text = '') {
    const all = load();
    if (!text) return all.slice(0, 8); // cap at 8 if no query
    const terms = text.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    if (!terms.length) return all.slice(0, 8);
    return all
      .map(r => {
        const hay = (r.summary + ' ' + r.scope).toLowerCase();
        const hits = terms.filter(t => hay.includes(t)).length;
        return { r, hits };
      })
      .filter(x => x.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.r.importance - a.r.importance)
      .slice(0, 8)
      .map(x => x.r);
  }

  return { add, list, get, remove, update, queryForPeer, querySelf };
}

module.exports = { createBrainStore };
