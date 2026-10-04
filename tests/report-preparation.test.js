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
async function fixture(t, count = 3, invoke) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-report-jobs-'));
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/Gate.sol'), code); fs.writeFileSync(path.join(root, 'report.md'), reportText(count));
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
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['I-1','generate'],['I-1','challenge'],['I-2','generate'],['I-2','challenge'],['I-3','generate'],['I-3','challenge']]);
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
  const f = await fixture(t, 3); f.options.configuration = () => ({ provider: 'codex', requestLimit: 1 });
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
  assert.equal(f.calls.length, 1); assert.equal(f.runner.status().mode, 'paused');
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
