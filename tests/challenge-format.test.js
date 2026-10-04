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
      events: [{ id: 'event', invocationId: 'call1', transaction: 'tx1', phase: 'guard', claimId: 'c1', evidenceId: 'guard', title: 'Reject the call', role: 'Decisive guard', actor: 'Caller', caller: 'msg.sender', receiver: 'Guard', conditions: ['accepted is false'], what: evidence.note, why: 'The alleged committed change cannot survive this revert.', inputs: [], changes: [], effect: 'rolled-back', paragraphId: '', phrase: '' }], relationships: [], order: ['event'], checks: [] },
    conclusion: { status: 'insufficient-evidence', scopedStatus: 'contradicted-in-scope', text: 'This rejected call cannot commit.', limitations: [] },
    walkthrough: { steps: [], assessment: { result: 'invalid', why: 'The guard rejects the stated condition.', supportingEvidence: '', opposingEvidence: 'guard' } } };
  return draft;
}
function delta(draft) {
  return { mode: format.MODE, changes: Object.fromEntries(Object.keys(format.schemaFor(schema).properties.changes.properties).map(key => [key, null])),
    causal: Object.fromEntries(Object.keys(format.schemaFor(schema).properties.causal.properties).map(key => [key, key === 'checks' ? [...draft.causal.obligations.map(item => item.id), 'event'].map(target => ({ target, reason: 'The false condition reaches require and reverts the invocation.', evidence: ['guard'], documentation: [] })) : null])),
    explanationReviews: [{ evidenceId: 'guard', result: 'kept', reason: 'The require statement rejects the false condition.', checkedSourceIds: ['function'] }] };
}
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
