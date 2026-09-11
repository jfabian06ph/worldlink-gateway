const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

async function runTask(task, brainRecords = []) {
  const { taskId, capability, prompt, sharedContext, attachments } = task;

  let fullPrompt = '';

  // Inject own brain context — keyword-matched records relevant to this task
  if (brainRecords.length) {
    fullPrompt += `WORLDLINK MEMORY CONTEXT\n`;
    fullPrompt += `The following records are from your world's own memory.\n`;
    fullPrompt += `Use them as background knowledge when completing the task.\n\n`;
    for (const r of brainRecords) {
      fullPrompt += `  [${r.type}] ${r.scope} — ${r.summary}\n`;
    }
    fullPrompt += `\n`;
  }

  fullPrompt += `[WorldLink — capability: ${capability}]\n\n${prompt}`;
  if (sharedContext && Object.keys(sharedContext).length > 0) {
    fullPrompt += `\n\nContext from requesting world:\n${JSON.stringify(sharedContext, null, 2)}`;
  }

  // Save image/binary attachments to temp files
  const tmpFiles = [];
  for (const att of attachments || []) {
    if (att.data) {
      const tmp = path.join(os.tmpdir(), `wl-${taskId}-${att.filename || 'attachment'}`);
      fs.writeFileSync(tmp, Buffer.from(att.data, 'base64'));
      tmpFiles.push(tmp);
      fullPrompt += `\n\n[Attachment saved at: ${tmp}]`;
    }
  }

  try {
    const output = await new Promise((resolve, reject) => {
      const proc = spawn('claude', ['-p', fullPrompt], {
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
      // 5 minute timeout
      setTimeout(() => { proc.kill(); reject(new Error('Task timed out (5 min)')); }, 300_000);
    });
    return output;
  } finally {
    for (const f of tmpFiles) try { fs.unlinkSync(f); } catch {}
  }
}

module.exports = { runTask };
