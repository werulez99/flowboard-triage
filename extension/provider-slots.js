'use strict';
// Account-wide local concurrency, including separate extension hosts/projects.
// A slot is permission to dispatch, never an extra spending allowance.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const ownership = require('./provider-ownership');
const MAX_ACTIVE = 2;
function cancelled() { return Object.assign(new Error('Cancelled while waiting for the provider.'), { code: 'INVESTIGATION_SUPERSEDED' }); }
function localDirectory(directory) {
  const root = directory || path.join(os.tmpdir(), `flowboard-provider-${process.getuid?.() ?? crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12)}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink() || process.getuid && fs.statSync(root).uid !== process.getuid()) throw new Error('Unsafe local provider slot directory.');
  return root;
}
function liveEntry(file) {
  const observed = ownership.inspect(file);
  if (observed?.entry?.quarantine || observed?.state === 'dead' && observed.entry?.dispatching) {
    const details = observed.entry.quarantine || observed.entry.providerProcess;
    const state = require('./provider-process').processGroup(details);
    if (!details?.unverifiedDescendants && state.confirmed && ownership.removeObserved(file, observed)) return null;
    throw Object.assign(new Error('A previous provider process has not been confirmed stopped. Its capacity is quarantined; check that process before retrying. No new request was reserved.'),
      { code: 'PROVIDER_TEARDOWN_UNCONFIRMED', quarantine: details || { reason: 'The owner stopped during dispatch before recording its process identity.' } });
  }
  return ownership.reap(file, observed)?.entry || null;
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
  const root = localDirectory(directory), metadata = ownership.ownerMetadata(), owner = metadata.owner, start = Date.now(), queuedAt = new Date(start).toISOString();
  const waiter = path.join(root, `${provider}-wait-${String(start).padStart(16, '0')}-${process.hrtime.bigint().toString().padStart(24, '0')}-${owner}.json`);
  ownership.publish(waiter, metadata);
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
          ownership.publish(file, { ...metadata, startedAt: Date.now() });
          const acquiredAt = new Date().toISOString(), waitMs = Date.now() - start;
          let quarantined = false;
          const release = () => { if (!quarantined) ownership.removeOwned(file, owner); };
          const update = change => {
            const held = ownership.snapshot(file);
            if (!held?.entry || held.entry.owner !== owner) throw ownership.resourceError('The provider slot changed before its process ownership could be recorded. Stop new preparation and inspect local provider state.');
            ownership.publish(file, { ...held.entry, ...change }, true);
          };
          const processRecord = details => ({ pid: Number.isSafeInteger(details?.pid) ? details.pid : null,
            processGroup: Number.isSafeInteger(details?.processGroup) ? details.processGroup : null, birth: details?.birth || null,
            platform: details?.platform || process.platform, strategy: details?.strategy || 'unknown',
            unverifiedDescendants: details?.unverifiedDescendants === true, streamsClosed: details?.streamsClosed === true,
            at: new Date().toISOString() });
          release.markDispatching = () => update({ dispatching: true });
          release.attachProcess = details => update({ dispatching: true, providerProcess: processRecord(details) });
          release.quarantine = details => { quarantined = true; update({ dispatching: true, quarantine: processRecord(details) }); };
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
    ownership.removeOwned(waiter, owner);
  }
}
module.exports = { acquire, MAX_ACTIVE, localDirectory };
