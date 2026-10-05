'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ReportPreparation, reconcile } = require('../extension/report-preparation');
const { importReport, parseReport, mapFile } = require('../extension/report');
const { analyze } = require('../extension/runner-adapter'), { SourceCatalog } = require('../extension/source');
const engine = require('../extension/investigation-engine'), policy = require('../extension/guide-policy');
const p = require('../extension/protocol');
const native = process.env.FLOWBOARD_EXTENSION_PATH;
// Independently readable fictional behavior: require(false) reverts. No state
// writes exist. Controlled responses test scheduling/reference plumbing only.
const code = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Gate {\n    function finish(bool accepted) external pure {\n        require(accepted, "rejected");\n    }\n}\n';
const reportText = count => '# Findings\n\n## Found by 2 phases\nThese findings were reported twice.\n\n' + Array.from({ length: count }, (_, i) => `### I-${i + 1}: Gate.finish completes with accepted=false\n**Severity**: Informational\n\nThe report says Gate.finish(false) completes normally instead of reverting.\n`).join('\n');
function response(input) {
  const unit = input.sources.find(item => item.name === 'Gate::finish');
  const quote = '        require(accepted, "rejected");', note = 'When accepted is false, require reverts the call. It cannot complete normally under the reported condition.';
  const obligations = ['applicability', 'entry', 'conditions', 'behavior', 'settlement', 'rule', 'impact', 'counterevidence'].map(kind => ({ id: kind, claimId: 'c1', kind,
    question: `Check ${kind}`, state: 'established', reason: note, evidence: ['guard'], documentation: [] }));
  const checks = [...obligations.map(item => item.id), 'event'].map(target => ({ target, reason: note, evidence: ['guard'], documentation: [] }));
  const reviews = [{ evidenceId: 'guard', result: 'kept', reason: note, checkedSourceIds: [unit.id] }];
  if (input.checkOnly) return { result: 'kept', problems: [], explanationReviews: reviews, checks };
  return { property: { text: 'The report alleges normal completion for a false accepted input.', basis: 'report-assumption', evidence: [], documentation: [] },
    claims: [{ id: 'c1', allegation: 'The false-accepted invocation completes normally.', actor: 'Caller', entry: unit.id, implementation: 'Gate.finish(bool)', conditions: ['accepted is false'],
      requiredFacts: ['The false condition would need to pass require.'], supportsIf: 'Normal return.', contradictsIf: 'Revert on the stated input.', status: 'contradicted', reason: note, evidence: ['guard'], unknowns: [], nextQuestion: '' }],
    evidence: [{ id: 'guard', claimId: 'c1', sourceId: unit.id, line: 5, endLine: 5, quote, stance: 'contradicts', explanation: note }],
    explanationReviews: input.phase === 'challenge' ? reviews : [], transitions: [], questions: [],
    conclusion: { status: 'contradicted-in-scope', text: note, limitations: [] },
    walkthrough: { steps: [{ evidenceId: 'guard', title: 'The guard rejects false', paragraphId: '', phrase: '' }], assessment: { result: 'invalid', why: note, supportingEvidence: '', opposingEvidence: 'guard' } },
    causal: { scope: 'The supplied Gate.finish(false) source behavior; no executed test.', summary: note, outcome: 'refuted', obligations,
      events: [{ id: 'event', invocationId: 'finish-1', transaction: 'tx1', phase: 'guard', claimId: 'c1', evidenceId: 'guard', callSiteId: '', title: 'False does not pass the guard', role: 'Decisive contradiction',
        actor: 'Caller', caller: 'msg.sender', receiver: 'Gate', conditions: ['accepted is false'], what: note, why: 'The reported normal completion is prevented by this guard.', inputs: [], changes: [], effect: 'rolled-back', paragraphId: '', phrase: '' }], relationships: [], order: ['event'], checks: input.phase === 'challenge' ? checks : [] }
  };
}
async function fixture(t, count = 3, invoke, report = reportText(count), source = code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-report-jobs-'));
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/Gate.sol'), source); fs.writeFileSync(path.join(root, 'report.md'), report);
  await importReport(path.join(root, 'report.md'), root, native, { deferMapping: true });
  const result = await analyze(native, root, { mode: 'source' }); let catalog = new SourceCatalog(root, result.runner, result.result);
  const calls = [], updates = [];
  const options = { configuration: () => ({ provider: 'codex', requestLimit: count * 4 }), catalog: async () => catalog,
    changed: status => updates.push(status), invoke: async input => { calls.push([input.finding.id, input.phase, input.checkOnly]); return { value: invoke ? await invoke(input, calls) : response(input), audit: { phase: input.phase, outcome: 'completed', provider: 'controlled-fixture' } }; } };
  const runner = new ReportPreparation(root, options);
  t.after(async () => { runner.dispose(); await runner.loop; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, options, runner, calls, updates, replaceCatalog: value => catalog = value };
}
test('selection promotes two durable stages without owning preparation or starving siblings', { skip: !native }, async t => {
  let release, entered;
  const held = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
  const f = await fixture(t, 3, async input => {
    if (input.finding.id === 'I-1' && input.phase === 'generate') { entered(); await held; }
    return response(input);
  });
  f.options.configuration = () => ({ provider: 'codex', workers: 1, requestLimit: 6 });
  const running = f.runner.ensure(); await started;
  try {
    f.runner.prioritize('I-3'); f.runner.prioritize('I-3');
    assert.equal(f.calls.length, 1, 'Selection must not dispatch alongside the current worker.');
  } finally { release(); }
  await running;
  assert.deepEqual(f.calls.slice(0, 3).map(([id, phase]) => [id, phase]),
    [['I-1', 'generate'], ['I-3', 'generate'], ['I-3', 'challenge']]);
  assert.equal(f.runner.status().ready, 3); assert.equal(f.calls.length, 6);
  f.runner.control('pause'); const before = f.calls.length;
  f.runner.prioritize('I-2'); await f.runner.ensure();
  assert.equal(f.calls.length, before, 'Priority does not authorize resuming or spending.');
});
test('offline production packet inspection preserves workspace bytes and dispatches no provider', { skip: !native }, async t => {
  const f = await fixture(t, 1), destination = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-packet-test-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const inventory = () => fs.readdirSync(path.join(f.root, '.flowboard'), { recursive: true }).filter(file => fs.statSync(path.join(f.root, '.flowboard', file)).isFile())
    .sort().map(file => [file, fs.readFileSync(path.join(f.root, '.flowboard', file), 'utf8')]);
  const before = inventory();
  const child = require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, '../scripts/inspect-review-packet.js'), f.root, 'I-1', path.join(destination, 'packet')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const metrics = JSON.parse(child.stdout);
  assert.equal(metrics.providerRequests, 0); assert.equal(metrics.reportCount, 1);
  assert.match(metrics.schemaHash, /^[a-f0-9]{64}$/);
  const packet = JSON.parse(fs.readFileSync(path.join(destination, 'packet/input.json')));
  assert.ok(packet.finding.reportParagraphs.some(part => part.text.includes('Gate.finish(false) completes normally instead of reverting.')));
  assert.ok(packet.sources.some(unit => unit.code.includes('require(accepted')));
  assert.deepEqual(inventory(), before); assert.deepEqual(f.calls, []);
});
test('corrupt individual investigations cannot prevent intact siblings reopening with no provider', { skip: !native }, async t => {
  for (const brokenId of ['I-1', 'I-2']) {
    const f = await fixture(t, 2); await f.runner.ensure();
    const intactId = brokenId === 'I-1' ? 'I-2' : 'I-1';
    const intact = engine.read(f.root, intactId), before = f.calls.length;
    const file = path.join(f.root, `.flowboard/investigations/${brokenId}.json`), corrupt = '{ interrupted private record';
    fs.writeFileSync(file, corrupt); f.runner.dispose(); await f.runner.loop;
    const reopened = new ReportPreparation(f.root, { ...f.options, configuration: () => ({ provider: 'none' }) });
    t.after(() => reopened.dispose()); await reopened.ensure();
    assert.ok(reopened.published(intact), 'A single damaged record must not block a later valid guide.');
    assert.equal(reopened.status().ready, 1); assert.equal(f.calls.length, before);
    assert.equal(reopened.state.jobs[brokenId].state, 'failed');
    assert.match(reopened.state.jobs[brokenId].reason, /record|saved|recover/i);
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'Original invalid bytes remain available for recovery.');
    await reopened.ensure(); assert.ok(reopened.published(intact));
  }
});
test('a fresh host restores an intact sibling with no provider despite missing, malformed and corrupt records', { skip: !native }, async t => {
  const f = await fixture(t, 4); await f.runner.ensure(); f.runner.dispose(); await f.runner.loop;
  const file = id => path.join(f.root, `.flowboard/investigations/${id}.json`);
  fs.writeFileSync(file('I-1'), '{ broken private JSON'); fs.unlinkSync(file('I-2'));
  fs.writeFileSync(file('I-3'), JSON.stringify({ findingId: 'I-3', claims: 'not a draft' }));
  const bytes = fs.readFileSync(file('I-1'), 'utf8');
  const child = require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, 'restore'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.notEqual(restored.pid, process.pid); assert.equal(restored.indexes, 1);
  assert.deepEqual(restored.calls, []); assert.deepEqual(restored.readable, ['I-4']);
  assert.equal(restored.jobs['I-1'].state, 'failed'); assert.equal(restored.jobs['I-3'].state, 'failed');
  assert.equal(restored.jobs['I-2'].publishable, false);
  assert.equal(fs.readFileSync(file('I-1'), 'utf8'), bytes);
});
test('a crash after a durable provider response reuses generation in a fresh process without a phantom reservation', { skip: !native }, async t => {
  const f = await fixture(t, 1), catalog = await f.options.catalog(), { report, entries } = reconcile(f.root);
  const request = f.runner.request(entries[0], catalog, report), issue = f.runner.issue(entries[0]);
  const value = response({ phase: 'challenge', sources: engine.makeContext(catalog, request, issue).units });
  // The full challenged controlled fixture can be accepted in either stage.
  fs.writeFileSync(path.join(f.root, '.flowboard/controlled-answer.json'), JSON.stringify(value));
  const run = mode => require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, mode], { encoding: 'utf8', timeout: 15000 });
  const crash = run('crash-after-response'); assert.equal(crash.status, 73, crash.stderr);
  const saved = engine.read(f.root, 'I-1'); assert.ok(saved.pendingResponse); assert.equal(saved.claims.length, 0);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, '.flowboard/report-preparation.json')));
  assert.equal(state.resources.requests, 1);
  assert.deepEqual(Object.values(state.resources.receipts).map(receipt => receipt.outcome), ['completed']);
  const resumed = run('resume'); assert.equal(resumed.status, 0, resumed.stderr);
  const result = JSON.parse(resumed.stdout);
  assert.deepEqual(result.calls, ['challenge'], 'The completed generation is read from the private checkpoint, not dispatched again.');
  assert.deepEqual(result.readable, ['I-1']); assert.equal(result.status.requests, 2);
  assert.ok(Object.values(result.receipts).every(receipt => receipt.finishedAt && receipt.outcome === 'completed'));
  const accepted = engine.read(f.root, 'I-1'); assert.ok(accepted.runs.some(run => run.phase === 'generate' && run.reusedResponse));
  assert.equal(accepted.pendingResponse, undefined);
  const reopen = run('restore'); assert.equal(reopen.status, 0, reopen.stderr);
  assert.deepEqual(JSON.parse(reopen.stdout).calls, []); assert.deepEqual(JSON.parse(reopen.stdout).readable, ['I-1']);
});
test('a final paid response recovers in a fresh disabled-provider host at 2/2 without increasing allowance', { skip: !native }, async t => {
  const f = await fixture(t, 2), catalog = await f.options.catalog(), { report, entries } = reconcile(f.root);
  const request = f.runner.request(entries[0], catalog, report), issue = f.runner.issue(entries[0]);
  fs.writeFileSync(path.join(f.root, '.flowboard/controlled-answer.json'), JSON.stringify(response({ phase: 'challenge', sources: engine.makeContext(catalog, request, issue).units })));
  const run = mode => require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, mode], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run('crash-after-challenge').status, 73);
  const pending = engine.read(f.root, 'I-1'); assert.equal(pending.pendingResponse.phase, 'challenge');
  const before = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json', 8 * 1024 * 1024);
  assert.equal(before.resources.requests, 2); assert.equal(before.resources.limit, 2);
  assert.ok(Object.values(before.resources.receipts).every(item => item.outcome === 'completed'));
  const reopened = run('restore'); assert.equal(reopened.status, 0, reopened.stderr);
  const state = JSON.parse(reopened.stdout);
  assert.deepEqual(state.calls, []); assert.deepEqual(state.readable, ['I-1']);
  assert.equal(state.status.requests, 2); assert.equal(state.status.requestLimit, 2);
  assert.equal(state.jobs['I-2'].publishable, false, 'Unpaid sibling work must remain stopped.');
  const accepted = engine.read(f.root, 'I-1');
  assert.equal(accepted.causal.summary, pending.causal.summary);
  assert.ok(accepted.runs.some(run => run.phase === 'challenge' && run.reusedResponse));
  assert.equal(accepted.pendingResponse, undefined);
  const again = JSON.parse(run('restore').stdout);
  assert.deepEqual(again.calls, []); assert.deepEqual(again.readable, ['I-1']); assert.equal(again.status.requestLimit, 2);
});
test('local recovery cannot publish stale code, damaged responses or a generation missing its challenge', { skip: !native }, async t => {
  for (const scenario of ['stale-code', 'damaged-response', 'missing-challenge']) await t.test(scenario, async t => {
    const f = await fixture(t, 1), catalog = await f.options.catalog(), { report, entries } = reconcile(f.root);
    const request = f.runner.request(entries[0], catalog, report), issue = f.runner.issue(entries[0]);
    fs.writeFileSync(path.join(f.root, '.flowboard/controlled-answer.json'), JSON.stringify(response({ phase: 'challenge', sources: engine.makeContext(catalog, request, issue).units })));
    const run = mode => require('node:child_process').spawnSync(process.execPath,
      [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, mode], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run(scenario === 'missing-challenge' ? 'crash-after-response' : 'crash-after-challenge').status, 73);
    const ledger = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json', 8 * 1024 * 1024);
    if (scenario === 'stale-code') fs.writeFileSync(path.join(f.root, 'src/Gate.sol'), code.replace('rejected', 'updated!'));
    if (scenario === 'damaged-response') fs.writeFileSync(path.join(f.root, '.flowboard/provider-results/I-1.json'), '{ damaged response');
    const reopened = run('restore'); assert.equal(reopened.status, 0, reopened.stderr);
    const result = JSON.parse(reopened.stdout);
    assert.deepEqual(result.calls, []); assert.deepEqual(result.readable, []);
    assert.equal(result.status.requests, ledger.resources.requests); assert.equal(result.status.requestLimit, ledger.resources.limit);
    assert.notEqual(result.jobs['I-1'].state, 'running');
    if (scenario === 'missing-challenge') assert.equal(engine.read(f.root, 'I-1').checkpoint.stage, 'challenge');
  });
});
test('a durable substantively checked model finishes host validation locally without resuming paid work', { skip: !native }, async t => {
  const f = await fixture(t, 1); await f.runner.ensure(); f.runner.dispose();
  const saved = engine.read(f.root, 'I-1'), summary = saved.causal.summary;
  // Simulate interruption after assembled challenge checks, before sealing.
  saved.phase = 'blocked'; saved.checkpoint.stage = 'challenge';
  delete saved.publication; saved.error = 'Interrupted before final host validation'; saved.revision++;
  engine.write(f.root, saved);
  const ledger = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json');
  ledger.mode = 'paused'; ledger.resources.limit = ledger.resources.requests;
  p.atomicJson(f.root, '.flowboard/report-preparation.json', ledger);
  const child = require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, 'restore'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.calls, []); assert.deepEqual(result.readable, ['I-1']);
  assert.equal(result.status.requests, 2); assert.equal(result.status.requestLimit, 2);
  assert.equal(result.status.mode, 'paused');
  assert.equal(engine.read(f.root, 'I-1').causal.summary, summary);
});
test('a live health lock cannot discard a completed generation, consume a phantom receipt, or require regeneration', { skip: !native }, async t => {
  const health = require('../extension/provider-health'), ownership = require('../extension/provider-ownership');
  let heldLock, heldOwner, lockOnce = true;
  const f = await fixture(t, 1, input => {
    if (lockOnce) {
      lockOnce = false;
      heldLock = path.join(f.root, 'provider-state', `health-${health.identity('codex')}.lock`);
      const owner = ownership.ownerMetadata(); heldOwner = owner.owner; ownership.publish(heldLock, owner);
    }
    return response(input);
  });
  f.options.invoke.isProviderTransport = true;
  f.options.providerResources = { directory: path.join(f.root, 'provider-state'), lockWaitMs: 20 };
  t.after(() => { if (heldLock) ownership.removeOwned(heldLock, heldOwner); });
  await f.runner.ensure();
  const draft = engine.read(f.root, 'I-1');
  assert.deepEqual(f.calls.map(call => call[1]), ['generate']);
  assert.equal(draft.claims.length, 1); assert.ok(draft.runs[0].resultAccepted);
  assert.equal(draft.runs[0].healthUpdateError.code, 'PROVIDER_HEALTH_UNAVAILABLE');
  assert.equal(draft.checkpoint.stage, 'challenge'); assert.equal(f.runner.state.mode, 'paused');
  assert.equal(f.runner.state.resources.requests, 1);
  assert.deepEqual(Object.values(f.runner.state.resources.receipts).map(receipt => receipt.outcome), ['completed']);
  ownership.removeOwned(heldLock, heldOwner);
  await f.runner.ensure({ retry: true });
  assert.deepEqual(f.calls.map(call => call[1]), ['generate', 'challenge']);
  assert.equal(f.runner.status().ready, 1); assert.equal(f.runner.status().requests, 2);
  assert.ok(Object.values(f.runner.state.resources.receipts).every(receipt => receipt.finishedAt));
});
test('superseded indexing restarts queued jobs without replacing interruption with user pause', { skip: !native }, async t => {
  const f = await fixture(t, 2), obtain = f.options.catalog;
  let entered, indexes = 0; const started = new Promise(resolve => entered = resolve);
  f.options.catalog = async signal => {
    indexes++;
    if (indexes === 1) { entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Source indexing consumer cancelled')), { once: true })); }
    return obtain();
  };
  const pending = f.runner.ensure(); await started;
  f.runner.invalidate('Saved source changed during indexing.');
  f.runner.ensure(); await pending;
  assert.equal(indexes, 2, 'Only the superseded and current indexes are requested.');
  assert.equal(f.runner.status().ready, 2);
  assert.equal(f.calls.length, 4); assert.equal(f.runner.state.mode, 'completed');
  assert.equal(f.runner.tasks.size, 0);
});
test('a genuine index failure is finite and an explicit pause survives edit-during-index', { skip: !native }, async t => {
  const broken = await fixture(t, 1);
  broken.options.catalog = async () => { throw new Error('Controlled parser initialization failure'); };
  await broken.runner.ensure();
  assert.equal(broken.runner.state.mode, 'paused'); assert.match(broken.runner.state.reason, /parser initialization/);
  assert.equal(broken.calls.length, 0); assert.equal(broken.runner.tasks.size, 0); assert.equal(broken.runner.loop, null);
  const f = await fixture(t, 1), obtain = f.options.catalog; let begin, indexes = 0;
  const started = new Promise(resolve => begin = resolve);
  f.options.catalog = async signal => {
    indexes++;
    if (indexes === 1) { begin(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Source indexing consumer cancelled')), { once: true })); }
    return obtain();
  };
  const pending = f.runner.ensure(); await started; await f.runner.control('pause');
  f.runner.invalidate('A saved edit superseded indexing.'); await pending;
  assert.equal(f.runner.state.mode, 'paused'); assert.equal(indexes, 1); assert.equal(f.calls.length, 0);
  await f.runner.ensure({ retry: true }); assert.equal(f.runner.status().ready, 1); assert.equal(f.calls.length, 2);
});
test('an abandoned pre-metadata report lock recovers, while a live owner cannot lose its state', { skip: !native || process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 1), file = path.join(f.root, '.flowboard/report-preparation.lock.json');
  fs.writeFileSync(file, ''); await f.runner.ensure(); assert.equal(f.runner.status().ready, 1);
  const ownership = require('../extension/provider-ownership'), owner = ownership.ownerMetadata(); ownership.publish(file, owner);
  const original = fs.readFileSync(path.join(f.root, '.flowboard/report-preparation.json'), 'utf8');
  await f.runner.ensure();
  assert.equal(fs.readFileSync(path.join(f.root, '.flowboard/report-preparation.json'), 'utf8'), original);
  assert.equal(ownership.snapshot(file).entry.owner, owner.owner);
  ownership.removeOwned(file, owner.owner);
});
test('a missed saved-input event rejects late old-scope answers but verdict-only changes do not cancel analysis', { skip: !native }, async t => {
  for (const semantic of [true, false]) {
    let begin, release; const started = new Promise(resolve => begin = resolve), held = new Promise(resolve => release = resolve);
    const f = await fixture(t, 1, async input => { if (input.phase === 'generate') { begin(); await held; } return response(input); });
    const pending = f.runner.ensure(); await started;
    try {
      const { report, entries } = reconcile(f.root), catalog = await f.options.catalog(), request = f.runner.request(entries[0], catalog, report);
      if (semantic) request.finding.preconditions = ['accepted must be true']; else request.finding.status = 'insufficient-evidence';
      require('../extension/store').writeDraft(f.root, 'I-1', request);
    } finally { release(); await pending; }
    assert.equal(f.runner.status().ready, semantic ? 0 : 1);
    assert.equal(f.calls.length, semantic ? 1 : 2);
    assert.ok(Object.values(f.runner.state.resources.receipts).every(receipt => receipt.finishedAt));
  }
});
test('saved conditions and edited summary reach generation and challenge, and cannot silently retain the old scope', { skip: !native }, async t => {
  const packets = []; let addressPremises = false;
  const f = await fixture(t, 1, input => {
    packets.push(JSON.parse(JSON.stringify(input)));
    const value = response(input);
    if (addressPremises) {
      value.inputReviews = input.semanticInput.premises.map(premise => ({ id: premise.id, status: 'applied',
        reason: 'The supplied researcher condition selects true. The original report specifically alleges the distinct false input.',
        claimIds: ['c1'], eventIds: ['event'], evidence: ['guard'] }));
      if (!input.checkOnly) {
        const note = 'Under the researcher-selected true input the guard succeeds. The report requires false, which is outside this selected scenario; this does not establish behavior in other implementations.';
        value.claims[0].conditions = ['accepted is true']; value.claims[0].reason = note;
        value.evidence[0].explanation = note; value.causal.summary = note;
        value.causal.scope = 'Only the researcher-selected true input, not a conclusion about unrelated inputs or implementations.';
        Object.assign(value.causal.events[0], { title: 'True satisfies the guard', conditions: ['accepted is true'], what: note, why: note, effect: 'condition' });
        value.conclusion.text = note; value.walkthrough.assessment.why = note;
        for (const obligation of value.causal.obligations) obligation.reason = note;
      }
    }
    return value;
  });
  await f.runner.ensure(); assert.ok(f.runner.artifact('I-1'));
  const { report, entries } = reconcile(f.root), catalog = await f.options.catalog();
  const saved = f.runner.request(entries[0], catalog, report);
  saved.finding.preconditions = ['accepted must be true'];
  saved.finding.summary = 'Researcher scope: check the true-input route.';
  require('../extension/store').writeDraft(f.root, 'I-1', saved);
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 12, findingRequestLimit: 12 });
  f.runner.invalidate('Researcher changed scope.', { findingId: 'I-1', saved: true });
  await f.runner.ensure();
  assert.equal(f.runner.artifact('I-1'), null, 'An unchanged false-input answer cannot pass under a new premise hash.');
  const failed = engine.read(f.root, 'I-1'); assert.match(failed.error, /saved preconditions|saved summary/);
  addressPremises = true; await f.runner.ensure({ retry: true });
  const draft = engine.read(f.root, 'I-1'); assert.ok(f.runner.published(draft), draft.error);
  const changed = packets.filter(packet => packet.semanticInput.saved.preconditions?.length);
  assert.ok(changed.some(packet => packet.phase === 'generate')); assert.ok(changed.some(packet => packet.phase === 'challenge'));
  for (const packet of changed) {
    assert.deepEqual(packet.semanticInput.saved.preconditions, ['accepted must be true']);
    assert.equal(packet.semanticInput.saved.summary, saved.finding.summary);
    assert.equal(packet.finding.savedSummary, undefined, 'Saved researcher fields appear in one canonical object, not duplicated in finding.');
    assert.ok(packet.finding.reportParagraphs.some(paragraph => paragraph.text.includes('false')), 'Original report quotation is retained unchanged.');
  }
  assert.deepEqual(draft.claims[0].conditions, ['accepted is true']);
  assert.equal(draft.inputReviews.length, 2); assert.equal(draft.inputReviews[0].status, 'applied');
});
test('phase group is accounted as context; ambiguous sections block instead of disappearing', () => {
  const parsed = parseReport(reportText(3), { manifest: true });
  assert.equal(parsed.issues.length, 3); assert.equal(parsed.manifest.findingCount, 3);
  const group = parsed.manifest.sections.find(section => section.title === 'Found by 2 phases');
  assert.equal(group.classification, 'context'); assert.ok(group.line && group.endLine);
  const ambiguous = parseReport('# Unclassified concern\nSomething important has no ID or finding fields.\n\n' + reportText(1), { manifest: true });
  assert.equal(ambiguous.manifest.ambiguities.length, 1);
});
test('a checked finding is immediately readable while a sibling is still checking and another fails', { skip: !native }, async t => {
  let release, entered = false;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, 4, async input => {
    if (input.finding.id === 'I-2' && input.phase === 'challenge') { entered = true; await held; }
    if (input.finding.id === 'I-4') return {};
    const value = response(input);
    if (input.finding.id === 'I-3' && !input.checkOnly) {
      value.claims[0].status = 'unresolved'; value.claims[0].unknowns = ['The deployment configuration is unavailable.'];
      value.causal.outcome = 'blocked'; value.causal.obligations[0].state = 'open';
      value.conclusion.limitations = ['The deployment configuration is unavailable.'];
    }
    return value;
  });
  const pending = f.runner.ensure();
  try {
    const deadline = Date.now() + 5000;
    while (!(entered && f.runner.state?.jobs['I-1']?.publishable) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(entered && f.runner.state.jobs['I-1'].publishable, 'A finishes its own checks while B waits at challenge.');
    const ready = engine.read(f.root, 'I-1');
    assert.equal(f.runner.published(ready), true, 'A sibling must never be the reading gate for an accepted finding.');
    assert.equal(policy.expose(ready, { findingId: ready.findingId, findingReady: f.runner.published(ready) }).phase, 'ready');
    assert.equal(f.runner.status().published, false, 'Report completion remains a separate aggregate.');
  } finally { release(); await pending; }
  assert.equal(f.runner.state.jobs['I-3'].state, 'blocked');
  assert.equal(f.runner.state.jobs['I-4'].state, 'failed');
  for (const id of ['I-1', 'I-2']) assert.ok(f.runner.published(engine.read(f.root, id)));
  const requests = f.calls.length;
  await f.runner.control('pause'); await f.runner.ensure();
  const reopened = new ReportPreparation(f.root, f.options); t.after(() => reopened.dispose());
  await reopened.ensure();
  for (const id of ['I-1', 'I-2']) assert.ok(reopened.published(engine.read(f.root, id)), 'Pause and host restart preserve accepted compatible guides.');
  assert.equal(f.calls.length, requests, 'Reopening or pausing accepted work makes zero provider requests.');
});
test('pausing at the final accepted stage cannot hide that guide on reopen', { skip: !native }, async t => {
  const f = await fixture(t, 1);
  const changed = f.options.changed;
  f.options.changed = status => { changed(status); if (status.ready === 1 && status.mode === 'running') return f.runner.control('pause'); };
  await f.runner.ensure();
  assert.ok(f.runner.published(engine.read(f.root, 'I-1')));
  await f.runner.ensure();
  assert.ok(f.runner.published(engine.read(f.root, 'I-1')), 'Revalidation precedes the paused-mode early exit.');
  assert.equal(f.calls.length, 2);
});
test('a missed finding-input watcher cannot reuse a completed aggregate after a researcher correction', { skip: !native }, async t => {
  const f = await fixture(t, 2); await f.runner.ensure();
  const a = engine.read(f.root, 'I-1'), b = engine.read(f.root, 'I-2'), acceptedA = f.runner.artifact('I-1');
  const { report, entries } = reconcile(f.root), catalog = await f.options.catalog();
  const corrected = structuredClone(f.runner.request(entries.find(entry => entry.id === 'I-2'), catalog, report));
  corrected.finding.expectedBehavior = 'Researcher correction: only true accepted inputs are expected to return normally.';
  corrected.finding.status = 'invalid';
  corrected.finding.triage.decisionReason = 'The original false-input normal-return allegation fails at the require.';
  corrected.finding.triage.evidence.push({ id: 'human-guard', stance: 'contradicts', source: b.evidence[0].source, note: 'The require rejects the reported false input.' });
  require('../extension/store').writeDraft(f.root, 'I-2', corrected);
  // No watcher callback, no source change, and the old aggregate is complete.
  // Reopening must still reconcile content, without spending a new request.
  f.options.configuration = () => ({ provider: 'none', requestLimit: 8 });
  await f.runner.ensure();
  assert.equal(f.runner.published(a), true); assert.equal(f.runner.artifact('I-1'), acceptedA);
  assert.equal(f.runner.published(b), false, 'The old B explanation has a different expected behavior input.');
  assert.equal(f.calls.length, 4);
  assert.equal(require('../extension/store').readDraft(f.root, 'I-2').finding.status, 'invalid', 'Human judgment is preserved, not replaced by preparation state.');
});
test('a full saved native canvas opens, removal frees a slot, and the checked guide recovers without AI', { skip: !native }, async t => {
  const source = code.replace('\n}\n', '\n    function unrelated() external pure { }\n}\n');
  const f = await fixture(t, 1, undefined, reportText(1), source); await f.runner.ensure();
  const host = await require('../scripts/workflow-host').start({ workspace: f.root, report: path.join(f.root, 'report.md') });
  t.after(() => host.close());
  const call = async (route, value) => (await fetch(host.origin + route, { headers: { 'X-Workflow-Token': host.secret, 'Content-Type': 'application/json' }, ...(value ? { method: 'POST', body: JSON.stringify(value) } : {}) })).json();
  const wait = async predicate => {
    const until = Date.now() + 3000;
    while (Date.now() < until) { const state = await call('/state'); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
    const state = await call('/state'); assert.fail(`Native host did not reach expected state: ${state.errors.join('; ')}`);
  };
  const send = message => call('/message', message);
  const open = async token => {
    await send({ type: 'triage:select', issueId: 'I-1', token });
    const state = await wait(state => state.lastLoad?.issueId === 'I-1' && state.lastLoad.token !== token);
    await send({ type: 'triage:rendered', issueId: 'I-1', token: state.lastLoad.token }); return state.lastLoad;
  };
  await send({ type: 'triage:ready' }); const first = await open();
  assert.equal(first.investigationDraft.phase, 'ready');
  const state = structuredClone(first.state), template = state.cards[0];
  state.cards = Array.from({ length: 200 }, (_, i) => ({ ...template, id: `exploration-${i}`, name: 'unrelated', startLine: 7, endLine: 7, code: '    function unrelated() external pure { }', x: i * 800, y: 0 }));
  state.edges = []; state.notes = [{ id: 'human-note', text: 'Keep my research', x: 10, y: 10 }];
  await send({ type: 'triage:persist', issueId: 'I-1', token: first.token, state });
  await wait(state => state.snapshots['I-1']?.state.cards.length === 200);
  const reopened = await open(first.token);
  assert.equal(reopened.state.cards.length, 200, JSON.stringify({ warnings: reopened.warnings, error: reopened.error, errors: (await call('/state')).errors })); assert.equal(reopened.state.notes[0].text, 'Keep my research');
  assert.equal(reopened.guideAvailability.ready, false); assert.match(reopened.guideAvailability.reason, /200/);
  assert.equal(reopened.investigationDraft.phase, 'ready', 'Materialization capacity is not failed semantic evidence.');
  const reduced = structuredClone(reopened.state); reduced.cards.pop();
  await send({ type: 'triage:persist', issueId: 'I-1', token: reopened.token, state: reduced });
  await wait(state => state.snapshots['I-1']?.state.cards.length === 199);
  const draft = reopened.investigationDraft;
  await send({ type: 'triage:investigationFocus', issueId: 'I-1', token: reopened.token, evidenceId: 'guard', investigationRevision: draft.revision });
  const until = Date.now() + 3000; let focus;
  while (!focus && Date.now() < until) { focus = (await call('/events')).messages.findLast(message => message.type === 'triage:investigationFocus'); if (!focus) await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(focus, 'The host materializes and focuses the exact missing function after a removal.');
  assert.equal(focus.source.line, 5); assert.equal(focus.guideAvailability.ready, true);
  const recovered = await call('/state');
  assert.deepEqual(recovered.errors, []);
  assert.equal(f.calls.length, 2, 'Canvas recovery and reopening spend zero new provider calls.');
});
test('editing one imported finding preserves another accepted artifact and cumulative allowance', { skip: !native }, async t => {
  const f = await fixture(t, 2); await f.runner.ensure(); await f.runner.control('pause');
  const first = engine.read(f.root, 'I-1'), digest = f.runner.artifact('I-1'), requests = f.calls.length;
  const changed = reportText(2).replace('### I-2: Gate.finish', '### I-2: Different condition for Gate.finish');
  fs.writeFileSync(path.join(f.root, 'report.md'), changed);
  await importReport(path.join(f.root, 'report.md'), f.root, native, { deferMapping: true });
  f.runner.invalidate('Finding text changed', { kind: 'report' });
  assert.ok(f.runner.published(first), 'An unrelated report section does not revoke A.');
  await f.runner.control('pause'); await f.runner.ensure();
  assert.equal(f.runner.artifact('I-1'), digest);
  assert.equal(f.runner.published(engine.read(f.root, 'I-2')), false);
  assert.equal(f.calls.length, requests); assert.equal(f.runner.state.resources.requests, requests);
});
test('a unique full path can reconcile citation case, but colliding files cannot', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-case-path-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); const a = path.join(root, 'src/Gate.sol'), b = path.join(root, 'Src/GATE.sol');
  fs.writeFileSync(a, code);
  assert.equal(mapFile(root, 'SRC/Gate.sol', [a]), 'src/Gate.sol');
  if (fs.existsSync(path.join(root, 'Src'))) { t.diagnostic('Case-folding volume: a second path differing only by case cannot exist. Unique-path reconciliation checked.'); return; }
  fs.mkdirSync(path.join(root, 'Src'));
  fs.writeFileSync(b, code); assert.equal(mapFile(root, 'SRC/Gate.sol', [a,b]), null);
});
test('cold import prepares all findings and publishes each accepted artifact independently', { skip: !native }, async t => {
  const { root, runner, calls, updates } = await fixture(t);
  await runner.ensure();
  for (const id of ['I-1', 'I-2', 'I-3']) assert.deepEqual(calls.filter(call => call[0] === id).map(call => call[1]), ['generate', 'challenge']);
  assert.equal(runner.status().published, true); assert.equal(runner.status().ready, 3);
  assert.equal(runner.status().costUSD, null, 'Unavailable cost is not reported as zero dollars.');
  assert.ok(updates.some(status => status.ready === 1 && status.published === false));
  const draft = engine.read(root, 'I-1'); assert.ok(runner.published(draft));
  assert.ok(policy.expose(draft, { findingId: draft.findingId, findingReady: true, published: false }).causal, 'Aggregate incompleteness is not a reading gate.');
  await runner.ensure(); assert.equal(calls.length, 6, 'Identical reopen/reimport reuses all compatible work.');
  assert.equal(reconcile(root).entries.length, 3);
});
test('a timed-out challenge resumes the accepted generation, while unrelated jobs run first', { skip: !native }, async t => {
  let failed = false;
  const f = await fixture(t, 3, input => {
    if (input.finding.id === 'I-1' && input.phase === 'challenge' && !failed) { failed = true; throw Object.assign(new Error('Injected timeout'), { audit: { phase: 'challenge', outcome: 'failed' } }); }
    return response(input);
  });
  await f.runner.ensure();
  assert.equal(f.runner.status().published, true);
  assert.equal(f.calls.filter(([id, phase]) => id === 'I-1' && phase === 'generate').length, 1);
  assert.equal(f.calls.at(-1)[0], 'I-1', 'Retry is behind the other initial attempts.');
  const resumed = engine.read(f.root, 'I-1');
  assert.ok(resumed.actions.some(action => action.kind === 'checkpoint-resume'));
  assert.equal(resumed.runs.filter(run => run.phase === 'challenge').length, 2);
});
test('one failed explanation prevents report completion but not other accepted guides and has a finite stop', { skip: !native }, async t => {
  const f = await fixture(t, 3, input => {
    const value = response(input); if (input.finding.id === 'I-2') return {};
    return value;
  });
  await f.runner.ensure();
  assert.equal(f.runner.status().published, false); assert.equal(f.runner.status().ready, 2);
  assert.equal(f.runner.state.jobs['I-2'].state, 'failed'); assert.ok(f.calls.length <= 8);
  const before = f.calls.length; await f.runner.ensure(); assert.equal(f.calls.length, before, 'A stopped malformed result is not retried forever.');
});
test('report resource budget pauses without counting queued jobs as ready; resume retains checkpoints', { skip: !native }, async t => {
  const f = await fixture(t, 3); f.options.configuration = () => ({ provider: 'codex', requestLimit: 1, workers: 1 });
  await f.runner.ensure(); assert.equal(f.runner.status().mode, 'paused'); assert.equal(f.calls.length, 1);
  assert.equal(f.runner.status().published, false); assert.equal(f.runner.status().ready, 0);
  await f.runner.control('resume');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1][1], 'challenge', 'Resume does not pay for generation again.');
  assert.equal(f.runner.status().ready, 1);
});
test('cancellation ignores a late provider response and preserves researcher files', { skip: !native }, async t => {
  let release; const wait = new Promise(resolve => release = resolve);
  const f = await fixture(t, 2, async input => { await wait; return response(input); });
  const note = path.join(f.root, '.flowboard/human-note.txt'); fs.writeFileSync(note, 'Keep my research.');
  const running = f.runner.ensure();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.runner.control('cancel'); release(); await running;
  assert.equal(f.runner.status().published, false); assert.equal(f.runner.status().mode, 'cancelled');
  assert.equal(f.runner.status().ready, 0); assert.equal(fs.readFileSync(note, 'utf8'), 'Keep my research.');
  assert.equal(engine.read(f.root, 'I-1').claims.length, 0);
});
test('changed shared source revokes affected guides and unchanged human records survive', { skip: !native }, async t => {
  const f = await fixture(t, 2); await f.runner.ensure(); assert.equal(f.runner.status().published, true);
  f.runner.invalidate('Code changed'); assert.equal(f.runner.status().published, false);
  fs.appendFileSync(path.join(f.root, 'src/Gate.sol'), '\n// changed saved snapshot\n');
  const result = await analyze(native, f.root, { mode: 'source' }); f.replaceCatalog(new SourceCatalog(f.root, result.runner, result.result));
  await f.runner.ensure(); assert.equal(f.calls.length, 8); assert.equal(f.runner.status().published, true);
  assert.ok(fs.readdirSync(path.join(f.root, '.flowboard/recovery')).some(name => name.startsWith('investigation-')));
});
test('host restart revalidates privately; pause finishes the current request but starts no later pass', { skip: !native }, async t => {
  let release; const wait = new Promise(resolve => release = resolve);
  const f = await fixture(t, 2, async input => { await wait; return response(input); });
  const pending = f.runner.ensure();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.runner.control('pause'); release(); await pending;
  assert.equal(f.calls.length, 2, 'Both already-running workers finish, but no challenge is dispatched after pause.'); assert.equal(f.runner.status().mode, 'paused');
  assert.equal(engine.read(f.root, 'I-1').checkpoint.stage, 'challenge');
  const restarted = new ReportPreparation(f.root, f.options);
  t.after(() => restarted.dispose());
  await restarted.control('resume');
  assert.equal(f.calls.filter(([id, phase]) => id === 'I-1' && phase === 'generate').length, 1);
  assert.equal(restarted.status().published, true);
});
test('Resume during a finishing request is not lost and does not regenerate the accepted stage', { skip: !native }, async t => {
  let release; const wait = new Promise(resolve => release = resolve);
  const f = await fixture(t, 1, async input => { await wait; return response(input); });
  const running = f.runner.ensure();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.runner.control('pause');
  const resumed = f.runner.control('resume'); release(); await Promise.all([running, resumed]);
  assert.equal(f.runner.status().published, true);
  assert.deepEqual(f.calls.map(call => call[1]), ['generate', 'challenge']);
});
test('a repaired answer can request new local evidence without spending the semantic-repair allowance again', { skip: !native }, async t => {
  let inspected = false;
  const f = await fixture(t, 1, (input, calls) => {
    if (input.checkOnly) return { result: 'repair', problems: ['Read the declared check before finalizing.'], explanationReviews: [], checks: [] };
    const value = response(input);
    if (input.phase === 'challenge' && !input.sources.some(unit => unit.name === 'Policy::expected')) {
      value.claims[0].status = 'unresolved'; value.claims[0].unknowns = ['Read the locally available declaration.'];
      value.causal.outcome = 'blocked'; value.causal.obligations[0].state = 'open';
      value.questions = [{ id: 'local', claimId: 'c1', text: 'Read the declaration before finishing.', action: 'symbol', target: 'Policy::expected', why: 'The challenge needs this code.' }];
    } else if (input.phase === 'challenge') {
      inspected = true;
      const unit = input.sources.find(unit => unit.name === 'Policy::expected');
      assert.match(unit.code, /return false;/);
      assert.ok(input.hostReview.newLocalCode);
    }
    return value;
  });
  fs.writeFileSync(path.join(f.root, 'src/Policy.sol'), 'pragma solidity ^0.8.20;\ncontract Policy { function expected() external pure returns (bool) { return false; } }\n');
  const result = await analyze(native, f.root, { mode: 'source' }); f.replaceCatalog(new SourceCatalog(f.root, result.runner, result.result));
  await f.runner.ensure();
  assert.equal(inspected, true);
  assert.equal(f.calls.length, 4, 'Generation, compact check, repair, then one new-evidence check.');
  assert.equal(f.runner.status().published, true);
  const saved = engine.read(f.root, 'I-1');
  assert.equal(saved.checkpoint.followups, 1); assert.equal(saved.checkpoint.repairUsed, true);
  assert.ok(saved.actions.some(action => action.target === 'Policy::expected' && action.outcome === 'source-returned'));
});
test('reconciliation changes preserve the shared report budget and human records', { skip: !native }, async t => {
  const f = await fixture(t, 2); await f.runner.ensure();
  const saved = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json');
  saved.identity = 'older-parser'; saved.publication = null;
  p.atomicJson(f.root, '.flowboard/report-preparation.json', saved);
  const again = new ReportPreparation(f.root, f.options); t.after(() => again.dispose());
  await again.ensure();
  assert.equal(again.state.resources.requests, saved.resources.requests, 'A parser/policy migration does not invent a new free report allowance.');
  assert.equal(f.calls.length, 4);
});
test('a 301-entry import schedules every legitimate entry independently before requesting any model work', { skip: !native }, async t => {
  const f = await fixture(t, 301); f.options.configuration = () => ({ provider: 'none', requestLimit: 12 });
  await f.runner.ensure();
  assert.equal(f.runner.status().total, 301); assert.equal(f.runner.status().ready, 0);
  assert.equal(f.runner.status().counts.queued, 301); assert.equal(f.calls.length, 0);
  assert.equal(f.runner.status().published, false);
});
module.exports = { response };

test('case-corrected Location reaches normal import, applicability, generation and publication', { skip: !native }, async t => {
  const f = await fixture(t, 1, null, reportText(1) + '\n**Location**: Src/Gate.sol:L5\n');
  await f.runner.ensure();
  assert.equal(f.calls.length, 2); assert.equal(f.runner.status().published, true);
  const saved = engine.read(f.root, 'I-1');
  assert.equal(saved.evidence[0].source.file, 'src/Gate.sol');
  assert.equal(saved.evidence[0].source.line, 5);
  assert.equal(saved.evidence[0].source.sourceHash, engine.hash(code));
});
test('Script/script applicability uses the same indexed path; a folded collision blocks before provider work', { skip: !native }, async t => {
  for (const collision of [false, true]) {
    const f = await fixture(t, 1, null, reportText(1) + '\n**Location**: Script/Gate.sol:L5\n');
    fs.mkdirSync(path.join(f.root, 'script'));
    fs.renameSync(path.join(f.root, 'src/Gate.sol'), path.join(f.root, 'script/Gate.sol'));
    if (collision) {
      fs.mkdirSync(path.join(f.root, 'SCRIPT'));
      fs.writeFileSync(path.join(f.root, 'SCRIPT/GATE.sol'), code.replace('contract Gate', 'contract DifferentGate'));
    }
    const indexed = await analyze(native, f.root, { mode: 'source' });
    f.replaceCatalog(new SourceCatalog(f.root, indexed.runner, indexed.result));
    await f.runner.ensure();
    assert.equal(f.runner.status().published, !collision);
    assert.equal(f.calls.length, collision ? 0 : 2);
    if (collision) assert.match(f.runner.state.jobs['I-1'].reason, /not present unambiguously/);
    else assert.equal(engine.read(f.root, 'I-1').evidence[0].source.file, 'script/Gate.sol');
  }
});
test('the largest supported causal collections survive acceptance, durable storage and reopening without truncation', { skip: !native }, async t => {
  const capacity = require('../extension/review-capacity');
  const f = await fixture(t, 1, input => {
    const output = response({ ...input, checkOnly: false });
    output.claims = Array.from({ length: capacity.limits.claims }, (_, i) => ({ ...output.claims[0], id: `c${i}`, evidence: [`g${i}`] }));
    output.evidence = output.claims.map((claim, i) => ({ ...output.evidence[0], id: `g${i}`, claimId: claim.id }));
    output.causal.obligations = output.claims.flatMap((claim, i) => capacity.kinds.map(kind => ({ ...output.causal.obligations.find(item => item.kind === kind), id: `${claim.id}-${kind}`, claimId: claim.id, evidence: [`g${i}`] })));
    output.causal.events = Array.from({ length: capacity.limits.events }, (_, i) => ({ ...output.causal.events[0], id: `e${i}`, claimId: `c${i % 8}`, evidenceId: `g${i % 8}` }));
    output.causal.order = output.causal.events.map(item => item.id);
    output.causal.relationships = Array.from({ length: capacity.limits.relationships }, (_, i) => ({ from: `e${i < 17 ? i : i - 17}`, to: `e${i < 17 ? i + 1 : 17}`, kind: 'context', explanation: 'Another condition in the same fictional source.', binding: 'Reading context only.', evidence: ['g0'] }));
    output.causal.checks = capacity.targets(output.causal).map(item => ({ target: item.key, reason: 'The stated false condition fails the guard.', evidence: output.evidence.map(item => item.id), documentation: [] }));
    output.explanationReviews = output.evidence.map(item => ({ evidenceId: item.id, result: 'kept', reason: item.explanation, checkedSourceIds: [item.sourceId] }));
    output.walkthrough.steps = output.evidence.map(item => ({ evidenceId: item.id, title: 'Check the guard', paragraphId: '', phrase: '' }));
    output.walkthrough.assessment.opposingEvidence = 'g0';
    if (input.checkOnly) return { result: 'kept', problems: [], explanationReviews: output.explanationReviews, checks: output.causal.checks };
    return output;
  });
  await f.runner.ensure();
  assert.equal(f.runner.status().published, true, f.runner.state.jobs['I-1'].reason);
  const draft = engine.read(f.root, 'I-1');
  assert.equal(draft.claims.length, 8); assert.equal(draft.causal.obligations.length, 64);
  assert.equal(draft.causal.events.length, 18); assert.equal(draft.causal.relationships.length, 30); assert.equal(draft.causal.checks.length, 112);
  assert.equal(policy.gate(draft).ready, true);
});
test('one finding allowance cannot pause other eligible findings or mislabel report spend', { skip: !native }, async t => {
  const f = await fixture(t, 2, input => {
    if (input.finding.id === 'I-1') f.runner.state.jobs['I-1'].requestLimit = 1;
    return response(input);
  });
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 100, workers: 2 });
  await f.runner.ensure();
  assert.equal(f.runner.state.jobs['I-1'].state, 'paused');
  assert.match(f.runner.state.jobs['I-1'].reason, /Finding I-1.*1\/1/);
  assert.equal(f.runner.state.jobs['I-2'].state, 'completed');
  assert.equal(f.runner.status().requests, 3); assert.equal(f.runner.status().requestLimit, 100);
  assert.equal(f.runner.status().published, false); assert.equal(f.runner.status().mode, 'incomplete');
});
test('dirty input before dispatch and during response leaves no running job without a task', { skip: !native }, async t => {
  for (const initiallyDirty of [true, false]) {
    let dirty = initiallyDirty;
    const f = await fixture(t, 1, input => { dirty = true; return response(input); });
    f.options.dirty = () => dirty;
    await f.runner.ensure();
    assert.equal(f.runner.state.jobs['I-1'].state, 'paused');
    assert.match(f.runner.state.jobs['I-1'].reason, /unsaved/);
    assert.equal(f.runner.tasks.size, 0); assert.equal(f.runner.active, null);
    assert.equal(f.calls.length, initiallyDirty ? 0 : 1); assert.equal(f.runner.status().published, false);
  }
});
test('slow work does not starve independent stages; achieved concurrency and receipts remain bounded', { skip: !native }, async t => {
  let release; const slow = new Promise(resolve => release = resolve); let active = 0, maximum = 0;
  const f = await fixture(t, 3, async input => {
    active++; maximum = Math.max(maximum, active);
    if (input.finding.id === 'I-1' && input.phase === 'generate') await slow;
    active--; return response(input);
  });
  const run = f.runner.ensure();
  for (let i = 0; i < 500 && f.runner.state?.jobs['I-3']?.state !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.runner.state.jobs['I-3'].state, 'completed');
  assert.equal(f.runner.state.jobs['I-1'].state, 'running');
  release(); await run;
  assert.equal(maximum, 2); assert.equal(f.runner.status().concurrency.achieved, 2);
  assert.equal(Object.keys(f.runner.state.resources.receipts).length, 6);
  assert.equal(f.runner.status().published, true);
});
test('a large cold manifest advances both new findings and checked continuations within a small allowance', { skip: !native }, async t => {
  const f = await fixture(t, 24);
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 6, workers: 2 });
  await f.runner.ensure();
  assert.equal(f.calls.length, 6); assert.ok(f.runner.status().ready >= 1);
  assert.ok(new Set(f.calls.map(call => call[0])).size >= 3, 'Continuations do not monopolize every worker.');
  assert.equal(f.runner.status().published, false, 'Aggregate completion is still false; independently ready findings are already readable.');
  assert.equal(f.runner.tasks.size, 0);
});
test('same-source restart reuses the manifest without one full workspace scan per artifact', { skip: !native }, async t => {
  const f = await fixture(t, 12); await f.runner.ensure();
  const metrics = require('../extension/workspace-snapshot').metrics, before = metrics.reconciliations;
  const again = new ReportPreparation(f.root, f.options); t.after(() => again.dispose());
  await again.ensure();
  assert.equal(f.calls.length, 24); assert.equal(again.status().published, true);
  assert.ok(metrics.reconciliations - before <= 2, 'One shared validation at reuse and one publication check, not N scans.');
});
test('source-only unrelated change keeps checked work; a new named caller invalidates its dependency closure', { skip: !native }, async t => {
  const f = await fixture(t, 1);
  const extra = path.join(f.root, 'src/Unrelated.sol');
  fs.writeFileSync(extra, 'pragma solidity ^0.8.20;\ncontract Unrelated { function color() external pure returns(uint) { return 1; } }\n');
  const reindex = async () => { const indexed = await analyze(native, f.root, { mode: 'source' }); f.replaceCatalog(new SourceCatalog(f.root, indexed.runner, indexed.result)); };
  await reindex(); await f.runner.ensure(); assert.equal(f.calls.length, 2);
  fs.writeFileSync(extra, fs.readFileSync(extra, 'utf8').replace('return 1', 'return 2'));
  f.runner.invalidate('unrelated change'); await reindex(); await f.runner.ensure();
  assert.equal(f.calls.length, 2); assert.equal(f.runner.status().published, true);
  fs.appendFileSync(extra, '\ncontract Caller { function callGate(Gate g) external { g.finish(false); } }\n');
  f.runner.invalidate('new caller'); await reindex(); await f.runner.ensure();
  assert.equal(f.calls.length, 4);
});
test('a long function keeps its full local body and reads its tail before a substantive challenge', { skip: !native }, async t => {
  const tail = Array.from({ length: 1500 }, (_, i) => `        // Deliberate long-function reading context ${i}: ${'padding '.repeat(10)}`).join('\n');
  // The only decisive guard is AFTER the initial model budget, not merely a
  // comment tail after a guard that was already known. Independently, false
  // still reverts; a prefix alone cannot establish that outcome.
  const long = code.replace('        require(accepted, "rejected");', tail + '\n        require(accepted, "rejected");');
  const guardLine = long.split('\n').findIndex(line => line.includes('require(accepted')) + 1;
  const packets = [];
  const f = await fixture(t, 1, input => {
    packets.push(input);
    const result = response(input);
    if (input.phase === 'challenge') {
      assert.equal(input.checkOnly, undefined, 'New tail code may change the argument; do not force check-then-repair.');
      assert.equal(input.repairOnly, true);
      assert.ok(input.sources.some(unit => unit.code.includes(`${guardLine} |         require(accepted, "rejected");`)), 'The decisive tail guard was actually supplied.');
      result.evidence[0].line = result.evidence[0].endLine = guardLine;
      result.explanationReviews[0].result = 'added';
      delete result.walkthrough.steps; // Current response schema derives this from causal order.
      return { mode: 'review-patch-v1', updates: Object.entries(result).filter(([key]) => key !== 'explanationReviews').map(([key, value]) => ({ path: '/' + key, valueJSON: JSON.stringify(value) })), explanationReviews: result.explanationReviews, checks: result.causal.checks };
    }
    assert.ok(!input.sources.some(unit => unit.code.includes('require(accepted')), 'The first packet has not read the decisive guard.');
    result.claims[0] = { ...result.claims[0], status: 'unresolved', reason: 'The complete ending has not been read.', evidence: [], unknowns: ['Read the remaining local function before judging normal completion.'] };
    result.evidence = []; result.walkthrough.steps = [];
    result.walkthrough.assessment = { result: 'unclear', why: 'The available prefix does not establish the outcome.', supportingEvidence: '', opposingEvidence: '' };
    result.conclusion = { status: 'insufficient-evidence', text: 'Read the local tail.', limitations: result.claims[0].unknowns };
    Object.assign(result.causal, { outcome: 'blocked', summary: 'The local tail remains unread.', events: [], order: [], checks: [], obligations: result.causal.obligations.map(item => ({ ...item, state: 'open', evidence: [], reason: 'The relevant tail is not in this packet.' })) });
    return result;
  }, reportText(1), long);
  await f.runner.ensure();
  assert.equal(f.calls.length, 2, JSON.stringify({ reason: f.runner.state.jobs['I-1'].reason, packets: packets.map(input => ({ phase: input.phase, feedback: input.feedback, repairOnly: input.repairOnly, sources: input.sources.map(unit => ({ line: unit.line, endLine: unit.endLine })) })) })); assert.equal(f.runner.status().published, true, f.runner.state.jobs['I-1'].reason);
  const draft = engine.read(f.root, 'I-1'), unit = draft.sources.find(item => item.name === 'Gate::finish');
  assert.ok(unit.code.length > 110000); assert.ok(unit.source.endLine > 1500);
  assert.equal(unit.readThrough, unit.source.endLine); assert.ok(unit.code.includes('reading context 1499'));
  assert.ok(packets[1].sources.find(item => item.id === unit.id).line > 800, 'The challenge actually receives code beyond the former stored prefix.');
  assert.equal(unit.code, long.split('\n').slice(unit.source.line - 1, unit.source.endLine).join('\n'));
  assert.equal(draft.evidence[0].source.line, guardLine); assert.equal(draft.claims[0].status, 'contradicted');
});
test('repeated identical structural failure resumes the challenge then stops without regeneration', { skip: !native }, async t => {
  const f = await fixture(t, 1, input => { const value = response(input); if (input.checkOnly) value.checks.pop(); else value.causal.events[0].caller = ''; return value; });
  await f.runner.ensure(); assert.equal(engine.read(f.root, 'I-1').failureKind, 'structural');
  const generated = f.calls.filter(([, phase]) => phase === 'generate').length;
  await f.runner.control('resume');
  assert.equal(f.calls.filter(([, phase]) => phase === 'generate').length, generated);
  const used = f.calls.length; await f.runner.control('resume');
  assert.equal(f.calls.length, used, 'The unchanged structural failure does not burn repeated allowances.');
  assert.equal(f.runner.status().published, false);
});
test('a missed same-size restored-mtime change revokes publication on reopen', { skip: !native }, async t => {
  const f = await fixture(t, 1); await f.runner.ensure();
  const file = path.join(f.root, 'src/Gate.sol'), stat = fs.statSync(file);
  fs.writeFileSync(file, code.replace('rejected', 'accepted')); fs.utimesSync(file, stat.atime, stat.mtime);
  await f.runner.ensure();
  assert.equal(f.runner.status().published, false); assert.equal(f.calls.length, 2);
  assert.match(f.runner.status().reason, /changed since|Source changed/);
});
test('progress events do not reconcile workspace content or deserialize another finding', { skip: !native }, async t => {
  const f = await fixture(t, 1), metrics = require('../extension/workspace-snapshot').metrics;
  let observed;
  f.options.invoke = async (input, options) => {
    const before = metrics.reconciliations;
    for (let i = 0; i < 100; i++) options.onProgress({ stage: 'model', receivedBytes: i });
    observed = metrics.reconciliations - before;
    return { value: response(input), audit: { phase: input.phase, outcome: 'completed' } };
  };
  await f.runner.ensure(); assert.equal(observed, 0); assert.equal(f.runner.status().published, true);
});
test('four attempted unknowns do not starve a fifth available local question', { skip: !native }, async t => {
  let sawFifth = false;
  const source = code + '\ncontract AdditionalContext { function boundary() external pure returns (uint256) { return 32; } }\n';
  const f = await fixture(t, 1, input => {
    const value = response(input);
    if (input.phase === 'generate') assert.equal(input.sources.some(unit => unit.name === 'AdditionalContext::boundary'), false, 'The unrelated definition is not an initial discovery anchor.');
    else sawFifth = input.sources.some(unit => unit.name === 'AdditionalContext::boundary');
    value.questions = Array.from({ length: 4 }, (_, i) => ({ id: `external-${i}`, claimId: 'c1', text: `Deployment fact ${i} is unavailable.`, action: 'missing-context', target: '', why: 'Requires independently supplied deployment evidence.' }));
    value.questions.push({ id: 'local-fifth', claimId: 'c1', text: 'Read the local boundary declaration.', action: 'symbol', target: 'AdditionalContext::boundary', why: 'This local definition is available after the four unresolved external questions.' });
    value.claims[0].status = 'unresolved'; value.claims[0].unknowns = ['Deployment evidence remains unavailable.'];
    value.causal.outcome = 'blocked'; value.causal.obligations[0].state = 'open'; value.conclusion.limitations = ['Deployment evidence remains unavailable.'];
    return value;
  }, reportText(1), source);
  await f.runner.ensure();
  assert.ok(sawFifth, 'The challenge receives the fifth question\'s actual local code.');
  const draft = engine.read(f.root, 'I-1');
  assert.equal(draft.phase, 'blocked'); assert.equal(f.runner.artifact('I-1'), null);
  assert.ok(draft.actions.some(action => action.sourceIds.some(id => draft.sources.find(unit => unit.id === id)?.name === 'AdditionalContext::boundary')));
  const receipts = draft.actions.filter(action => action.acquisitionKey);
  for (let i = 0; i < 4; i++) assert.ok(receipts.filter(action => action.questionId === `external-${i}`).length <= 1, 'No-progress receipts prevent identical repeated local searches.');
});
test('a compatible privately checked v4 artifact without execution handoffs migrates locally', { skip: !native }, async t => {
  const f = await fixture(t, 1); await f.runner.ensure();
  const saved = engine.read(f.root, 'I-1');
  saved.snapshot.policy = 'checked-explanation-v4'; saved.publication.policy = 'checked-explanation-v4';
  delete saved.causal.events[0].callSiteId;
  saved.publication.digest = policy.digest(saved); saved.revision++; engine.write(f.root, saved);
  await f.runner.control('pause');
  const old = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json'); old.version = 1; old.publication = null; p.atomicJson(f.root, '.flowboard/report-preparation.json', old);
  const restarted = new ReportPreparation(f.root, f.options); t.after(() => restarted.dispose());
  await restarted.ensure();
  const current = engine.read(f.root, 'I-1');
  assert.equal(current.migration.from, 'checked-explanation-v4'); assert.equal(current.publication.policy, policy.POLICY);
  assert.ok(restarted.published(current)); assert.equal(f.calls.length, 2, 'Local policy migration makes no provider request.');
});
test('a sealed v7 artifact is rechecked under current path policy without buying another review', { skip: !native }, async t => {
  const f = await fixture(t, 1); await f.runner.ensure();
  const saved = engine.read(f.root, 'I-1'), original = structuredClone(saved.causal);
  saved.snapshot.policy = 'checked-explanation-v7'; saved.publication.policy = 'checked-explanation-v7';
  saved.publication.digest = policy.digest(saved); saved.revision++; engine.write(f.root, saved);
  await f.runner.control('pause'); f.runner.dispose();
  const restarted = new ReportPreparation(f.root, { ...f.options, invoke:async()=>assert.fail('Migration cannot dispatch a paid request.') });
  t.after(()=>restarted.dispose()); await restarted.ensure();
  const current = engine.read(f.root, 'I-1');
  assert.equal(current.migration.from,'checked-explanation-v7'); assert.equal(current.publication.policy,policy.POLICY);
  assert.deepEqual(current.causal,original); assert.ok(restarted.published(current)); assert.equal(f.calls.length,2);
});
