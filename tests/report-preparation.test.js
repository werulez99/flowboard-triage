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
      events: [{ id: 'event', invocationId: 'finish-1', transaction: 'tx1', phase: 'guard', claimId: 'c1', evidenceId: 'guard', title: 'False does not pass the guard', role: 'Decisive contradiction',
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
test('phase group is accounted as context; ambiguous sections block instead of disappearing', () => {
  const parsed = parseReport(reportText(3), { manifest: true });
  assert.equal(parsed.issues.length, 3); assert.equal(parsed.manifest.findingCount, 3);
  const group = parsed.manifest.sections.find(section => section.title === 'Found by 2 phases');
  assert.equal(group.classification, 'context'); assert.ok(group.line && group.endLine);
  const ambiguous = parseReport('# Unclassified concern\nSomething important has no ID or finding fields.\n\n' + reportText(1), { manifest: true });
  assert.equal(ambiguous.manifest.ambiguities.length, 1);
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
test('cold import prepares all findings without a selected board; private ready artifacts cross one atomic report barrier', { skip: !native }, async t => {
  const { root, runner, calls, updates } = await fixture(t);
  await runner.ensure();
  for (const id of ['I-1', 'I-2', 'I-3']) assert.deepEqual(calls.filter(call => call[0] === id).map(call => call[1]), ['generate', 'challenge']);
  assert.equal(runner.status().published, true); assert.equal(runner.status().ready, 3);
  assert.equal(runner.status().costUSD, null, 'Unavailable cost is not reported as zero dollars.');
  assert.ok(updates.some(status => status.ready === 1 && status.published === false));
  const draft = engine.read(root, 'I-1'); assert.ok(runner.published(draft));
  assert.equal(policy.expose(draft, { ...runner.status(), published: false, stopped: [] }).causal, undefined, 'A ready subset cannot leak through the old explanation route.');
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
test('one failed explanation withholds the report, preserves other private artifacts and has a finite stop', { skip: !native }, async t => {
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
test('source changes revoke the entire published report and unchanged human records survive', { skip: !native }, async t => {
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
  assert.equal(f.runner.status().published, false, 'Private progress does not weaken the manifest barrier.');
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
