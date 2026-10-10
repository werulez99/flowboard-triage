'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { providerIdentity } = require('../extension/runtime-diagnostics');
test('Doctor identifies the configured local executable without inferring a model or dispatching review', async () => {
  let calls = 0;
  const value = await providerIdentity('codex', process.execPath, true, [], (exe, args, options, done) => {
    calls++; assert.equal(exe, process.execPath); assert.deepEqual(args, ['--version']);
    assert.equal(options.shell, false); assert.equal(options.timeout, 2000); done(null, 'codex-cli 0.160.0\n');
  });
  assert.equal(calls, 1); assert.equal(value.version, 'codex-cli 0.160.0'); assert.equal(value.observedModel, null);
  assert.equal(value.resolvedExecutable, process.execPath);
});
test('Doctor only attributes model identity to a matching saved transport observation', async () => {
  const receipt = { id: 'r1', finishedAt: '2026-01-01T00:00:00Z', audit: { provider: 'codex-cli',
    effectiveConfiguration: { executable: process.execPath, observedModel: 'observed-fixture-model' } } };
  const run = (_e, _a, _o, done) => done(null, 'codex-cli 0.160.0');
  const result = await providerIdentity('codex', process.execPath, true, [receipt], run);
  assert.equal(result.observedModel, 'observed-fixture-model'); assert.equal(result.modelObservation.requestId, 'r1');
  assert.match(result.modelObservation.scope, /not the current CLI default/);
  const other = await providerIdentity('codex', process.execPath, true, [{ ...receipt, audit: { ...receipt.audit,
    effectiveConfiguration: { executable: '/different/cli', observedModel: 'do-not-borrow' } } }], run);
  assert.equal(other.observedModel, null);
});
test('Doctor does not execute an untrusted/disabled provider or leak arbitrary version output', async () => {
  const no = () => { throw new Error('Must not execute'); };
  assert.equal((await providerIdentity('codex', process.execPath, false, [], no)).version, null);
  assert.equal((await providerIdentity('none', undefined, true, [], no)).configuredExecutable, null);
  assert.equal((await providerIdentity('codex', 'codex --anything', true, [], no)).resolvedExecutable, null);
  const result = await providerIdentity('codex', process.execPath, true, [], (_e, _a, _o, done) => done(null, 'private arbitrary wrapper output'));
  assert.equal(result.version, null); assert.ok(!JSON.stringify(result).includes('private arbitrary'));
});
test('Doctor skips malformed observations and preserves an attributed Claude model list', async () => {
  const receipt = { id: 'claude-r1', finishedAt: '2026-10-01', audit: { provider: 'claude-cli', effectiveConfiguration: {
    executable: process.execPath, observedModels: ['observed-a', 'observed-b'] } } };
  const result = await providerIdentity('claude', process.execPath, false, [null, {}, { audit: null }, receipt]);
  assert.deepEqual(result.observedModels, ['observed-a', 'observed-b']); assert.equal(result.observedModel, null);
  assert.equal(result.modelObservation.requestId, 'claude-r1'); assert.equal(result.modelObservation.at, '2026-10-01');
});
test('a non-daemonizing version child ignoring TERM is killed and the optional probe settles finitely', { skip: process.platform !== 'linux' }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-version-')), executable = path.join(folder, 'version-cli'), pidFile = path.join(folder, 'pid');
  fs.writeFileSync(executable, '#!' + process.execPath + '\nrequire("fs").writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},100);\n', { mode: 0o700 });
  let pid; t.after(() => { try { if(pid) process.kill(pid,'SIGKILL'); } catch {} fs.rmSync(folder, { recursive: true, force: true }); });
  const start = performance.now();
  const result = await providerIdentity('codex', executable, true); pid = Number(fs.readFileSync(pidFile,'utf8'));
  assert.ok(performance.now() - start < 3500, 'Version diagnostics must not wait indefinitely for close.');
  assert.equal(result.version, null); assert.equal(result.versionCleanup.confirmed, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
