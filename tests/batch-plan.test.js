'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const batch = require('../extension/batch-plan'), slots = require('../extension/provider-slots');
test('capacity scenarios distinguish expected, bounded maximum, shared allowance and remote unknowns', () => {
  const jobs = Array.from({ length: 200 }, (_, i) => ({ id: String(i), requests: 0, requestLimit: 6 }));
  for (const [capacity, minutes] of [[2, 200], [8, 50], [16, 25]]) {
    const plan = batch.plan(jobs, { requests: 0, limit: 1200 }, 32, capacity);
    assert.equal(plan.expectedRequests, 400); assert.equal(plan.maximumRequests, 1200);
    assert.equal(plan.scenario.lowerBoundMinutes, minutes); assert.equal(plan.scenario.requiredConcurrency30, 14); assert.equal(plan.scenario.requiredConcurrency20, 20);
    assert.match(plan.scenario.label, /not an ETA/);
  }
});
test('configured shared pool admits four, waits FIFO, refuses conflicting project capacity and retains default two', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-capacity-test-')), held = [];
  t.after(() => { for (const release of held) release(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 4; i++) held.push(await slots.acquire('codex', null, { directory, capacity: 4 }));
  assert.ok(held.every(release => release.capacity.limit === 4));
  await assert.rejects(slots.acquire('codex', null, { directory, capacity: 8 }), /different shared provider capacity/);
  const order = [], abort = new AbortController();
  const a = slots.acquire('codex', abort.signal, { directory, capacity: 4, pollMs: 5 }).then(release => { order.push('a'); held.push(release); });
  const b = slots.acquire('codex', abort.signal, { directory, capacity: 4, pollMs: 5 }).then(release => { order.push('b'); held.push(release); });
  held.shift()(); await a; assert.deepEqual(order, ['a']); held.shift()(); await b; assert.deepEqual(order, ['a', 'b']);
  for (const release of held.splice(0)) release();
  const normal = await slots.acquire('codex', null, { directory }); assert.equal(normal.capacity.limit, 2); normal();
});
