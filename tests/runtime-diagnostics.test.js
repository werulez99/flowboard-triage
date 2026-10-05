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
