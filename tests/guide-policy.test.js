'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const policy = require('../extension/guide-policy');
const walk = require('../extension/webview/walkthrough-model');
// Independently specified small source interpretation; this is a structural
// fixture, NOT a real model check. A rejected boolean always reverts.
function checked() {
  const source = { file: 'src/Guard.sol', line: 2, endLine: 4, sourceHash: 'a'.repeat(64) };
  const quote = '    require(accepted, "rejected");';
  const evidence = { id: 'guard', claimId: 'c1', sourceId: 'fn', source: { ...source, line: 3, endLine: 3 }, quote,
    stance: 'contradicts', note: 'A false accepted value reverts the call.', explanationReview: { result: 'kept' } };
  const obligations = ['applicability','entry','conditions','behavior','settlement','rule','impact','counterevidence'].map(kind => ({ id: kind, claimId: 'c1', kind,
    question: `Check ${kind}`, state: kind === 'impact' ? 'not-applicable' : 'established', reason: 'The false-accepted branch unconditionally reverts, so its writes cannot persist.', evidence: ['guard'], documentation: [] }));
  const draft = { findingId: 'I-01', phase: 'ready', revision: 1, snapshot: { policy: policy.POLICY, project: 'project', sourceDigest: 'a', reportHash: 'b' },
    sources: [{ id: 'fn', name: 'Guard::finish', complete: true, source, code: 'function finish(bool accepted) external {\n' + quote + '\n}' }],
    evidence: [evidence], claims: [{ id: 'c1', status: 'contradicted', unknowns: [] }],
    property: { basis: 'report-assumption', text: 'Reverted writes do not persist.' }, conclusion: { limitations: [] }, actions: [],
    walkthrough: { assessment: { result: 'invalid', why: 'The guard rejects the stated condition.', opposingEvidence: 'guard', supportingEvidence: '' } },
    causal: { scope: 'Only the false-accepted call.', summary: 'The guard refutes a committed change after rejection.', outcome: 'refuted', obligations,
      events: [{ id: 'e1', invocationId: 'finish1', transaction: 'tx1', claimId: 'c1', evidenceId: 'guard', title: 'Rejection reverts', role: 'Decisive guard',
        what: evidence.note, why: 'The reported persisted write cannot survive this revert.', actor: 'Caller', caller: 'msg.sender', receiver: 'Guard', effect: 'rolled-back', inputs: [], changes: [] }],
      relationships: [], order: ['e1'], checks: [...obligations.map(item => item.id), 'e1'].map(target => ({ target, reason: evidence.note, evidence: ['guard'], documentation: [] })) } };
  draft.publication = policy.gate(draft); draft.publication.digest = policy.digest(draft); return draft;
}
test('only a complete checked snapshot crosses the publication boundary, including older results', () => {
  const ready = checked(); assert.equal(ready.publication.ready, true);
  assert.equal(policy.expose(ready).causal.order[0], 'e1');
  for (const phase of ['generating', 'checking-source', 'challenging', 'blocked', 'provider-required']) {
    const partial = { ...ready, phase }, exposed = policy.expose(partial);
    assert.equal(exposed.causal, undefined); assert.deepEqual(exposed.evidence, []); assert.deepEqual(exposed.claims, []);
    assert.ok(exposed.preparation); assert.equal(ready.evidence.length, 1, 'Private evidence is retained.');
  }
  const old = checked(); delete old.causal; delete old.publication;
  assert.equal(walk.build(old, ''), null); assert.equal(policy.expose(old).causal, undefined);
});
test('missing obligations, open branches and unsupported impact block the whole guide', () => {
  for (const alter of [d => d.causal.obligations.pop(), d => d.claims.push({ id: 'c2', status: 'unresolved', unknowns: ['Adapter absent'] }),
    d => d.causal.obligations[0].state = 'open', d => d.evidence[0].quote = 'accepted = true;',
    d => d.causal.checks = [], d => d.causal.events[0].claimId = 'other', d => d.causal.events[0].effect = 'guessed']) {
    const draft = checked(); alter(draft); assert.equal(policy.gate(draft).ready, false); assert.equal(policy.expose(draft).causal, undefined);
  }
  const draft = checked(); draft.causal.outcome = 'supported'; assert.equal(policy.gate(draft).ready, false);
});
test('editing even a location-valid explanation invalidates the immutable published snapshot', () => {
  const draft = checked(); draft.evidence[0].note = 'This guard always allows the call.';
  // Location checks cannot detect this lie. Its changed digest forbids reusing
  // the previously checked interpretation; a new reasoning review is needed.
  assert.equal(policy.expose(draft).causal, undefined);
});
test('a real declaration cannot carry a claim of an operation or committed result', () => {
  const draft = checked(); draft.sources[0].contextKind = 'state';
  draft.causal.events[0].effect = 'committed';
  assert.ok(policy.gate(draft).problems.some(problem => /declaration is context/.test(problem)));
  draft.causal.events[0].effect = 'read'; assert.equal(policy.gate(draft).ready, true);
});
test('the displayed issue assessment must agree with the explanation and its decisive evidence', () => {
  const draft = checked(); draft.walkthrough.assessment.result = 'valid';
  assert.equal(policy.gate(draft).ready, false);
  draft.walkthrough.assessment.result = 'invalid'; draft.walkthrough.assessment.opposingEvidence = 'missing';
  assert.equal(policy.gate(draft).ready, false);
});
test('repeated invocations retain event identities, and calls cannot cross transactions', () => {
  const draft = checked(), first = draft.causal.events[0];
  draft.causal.events.push({ ...first, id: 'e2', invocationId: 'finish2', transaction: 'tx2' });
  draft.causal.order.push('e2');
  const link = { from: 'e1', to: 'e2', kind: 'call', explanation: 'Later separate invocation of the same entry.', evidence: ['guard'] };
  draft.causal.relationships.push(link);
  for (const target of ['e2','e1->e2']) draft.causal.checks.push({ target, reason: 'Each rejected call reverts.', evidence: ['guard'], documentation: [] });
  assert.equal(policy.gate(draft).ready, false);
  link.kind = 'later-transaction'; assert.equal(policy.gate(draft).ready, true);
  draft.publication = policy.gate(draft);
  assert.equal(walk.build(draft, '').steps.length, 2, 'One function and quotation can describe separate invocations without merging them.');
});
test('a return cannot use the caller invocation but highlight a different helper function', () => {
  const draft = checked(), original = draft.sources[0];
  const helper = { ...original, id: 'helper', name: 'Guard::_helper', source: { ...original.source, file: 'src/Helper.sol' } };
  draft.sources.push(helper);
  draft.evidence.push({ ...draft.evidence[0], id: 'helper-note', sourceId: helper.id, source: { ...draft.evidence[0].source, file: helper.source.file } });
  draft.causal.events.push({ ...draft.causal.events[0], id: 'e2', evidenceId: 'helper-note', title: 'Return to the caller' });
  draft.causal.order.push('e2');
  draft.causal.relationships.push({ from: 'e1', to: 'e2', kind: 'return', explanation: 'Return to the original invocation.', evidence: ['guard', 'helper-note'] });
  for (const target of ['e2','e1->e2']) draft.causal.checks.push({ target, reason: 'Controlled fixture for frame identity, not AI quality.', evidence: ['guard', 'helper-note'], documentation: [] });
  assert.ok(policy.gate(draft).problems.some(problem => /invocation.*was anchored.*helper/.test(problem)));
  draft.causal.events[1].invocationId = 'helper-invocation';
  draft.causal.relationships[0].kind = 'context';
  assert.equal(policy.gate(draft).ready, true, 'A separately identified helper context is not the original caller invocation.');
  helper.code = helper.code.replace('function finish(bool accepted) external', 'modifier acceptedOnly()');
  draft.causal.events[1].invocationId = draft.causal.events[0].invocationId;
  assert.equal(policy.gate(draft).ready, true, 'An actual modifier belongs to its enclosing invocation.');
});
