'use strict';
// Shared local provider health is not an allowance. Only repeated transport
// failures trip it; rejected reasoning/schema and unavailable evidence do not.
const path = require('node:path'), crypto = require('node:crypto');
const { localDirectory } = require('./provider-slots');
const ownership = require('./provider-ownership');
const THRESHOLD = 2, WINDOW_MS = 10 * 60 * 1000;
const transportFailures = new Set(['timeout', 'spawn', 'transport', 'provider-exit']);
function identity(provider, options = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('Unknown review provider.');
  // Raw paths, prompts, source, stdout, credentials and environment values are
  // never copied into this cross-project status file.
  return crypto.createHash('sha256').update(JSON.stringify({ provider, executable: options.executable || provider,
    configuration: provider === 'codex' ? 'isolated-medium-v1' : 'isolated-budget-v1' })).digest('hex').slice(0, 24);
}
function files(provider, options) {
  const root = localDirectory(options.directory), key = identity(provider, options);
  return { file: path.join(root, `health-${key}.json`), lock: path.join(root, `health-${key}.lock`) };
}
function read(file) {
  try {
    const observed = ownership.snapshot(file);
    if (observed) {
      const value = observed.entry;
      if (!value || value.version !== 1 || !Array.isArray(value.failures) || value.failures.some(item => !item || typeof item.requestId !== 'string' || !Number.isFinite(Date.parse(item.at))) ||
          value.openedAt !== null && !Number.isFinite(Date.parse(value.openedAt))) throw unavailable('Provider health data is incomplete. Automatic requests are stopped; preserve the file and repair local provider state before retrying.');
      return value;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { version: 1, failures: [], openedAt: null, lastSuccessAt: null };
}
function unavailable(message) { return Object.assign(new Error(message), { code: 'PROVIDER_HEALTH_UNAVAILABLE', retryable: true }); }
function status(provider, options = {}) {
  const value = read(files(provider, options).file);
  return { ...value, open: !!value.openedAt, threshold: THRESHOLD, windowMs: WINDOW_MS };
}
function check(provider, options = {}) {
  const { lock } = files(provider, options);
  try {
    const held = ownership.reap(lock);
    if (held) throw unavailable('Provider health is being updated by another live owner. No new request was dispatched; retry after that update finishes.');
  } catch (error) { if (error.code === 'PROVIDER_RESOURCE_UNAVAILABLE') throw unavailable(error.message); throw error; }
  const current = status(provider, options);
  if (current.open) throw Object.assign(new Error(`The ${provider} review provider failed ${current.failures.length} recent transport attempts (${current.reason}). Automatic requests are stopped. Check provider access, then explicitly retry preparation; accepted work is saved.`),
    { code: 'PROVIDER_HEALTH_OPEN', providerHealth: current });
  return current;
}
async function update(provider, options, change) {
  const { file, lock } = files(provider, options), metadata = ownership.ownerMetadata(), started = Date.now();
  let acquired = false;
  while (!acquired) {
    try { ownership.publish(lock, metadata); acquired = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        ownership.reap(lock);
      } catch (probe) { if (probe.code !== 'PROVIDER_RESOURCE_UNAVAILABLE') throw probe; }
      if (Date.now() - started >= Math.max(20, Math.min(2000, options.lockWaitMs || 2000))) throw unavailable('Provider health could not be updated because its lock still has a live or unknown owner. Accepted provider results must be retained; no new request should be dispatched until the lock can be checked.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    const next = change(read(file));
    ownership.publish(file, next, true);
    return { ...next, open: !!next.openedAt, threshold: THRESHOLD, windowMs: WINDOW_MS };
  } finally {
    ownership.removeOwned(lock, metadata.owner);
  }
}
async function record(provider, audit, options = {}) {
  if (!audit || audit.outcome !== 'completed' && !transportFailures.has(audit.failureKind)) return status(provider, options);
  return update(provider, options, previous => {
    const finishedAt = audit.finishedAt || new Date().toISOString(), time = Date.parse(finishedAt), requestId = audit.requestId;
    if (audit.outcome === 'completed') {
      // A late successful peer does not silently reopen an already tripped
      // circuit. Explicit user retry is required; the success remains visible.
      return { ...previous, lastSuccessAt: finishedAt, ...(previous.openedAt ? {} : { failures: [] }) };
    }
    const failures = previous.failures.filter(value => time - Date.parse(value.at) <= WINDOW_MS && value.requestId !== requestId);
    failures.push({ requestId, at: finishedAt, kind: audit.failureKind, phase: audit.phase, inputBytes: audit.inputBytes ?? null });
    const open = previous.openedAt || failures.length >= THRESHOLD;
    return { ...previous, failures: failures.slice(-THRESHOLD), openedAt: previous.openedAt || (open ? finishedAt : null),
      reason: open ? failures.every(value => value.kind === failures[0].kind) ? failures[0].kind : 'repeated transport failures' : null };
  });
}
// Only an explicit retry/resume may call reset. Reading/opening/navigation must
// never clear a provider-health stop or reserve a new request.
async function reset(provider, options = {}) {
  return update(provider, options, previous => ({ version: 1, failures: [], openedAt: null, reason: null,
    lastSuccessAt: previous.lastSuccessAt, resetAt: new Date().toISOString() }));
}
module.exports = { THRESHOLD, WINDOW_MS, status, check, record, reset, identity };
