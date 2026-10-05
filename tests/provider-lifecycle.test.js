'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const provider = require('../extension/semantic-provider'), slots = require('../extension/provider-slots'), health = require('../extension/provider-health');
const ownership = require('../extension/provider-ownership'), processes = require('../extension/provider-process');
const linux = process.platform === 'linux', posix = process.platform !== 'win32';
const input = { phase: 'generate', finding: { title: 'fictional-transport-check' }, sources: [], documentation: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function running(pid) { const current = ownership.processIdentity(pid); return !!current && !['Z', 'X'].includes(current.state); }
async function killChild(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function owner(t, mode, file) {
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-owner.js'), mode, file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => killChild(child)); await once(child, 'message'); return child;
}
function descendantTransport(t, mode, extra = {}) {
  let child, descendant, cwd, terminal = 0;
  const events = [], options = {
    timeoutMs: 700, terminationGraceMs: 150, terminationSettleMs: 250, ...extra,
    spawn(executable, args, settings) {
      cwd = settings.cwd;
      child = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-descendants.js'), mode], settings);
      let buffered = '';
      child.stdout.on('data', chunk => {
        buffered += chunk; const newline = buffered.indexOf('\n'); if (newline < 0) return;
        const event = JSON.parse(buffered.slice(0, newline));
        descendant ||= { pid: event.fixtureChildPid, birth: ownership.processIdentity(event.fixtureChildPid)?.birth };
      });
      return child;
    },
    onProgress: event => { events.push(event); extra.onProgress?.(event); }
  };
  const promise = provider.runCodex(input, options).then(value => { terminal++; return value; }, error => { terminal++; throw error; });
  // Cleanup targets are only the exact child identities created by this test.
  t.after(async () => {
    if (descendant?.pid) {
      const current = ownership.processIdentity(descendant.pid);
      if (current && (!descendant.birth || current.birth === descendant.birth) && !['Z', 'X'].includes(current.state)) process.kill(descendant.pid, 'SIGKILL');
    }
    if (child) await killChild(child);
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { promise, events, child: () => child, descendant: () => descendant, terminal: () => terminal };
}
for (const mode of ['inherited', 'ignore-term', 'launcher-exits']) test(`deadline ends the actual ${mode} launcher and descendant, including inherited pipes`, { skip: !linux, timeout: 5000 }, async t => {
  const started = Date.now(), run = descendantTransport(t, mode);
  await assert.rejects(run.promise, error => {
    assert.equal(error.code, 'PROVIDER_TIMEOUT'); assert.equal(error.audit.failureKind, 'timeout');
    assert.equal(error.audit.teardown.confirmed, true); assert.equal(error.audit.teardown.streamsClosed, true);
    assert.equal(error.audit.teardown.strategy, 'owned-process-group');
    if (mode === 'ignore-term') assert.equal(error.audit.teardown.forced, true);
    return true;
  });
  assert.ok(Date.now() - started < 3000, 'The finite request-plus-cleanup bound must not wait for a retained pipe indefinitely.');
  assert.ok(run.descendant()?.pid); assert.equal(running(run.descendant().pid), false); assert.equal(running(run.child().pid), false);
  await pause(50); assert.equal(run.terminal(), 1);
});
test('the reported 500ms request deadline terminates an ignoring descendant with the unchanged production cleanup grace', { skip: !linux, timeout: 6000 }, async t => {
  const run = descendantTransport(t, 'ignore-term', { timeoutMs: 500, terminationGraceMs: undefined, terminationSettleMs: undefined });
  await assert.rejects(run.promise, error => {
    assert.equal(error.code, 'PROVIDER_TIMEOUT'); assert.equal(error.audit.deadline.milliseconds, 500);
    assert.equal(error.audit.teardown.confirmed, true); assert.equal(error.audit.teardown.forced, true);
    assert.ok(error.audit.durationMs >= 2400 && error.audit.durationMs < 4500, `Observed ${error.audit.durationMs}ms including the 2000ms TERM grace.`);
    return true;
  });
  assert.ok(run.descendant()?.pid); assert.equal(running(run.descendant().pid), false); assert.equal(run.terminal(), 1);
});
test('cancellation kills an actual inherited descendant and produces exactly one cancelled terminal result', { skip: !linux, timeout: 5000 }, async t => {
  const controller = new AbortController();
  const run = descendantTransport(t, 'ignore-term', { timeoutMs: 3000, signal: controller.signal,
    onProgress: event => { if (event.event === 'thread.started') setTimeout(() => controller.abort(), 150); } });
  await assert.rejects(run.promise, error => error.code === 'INVESTIGATION_SUPERSEDED' && error.audit.failureKind === 'cancelled' && error.audit.teardown.confirmed);
  assert.equal(running(run.descendant().pid), false); assert.equal(run.terminal(), 1);
});
test('an unverified escaped descendant produces a finite quarantine instead of freeing its request slot', { skip: !linux, timeout: 5000 }, async t => {
  const root = directory(t), release = await slots.acquire('codex', null, { directory: root });
  release.markDispatching();
  const run = descendantTransport(t, 'escaped-pipes', { onProcessStart: release.attachProcess });
  await assert.rejects(run.promise, error => {
    assert.equal(error.code, 'PROVIDER_TEARDOWN_UNCONFIRMED'); assert.equal(error.audit.teardown.confirmed, false);
    assert.equal(error.audit.teardown.unverifiedDescendants, true); assert.equal(error.audit.primaryFailureKind, 'timeout');
    release.quarantine(error.audit.teardown); release(); return true;
  });
  assert.equal(running(run.child().pid), false); assert.equal(running(run.descendant().pid), true, 'Do not signal an unestablished process outside the owned group.');
  await assert.rejects(slots.acquire('codex', null, { directory: root, timeoutMs: 100 }), { code: 'PROVIDER_TEARDOWN_UNCONFIRMED' });
  assert.equal(fs.readdirSync(root).filter(file => /^codex-\d.json$/.test(file)).length, 1);
  assert.equal(run.terminal(), 1);
});
test('ordinary actual adapter completion confirms normal group exit and saves process ownership before sending input', { skip: !posix }, async () => {
  let attached, sent = false;
  const result = await provider.runCodex(input, {
    spawn(executable, args, settings) {
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-cli.js'), 'codex'], settings), end = child.stdin.end.bind(child.stdin);
      child.stdin.end = (...arguments_) => { assert.ok(attached?.pid); sent = true; return end(...arguments_); }; return child;
    }, onProcessStart: value => { attached = value; }
  });
  assert.equal(sent, true); assert.equal(attached.pid, result.audit.pid); assert.equal(result.audit.teardown.confirmed, true);
  assert.equal(result.audit.teardown.normalCompletion, true); assert.equal(result.audit.outcome, 'completed');
});
test('a daemonizing wrapper with closed pipes is explicitly outside the certified process-group contract', { skip: !linux, timeout: 5000 }, async t => {
  const run = descendantTransport(t, 'escaped-closed');
  await assert.rejects(run.promise, error => {
    assert.equal(error.code, 'PROVIDER_TIMEOUT');
    assert.equal(error.audit.teardown.confirmed, true, 'Only the owned group is confirmed.');
    assert.equal(error.audit.teardown.scope, 'owned-process-group');
    assert.equal(error.audit.teardown.treeVerified, false);
    assert.match(error.audit.teardown.descendantContract, /escaping this group are not certified/);
    return true;
  });
  assert.equal(running(run.child().pid), false);
  assert.equal(running(run.descendant().pid), true, 'This benign unsupported worker is killed only by the test-owned identity cleanup.');
  assert.equal(run.terminal(), 1);
});
test('a live PID missing from the mounted proc view fails finitely instead of deleting its queue owner', { skip: !linux }, async t => {
  const root = directory(t), file = path.join(root, 'codex-0.json'), metadata = ownership.ownerMetadata();
  ownership.publish(file, metadata);
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (file === `/proc/${process.pid}/stat`) throw Object.assign(new Error('Controlled namespace mismatch.'), { code: 'ENOENT' });
    return read.call(this, file, ...args);
  };
  try {
    assert.equal(ownership.inspect(file).state, 'unknown');
    assert.throws(() => ownership.reap(file), { code: 'PROVIDER_RESOURCE_UNAVAILABLE' });
    const start = Date.now();
    await assert.rejects(slots.acquire('codex', null, { directory: root }), error => error.code === 'PROVIDER_RESOURCE_UNAVAILABLE' && /inconsistent process IDs/.test(error.message));
    assert.ok(Date.now() - start < 1000);
    assert.equal(ownership.snapshot(file).entry.owner, metadata.owner);
    assert.deepEqual(fs.readdirSync(root), ['codex-0.json']);
  } finally { fs.readFileSync = read; }
});
test('failed process-ownership persistence stops the actual child before any review input is sent', { skip: !linux }, async () => {
  let sent = false;
  await assert.rejects(provider.runCodex(input, {
    timeoutMs: 1000, terminationGraceMs: 100, terminationSettleMs: 100,
    spawn(executable, args, settings) {
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-cli.js'), 'codex'], settings), end = child.stdin.end.bind(child.stdin);
      child.stdin.end = (...arguments_) => { sent = true; return end(...arguments_); }; return child;
    }, onProcessStart: () => { throw new Error('Controlled ownership write failure.'); }
  }), error => error.code === 'PROVIDER_OWNERSHIP_UNAVAILABLE' && error.audit.teardown.confirmed);
  assert.equal(sent, false);
});
test('crashing after legacy exclusive-create but before metadata no longer wedges health or capacity', { skip: !linux }, async t => {
  const root = directory(t), options = { directory: root, lockWaitMs: 40 }, lock = path.join(root, `health-${health.identity('codex')}.lock`);
  for (const file of [lock, path.join(root, 'codex-0.json'), path.join(root, 'codex-1.json')]) {
    const child = await owner(t, 'empty-held', file); assert.equal(fs.statSync(file).size, 0); await killChild(child);
  }
  assert.equal(health.check('codex', options).open, false);
  await health.record('codex', { outcome: 'failed', failureKind: 'timeout', requestId: 'one', phase: 'generate' }, options);
  await health.reset('codex', options);
  const release = await slots.acquire('codex', null, { ...options, timeoutMs: 200 }); release();
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(path.join(root, 'codex-1.json')), false);
});
test('a live pre-metadata owner is never removed by age and preflight prevents dispatch', { skip: !linux }, async t => {
  const root = directory(t), options = { directory: root, lockWaitMs: 30 }, lock = path.join(root, `health-${health.identity('codex')}.lock`);
  const child = await owner(t, 'empty-held', lock), before = fs.statSync(lock);
  fs.utimesSync(lock, new Date(0), new Date(0));
  assert.throws(() => health.check('codex', options), { code: 'PROVIDER_HEALTH_UNAVAILABLE' });
  await assert.rejects(health.record('codex', { outcome: 'completed', requestId: 'not-dispatched' }, options), { code: 'PROVIDER_HEALTH_UNAVAILABLE' });
  assert.equal(fs.statSync(lock).ino, before.ino); assert.equal(running(child.pid), true);
  await killChild(child); assert.equal(health.check('codex', options).open, false);
});
test('a live empty slot is explicit finite unavailable, not silently absent or age-reaped', { skip: !linux }, async t => {
  const root = directory(t), file = path.join(root, 'codex-0.json'), child = await owner(t, 'empty-held', file), before = fs.statSync(file);
  fs.utimesSync(file, new Date(0), new Date(0));
  await assert.rejects(slots.acquire('codex', null, { directory: root, timeoutMs: 50 }), { code: 'PROVIDER_RESOURCE_UNAVAILABLE' });
  assert.equal(fs.statSync(file).ino, before.ino); assert.equal(running(child.pid), true);
  await killChild(child); const release = await slots.acquire('codex', null, { directory: root, timeoutMs: 200 }); release();
});
for (const mode of ['before-publish', 'after-publish']) test(`atomic initialization survives a real ${mode} crash without publishing empty metadata`, { skip: !linux }, async t => {
  const root = directory(t), file = path.join(root, 'codex-0.json'), child = await owner(t, mode, file);
  assert.equal(fs.existsSync(file), mode === 'after-publish');
  if (mode === 'after-publish') assert.equal(ownership.inspect(file).state, 'live');
  await killChild(child);
  const release = await slots.acquire('codex', null, { directory: root, timeoutMs: 200 }); release();
  assert.equal(fs.existsSync(file), false);
});
test('a complete live health owner is preserved and a dead owner can be reclaimed safely', { skip: !linux }, async t => {
  const root = directory(t), options = { directory: root }, lock = path.join(root, `health-${health.identity('codex')}.lock`), child = await owner(t, 'metadata-held', lock);
  assert.throws(() => health.check('codex', options), { code: 'PROVIDER_HEALTH_UNAVAILABLE' });
  await killChild(child); assert.equal(health.check('codex', options).open, false); assert.equal(fs.existsSync(lock), false);
});
test('slot recovery treats an exited host with a running provider as quarantined and reclaims only its ended group', { skip: !linux }, async t => {
  const root = directory(t), providerChild = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-descendants.js'), 'worker'], { detached: true, stdio: 'ignore' });
  t.after(() => killChild(providerChild)); await once(providerChild, 'spawn');
  const details = processes.create(providerChild, true).record, ownerProcess = await owner(t, 'metadata-held', path.join(root, 'host-marker'));
  const metadata = ownership.snapshot(path.join(root, 'host-marker')).entry, file = path.join(root, 'codex-0.json');
  ownership.publish(file, { ...metadata, dispatching: true, providerProcess: details }); await killChild(ownerProcess);
  await assert.rejects(slots.acquire('codex', null, { directory: root, timeoutMs: 50 }), { code: 'PROVIDER_TEARDOWN_UNCONFIRMED' });
  assert.equal(running(providerChild.pid), true);
  await killChild(providerChild); const release = await slots.acquire('codex', null, { directory: root, timeoutMs: 200 }); release();
  assert.equal(fs.existsSync(file), false);
});
test('unknown post-reservation process identity stays quarantined after the owning host crashes', { skip: !linux }, async t => {
  const root = directory(t), marker = path.join(root, 'host-marker'), child = await owner(t, 'metadata-held', marker);
  ownership.publish(path.join(root, 'codex-0.json'), { ...ownership.snapshot(marker).entry, dispatching: true }); await killChild(child);
  await assert.rejects(slots.acquire('codex', null, { directory: root, timeoutMs: 50 }), { code: 'PROVIDER_TEARDOWN_UNCONFIRMED' });
});
test('malformed durable health state is not silently converted to healthy or reset before dispatch', async t => {
  const root = directory(t), options = { directory: root }, file = path.join(root, `health-${health.identity('codex')}.json`);
  fs.writeFileSync(file, '{');
  assert.throws(() => health.check('codex', options), { code: 'PROVIDER_HEALTH_UNAVAILABLE' });
  await assert.rejects(health.reset('codex', options), { code: 'PROVIDER_HEALTH_UNAVAILABLE' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});
test('legacy recovery remains unavailable if neither inode visibility nor the optional kernel lease is available', { skip: !linux }, t => {
  const root = directory(t), file = path.join(root, `health-${health.identity('codex')}.lock`);
  fs.writeFileSync(file, '');
  const children = require('node:child_process'), originalSpawn = children.spawnSync, originalRead = fs.readdirSync;
  try {
    fs.readdirSync = (target, ...args) => { if (target === '/proc') throw Object.assign(new Error('Controlled restricted process view.'), { code: 'EACCES' }); return originalRead(target, ...args); };
    children.spawnSync = () => ({ error: Object.assign(new Error('Controlled missing optional helper.'), { code: 'ENOENT' }) });
    assert.throws(() => health.check('codex', { directory: root }), { code: 'PROVIDER_HEALTH_UNAVAILABLE' });
    assert.equal(fs.existsSync(file), true);
  } finally { children.spawnSync = originalSpawn; fs.readdirSync = originalRead; }
});
test('a process-group record with a recycled identity never authorizes signalling or capacity release', { skip: !linux }, async t => {
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-descendants.js'), 'worker'], { detached: true, stdio: 'ignore' });
  t.after(() => killChild(child)); await once(child, 'spawn');
  const record = processes.create(child, true).record;
  const state = processes.processGroup({ ...record, birth: `${record.birth}-different-process` });
  assert.equal(state.confirmed, false); assert.match(state.reason, /different process/); assert.equal(running(child.pid), true);
});
