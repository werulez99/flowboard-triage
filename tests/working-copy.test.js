'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const review = require('../extension/webview/review-model');
const store = require('../extension/store');

function copy() {
  const triage = review.create();
  triage.claims.push({ id: 'claim-1', text: '', state: 'supported', reason: '', observed: '', evidence: [], questions: [] });
  triage.checks[0] = { id: 'revision', state: 'checked', note: '' };
  return { version: 1, baseDraftFingerprint: 'draft', baseSourceFingerprint: 'source',
    patch: { triage, summary: '', status: 'confirmed', openQuestions: 'A pending question\n' },
    editVersion: 4, evidenceInput: { cardId: 'finding:sample:source-1', line: 0, note: 'Unadded explanation', reference: '' } };
}

test('working-copy shape guards preserve unfinished reasoning without treating it as a valid assessment', () => {
  const value = copy(), before = structuredClone(value);
  const restored = review.workingCopy(value, 'draft', 'source');
  assert.equal(restored.matches, true); assert.equal(restored.patch.triage.claims[0].text, '');
  assert.equal(restored.patch.triage.claims[0].state, 'supported', 'Typing retains the provisional selection rather than changing its meaning.');
  assert.equal(restored.patch.triage.checks[0].note, '');
  assert.equal(restored.evidenceInput.note, 'Unadded explanation');
  assert.deepEqual(value, before, 'Only a disposable validation probe may be normalized.');
  assert.ok(review.readiness({ title: 'Incomplete', ...restored.patch }).errors.length);
  value.patch.summary = 'x'.repeat(8000); value.patch.triage.decisionReason = 'x'.repeat(5000);
  assert.equal(review.workingCopy(value, 'draft', 'source').patch.triage.decisionReason.length, 5000, 'Overlong incomplete typing remains recoverable within the working-copy cap.');
});

test('malformed nested working-copy values fail closed before any renderer consumes them', () => {
  const corruptions = [
    value => { value.patch.summary = {}; },
    value => { value.patch.openQuestions = [null]; },
    value => { value.patch.triage.checks = {}; },
    value => { value.patch.triage.checks[0] = null; },
    value => { value.patch.triage.claims = 'not an array'; },
    value => { value.patch.triage.claims[0] = null; },
    value => { value.patch.triage.claims[0].text = {}; },
    value => { value.patch.triage.claims[0].evidence = null; },
    value => { value.patch.triage.claims[0].evidence = [{ evidenceId: 'missing', stance: 'context', reason: '' }]; },
    value => { value.patch.triage.claims[0].state = 'automatically-proved'; },
    value => { value.patch.triage.ruleOrigin = []; },
    value => { value.patch.triage.actor = {}; },
    value => { value.patch.triage.evidence = [null]; },
    value => { value.evidenceInput = []; },
    value => { value.evidenceInput.note = {}; },
    value => { value.evidenceInput.line = {}; },
    value => { value.editVersion = -1; },
    value => { value.baseSourceFingerprint = {}; }
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const value = copy(); corrupt(value);
    assert.equal(review.workingCopy(value, 'draft', 'source'), null, `Malformed case ${index} should be withheld, not crash a view.`);
  }
  const cyclic = copy(); cyclic.patch.summary = cyclic;
  assert.equal(review.workingCopy(cyclic, 'draft', 'source'), null);
  const oversized = copy(); oversized.patch.summary = 'x'.repeat(300001);
  assert.equal(review.workingCopy(oversized, 'draft', 'source'), null);
});

test('view and recovery snapshots reject malformed arrays, tuples and navigation before rendering', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-view-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const validView = { version: 1, drawerTab: 'claims', selectedCard: 'finding:sample:card', activeClaim: 'claim-1',
    claimFocus: true, spotlight: false, inlineVisible: true, navigation: ['finding:sample:card'], navigationIndex: 0,
    scroll: [['claims', 14]], disclosures: [['note:claim-1', false]] };
  const state = { cards: [], edges: [], notes: [], view: validView, workingCopy: copy(), recoveries: [copy()] };
  store.writeBoard(root, 'valid', state, 'source');
  assert.deepEqual(store.readBoard(root, 'valid').state, state);
  for (const patch of [{ scroll: {} }, { scroll: ['claims'] }, { scroll: [['claims', 'bad']] }, { scroll: [['claims', -1]] },
    { disclosures: [null] }, { disclosures: [['note', {}]] }, { navigation: 'not an array' }, { navigation: [null] },
    { navigationIndex: 70 }, { selectedCard: {} }, { claimFocus: 'false' }, { drawerTab: 'unknown' }]) {
    assert.throws(() => store.writeBoard(root, 'bad', { ...state, view: { ...validView, ...patch } }, 'source'), /view checkpoint/);
  }
  assert.throws(() => store.writeBoard(root, 'bad', { ...state, recoveries: {} }, 'source'), /earlier working copies/);
  assert.throws(() => store.writeBoard(root, 'bad', { ...state, recoveries: [null] }, 'source'), /earlier working copies/);
  assert.throws(() => store.writeBoard(root, 'bad', { ...state, workingCopy: { ...copy(), patch: { triage: { checks: {} } } } }, 'source'), /working copy/);
});
