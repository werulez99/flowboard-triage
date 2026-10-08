'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const format = require('../extension/challenge-format');
const { schema } = require('../extension/semantic-provider');
const engine = require('../extension/investigation-engine');
const policy = require('../extension/guide-policy');
function example() {
  const source = { file: 'src/Guard.sol', line: 1, endLine: 3, sourceHash: 'a'.repeat(64) };
  const quote = '    require(accepted);';
  const unit = { id: 'function', name: 'Guard::finish', complete: true, source, code: `function finish(bool accepted) external {\n${quote}\n}`, declarationEndLine: 3 };
  const evidence = { id: 'guard', claimId: 'c1', sourceId: 'function', source: { ...source, line: 2, endLine: 2 }, quote, note: 'A false accepted value reverts.', stance: 'contradicts' };
  const obligations = ['applicability','entry','conditions','behavior','settlement','rule','impact','counterevidence'].map(kind => ({ id: kind, kind, claimId: 'c1', question: `Check ${kind}.`, state: 'established', reason: 'The rejected invocation reverts.', evidence: ['guard'], documentation: [] }));
  const draft = { findingId: 'fictional', corrections: [], experiments: [], sources: [unit], property: { text: 'Rejected operations do not persist.', basis: 'report-assumption', evidence: [], documentation: [] },
    claims: [{ id: 'c1', allegation: 'Rejected calls retain changes.', actor: 'Caller', entry: 'function', implementation: 'Guard::finish(bool)', conditions: ['accepted is false'], requiredFacts: ['No revert'], supportsIf: 'The call completes.', contradictsIf: 'The call reverts.', status: 'contradicted', reason: 'The require reverts.', evidence: ['guard'], unknowns: [], nextQuestion: '' }],
    evidence: [evidence], transitions: [], questions: [],
    causal: { scope: 'The false-accepted invocation, source only.', summary: 'The guard rejects this invocation.', outcome: 'refuted', obligations,
      events: [{ id: 'event', invocationId: 'call1', transaction: 'tx1', phase: 'guard', claimId: 'c1', evidenceId: 'guard', callSiteId: '', title: 'Reject the call', role: 'Decisive guard', actor: 'Caller', caller: 'msg.sender', receiver: 'Guard', conditions: ['accepted is false'], what: evidence.note, why: 'The alleged committed change cannot survive this revert.', inputs: [], changes: [], effect: 'rolled-back', paragraphId: '', phrase: '' }], relationships: [], order: ['event'], checks: [] },
    conclusion: { status: 'insufficient-evidence', scopedStatus: 'contradicted-in-scope', text: 'This rejected call cannot commit.', limitations: [] },
    walkthrough: { steps: [], assessment: { result: 'invalid', why: 'The guard rejects the stated condition.', supportingEvidence: '', opposingEvidence: 'guard' } } };
  return draft;
}
function delta(draft) {
  return { mode: format.MODE, changes: Object.fromEntries(Object.keys(format.schemaFor(schema).properties.changes.properties).map(key => [key, null])),
    causal: Object.fromEntries(Object.keys(format.schemaFor(schema).properties.causal.properties).map(key => [key, key === 'checks' ? [...draft.causal.obligations.map(item => item.id), 'event'].map(target => ({ target, reason: 'The false condition reaches require and reverts the invocation.', evidence: ['guard'], documentation: [] })) : null])),
    explanationReviews: [{ evidenceId: 'guard', result: 'kept', reason: 'The require statement rejects the false condition.', checkedSourceIds: ['function'] }] };
}
test('the stored outline is derived from the checked causal order instead of a competing model-authored outline', () => {
  const draft = example(), output = format.earlier(draft, schema);
  assert.equal(schema.properties.walkthrough.properties.steps, undefined);
  const accepted = engine.accept(output, draft, draft.sources);
  assert.deepEqual(accepted.walkthrough.steps, [{ evidenceId: 'guard', title: 'Reject the call', paragraphId: '', phrase: '' }]);
  output.walkthrough.steps = [{ evidenceId: 'guard', title: 'A conflicting legacy heading', paragraphId: '', phrase: '' }];
  assert.deepEqual(engine.accept(output, draft, draft.sources).walkthrough.steps, accepted.walkthrough.steps);
  assert.equal(accepted.walkthrough.assessment.result, 'invalid');
  assert.equal(accepted.causal.obligations.length, 8, 'Presentation projection does not remove analytical obligations.');
});
test('a compact challenge retains exact text but still needs all fresh reasoning checks', () => {
  const draft = example(), previous = format.earlier(draft, schema), update = delta(draft);
  const expanded = format.expand(update, previous, schema);
  assert.equal(expanded.evidence[0].line, 2);
  assert.equal(expanded.evidence[0].quote, draft.evidence[0].quote);
  assert.equal(expanded.evidence[0].explanation, draft.evidence[0].note);
  assert.equal(expanded.evidence[0].source, undefined, 'Host metadata is not duplicated in the review input.');
  assert.deepEqual(expanded.claims, previous.claims);
  const checked = engine.checkExplanations(expanded, draft, engine.accept(expanded, draft, draft.sources), draft.sources);
  assert.equal(policy.gate({ ...draft, ...checked }).ready, true);
  update.causal.checks = [];
  const unchecked = format.expand(update, previous, schema);
  assert.equal(policy.gate({ ...draft, ...engine.checkExplanations(unchecked, draft, engine.accept(unchecked, draft, draft.sources), draft.sources) }).ready, false);
  assert.deepEqual(draft.causal.checks, [], 'The earlier private draft is not mutated.');
});
test('malformed, missing and null review checks cannot inherit a successful older check', () => {
  const draft = example(), previous = format.earlier(draft, schema);
  for (const change of [value => delete value.changes.claims, value => value.causal.checks = null, value => value.explanationReviews = null, value => value.changes.extra = 'ignored?', value => value.changes.claims = 'same']) {
    const value = delta(draft); change(value); assert.throws(() => format.expand(value, previous, schema), /incomplete review update/);
  }
});
test('a removed old note needs its actual source span in the current verification packet',()=>{
  const draft=example(),next=structuredClone(draft);next.evidence=[];next.claims[0].evidence=[];
  const output={explanationReviews:[{evidenceId:'guard',result:'removed',reason:'Controlled removal review.',checkedSourceIds:['function']}]};
  const packet={sources:engine.modelSources(draft.sources,Infinity,true)};
  assert.doesNotThrow(()=>engine.checkExplanations(output,draft,next,draft.sources,packet));
  packet.sources[0].providedRanges=[{line:1,endLine:1},{line:3,endLine:3}];packet.sources[0].complete=false;
  packet.sources[0].code=packet.sources[0].code.split('\n').filter(line=>!line.startsWith('2 | ')).join('\n');
  assert.throws(()=>engine.checkExplanations(output,draft,next,draft.sources,packet),/evidence guard.*not supplied/);
});
test('a review update cannot silently drop a path, relabel an altered note as kept, or confirm an unsupported rule', () => {
  const draft = example(), previous = format.earlier(draft, schema);
  let update = delta(draft); update.changes.claims = [];
  const dropped = format.expand(update, previous, schema);
  assert.throws(() => engine.checkExplanations(dropped, draft, { claims: [], evidence: [] }, draft.sources), /omitted statement/);
  update = delta(draft); update.changes.evidence = [{ ...previous.evidence[0], explanation: 'This guard permits rejection.' }];
  const altered = format.expand(update, previous, schema);
  assert.throws(() => engine.checkExplanations(altered, draft, engine.accept(altered, draft, draft.sources), draft.sources), /marked repaired/);
  update = delta(draft); update.causal.outcome = 'supported';
  const unsupported = format.expand(update, previous, schema);
  assert.equal(policy.gate({ ...draft, ...engine.checkExplanations(unsupported, draft, engine.accept(unsupported, draft, draft.sources), draft.sources) }).ready, false);
});
test('targeted repair preserves untouched code and uses stable item IDs, fresh checks and the full schema', () => {
  const draft = example(), previous = format.earlier(draft, schema), update = delta(draft);
  const patch = { mode: format.PATCH, updates: [{ path: '/claims/c1/reason', valueJSON: JSON.stringify('The require rejects accepted=false before normal return.') }],
    explanationReviews: update.explanationReviews, checks: update.causal.checks };
  const result = format.apply(patch, previous, schema);
  assert.equal(result.claims[0].reason, 'The require rejects accepted=false before normal return.');
  assert.deepEqual(result.evidence, previous.evidence);
  assert.equal(policy.gate({ ...draft, ...engine.checkExplanations(result, draft, engine.accept(result, draft, draft.sources), draft.sources) }).ready, true);
  for (const path of ['/claims/0/reason', '/causal/checks', '/__proto__/polluted', '/claims/c1/invalidField']) {
    assert.throws(() => format.apply({ ...patch, updates: [{ path, valueJSON: '"bad"' }] }, previous, schema));
  }
  assert.throws(() => format.apply({ ...patch, updates: [{ path: '/claims/c1/status', valueJSON: '"definitely-safe"' }] }, previous, schema));
  const changedNote = format.apply({ ...patch, updates: [{ path: '/evidence/guard/explanation', valueJSON: '"The guard allows a false value."' }] }, previous, schema);
  assert.throws(() => engine.checkExplanations(changedNote, draft, engine.accept(changedNote, draft, draft.sources), draft.sources), /marked repaired/, 'A real code location cannot validate a changed interpretation.');
});
test('legacy context aliases require identical file, complete range, hash and original code', () => {
  const draft = example(), previous = format.earlier(draft, schema), update = delta(draft);
  const same = { ...structuredClone(draft.sources[0]), id: 'legacy-context' };
  update.explanationReviews[0].checkedSourceIds = ['legacy-context'];
  const output = format.expand(update, previous, schema);
  assert.doesNotThrow(() => engine.checkExplanations(output, draft, engine.accept(output, draft, draft.sources), [...draft.sources, same]));
  for (const change of [unit => unit.code += ' ', unit => unit.source.file = 'other/Guard.sol', unit => unit.source.line++, unit => unit.source.sourceHash = 'b'.repeat(64)]) {
    const altered = structuredClone(same); change(altered);
    assert.throws(() => engine.checkExplanations(output, draft, engine.accept(output, draft, draft.sources), [...draft.sources, altered]), /did not inspect/);
  }
});
test('all repair forms preserve evidence scope, including shared context, with actionable aggregated identities', () => {
  const scope = require('../extension/review-scope');
  const draft = example(), previous = format.earlier(draft, schema), update = delta(draft);
  const patch = { mode: format.PATCH, updates: [], explanationReviews: update.explanationReviews, checks: update.causal.checks };
  for (const claimId of ['', 'c2']) for (const updates of [
    [{ path: '/evidence/guard/claimId', valueJSON: JSON.stringify(claimId) }],
    [{ path: '/evidence/guard', valueJSON: JSON.stringify({ ...previous.evidence[0], claimId }) }],
    [{ path: '/evidence', valueJSON: JSON.stringify([{ ...previous.evidence[0], claimId }]) }]
  ]) assert.throws(() => format.apply({ ...patch, updates }, previous, schema), error => {
    const problem = error.validationProblems[0];
    assert.equal(problem.code, 'EVIDENCE_SCOPE_CHANGED'); assert.equal(problem.evidenceId, 'guard');
    assert.equal(problem.oldClaimId, 'c1'); assert.equal(problem.proposedClaimId, claimId);
    assert.ok(problem.dependentTargets.previous.includes('/causal/events/event/evidenceId'));
    assert.match(problem.permittedOperation, /fresh ID/); return true;
  });
  const shared = structuredClone(previous); shared.evidence[0].claimId = '';
  assert.throws(() => format.apply({ ...patch, updates: [{ path: '/evidence/guard/claimId', valueJSON: '"c1"' }] }, shared, schema), /claim ""/);
  const changed = structuredClone(previous); changed.evidence[0].claimId = ''; changed.evidence[0].stance = 'context';
  // No silent host downgrade or discarded decisive assessment reference.
  changed.claims[0].status='unresolved';changed.walkthrough.assessment.opposingEvidence='';
  assert.throws(()=>engine.accept(changed,draft,draft.sources),error=>error.code==='REVIEW_REFERENCE_SCOPE'&&error.validationProblems.some(p=>p.target==='/causal/events/event/evidenceId'));
  // The old fixture retained a claim-owned runtime event on shared context.
  // Remove that invalid fixture event explicitly to isolate review aggregation;
  // this deliberately incomplete explanation still cannot publish.
  changed.causal.events=[];changed.causal.order=[];changed.causal.relationships=[];
  const next = engine.accept(changed, draft, draft.sources); changed.explanationReviews = [{ ...update.explanationReviews[0], checkedSourceIds: ['absent'] }];
  assert.throws(() => engine.checkExplanations(changed, draft, next, draft.sources), error => {
    assert.deepEqual(new Set(error.validationProblems.map(p => p.code)), new Set(['EVIDENCE_SCOPE_CHANGED', 'EXPLANATION_REVIEW_INVALID', 'EXPLANATION_REVIEW_MISSING'])); return true;
  });
  assert.equal(next.evidence[0].explanationReview, undefined, 'Failed checking has no partial accepted-note mutations.');
  assert.deepEqual(scope.manifest(previous), { claims: ['c1'], evidence: [{ id: 'guard', claimId: 'c1' }] });
  assert.match(format.patchInstruction, /claimId=""/);
});
test('explicit removal and fresh scoped note preserve checks/references but cannot close an unresolved material claim', () => {
  const draft = example(), previous = format.earlier(draft, schema), replacement = structuredClone(previous);
  // One source may support a separately scoped note. Update ALL dependent
  // references explicitly; the host does not renumber the model's answer.
  replacement.claims.push({ ...replacement.claims[0], id: 'c2', status: 'unresolved', unknowns: ['External rule is unavailable.'] });
  replacement.evidence = [{ ...replacement.evidence[0], id: 'new-guard', claimId: 'c2' }];
  const replaceRefs = value => {
    if (Array.isArray(value)) return value.map(replaceRefs);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceRefs(child)]));
    return value === 'guard' ? 'new-guard' : value;
  };
  const fixed = replaceRefs(replacement), update = delta(draft);
  // c1 cannot retain a c2-only reference. Make the fixture's unresolved old
  // claim explicit instead of relying on lossy host filtering/downgrading.
  fixed.claims[0].evidence=[];fixed.claims[0].status='unresolved';fixed.claims[0].unknowns=['Its original material explanation was removed.'];
  assert.throws(()=>engine.accept(fixed,draft,draft.sources),error=>error.code==='REVIEW_REFERENCE_SCOPE'&&error.validationProblems.length===9);
  // Update causal dependents too; the earlier fixture left c1 obligations and
  // its event pointing at c2-only evidence and tested only the final gate.
  fixed.causal.obligations.push(...fixed.causal.obligations.map(o=>({...o,id:o.id+'-c2',claimId:'c2'})));
  for(const o of fixed.causal.obligations.filter(o=>o.claimId==='c1')){o.evidence=[];o.state='open';o.reason='The original material explanation remains unresolved after removal.';}
  fixed.causal.events[0].claimId='c2';
  const patch = { mode: format.PATCH, updates: Object.entries(fixed).filter(([key]) => !['explanationReviews', 'inputReviews', 'causal'].includes(key)).map(([key, value]) => ({ path: '/' + key, valueJSON: JSON.stringify(value) })),
    explanationReviews: [{ ...update.explanationReviews[0], result: 'removed' }, { ...update.explanationReviews[0], evidenceId: 'new-guard', result: 'added' }], checks: replaceRefs(update.causal.checks) };
  for (const [key, value] of Object.entries(fixed.causal)) if (key !== 'checks') patch.updates.push({ path: '/causal/' + key, valueJSON: JSON.stringify(value) });
  const output = format.apply(patch, previous, schema), next = engine.accept(output, draft, draft.sources);
  assert.doesNotThrow(() => engine.checkExplanations(output, draft, next, draft.sources));
  const candidate = { ...draft, ...next, actions: [] };
  assert.equal(policy.gate(candidate).ready, false);
  assert.equal(policy.expose(candidate).causal, undefined);
  output.explanationReviews.pop();
  assert.throws(() => engine.checkExplanations(output, draft, next, draft.sources), /new-guard/);
});
test('pure replay diagnoses the exact rejected base without mutating or publishing any input', () => {
  const { replayReview } = require('../scripts/replay-review');
  const saved = { ...example(), actions: [] }, earlierDraft = format.earlier(saved, schema), update = delta(saved);
  const source = saved.sources[0], input = { phase: 'challenge', earlierDraft, sources: [{ id: source.id, file: source.source.file, sourceHash:source.source.sourceHash,
    line: 1, endLine: 3, code: source.code.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n') }] };
  const response = { mode: format.PATCH, updates: [{ path: '/evidence/guard/claimId', valueJSON: '""' }, { path: '/evidence/guard/stance', valueJSON: '"context"' }],
    checks: update.causal.checks, explanationReviews: [{ ...update.explanationReviews[0], result: 'repaired' }] };
  const before = JSON.stringify({ saved, input, response });
  const result = replayReview({ saved, input, response, units: saved.sources });
  assert.equal(result.fullSchema, true); assert.equal(result.errors[0].code, 'EVIDENCE_SCOPE_CHANGED');
  assert.equal(result.accepted, false); assert.equal(result.writes, 0); assert.equal(result.providerRequests, 0);
  assert.equal(JSON.stringify({ saved, input, response }), before);
  const rich=structuredClone(input);rich.sources[0].initialization={scopes:Array.from({length:12},()=>({file:source.source.file,sourceHash:source.source.sourceHash,description:'Fixture context is not a verified runtime fact. '.repeat(12)}))};
  const compact=require('../extension/packet-context').compact(rich);assert.equal(compact.sourceContextFormat,'source-context-v2');
  assert.deepEqual(replayReview({saved,input:JSON.parse(JSON.stringify(compact)),response,units:saved.sources}),result);
  assert.throws(() => replayReview({ saved: { ...saved, evidence: [] }, input, response, units: saved.sources }), /exact earlierDraft/);
});
test('a substantive repair can inspect its old function inside exact complete current context', () => {
  const draft = example(), update = delta(draft), output = format.expand(update, format.earlier(draft, schema), schema);
  const contained = { ...structuredClone(draft.sources[0]), id: 'whole-file', contextKind: 'excerpt',
    code: draft.sources[0].code + '\n// surrounding source', source: { ...draft.sources[0].source, endLine: 4 } };
  output.explanationReviews[0].checkedSourceIds = [contained.id];
  assert.doesNotThrow(() => engine.checkExplanations(output, draft, engine.accept(output, draft, draft.sources), [...draft.sources, contained]));
  for (const alter of [u => u.complete = false, u => u.source.file = 'other.sol', u => u.source.sourceHash = 'b'.repeat(64),
    u => u.code = u.code.replace('require(accepted)', 'require(true)'), u => u.source.endLine = 2, u => u.code += '\nunknown bytes']) {
    const invalid = structuredClone(contained); alter(invalid);
    assert.throws(() => engine.checkExplanations(output, draft, engine.accept(output, draft, draft.sources), [...draft.sources, invalid]), /did not inspect/);
  }
});
test('already read enclosing source does not become new evidence merely by extracting a declaration', () => {
  const { contains } = require('../extension/source-coverage'), unit = example().sources[0];
  const enclosing = { ...structuredClone(unit), readThrough: 3 };
  const declaration = { ...structuredClone(unit), id: 'new-id', source: { ...unit.source, line: 2, endLine: 2 }, code: unit.code.split('\n')[1] };
  assert.equal(contains(declaration, enclosing, true), true);
  enclosing.readThrough = 1; assert.equal(contains(declaration, enclosing, true), false);
  enclosing.readThrough = 3; declaration.source.sourceHash = 'b'.repeat(64); assert.equal(contains(declaration, enclosing, true), false);
});
