'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ChallengePilotGuard } = require('../scripts/challenge-pilot-guard');
const input = () => ({ phase: 'challenge', finding: { id: 'I-2' }, sources: [{ id: 's1', code: 'require(ok);', line: 1, endLine: 1 }] });
test('bounded saved challenge guard permits only concrete C1/C2 and refuses generation, siblings and third dispatch', () => {
  const ledger = { limit: 2, used: 0, receipts: [] }, guard = new ChallengePilotGuard('I-2', ledger, () => {}), packet = input();
  assert.throws(() => guard.check({ ...packet, phase: 'generate' }), /never generation/);
  assert.throws(() => guard.check({ ...packet, finding: { id: 'I-3' } }), /siblings/);
  assert.equal(guard.check(packet), 600000);
  const c1 = guard.reserve(packet, 'c1');
  guard.result(c1, { checks: [{ target: 'event:e1', reason: 'The source guard rejects this value.' }] }, { outcome: 'completed' });
  assert.throws(() => guard.check(packet), /concrete engine feedback/);
  const repair = { ...packet, hostReview: { problems: ['Evidence e1 has a mismatched quoted span.'] } };
  assert.equal(guard.check(repair), 240000); guard.reserve(repair, 'c2');
  assert.throws(() => guard.check(repair), /no third/); assert.equal(ledger.used, 2);
});
test('timeout, no JSON and nonresponsive objects cannot spend C2 even with host feedback', () => {
  for (const [value, outcome] of [[null, 'failed'], ['some prose', 'completed'], [{ ok: true }, 'completed']]) {
    const ledger = { limit: 2, used: 0, receipts: [] }, guard = new ChallengePilotGuard('I-2', ledger, () => {}), packet = input();
    guard.result(guard.reserve(packet, 'c1'), value, { outcome });
    assert.throws(() => guard.check({ ...packet, hostReview: { problems: ['A proper review is required.'] } }), /C2 requires/);
    assert.equal(ledger.used, 1);
  }
});
test('R1 requires exact saved base and available evidence; every terminal outcome consumes its sole permission', () => {
  const { SingleReviewRepairGuard } = require('../scripts/challenge-pilot-guard'), { hash } = require('../extension/investigation-engine');
  const packet = { ...input(), earlierDraft: { claims: ['unchanged'] }, snapshot: { policy: 'v9', source: 'fixed' },
    evidenceScopes: { evidence: [] }, hostReview: { rejectedOutput: { mode: 'review-patch-v1' }, validationProblems: [{ code: 'EVIDENCE_SCOPE_CHANGED' }] } };
  for (const outcome of ['completed', 'failed']) {
    const ledger = { limit: 1, used: 0, receipts: [], prerequisites: { controlsPassed: true, localReplayHash: 'replay-hash', necessarySourcesRead: true,
      noIndispensableMissingEvidence: false, savedBaseHash: hash(packet.earlierDraft), snapshotHash: hash(packet.snapshot) } };
    const guard = new SingleReviewRepairGuard('I-2', ledger, () => {});
    assert.throws(() => guard.check(packet), /prerequisites/); assert.equal(ledger.used, 0);
    ledger.prerequisites.noIndispensableMissingEvidence = true;
    for (const wrong of [{ ...packet, phase: 'generate' }, { ...packet, finding: { id: 'I-1' } }, { ...packet, earlierDraft: {} }, { ...packet, snapshot: {} }])
      assert.throws(() => guard.check(wrong));
    assert.equal(ledger.used, 0); assert.equal(guard.check(packet), 600000);
    const receipt = guard.reserve(packet, 'r1'); guard.result(receipt, outcome === 'completed' ? 'unusable prose' : null, { outcome });
    assert.throws(() => guard.check(packet), /one invocation/); assert.equal(ledger.used, 1);
  }
});
