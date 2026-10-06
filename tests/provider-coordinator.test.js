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
  return { root, directory, runner, options, calls, catalog };
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
test('explicit guarded pair changes only its generation deadline; challenge/default and exact two-call allowance remain', { skip: !native }, async t => {
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const provider = require('../extension/semantic-provider'); let dispatched = 0; const audits = [];
  const fake = value => (_exe, args) => {
    assert.ok(args.includes('--output-schema')); assert.ok(args.includes('model_reasoning_effort="medium"'));
    const child = new EventEmitter(); child.pid = process.pid; child.stdin = new PassThrough(); child.stdin.resume(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on('finish', () => queueMicrotask(() => { child.emit('spawn'); child.stdout.write([
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }, { type: 'turn.completed', usage: { output_tokens: 1 } }
    ].map(JSON.stringify).join('\n')); child.emit('close', 0); })); return child;
  };
  const f = await fixture(t, 1, async (input, options) => {
    assert.equal(input.finding.id, 'I-1'); assert.equal(input.phase, dispatched === 0 ? 'generate' : 'challenge');
    assert.ok(dispatched < 2); dispatched++;
    const result = await provider.runProvider(input, { ...options, ...(input.phase === 'generate' ? { timeoutMs: 600000 } : {}), spawn: fake(response(input)) });
    audits.push(result.audit); return result;
  });
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 2, findingRequestLimit: 2, workers: 1 });
  await f.runner.ensure();
  assert.equal(dispatched, 2); assert.deepEqual(audits.map(a => a.deadline.milliseconds), [600000, 240000]);
  assert.ok(Object.values(f.runner.state.resources.receipts).every(receipt => receipt.hostAcceptedAt));
  assert.equal(f.runner.state.resources.requests, 2);
  assert.ok(f.runner.published(engine.read(f.root, 'I-1')));
  const normal = await provider.runCodex({ phase: 'generate' }, { spawn: fake({ controlled: true }) });
  assert.equal(normal.audit.deadline.milliseconds, 240000);
  fs.writeFileSync(path.join(f.root, 'report.md'), report(2)); await importReport(path.join(f.root, 'report.md'), f.root, native, { deferMapping: true });
  await f.runner.ensure(); assert.equal(dispatched, 2, 'An extra job cannot reserve or dispatch a third request.');
  assert.equal(f.runner.state.resources.requests, 2); assert.equal(f.runner.state.resources.limit, 2);
});
test('selected continuation in a paused mixed report reuses only its challenge and never grants shared allowance', { skip: !native }, async t => {
  let recover = false;
  const f = await fixture(t, 4, async (input, options) => {
    if (input.finding.id === 'I-2' && input.phase === 'challenge' && !recover) throw Object.assign(new Error('Controlled challenge transport failure'), { audit: { requestId: options.requestId, phase: 'challenge', outcome: 'failed' } });
    if (input.finding.id === 'I-3') throw Object.assign(new Error('Finding allowance paused'), { code: 'FINDING_BUDGET' });
    const value = response(input);
    if (input.finding.id === 'I-4') { value.claims[0].status = 'unresolved'; value.claims[0].unknowns = ['The externally supplied runtime implementation is not established.']; value.causal.outcome = 'blocked'; }
    return { value, audit: { requestId: options.requestId, phase: input.phase, outcome: 'completed' } };
  });
  await f.runner.ensure(); await f.runner.control('pause');
  assert.ok(f.runner.published(engine.read(f.root, 'I-1')));
  assert.equal(f.runner.state.jobs['I-2'].state, 'failed');
  assert.equal(f.runner.state.jobs['I-3'].state, 'paused'); assert.equal(f.runner.state.jobs['I-4'].state, 'blocked');
  const jobs = structuredClone(f.runner.state.jobs), limit = f.runner.state.resources.limit, count = f.calls.length;
  assert.throws(() => f.runner.continueFinding('removed-finding'), /no longer in this report/);
  assert.deepEqual(f.runner.state.jobs, jobs); assert.equal(f.runner.state.mode, 'paused');
  const a = engine.read(f.root, 'I-1').publication.digest;
  const note = path.join(f.root, '.flowboard/human-note.txt'); fs.writeFileSync(note, 'Keep my research notes and verdict.'); const human = fs.readFileSync(note);
  const before = engine.read(f.root, 'I-2'); assert.equal(before.checkpoint.stage, 'challenge');
  const raw = fs.readFileSync(path.join(f.root, '.flowboard/investigations/I-2.json'));
  const { report: manifest, entries } = require('../extension/report-preparation').reconcile(f.root), entry = entries.find(e => e.id === 'I-2');
  const packet = await require('../scripts/saved-stage-packet').inspectSavedStage({ root: f.root, catalog: f.catalog,
    request: f.runner.request(entry, f.catalog, manifest), issue: f.runner.issue(entry), findingId: 'I-2', saved: before });
  assert.equal(packet.packet.phase, 'challenge'); assert.equal(f.calls.length, count);
  assert.ok(raw.equals(fs.readFileSync(path.join(f.root, '.flowboard/investigations/I-2.json'))));
  recover = true; await f.runner.continueFinding('I-2');
  assert.deepEqual(f.calls.slice(count).map(c => [c.id, c.phase]), [['I-2', 'challenge']]);
  assert.equal(f.runner.state.mode, 'paused'); assert.equal(f.runner.state.resources.limit, limit);
  for (const id of ['I-3', 'I-4']) assert.deepEqual(f.runner.state.jobs[id], jobs[id]);
  assert.equal(engine.read(f.root, 'I-1').publication.digest, a); assert.ok(human.equals(fs.readFileSync(note)));
  assert.ok(f.runner.published(engine.read(f.root, 'I-2')));
  await f.runner.ensure(); assert.equal(f.calls.length, count + 1);
  f.runner.state.resources.limit = f.runner.state.resources.requests; f.runner.save();
  await f.runner.continueFinding('I-3'); assert.equal(f.calls.length, count + 1);
  assert.equal(f.runner.state.resources.limit, f.runner.state.resources.requests); assert.match(f.runner.state.jobs['I-3'].reason, /Shared report allowance exhausted/);
});
test('saved production challenge uses guarded 600s then specific 240s repair, with no generation or third reservation', { skip: !native }, async t => {
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const provider = require('../extension/semantic-provider'), { ChallengePilotGuard } = require('../scripts/challenge-pilot-guard');
  const ledger = { limit: 2, used: 0, receipts: [] }, guard = new ChallengePilotGuard('I-1', ledger, () => {});
  let pilot = false;
  const f = await fixture(t, 1, async (input, options) => {
    if (!pilot) {
      if (input.phase === 'challenge') throw Object.assign(new Error('Controlled previous challenge failed'), { audit: { phase: 'challenge', outcome: 'failed' } });
      return { value: response(input), audit: { phase: 'generate', outcome: 'completed' } };
    }
    const receipt = guard.reserve(input, options.requestId);
    const value = ledger.used === 1 ? { result: 'kept', problems: [], explanationReviews: [], checks: [{ target: 'event:event',
      reason: 'The source guard rejects false, but this response omitted the evidence-note review.', evidence: ['guard'], documentation: [] }] } : response(input);
    const result = await provider.runProvider(input, { ...options, timeoutMs: receipt.timeoutMs, spawn: (_exe, args) => {
      assert.ok(args.includes('--output-schema'));
      const child = new EventEmitter(); child.pid = process.pid; child.stdin = new PassThrough(); child.stdin.resume(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on('finish', () => queueMicrotask(() => { child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }) + '\n' + JSON.stringify({type:'turn.completed',usage:{output_tokens:1}}) + '\n'); child.emit('close', 0); }));
      return child;
    } });
    guard.result(receipt, result.value, result.audit); return result;
  });
  await f.runner.ensure(); await f.runner.control('pause'); const count = f.calls.length, requests = f.runner.state.resources.requests;
  pilot = true; f.options.authorizeRequest = ({ input }) => guard.check(input);
  await f.runner.continueFinding('I-1');
  assert.deepEqual(f.calls.slice(count).map(c => c.phase), ['challenge', 'challenge'], JSON.stringify({job:f.runner.state.jobs['I-1'],ledger}));
  assert.deepEqual(ledger.receipts.map(r => r.audit.deadline.milliseconds), [600000, 240000]);
  assert.equal(f.runner.state.resources.requests, requests + 2); assert.ok(f.runner.published(engine.read(f.root, 'I-1')));
  await f.runner.ensure(); assert.equal(f.calls.length, count + 2);
});
test('pause during explicit authorization prevents a late reservation and dispatch', { skip: !native }, async t => {
  const f = await fixture(t);
  f.options.authorizeRequest = async () => { await f.runner.control('pause'); };
  await f.runner.ensure();
  assert.equal(f.calls.length, 0); assert.equal(f.runner.state.resources.requests, 0);
  assert.equal(f.runner.state.mode, 'paused'); assert.equal(f.runner.tasks.size, 0);
});
test('selected setup failure consumes one intent: disabled provider, permanent catalog error and live owner', { skip: !native }, async t => {
  for (const mode of ['disabled', 'catalog', 'owner']) await t.test(mode, async t => {
    const f = await fixture(t), original = f.runner.run.bind(f.runner); let attempts = 0;
    // A breaker makes the historical infinite finally/restart defect safe to reproduce.
    f.runner.run = async (...args) => { if (++attempts > 3) { f.runner.disposed = true; throw new Error('Test restart breaker'); } return original(...args); };
    let lock, metadata, before;
    if (mode === 'disabled') f.options.configuration = () => ({ provider: 'none', requestLimit: 20 });
    if (mode === 'catalog') f.options.catalog = async () => { throw new Error('Permanent controlled index failure'); };
    if (mode === 'owner') {
      lock = path.join(f.root, '.flowboard/report-preparation.lock.json');
      const ownership = require('../extension/provider-ownership'); metadata = ownership.ownerMetadata(); ownership.publish(lock, metadata);
      before = fs.readFileSync(lock); t.after(() => ownership.removeOwned(lock, metadata.owner));
    }
    await f.runner.continueFinding('I-1');
    assert.equal(attempts, 1, 'An unchanged failed intent cannot schedule itself again.');
    assert.equal(f.calls.length, 0); assert.equal(f.runner.pendingFindings.size, 0);
    assert.match(f.runner.status().reason, mode === 'disabled' ? /provider/ : mode === 'catalog' ? /index failure/ : /another local host/);
    if (lock) { assert.ok(before.equals(fs.readFileSync(lock))); assert.ok(!fs.existsSync(path.join(f.root, '.flowboard/report-preparation.json'))); }
  });
});
test('Pause, Cancel and disposal during real health-lock admission revoke its authority', { skip: !native }, async t => {
  for (const action of ['pause', 'cancel', 'dispose']) await t.test(action, async t => {
    let recovering = false;
    const f = await fixture(t, 1, input => {
      if (!recovering && input.phase === 'challenge') throw new Error('Saved challenge interruption');
      return { value: response(input), audit: { phase: input.phase, outcome: 'completed' } };
    });
    await f.runner.ensure(); await f.runner.control('pause'); recovering = true;
    const used = f.calls.length, spent = f.runner.state.resources.requests;
    const ownership = require('../extension/provider-ownership'), metadata = ownership.ownerMetadata();
    const lock = path.join(f.directory, `health-${health.identity('codex')}.lock`); ownership.publish(lock, metadata);
    t.after(() => ownership.removeOwned(lock, metadata.owner));
    let entered; const observed = new Promise(resolve => { entered = resolve; }); const reset = health.reset;
    health.reset = (...args) => { entered(); return reset(...args); }; t.after(() => { health.reset = reset; });
    const pending = f.runner.continueFinding('I-1'); await observed;
    const duplicate = f.runner.continueFinding('I-1');
    if (action === 'dispose') f.runner.dispose(); else await f.runner.control(action);
    ownership.removeOwned(lock, metadata.owner); await pending; await duplicate;
    assert.equal(f.calls.length, used, 'Admission must not restore eligibility after control revoked it.');
    assert.equal(f.runner.state.resources.requests, spent); assert.equal(f.runner.localEligible.size, 0);
    assert.equal(f.runner.pendingFindings.size, 0); assert.equal(f.runner.tasks.size, 0);
  });
});

test('board receives finite host-local admission and save conflicts without touching the other owner', { skip: !native }, async t => {
  const f = await fixture(t), { TriageBoard } = require('../extension/board'), messages = [], errors = [];
  f.options.configuration = () => ({ provider: 'none', requestLimit: 2 }); await f.runner.ensure();
  f.runner.state.jobs['I-1'].state = 'paused'; f.runner.state.jobs['I-1'].reason = 'Finding request allowance exhausted.'; f.runner.save();
  const journal = fs.readFileSync(path.join(f.root, '.flowboard/report-preparation.json'));
  const model = { id: 'I-1', displayedArtifact: null };
  const board = Object.assign(Object.create(TriageBoard.prototype), { activeId: 'I-1', models: new Map([['I-1', model]]), callbacks: { reportPreparation: () => f.runner },
    investigationCurrent: () => true, post: async m => messages.push(m), vscode: { window: { showErrorMessage: e => errors.push(e) } } });
  f.options.changed = () => board.reportProgress();
  const ownership = require('../extension/provider-ownership'), lock = path.join(f.root, '.flowboard/report-preparation.lock.json'), owner = ownership.ownerMetadata();
  ownership.publish(lock, owner); t.after(() => ownership.removeOwned(lock, owner.owner)); const bytes = fs.readFileSync(lock);
  await board.startInvestigation(model, true); await f.runner.loop; await new Promise(resolve => setImmediate(resolve));
  assert.match(messages.at(-1)?.report?.reason || '', /another local host/); assert.deepEqual(errors, []);
  assert.ok(bytes.equals(fs.readFileSync(lock))); assert.equal(f.calls.length, 0); assert.equal(f.runner.pendingFindings.size, 0);
  assert.ok(journal.equals(fs.readFileSync(path.join(f.root, '.flowboard/report-preparation.json'))));
  const rendered = require('./helpers/preparation-renderer')(messages.at(-1).report, 'I-1');
  assert.equal((rendered.text.match(/This host cannot continue/g) || []).length, 2);
  assert.match(rendered.text, /another local host/); assert.match(rendered.text, /Finding request allowance exhausted/);
  assert.ok(!rendered.buttons.some(button => button.text === 'Continue this finding'));
  assert.equal(rendered.buttons.find(button => button.text === 'Resume entire report').disabled, true);
  // save's no-ownership early return must use the same local notification path.
  messages.length = 0; f.runner.save(); await new Promise(resolve => setImmediate(resolve));
  assert.match(messages.at(-1)?.report?.reason || '', /another local host/); assert.ok(bytes.equals(fs.readFileSync(lock)));
  messages.length = 0; f.runner.locked = true; f.runner.save(); await new Promise(resolve => setImmediate(resolve));
  assert.match(messages.at(-1)?.report?.reason || '', /ownership changed/); assert.ok(bytes.equals(fs.readFileSync(lock)));
});
test('stale-journal save refusal notifies the board without overwriting the newer journal', { skip: !native }, async t => {
  const f = await fixture(t), messages = [], { TriageBoard } = require('../extension/board');
  const board = Object.assign(Object.create(TriageBoard.prototype), { models: new Map(), callbacks: { reportPreparation: () => f.runner }, post: async message => messages.push(message) });
  f.options.changed = () => board.reportProgress(); await f.runner.ensure();
  const file = path.join(f.root, '.flowboard/report-preparation.json'), newer = JSON.parse(fs.readFileSync(file));
  newer.reason = 'Newer owner has a saved action'; fs.writeFileSync(file, JSON.stringify(newer)); const bytes = fs.readFileSync(file);
  messages.length = 0; f.runner.save(); await new Promise(resolve => setImmediate(resolve));
  assert.match(messages.at(-1)?.report?.reason || '', /Another host updated/); assert.ok(bytes.equals(fs.readFileSync(file)));
  assert.equal(f.calls.length, 2); assert.equal(f.runner.published(engine.read(f.root, 'I-1')), true);
});
test('a genuinely new intent survives failed setup; repeated selection is idempotent', { skip: !native }, async t => {
  const f = await fixture(t, 2); let release, entered, catalogs = 0;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.options.catalog = async () => { if (++catalogs === 1) { entered(); await blocked; throw new Error('One controlled setup interruption'); } return f.catalog; };
  const first = f.runner.continueFinding('I-1'); await started;
  const second = f.runner.continueFinding('I-2'), duplicate = f.runner.continueFinding('I-2'); release();
  await Promise.all([first, second, duplicate]);
  assert.equal(catalogs, 2); assert.deepEqual(f.calls.map(c => [c.id, c.phase]), [['I-2', 'generate'], ['I-2', 'challenge']]);
  assert.equal(f.runner.state.jobs['I-1'].requests, 0); assert.ok(f.runner.published(engine.read(f.root, 'I-2')));
});
test('a finding removed while indexing cannot be admitted or reserve a request', { skip: !native }, async t => {
  const f = await fixture(t); let release, entered;
  const blocked = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.options.catalog = async () => { entered(); await blocked; return f.catalog; };
  const pending = f.runner.continueFinding('I-1'); await started;
  const file = path.join(f.root, '.flowboard/report.json'), report = JSON.parse(fs.readFileSync(file)); report.issues = [];
  fs.writeFileSync(file, JSON.stringify(report)); release(); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.runner.state.resources.requests, 0); assert.equal(f.runner.pendingFindings.size, 0);
  assert.match(f.runner.status().reason, /report changed/);
});
test('fixed finding evaluation enforces identity, one generation/challenge, finite failure and unchanged defaults before reservation', { skip: !native }, async t => {
  const { FindingEvaluationGuard } = require('../scripts/finding-evaluation-guard'), binding = require('../scripts/fixtures/source-bound-output');
  let guard, ledger;
  const f = await fixture(t, 2, (input, options) => {
    const receipt = guard.reserve(input, options.requestId); assert.equal(receipt.timeoutMs, 600000); assert.equal(options.timeoutMs, undefined);
    const value = input.checkOnly ? response(input) : binding.encode(response(input), input), audit = { outcome: 'completed' }; guard.result(receipt, input, value, audit);
    return { value, audit };
  });
  f.options.configuration = () => ({ provider: 'none', requestLimit: 2, workers: 1 }); await f.runner.ensure();
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 2, workers: 1 });
  f.options.authorizeRequest = ({ input }) => {
    if (!guard) {
      ledger = { eligible: true, referenceHash: 'controlled-reference', frozenSnapshot: engine.hash(input.snapshot), findingId: 'I-1', phases: ['generate', 'challenge'], limit: 2, used: 0, receipts: [] };
      guard = new FindingEvaluationGuard(ledger, () => {});
      assert.throws(() => guard.check({ ...input, finding: { id: 'I-2' } }), /identity/);
      assert.throws(() => guard.check({ ...input, phase: 'challenge' }), /next specified/);
      const failed = structuredClone(ledger); failed.used = 1; failed.receipts = [{ outcome: 'failed', completeGeneration: false }];
      assert.throws(() => new FindingEvaluationGuard(failed, () => {}).check({ ...input, phase: 'challenge', earlierDraft: {} }), /complete structured/);
    }
    guard.check(input);
  };
  await f.runner.continueFinding('I-1');
  assert.equal(ledger.used, 2); assert.deepEqual(f.calls.map(call => call.phase), ['generate', 'challenge']);
  assert.equal(f.runner.state.resources.requests, 2); assert.equal(f.runner.state.jobs['I-2'].requests, 0);
  assert.ok(f.runner.published(engine.read(f.root, 'I-1')), engine.read(f.root, 'I-1').error); assert.ok(engine.read(f.root, 'I-1').bindingPlan);
  const before = f.calls.length; await f.runner.continueFinding('I-2'); assert.equal(f.calls.length, before);
  assert.equal(f.runner.state.resources.requests, 2);
});
test('reviewed enclosing source resolves an exact original native function without moving the note or buying another answer', { skip: !native }, async t => {
  const f = await fixture(t), policy = require('../extension/guide-policy'), { TriageBoard } = require('../extension/board');
  await f.runner.ensure(); const draft = engine.read(f.root, 'I-1'), original = structuredClone(draft.evidence[0]), doc = f.catalog.document('src/Guard.sol');
  const context = engine.makeContext(f.catalog, f.runner.request(require('../extension/report').parseReport(report(1), { manifest: true }).issues[0], f.catalog, require('../extension/store').readReport(f.root)));
  const id = context.add({ name:'Code details', kind:'context', contextKind:'excerpt', file:doc.uri.fsPath, startLine:1, endLine:doc.lineCount, contract:null, calls:[], memberCalls:[], modifiers:[] },'Controlled supplied enclosing file.');
  const unit = context.units.find(item => item.id === id); unit.readThrough = unit.source.endLine;
  draft.sources.push(unit); draft.evidence[0].sourceId = id; draft.claims[0].entry = id;
  // Real response interpretation and substantive-check ingestion on the new
  // full-source identity, without editing a paid response or fabricating checks.
  const format = require('../extension/challenge-format'), schema = require('../extension/semantic-provider').schema, output = format.earlier(draft, schema);
  output.explanationReviews = [{ evidenceId:'guard', result:'kept', reason:'Read the complete supplied function in its enclosing file; require(false) rejects.', checkedSourceIds:[id] }];
  const accepted = { ...draft, ...engine.checkExplanations(output, draft, engine.accept(output, draft, draft.sources), draft.sources) };
  accepted.phase = 'ready'; accepted.publication = policy.gate(accepted); accepted.publication.digest = policy.digest(accepted);
  assert.equal(accepted.publication.ready, true, accepted.publication.problems.join('\n'));
  const exposed = policy.expose(accepted), projected = exposed.nativeSources.event;
  assert.ok(projected); assert.equal(projected.contextKind, undefined);
  assert.equal(projected.id, original.sourceId, 'An already supplied identical function keeps its canonical frame identity.');
  const fn = TriageBoard.prototype.resolveGuideUnit({ catalog:f.catalog }, projected);
  assert.equal(fn.name,'finish'); assert.equal(f.catalog.code(fn),projected.code);
  assert.equal(projected.source.line,3); assert.equal(projected.source.endLine,5);
  assert.deepEqual(accepted.evidence[0].source,original.source); assert.equal(accepted.evidence[0].quote,original.quote);
  assert.ok(require('../extension/webview/walkthrough-model').build(exposed, '').steps[0].unit.projectedFrom);
  const enclosingOnly = structuredClone(accepted); enclosingOnly.sources = enclosingOnly.sources.filter(u => u.id !== original.sourceId);
  const standalone = require('../extension/event-source').eventSource(enclosingOnly, enclosingOnly.causal.events[0]);
  assert.equal(TriageBoard.prototype.resolveGuideUnit({ catalog: f.catalog }, standalone).name, 'finish', 'Derived ABI signature must match the native catalog, not the entire declaration header.');
  assert.equal(policy.gate(enclosingOnly).ready, true);
  unit.readThrough = unit.source.endLine - 1; assert.equal(policy.gate(accepted).ready,false,'Supplied/read coverage is still required.');
  unit.readThrough = unit.source.endLine; unit.contextKind = 'state'; assert.equal(policy.gate(accepted).ready,false,'A storage declaration is still not an executed function.');
  assert.equal(f.calls.length,2);
});
test('sealed projected input drift is withdrawn durably on first reopen without reserving generation; good sibling survives', { skip: !native }, async t => {
  const f = await fixture(t, 2), policy = require('../extension/guide-policy'); await f.runner.ensure();
  const draft = engine.read(f.root, 'I-1'), doc = f.catalog.document('src/Guard.sol');
  const context = engine.makeContext(f.catalog, f.runner.request(require('../extension/report').parseReport(report(2), { manifest: true }).issues[0], f.catalog, require('../extension/store').readReport(f.root)));
  const id = context.add({ name: 'Code details', kind: 'context', contextKind: 'excerpt', file: doc.uri.fsPath, startLine: 1, endLine: doc.lineCount, contract: null, calls: [], memberCalls: [], modifiers: [] }, 'Controlled enclosing source.');
  const whole = context.units.find(unit => unit.id === id); whole.readThrough = whole.source.endLine;
  draft.sources.push(whole); draft.evidence[0].sourceId = whole.id;
  draft.causal.events.push({ ...structuredClone(draft.causal.events[0]), id: 'drift', conditions: ['accepted is true'] });
  draft.causal.order.push('drift'); draft.causal.relationships.push({ from: 'event', to: 'drift', kind: 'branch', explanation: 'Controlled historical incorrect drift.', evidence: ['guard'], callSiteId: '', binding: '',
    dispatch: { kind: 'not-applicable', receiver: '', implementation: '', evidence: [], context: 'none', failure: 'not-applicable' } });
  draft.causal.checks = require('../extension/review-capacity').targets(draft.causal).map(item => ({ target: item.key, reason: 'Controlled pre-fix review fixture.', evidence: ['guard'], documentation: [] }));
  delete draft.bindingPlan;
  draft.publication = { ready: true, policy: policy.POLICY, problems: [], digest: policy.digest(draft) }; draft.revision++; engine.write(f.root, draft);
  const preserved = JSON.stringify([draft.claims, draft.evidence, draft.causal, draft.runs]), resources = structuredClone(f.runner.state.resources);
  f.runner.dispose(); const messages = [], reopened = new ReportPreparation(f.root, { ...f.options, changed: status => messages.push(status) });
  t.after(() => reopened.dispose()); await reopened.ensure();
  const after = engine.read(f.root, 'I-1'), job = reopened.status().jobs.find(job => job.id === 'I-1');
  assert.equal(after.failureCode, 'LOCAL_GATE_WITHDRAWN', JSON.stringify(job)); assert.equal(after.checkpoint.stage, 'challenge'); assert.equal(after.phase, 'blocked');
  assert.equal(job.state, 'blocked'); assert.ok(job.validationProblems.length); assert.match(job.reason, /parameter premise/);
  assert.equal(policy.expose(after).causal, undefined); assert.equal(reopened.published(engine.read(f.root, 'I-2')), true);
  assert.equal(JSON.stringify([after.claims, after.evidence, after.causal, after.runs]), preserved);
  assert.deepEqual(reopened.state.resources, resources); assert.equal(f.calls.length, 4);
  const bytes = fs.readFileSync(path.join(f.root, '.flowboard/investigations/I-1.json')); await reopened.ensure();
  assert.ok(bytes.equals(fs.readFileSync(path.join(f.root, '.flowboard/investigations/I-1.json')))); assert.equal(f.calls.length, 4);
  assert.ok(messages.some(status => status.jobs.find(job => job.id === 'I-1')?.validationProblems?.length));
});
test('single saved-review guard rejects the next internal repair before coordinator reservation', { skip: !native }, async t => {
  const { SingleReviewRepairGuard } = require('../scripts/challenge-pilot-guard'), format = require('../extension/challenge-format'), { schema } = require('../extension/semantic-provider');
  let pilot = false, guard;
  const f = await fixture(t, 1, input => {
    if (!pilot) {
      if (input.phase === 'challenge') throw new Error('Controlled interruption at challenge');
      return { value: response(input), audit: { phase: input.phase, outcome: 'completed' } };
    }
    const receipt = guard.reserve(input, 'r1'); assert.equal(receipt.timeoutMs, 600000);
    const audit = { phase: 'challenge', outcome: 'completed' }; guard.result(receipt, 'unusable prose', audit);
    return { value: 'unusable prose', audit };
  });
  await f.runner.ensure(); await f.runner.control('pause');
  const draft = engine.read(f.root, 'I-1'); draft.checkpoint.feedback = { problems: ['A specific checked-note repair is required.'], validationProblems: [{ code: 'EXPLANATION_REVIEW_MISSING' }], rejectedOutput: { invalid: true } }; draft.revision++; engine.write(f.root, draft);
  const ledger = { limit: 1, used: 0, receipts: [], prerequisites: { controlsPassed: true, localReplayHash: 'controlled', necessarySourcesRead: true,
    noIndispensableMissingEvidence: true, savedBaseHash: engine.hash(format.earlier(draft, schema)), snapshotHash: engine.hash(draft.snapshot) } };
  guard = new SingleReviewRepairGuard('I-1', ledger, () => {}); f.options.authorizeRequest = ({ input }) => guard.check(input);
  const requests = f.runner.state.resources.requests, calls = f.calls.length; pilot = true;
  await f.runner.continueFinding('I-1');
  assert.equal(ledger.used, 1); assert.equal(f.calls.length, calls + 1); assert.equal(f.calls.at(-1).phase, 'challenge');
  assert.equal(f.runner.state.resources.requests, requests + 1); assert.equal(f.runner.tasks.size, 0);
  assert.equal(f.runner.published(engine.read(f.root, 'I-1')), false);
});
test('an unpaid recovered incomplete review exposes its real blockers, not a transport retry invitation', { skip: !native }, async t => {
  const f = await fixture(t); await f.runner.ensure(); const calls = f.calls.length;
  const draft = engine.read(f.root, 'I-1'); draft.claims[0].unknowns = ['A separately asserted external receiver is not established.'];
  draft.phase = 'blocked'; draft.failureKind = 'paused'; draft.failureCode = 'LOCAL_RECOVERY_PENDING'; draft.yielded = true;
  draft.runs.at(-1).reusedResponse = true; draft.checkpoint.stage = 'challenge'; draft.checkpoint.feedback = {}; delete draft.publication;
  draft.revision++; engine.write(f.root, draft); const claimHash = engine.hash(draft.claims);
  f.runner.dispose(); f.options.configuration = () => ({ provider: 'none', requestLimit: 20 });
  const reopened = new ReportPreparation(f.root, f.options); t.after(() => reopened.dispose()); await reopened.ensure();
  const recovered = engine.read(f.root, 'I-1');
  assert.equal(recovered.failureKind, 'material-evidence'); assert.match(recovered.error, /external receiver/);
  assert.equal(engine.hash(recovered.claims), claimHash); assert.equal(reopened.published(recovered), false);
  assert.equal(f.calls.length, calls); assert.equal(recovered.publication.ready, false);
  const revision = recovered.revision; await reopened.ensure(); assert.equal(engine.read(f.root, 'I-1').revision, revision);
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
test('an actual launcher/descendant timeout records one terminal receipt and releases one owned request slot', { skip: !native || process.platform !== 'linux' }, async t => {
  const { spawn } = require('node:child_process'), ownership = require('../extension/provider-ownership');
  let descendant;
  const f = await fixture(t, 1, (input, options) => require('../extension/semantic-provider').runCodex(input, {
    ...options, timeoutMs: 700, terminationGraceMs: 150, terminationSettleMs: 150,
    spawn(executable, args, settings) {
      const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-descendants.js'), 'ignore-term'], settings);
      let buffered = '';
      child.stdout.on('data', chunk => { buffered += chunk; if (buffered.includes('\n')) descendant ||= JSON.parse(buffered.split('\n')[0]).fixtureChildPid; });
      return child;
    }
  }));
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 1, workers: 1 });
  t.after(() => { if (descendant) { const state = ownership.processIdentity(descendant); if (state && !['Z', 'X'].includes(state.state)) process.kill(descendant, 'SIGKILL'); } });
  await f.runner.ensure();
  assert.equal(f.calls.length, 1); assert.equal(f.runner.state.resources.requests, 1);
  const receipts = Object.values(f.runner.state.resources.receipts);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].outcome, 'failed'); assert.ok(receipts[0].finishedAt);
  assert.ok(descendant); assert.ok(!ownership.processIdentity(descendant) || ['Z', 'X'].includes(ownership.processIdentity(descendant).state));
  assert.equal(f.runner.tasks.size, 0); assert.equal(f.runner.status().concurrency.dispatched || 0, 0);
  assert.equal(fs.readdirSync(f.directory).filter(file => /^codex-\d.json$/.test(file)).length, 0);
  const draft = engine.read(f.root, 'I-1'); assert.equal(draft.runs.length, 1); assert.equal(draft.runs[0].teardown.confirmed, true);
});
