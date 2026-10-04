'use strict';
// Account-wide local concurrency, including separate extension hosts/projects.
// A slot is permission to dispatch, never an extra spending allowance.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const MAX_ACTIVE = 2;
function cancelled() { return Object.assign(new Error('Cancelled while waiting for the provider.'), { code: 'INVESTIGATION_SUPERSEDED' }); }
async function acquire(provider, signal, { timeoutMs = 60000, directory } = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('Unknown review provider.');
  const root = directory || path.join(os.tmpdir(), `flowboard-provider-${process.getuid?.() ?? crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12)}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink() || process.getuid && fs.statSync(root).uid !== process.getuid()) throw new Error('Unsafe local provider slot directory.');
  const owner = crypto.randomUUID(), start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) throw cancelled();
    for (let i = 0; i < MAX_ACTIVE; i++) {
      const file = path.join(root, `${provider}-${i}.json`);
      try {
        const descriptor = fs.openSync(file, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ owner, pid: process.pid, startedAt: Date.now() })); fs.closeSync(descriptor);
        return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).owner === owner) fs.unlinkSync(file); } catch { /* already released */ } };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
          try { process.kill(entry.pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') fs.unlinkSync(file); }
        } catch { /* A just-created slot may not have finished writing. */ }
      }
    }
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(cancelled()); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 100);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  throw Object.assign(new Error('The two local provider slots are busy. This finding is paused; no request was reserved. Resume when the other work finishes.'), { code: 'PROVIDER_CAPACITY' });
}
module.exports = { acquire, MAX_ACTIVE };
