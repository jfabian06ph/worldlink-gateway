const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(task, brainRecords = []) {
  const { taskId, capability, prompt, sharedContext, attachments } = task;
  let full = '';

  if (brainRecords.length) {
    full += `WORLDLINK MEMORY CONTEXT\n`;
    full += `The following records are from your world's own memory.\n`;
    full += `Use them as background knowledge when completing the task.\n\n`;
    for (const r of brainRecords) {
      full += `  [${r.type}] ${r.scope} — ${r.summary}\n`;
    }
    full += `\n`;
  }

  full += `[WorldLink — capability: ${capability}]\n\n${prompt}`;
  if (sharedContext && Object.keys(sharedContext).length > 0) {
    full += `\n\nContext from requesting world:\n${JSON.stringify(sharedContext, null, 2)}`;
  }

  const tmpFiles = [];
  for (const att of attachments || []) {
    if (att.data) {
      const tmp = path.join(os.tmpdir(), `wl-${taskId}-${att.filename || 'attachment'}`);
      fs.writeFileSync(tmp, Buffer.from(att.data, 'base64'));
      tmpFiles.push(tmp);
      full += `\n\n[Attachment saved at: ${tmp}]`;
    }
  }

  return { fullPrompt: full, tmpFiles };
}

// ── Backend runners ───────────────────────────────────────────────────────────

function runClaude(fullPrompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', fullPrompt, '--dangerously-skip-permissions'], {
      env: { ...process.env },
      cwd: process.cwd(),
    });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`))
    );
    proc.on('error', e => reject(new Error(`Could not spawn claude: ${e.message}`)));
    setTimeout(() => { proc.kill(); reject(new Error('Task timed out (5 min)')); }, 300_000);
  });
}

function runOllama(fullPrompt, cfg) {
  const model  = cfg.model  || 'llama3.2';
  const host   = cfg.host   || 'http://localhost:11434';
  const url    = new URL('/api/generate', host);
  const body   = JSON.stringify({ model, prompt: fullPrompt, stream: false });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(`Ollama error: ${json.error}`));
          resolve((json.response || '').trim());
        } catch (e) {
          reject(new Error(`Ollama bad response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', e => reject(new Error(`Cannot reach Ollama at ${host}: ${e.message}`)));
    req.setTimeout(300_000, () => { req.destroy(); reject(new Error('Ollama timed out (5 min)')); });
    req.write(body);
    req.end();
  });
}

function runOpenAI(fullPrompt, cfg) {
  const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI backend requires apiKey in config or OPENAI_API_KEY env var');
  const model = cfg.model || 'gpt-4o';
  const body  = JSON.stringify({
    model,
    messages: [{ role: 'user', content: fullPrompt }],
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path:     '/v1/chat/completions',
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const https = require('https');
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(`OpenAI error: ${json.error.message}`));
          resolve((json.choices?.[0]?.message?.content || '').trim());
        } catch (e) {
          reject(new Error(`OpenAI bad response: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', e => reject(new Error(`OpenAI request failed: ${e.message}`)));
    req.setTimeout(300_000, () => { req.destroy(); reject(new Error('OpenAI timed out (5 min)')); });
    req.write(body);
    req.end();
  });
}

// ── Claude stream-json — multimodal via stdin (no API key needed) ────────────

function runClaudeStreamJSON(textPrompt, imageAtts) {
  return new Promise((resolve, reject) => {
    const content = [];
    for (const att of imageAtts) {
      if (att.mimeType && att.mimeType.startsWith('image/') && att.data) {
        content.push({ type: 'image', source: { type: 'base64', media_type: att.mimeType, data: att.data } });
      }
    }
    content.push({ type: 'text', text: textPrompt });
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content } });
    const proc = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'], {
      env: { ...process.env }, cwd: process.cwd(),
    });
    let result = null, err = '';
    proc.stdout.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        try { const ev = JSON.parse(line); if (ev.type === 'result' && ev.subtype === 'success') result = ev.result || ''; } catch {}
      }
    });
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => result !== null ? resolve(result.trim()) : reject(new Error(`claude stream-json exited ${code}: ${err.slice(0, 200)}`)));
    proc.on('error', e => reject(new Error(`Could not spawn claude: ${e.message}`)));
    proc.stdin.write(msg + '\n');
    proc.stdin.end();
    setTimeout(() => { proc.kill(); reject(new Error('Task timed out (5 min)')); }, 300_000);
  });
}

// ── Main entry ────────────────────────────────────────────────────────────────

async function runTask(task, brainRecords = [], aiBackend = { type: 'claude' }) {
  const { type = 'claude' } = aiBackend;

  if (type === 'none') {
    throw new Error('This world has no AI backend configured. Task execution is disabled.');
  }

  // Image attachments need the API (CLI can't see images)
  const imageAtts = (task.attachments || []).filter(a => a.mimeType?.startsWith('image/') && a.data);
  if (imageAtts.length > 0 && type === 'claude') {
    const { fullPrompt, tmpFiles } = buildPrompt({ ...task, attachments: [] }, brainRecords);
    try { return await runClaudeStreamJSON(fullPrompt, imageAtts); }
    finally { for (const f of tmpFiles) try { fs.unlinkSync(f); } catch {} }
  }

  const { fullPrompt, tmpFiles } = buildPrompt(task, brainRecords);

  try {
    switch (type) {
      case 'claude':  return await runClaude(fullPrompt);
      case 'ollama':  return await runOllama(fullPrompt, aiBackend);
      case 'openai':  return await runOpenAI(fullPrompt, aiBackend);
      default: throw new Error(`Unknown aiBackend type: "${type}". Supported: claude, ollama, openai, none`);
    }
  } finally {
    for (const f of tmpFiles) try { fs.unlinkSync(f); } catch {}
  }
}

// Returns true if the given backend config can execute AI tasks
function canExecuteTasks(aiBackend = { type: 'claude' }) {
  return (aiBackend?.type || 'claude') !== 'none';
}

module.exports = { runTask, canExecuteTasks };
