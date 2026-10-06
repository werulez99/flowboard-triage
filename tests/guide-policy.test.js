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
      events: [{ id: 'e1', invocationId: 'finish1', transaction: 'tx1', claimId: 'c1', evidenceId: 'guard', callSiteId: '', title: 'Rejection reverts', role: 'Decisive guard',
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
test('a supported primary statement does not require a narrowed secondary impact to become supported', () => {
  const draft = checked(), second = structuredClone(draft.claims[0]); second.id = 'c2'; second.status = 'narrowed';
  draft.claims[0].status = 'supported'; draft.claims.push(second);
  draft.evidence.push({ ...structuredClone(draft.evidence[0]), id: 'secondary', claimId: 'c2' });
  for (const obligation of [...draft.causal.obligations]) {
    const other = { ...structuredClone(obligation), id: `secondary-${obligation.id}`, claimId: 'c2', evidence: ['secondary'], state: obligation.kind === 'impact' ? 'refuted' : 'established' };
    draft.causal.obligations.push(other); draft.causal.checks.push({ target: other.id, reason: other.reason, evidence: ['secondary'], documentation: [] });
    obligation.state = 'established';
  }
  draft.causal.outcome = 'supported'; draft.property = { text: 'Controlled independently supplied rule', basis: 'source-contract', evidence: ['guard'] };
  draft.evidence[0].stance = 'supports'; draft.walkthrough.assessment = { result: 'valid', why: 'Primary supported; secondary impact refuted in scope.', supportingEvidence: 'guard', opposingEvidence: 'secondary' };
  assert.equal(policy.gate(draft).ready, true, policy.gate(draft).problems.join('\n'));
  draft.causal.obligations.find(item => item.claimId === 'c1' && item.kind === 'impact').state = 'refuted';
  assert.equal(policy.gate(draft).ready, false, 'No established primary impact cannot be hidden behind a narrowed secondary.');
  draft.causal.obligations.find(item => item.claimId === 'c1' && item.kind === 'impact').state = 'established';
  draft.claims[1].unknowns = ['A material input remains unavailable']; assert.equal(policy.gate(draft).ready, false);
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

test('reading and returning in one invocation cannot change its execution receiver', () => {
  const draft = checked(), capacity = require('../extension/review-capacity');
  draft.causal.events[0].effect = 'read';
  draft.causal.events.push({ ...draft.causal.events[0], id: 'outcome', effect: 'return', receiver: 'msg.sender', title: 'Return after the guard' });
  draft.causal.order.push('outcome');
  draft.causal.relationships.push({ from: 'e1', to: 'outcome', kind: 'context', explanation: 'Check the same invocation, not an additional call.', binding: '', evidence: ['guard'] });
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key, reason: 'Synthetic identity check, not a model result.', evidence: ['guard'], documentation: [] }));
  let result = policy.gate(draft);
  assert.ok(result.details.some(problem => problem.kind === 'structural' && problem.target === 'event:outcome' && /changes its caller or receiver/.test(problem.reason)));
  draft.causal.events[1].receiver = 'Guard';
  assert.equal(policy.gate(draft).ready, true);
  draft.causal.events[1].caller = 'Other caller';
  assert.match(policy.gate(draft).problems.join('\n'), /changes its caller or receiver/);
  draft.causal.events[1].invocationId = 'different-invocation';
  assert.equal(policy.gate(draft).ready, true, 'A separate invocation may have different participants.');
});

test('all eight claims, eighteen events and thirty relationships fit fresh challenge coverage', () => {
  const capacity = require('../extension/review-capacity'), valid = require('../extension/challenge-format').valid;
  for (let count = 1; count <= capacity.limits.claims; count++) {
    const draft = checked(), template = draft.causal.events[0];
    draft.claims = Array.from({ length: count }, (_, i) => ({ id: `c${i}`, status: 'contradicted', unknowns: [] }));
    draft.evidence = draft.claims.map((claim, i) => ({ ...draft.evidence[0], id: `g${i}`, claimId: claim.id }));
    draft.walkthrough.assessment.opposingEvidence = 'g0';
    draft.causal.obligations = draft.claims.flatMap((claim, i) => capacity.kinds.map(kind => ({ id: `${claim.id}-${kind}`, claimId: claim.id, kind,
      question: `Check ${kind}`, state: 'established', reason: 'The false condition reverts.', evidence: [`g${i}`], documentation: [] })));
    draft.causal.events = Array.from({ length: capacity.limits.events }, (_, i) => ({ ...template, id: `event${i}`, claimId: `c${i % count}`, evidenceId: `g${i % count}`,
      phase: 'guard', conditions: ['accepted is false'], paragraphId: '', phrase: '' }));
    draft.causal.order = draft.causal.events.map(event => event.id);
    draft.causal.relationships = Array.from({ length: capacity.limits.relationships }, (_, i) => ({
      from: `event${i < 17 ? i : i - 17}`, to: `event${i < 17 ? i + 1 : 17}`, kind: 'context',
      callSiteId: '', dispatch: { kind: 'not-applicable', receiver: '', implementation: '', evidence: [], context: 'none', failure: 'not-applicable' },
      explanation: 'Another checked condition, not an executed call.', binding: 'No call parameters: reading context.', evidence: ['g0'] }));
    const targets = capacity.targets(draft.causal);
    draft.causal.checks = targets.map(item => ({ target: item.key, reason: 'Controlled coverage check, not AI evidence.', evidence: draft.evidence.map(item => item.id), documentation: [] }));
    assert.equal(draft.causal.checks.length, count * 8 + 18 + 30);
    assert.ok(draft.causal.checks.length <= policy.schema.properties.checks.maxItems);
    assert.equal(policy.gate(draft).ready, true, policy.gate(draft).problems.join('\n'));
    assert.ok(valid(draft.causal, policy.schema), 'The same admitted model fits the actual provider/patch schema.');
    draft.causal.checks.pop(); assert.equal(policy.gate(draft).ready, false, 'Capacity does not weaken complete coverage.');
  }
});
test('an untyped collision cannot check an event and obligation with the same ID', () => {
  const draft = checked(); draft.causal.events[0].id = draft.causal.obligations[0].id;
  draft.causal.order = [draft.causal.events[0].id];
  draft.causal.checks = draft.causal.checks.filter(item => item.target !== 'e1');
  assert.equal(policy.gate(draft).ready, false);
  const capacity = require('../extension/review-capacity');
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key, reason: 'Explicit distinct coverage.', evidence: ['guard'], documentation: [] }));
  assert.equal(policy.gate(draft).ready, true);
});
test('a call handoff checks the callee parameter against its exact caller argument and reference', () => {
  const draft = checked(), capacity = require('../extension/review-capacity');
  draft.sources[0].code = draft.sources[0].code.replace('external', 'internal');
  const caller = { ...draft.sources[0], id: 'caller', name: 'Guard::enter', source: { ...draft.sources[0].source, line: 6, endLine: 8 },
    code: 'function enter(bool value) external {\n    finish(value);\n}' };
  caller.relatedCalls = require('../extension/call-bindings').unitSites(caller).map(site => ({ ...site, line: site.span.line, receiver: 'internal', relationship: 'call', targets: [{ file: 'src/Guard.sol', line: 2, contract: 'Guard', signature: 'finish(bool)' }] }));
  draft.sources.push(caller);
  draft.evidence.push({ ...draft.evidence[0], id: 'call-site', sourceId: caller.id, source: { ...caller.source, line: 7, endLine: 7 }, quote: '    finish(value);', stance: 'context', note: 'Pass value as accepted.' });
  draft.causal.events.unshift({ ...draft.causal.events[0], id: 'entry', invocationId: 'enter1', evidenceId: 'call-site', callSiteId: caller.relatedCalls[0].id, title: 'Pass the requested boolean', effect: 'intermediate' });
  draft.causal.events[1].inputs = [{ name: 'accepted', expression: 'value', type: 'bool', units: 'boolean', origin: 'The caller argument at line 7.', evidence: ['call-site', 'guard'] }];
  draft.causal.relationships.push({ from: 'entry', to: 'e1', kind: 'call', callSiteId: caller.relatedCalls[0].id,
    dispatch: { kind: 'internal', receiver: 'internal', implementation: 'fn', evidence: ['call-site', 'guard'], context: 'same', failure: 'propagates' },
    explanation: 'The internal call passes value to finish.', binding: 'value -> accepted', evidence: ['call-site', 'guard'] });
  draft.causal.order = ['entry', 'e1'];
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key, reason: 'A false value reaches the reverting guard.', evidence: ['call-site', 'guard'], documentation: [] }));
  assert.equal(policy.gate(draft).ready, true, policy.gate(draft).problems.join('\n'));
  draft.causal.events[1].inputs[0].expression = 'false';
  assert.match(policy.gate(draft).problems.join('\n'), /actual argument position/);
  draft.causal.events[1].inputs[0].expression = 'value';
  draft.causal.events[1].inputs[0].evidence = ['guard'];
  assert.match(policy.gate(draft).problems.join('\n'), /caller-side origin/);
  draft.causal.events[1].inputs[0].evidence = ['call-site', 'guard'];
  draft.causal.events[1].inputs[0].name = 'unrelated';
  assert.match(policy.gate(draft).problems.join('\n'), /not a parameter/);
  draft.causal.events[1].inputs[0].name = 'accepted';
  caller.relatedCalls[0].targets = [];
  assert.match(policy.gate(draft).problems.join('\n'), /no unique checked non-virtual internal target/);
});
