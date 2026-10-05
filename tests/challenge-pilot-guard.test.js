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
