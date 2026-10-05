'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ReportPreparation } = require('../extension/report-preparation'), { importReport } = require('../extension/report');
const { analyze } = require('../extension/runner-adapter'), { SourceCatalog } = require('../extension/source');
const engine = require('../extension/investigation-engine'), slots = require('../extension/provider-slots'), health = require('../extension/provider-health');
const native = process.env.FLOWBOARD_EXTENSION_PATH;
const code = 'pragma solidity ^0.8.20;\ncontract Guard {\n    function finish(bool accepted) external pure {\n        require(accepted, "rejected");\n    }\n}\n';
const report = count => '# Findings\n\n' + Array.from({ length: count }, (_, i) => `## I-${i + 1}: Guard.finish returns normally for accepted=false\nSeverity: Low\n\nThe report alleges that Guard.finish(false) returns normally.\n`).join('\n');
// Independently read fixture: the single require rejects accepted=false, with
// no writes or callees. These controlled responses exercise production gates,
// slots, request accounting and persistence, not real-model reasoning quality.
function response(input) {
  const unit = input.sources.find(item => item.name === 'Guard::finish'), note = 'The require rejects accepted=false. The reported normal return cannot occur under that condition.';
  const obligations = ['applicability', 'entry', 'conditions', 'behavior', 'settlement', 'rule', 'impact', 'counterevidence'].map(kind => ({
    id: kind, claimId: 'c1', kind, question: `Check ${kind}`, state: 'established', reason: note, evidence: ['guard'], documentation: [] }));
  const checks = [...obligations.map(item => `obligation:${item.id}`), 'event:event'].map(target => ({ target, reason: note, evidence: ['guard'], documentation: [] }));
  const explanationReviews = [{ evidenceId: 'guard', result: 'kept', reason: note, checkedSourceIds: [unit.id] }];
  if (input.checkOnly) return { result: 'kept', problems: [], explanationReviews, checks };
  return { property: { text: 'The report alleges normal completion for a false input.', basis: 'report-assumption', evidence: [], documentation: [] },
    claims: [{ id: 'c1', allegation: 'The false-accepted invocation completes normally.', actor: 'Caller', entry: unit.id, implementation: 'Guard.finish(bool)', conditions: ['accepted is false'],
      requiredFacts: ['A false condition would have to pass the guard.'], supportsIf: 'Normal return.', contradictsIf: 'Revert on accepted=false.', status: 'contradicted', reason: note, evidence: ['guard'], unknowns: [], nextQuestion: '' }],
    evidence: [{ id: 'guard', claimId: 'c1', sourceId: unit.id, line: 4, endLine: 4, quote: '        require(accepted, "rejected");', stance: 'contradicts', explanation: note }],
    explanationReviews: input.phase === 'challenge' ? explanationReviews : [], transitions: [], questions: [],
    conclusion: { status: 'contradicted-in-scope', text: note, limitations: [] },
    walkthrough: { steps: [{ evidenceId: 'guard', title: 'False does not pass the guard', paragraphId: '', phrase: '' }], assessment: { result: 'invalid', why: note, supportingEvidence: '', opposingEvidence: 'guard' } },
    causal: { scope: 'Guard.finish(false), source only; no executed contract test.', summary: note, outcome: 'refuted', obligations,
      events: [{ id: 'event', invocationId: 'finish-1', transaction: 'tx1', phase: 'guard', claimId: 'c1', evidenceId: 'guard', callSiteId: '',
        title: 'False does not pass the guard', role: 'Decisive contradiction', actor: 'Caller', caller: 'msg.sender', receiver: 'Guard', conditions: ['accepted is false'],
        what: note, why: 'The guard prevents the alleged normal return.', inputs: [], changes: [], effect: 'rolled-back', paragraphId: '', phrase: '' }],
      relationships: [], order: ['event'], checks: input.phase === 'challenge' ? checks : [] } };
}
async function until(check, message) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), typeof message === 'function' ? message() : message);
}
async function fixture(t, count = 1, callback) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-provider-coordinator-')), root = path.join(base, 'project'), directory = path.join(base, 'provider');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.writeFileSync(path.join(root, 'src/Guard.sol'), code); fs.writeFileSync(path.join(root, 'report.md'), report(count));
  await importReport(path.join(root, 'report.md'), root, native, { deferMapping: true });
  const indexed = await analyze(native, root, { mode: 'source' }), catalog = new SourceCatalog(root, indexed.runner, indexed.result), calls = [];
  const invoke = async (input, options) => {
    calls.push({ id: input.finding.id, phase: input.phase, requestId: options.requestId, capacity: options.capacity });
    if (callback) return callback(input, options);
    return { value: response(input), audit: { requestId: options.requestId, phase: input.phase, provider: 'controlled-transport-fixture', outcome: 'completed',
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), hostAcceptedAt: null, inputBytes: Buffer.byteLength(JSON.stringify(input)) } };
  };
  invoke.isProviderTransport = true;
  const options = { invoke, providerResources: { directory, pollMs: 5 }, configuration: () => ({ provider: 'codex', requestLimit: 20, workers: 2 }), catalog: async () => catalog };
  const runner = new ReportPreparation(root, options);
  t.after(async () => { runner.dispose(); await runner.loop; fs.rmSync(base, { recursive: true, force: true }); });
  return { root, directory, runner, options, calls };
}
test('production coordinator waits for shared capacity without reserving, then generates/checks exactly once', { skip: !native }, async t => {
  const f = await fixture(t), first = await slots.acquire('codex', null, { directory: f.directory }), second = await slots.acquire('codex', null, { directory: f.directory });
  t.after(() => { first(); second(); });
  const pending = f.runner.ensure();
  await until(() => f.runner.state?.jobs['I-1']?.state === 'waiting-for-provider-capacity', 'Waiting capacity must be explicit in the real coordinator.');
  assert.equal(f.calls.length, 0); assert.equal(f.runner.state.resources.requests, 0); assert.equal(f.runner.status().concurrency.dispatched || 0, 0);
  await new Promise(resolve => setTimeout(resolve, 100)); first(); await pending; second();
  assert.deepEqual(f.calls.map(call => call.phase), ['generate', 'challenge']); assert.equal(f.runner.state.resources.requests, 2);
  assert.ok(f.calls.every(call => call.requestId && call.capacity?.acquiredAt)); assert.ok(f.calls[0].capacity.waitMs >= 90);
  assert.ok(f.runner.published(engine.read(f.root, 'I-1')));
  await f.runner.ensure(); assert.equal(f.calls.length, 2, 'Opening a ready artifact does not acquire or dispatch another provider request.');
});
test('pause cancels a waiting sibling promptly without hiding ready work on reopen or reserving a request', { skip: !native }, async t => {
  const f = await fixture(t); await f.runner.ensure(); assert.ok(f.runner.published(engine.read(f.root, 'I-1')));
  const human = path.join(f.root, '.flowboard/human-note.txt'); fs.writeFileSync(human, 'Preserve this optional research note.');
  fs.writeFileSync(path.join(f.root, 'report.md'), report(2)); const imported = await importReport(path.join(f.root, 'report.md'), f.root, native, { deferMapping: true });
  const sibling = imported.issues.find(issue => issue.displayId === 'I-2').id;
  const first = await slots.acquire('codex', null, { directory: f.directory }), second = await slots.acquire('codex', null, { directory: f.directory });
  t.after(() => { first(); second(); });
  const pending = f.runner.ensure(); await until(() => f.runner.state?.jobs[sibling]?.state === 'waiting-for-provider-capacity', () => `Only the unready sibling waits: ${JSON.stringify(f.runner.status())}`);
  await f.runner.control('pause'); await pending;
  assert.equal(f.calls.length, 2); assert.equal(f.runner.state.resources.requests, 2); assert.ok(f.runner.published(engine.read(f.root, 'I-1')));
  assert.ok(!['running', 'waiting-for-provider-capacity'].includes(f.runner.state.jobs[sibling].state)); assert.equal(f.runner.tasks.size, 0);
  first(); second();
  const reopened = new ReportPreparation(f.root, f.options); t.after(() => reopened.dispose()); await reopened.ensure();
  assert.ok(reopened.published(engine.read(f.root, 'I-1'))); assert.equal(f.calls.length, 2); assert.equal(fs.readFileSync(human, 'utf8'), 'Preserve this optional research note.');
});
test('shared transport-health stop preserves queued jobs and accounts only the two failed dispatches', { skip: !native }, async t => {
  const f = await fixture(t, 4, (input, options) => { throw Object.assign(new Error('Controlled timeout, not a real provider request.'), { code: 'PROVIDER_TIMEOUT',
    audit: { requestId: options.requestId, phase: input.phase, outcome: 'failed', failureKind: 'timeout', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } }); });
  await f.runner.ensure();
  assert.equal(f.calls.length, 2); assert.equal(f.runner.state.resources.requests, 2); assert.equal(health.status('codex', { directory: f.directory }).open, true);
  assert.equal(f.runner.status().mode, 'paused'); assert.equal(f.runner.tasks.size, 0);
  const before = f.calls.length; await f.runner.ensure(); assert.equal(f.calls.length, before, 'Opening or retrying ensure cannot clear the provider-health circuit.');
  assert.ok(Object.values(f.runner.state.jobs).every(job => job.state !== 'running' && job.state !== 'waiting-for-provider-capacity'));
});
