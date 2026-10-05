'use strict';
// Account-wide local concurrency, including separate extension hosts/projects.
// A slot is permission to dispatch, never an extra spending allowance.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const MAX_ACTIVE = 2;
function cancelled() { return Object.assign(new Error('Cancelled while waiting for the provider.'), { code: 'INVESTIGATION_SUPERSEDED' }); }
function localDirectory(directory) {
  const root = directory || path.join(os.tmpdir(), `flowboard-provider-${process.getuid?.() ?? crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12)}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink() || process.getuid && fs.statSync(root).uid !== process.getuid()) throw new Error('Unsafe local provider slot directory.');
  return root;
}
function removeOwned(file, owner) { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).owner === owner) fs.unlinkSync(file); } catch { /* Already released. */ } }
function liveEntry(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(entry.pid) || entry.pid < 1 || typeof entry.owner !== 'string') return null;
    try { process.kill(entry.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { removeOwned(file, entry.owner); return null; } }
    return entry;
  } catch { return null; /* A just-created entry may not have finished writing. */ }
}
function wait(signal, ms) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
// Ordinary production waits are cancellable, not a paid request and not a
// 60-second terminal failure. The active request itself has a finite deadline.
// An explicit timeout is useful for callers with a different lifetime; it is a
// retryable capacity outcome, never an exhausted allowance or missing evidence.
async function acquire(provider, signal, { timeoutMs = 0, directory, onProgress, pollMs = 100 } = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('Unknown review provider.');
  if (signal?.aborted) throw cancelled();
  const root = localDirectory(directory), owner = crypto.randomUUID(), start = Date.now(), queuedAt = new Date(start).toISOString();
  const waiter = path.join(root, `${provider}-wait-${String(start).padStart(16, '0')}-${process.hrtime.bigint().toString().padStart(24, '0')}-${owner}.json`);
  fs.writeFileSync(waiter, JSON.stringify({ owner, pid: process.pid, startedAt: start }), { flag: 'wx', mode: 0o600 });
  let lastPosition = null;
  const notify = data => { try { onProgress?.(data); } catch { /* A status observer cannot strand a slot. */ } };
  try {
    while (!timeoutMs || Date.now() - start < timeoutMs) {
      if (signal?.aborted) throw cancelled();
      const queue = fs.readdirSync(root).filter(name => name.startsWith(`${provider}-wait-`) && name.endsWith('.json')).sort()
        .filter(name => liveEntry(path.join(root, name)));
      const position = queue.indexOf(path.basename(waiter));
      let activeSlots = 0;
      for (let i = 0; i < MAX_ACTIVE; i++) if (liveEntry(path.join(root, `${provider}-${i}.json`))) activeSlots++;
      // Only the queue head acquires. On success it removes its ticket, allowing
      // the next waiter to use a second free slot on its next short poll.
      if (position === 0) for (let i = 0; i < MAX_ACTIVE; i++) {
        const file = path.join(root, `${provider}-${i}.json`);
        try {
          const descriptor = fs.openSync(file, 'wx', 0o600);
          try { fs.writeFileSync(descriptor, JSON.stringify({ owner, pid: process.pid, startedAt: Date.now() })); }
          finally { fs.closeSync(descriptor); }
          const acquiredAt = new Date().toISOString(), waitMs = Date.now() - start;
          const release = () => removeOwned(file, owner);
          release.capacity = { queuedAt, acquiredAt, waitMs, limit: MAX_ACTIVE };
          notify({ stage: 'provider-capacity', event: 'provider.capacity.acquired', at: acquiredAt, provider, waitMs, queuedAt, activeSlots: activeSlots + 1, limit: MAX_ACTIVE });
          return release;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (position !== lastPosition) {
        lastPosition = position;
        notify({ stage: 'waiting-for-provider-capacity', event: 'provider.capacity.waiting', at: new Date().toISOString(), provider,
          queuedAt, waitMs: Date.now() - start, queuePosition: position + 1, activeSlots, limit: MAX_ACTIVE });
      }
      await wait(signal, Math.max(5, Math.min(1000, pollMs)));
    }
    throw Object.assign(new Error('Waiting for a free provider slot. No request has been reserved; preparation can continue when capacity is free.'),
      { code: 'PROVIDER_CAPACITY', retryable: true, waitMs: Date.now() - start });
  } finally {
    removeOwned(waiter, owner);
  }
}
module.exports = { acquire, MAX_ACTIVE, localDirectory };
