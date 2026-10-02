'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const claims = require('../extension/webview/claim-model');
const review = require('../extension/webview/review-model');
const path = require('node:path');
const protocol = require('../extension/protocol');
function fixture() {
  return { ...review.create(), ruleOrigin: { kind: 'specification', reference: 'Fictional counter specification: additions are intended.' },
    evidence: [{ id: 'e-1', stance: 'contradicts', note: 'The fictional helper adds amount.', source: { file: 'src/Demo.sol', line: 13, sourceHash: 'a'.repeat(64) } }],
    claims: [{ id: 'c-1', text: 'The helper adds amount.', state: 'supported', observed: 'The counter receives += amount.', reason: 'The statement matches the supplied fictional source.',
      evidence: [{ evidenceId: 'e-1', stance: 'supports', reason: 'The addition statement establishes this narrow claim.' }], questions: [] }] };
}
test('claim stance is independent of the overall finding stance and verdict', () => {
  const triage = fixture(), finding = { status: 'insufficient-evidence', triage };
  review.validate(triage); const ready = review.readiness(finding);
  assert.equal(ready.counts.contradicts, 1); assert.equal(claims.argument(triage.claims[0], triage.evidence).counts.supports, 1);
  assert.equal(finding.status, 'insufficient-evidence'); assert.equal(ready.toolVerified, false);
  assert.deepEqual(review.create(triage).claims, triage.claims);
});
test('portable claim demo binds real fictional lines without deciding its unfinished claims', () => {
  const demo = structuredClone(require('../examples/claim-review.json'));
  protocol.validate(demo);
  const sources = protocol.evidenceSources(path.resolve(__dirname, '../examples/project'), demo.finding.triage, true);
  assert.equal(sources.length, 2); protocol.validate(demo);
  assert.match(demo.finding.triage.evidence[0].source.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(demo.finding.triage.claims[0].state, 'unreviewed');
  assert.equal(demo.finding.triage.claims[1].state, 'unresolved');
  assert.equal(demo.finding.status, 'insufficient-evidence');
});
test('claim schema rejects dangling/duplicate links, duplicate IDs and unexplained reasoning', () => {
  for (const mutate of [
    p => p.claims.push(structuredClone(p.claims[0])),
    p => p.claims[0].evidence.push(structuredClone(p.claims[0].evidence[0])),
    p => p.claims[0].evidence[0].evidenceId = 'missing',
    p => p.claims[0].evidence[0].reason = '',
    p => p.claims[0].reason = '', p => p.claims[0].text = '',
    p => p.claims[0].state = 'confirmed', p => p.claims[0].evidence[0].stance = 'likely'
  ]) { const value = fixture(); mutate(value); assert.throws(() => review.validate(value)); }
});
test('claim field limits and rule provenance are validated before saving', () => {
  for (const mutate of [
    p => p.claims = Array(21).fill(p.claims[0]), p => p.claims[0].text = 'x'.repeat(2001),
    p => p.claims[0].observed = 'x'.repeat(4001), p => p.claims[0].questions = Array(13).fill('Question'),
    p => p.ruleOrigin.kind = 'model-confidence', p => p.ruleOrigin.reference = '',
    p => p.claims[0].evidence[0].reason = 'x'.repeat(1001)
  ]) { const value = fixture(); mutate(value); assert.throws(() => review.validate(value)); }
});
test('supported/contradicted/mixed labels require current evidence of the appropriate stance', () => {
  const value = fixture(); value.claims[0].state = 'mixed'; assert.throws(() => review.validate(value), /contradicting/);
  value.evidence.push({ id: 'e-2', stance: 'context', note: 'Fictional alternative specification.', reference: 'Fictional spec B' });
  value.claims[0].evidence.push({ evidenceId: 'e-2', stance: 'contradicts', reason: 'The alternate requirement conflicts with this claim.' });
  review.validate(value);
  value.evidence[1].needsReview = true; assert.throws(() => review.validate(value), /contradicting/);
  value.claims[0].state = 'supported'; value.evidence[0].needsReview = true; assert.throws(() => review.validate(value), /supporting/);
  delete value.evidence[0].needsReview; delete value.evidence[0].source.sourceHash; assert.throws(() => review.validate(value), /supporting/);
});
test('malformed claim data is an actionable readiness error, not a renderer exception', () => {
  for (const value of ['bad', {}, [null], [{ id: 'x', evidence: null }]]) {
    const triage = fixture(); triage.claims = value;
    assert.ok(review.readiness({ status: 'unreviewed', triage }).errors.length);
  }
});
test('report-only rule and unresolved claims remain explicit review gaps', () => {
  const value = fixture(); value.ruleOrigin = { kind: 'report', reference: 'Original report description' };
  value.claims[0].state = 'unresolved'; value.claims[0].questions = ['Which deployed implementation is used?'];
  const ready = review.readiness({ status: 'insufficient-evidence', triage: value });
  assert.ok(ready.gaps.some(text => text.includes('not independently established')));
  assert.ok(ready.gaps.some(text => text.includes('c-1')));
  assert.ok(claims.argument(value.claims[0], value.evidence).gaps.includes('Which deployed implementation is used?'));
});
test('removing evidence resets linked claims but preserves unrelated review work', () => {
  const value = fixture(); value.claims.push({ id: 'c-2', text: 'An unresolved separate claim.', state: 'unresolved', reason: 'Needs independent review.', evidence: [] });
  const reason = value.claims[0].reason;
  claims.detach(value, 'e-1'); assert.equal(value.claims[0].state, 'unreviewed'); assert.deepEqual(value.claims[0].evidence, []);
  assert.equal(value.claims[0].reason, reason); assert.equal(value.claims[1].state, 'unresolved'); review.validate(value);
});
test('changed evidence interpretation or rule provenance resets dependent claim assessments', () => {
  const previous = fixture(), next = structuredClone(previous); next.evidence[0].note = 'Revised interpretation.';
  claims.reconcile(previous, next); assert.equal(next.claims[0].state, 'unreviewed');
  const changedRule = structuredClone(previous); changedRule.ruleOrigin.reference = 'New specification';
  claims.reconcile(previous, changedRule); assert.equal(changedRule.claims[0].state, 'unreviewed');
  const same = structuredClone(previous); claims.reconcile(previous, same); assert.equal(same.claims[0].state, 'supported');
});
test('source refresh retains hashes/reasoning but marks evidence historical and claims unreviewed', () => {
  const value = fixture(), old = structuredClone(value); claims.invalidate(value); review.validate(value);
  assert.equal(value.evidence[0].needsReview, true); assert.equal(value.evidence[0].source.sourceHash, old.evidence[0].source.sourceHash);
  assert.equal(value.claims[0].state, 'unreviewed'); assert.equal(value.claims[0].reason, old.claims[0].reason);
});
test('review brief includes source-linked claim reasoning and uncertainty, not an execution path', () => {
  const value = fixture(); value.claims[0].questions = ['Deployment is not checked.'];
  const brief = review.brief({ status: 'insufficient-evidence', triage: value });
  assert.match(brief, /Rule provenance: specification/); assert.match(brief, /supports: src\/Demo.sol:13/);
  assert.match(brief, /addition statement establishes/); assert.match(brief, /Deployment is not checked/);
  assert.match(brief, /not execution order/); assert.doesNotMatch(brief, /\d+%/);
});
