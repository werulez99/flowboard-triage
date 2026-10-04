'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const p = require('../extension/protocol');
const store = require('../extension/store');
const { layoutGraph } = require('../extension/graph');
const fixture = require('../examples/finding.json');
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-store-'));
  fs.cpSync(path.join(__dirname, '../examples/project'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('review assessments persist with evidence and history', t => {
  const root = workspace(t), request = structuredClone(fixture); request.findingId = 'I-01';
  store.writeDraft(root, 'I-01', request);
  const hash = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const next = store.saveReview(root, 'I-01', { status: 'invalid', evidence: ['src/Demo.sol:8 — specified behavior'], expectedBehavior: 'Public counter updates are intentional.' }, hash);
  assert.equal(next.finding.status, 'invalid'); assert.equal(store.readDraft(root, 'I-01').finding.status, 'invalid');
  assert.equal(p.readWorkspaceJson(root, '.flowboard/history/I-01.json').entries.length, 1);
});
test('concurrent draft edit is not overwritten by an old review form', t => {
  const root = workspace(t), request = structuredClone(fixture);
  store.writeDraft(root, 'I-01', request);
  const old = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
  request.finding.summary = 'Edited in another source editor'; store.writeDraft(root, 'I-01', request);
  assert.throws(() => store.saveReview(root, 'I-01', { status: 'insufficient-evidence' }, old), /edited elsewhere/);
  assert.equal(store.readDraft(root, 'I-01').finding.summary, 'Edited in another source editor');
});
test('definitive verdict without evidence is rejected and current draft is preserved', t => {
  const root = workspace(t), request = structuredClone(fixture);
  store.writeDraft(root, 'I-01', request);
  assert.throws(() => store.saveReview(root, 'I-01', { status: 'confirmed', evidence: [] }), /requires evidence/);
  assert.equal(store.readDraft(root, 'I-01').finding.status, 'unreviewed');
});
test('board snapshots are isolated per finding and source fingerprint', t => {
  const root = workspace(t);
  const state = { cards: [{ id: 'first', fsPath: path.join(root, 'src/Demo.sol') }], edges: [], notes: [] };
  store.writeBoard(root, 'I-01', state, 'first-source');
  store.writeBoard(root, 'I-02', { cards: [], edges: [], notes: [] }, 'second-source');
  assert.equal(store.readBoard(root, 'I-01').state.cards.length, 1);
  assert.equal(store.readBoard(root, 'I-02').state.cards.length, 0);
  assert.equal(store.readBoard(root, 'I-01').fingerprint, 'first-source');
});
test('unsafe IDs and out-of-workspace saved sources are rejected', t => {
  const root = workspace(t);
  assert.throws(() => store.readDraft(root, '../elsewhere'), /finding ID/);
  assert.throws(() => store.writeBoard(root, 'I-01', { cards: [{ fsPath: path.join(root, '..') }], edges: [] }, 'hash'), /escapes/);
});
test('previous layouts and exact corrupt cache bytes are recoverable archives', t => {
  const root = workspace(t), state = { cards: [], edges: [], notes: [{ html: 'Private reviewer note' }] };
  store.writeBoard(root, 'I-01', state, 'old-source');
  const old = store.readBoard(root, 'I-01');
  const backup = store.archiveBoard(root, 'I-01', old);
  store.writeBoard(root, 'I-01', { cards: [], edges: [], notes: [] }, 'new-source');
  assert.equal(p.readWorkspaceJson(root, backup).state.notes[0].html, 'Private reviewer note');
  fs.writeFileSync(path.join(root, '.flowboard/boards/I-01.json'), '{ incomplete JSON with a note');
  assert.throws(() => store.readBoard(root, 'I-01'), /JSON/);
  const raw = store.archiveBoardFile(root, 'I-01');
  assert.equal(fs.readFileSync(path.join(root, raw), 'utf8'), '{ incomplete JSON with a note');
});
test('restoring a manually edited board applies the same source containment checks', t => {
  const root = workspace(t);
  p.atomicJson(root, '.flowboard/boards/I-01.json', { state: { cards: [{ fsPath: path.join(root, '..') }], edges: [] } });
  assert.throws(() => store.readBoard(root, 'I-01'), /escapes/);
});
test('malformed snapshots are rejected before reaching the native renderer', t => {
  const root = workspace(t);
  assert.throws(() => store.writeBoard(root, 'I-01', { cards: [], edges: [], notes: {} }, 'source'), /snapshot/);
  assert.throws(() => store.writeBoard(root, 'I-01', { cards: [null], edges: [] }, 'source'), /card/);
  assert.throws(() => store.writeBoard(root, 'I-01', { cards: [], edges: [], camera: { scale: 'bad' } }, 'source'), /camera/);
});
test('cached native annotation shape is bounded without promoting model comments into evidence', t => {
  const root = workspace(t), card = { id: 'source', fsPath: path.join(root, 'src/Demo.sol'), showAnnotations: true,
    summary: 'An unverified optional explanation.', annotations: [{ line: 1, comment: 'A fictional observation.' }] };
  const state = { cards: [card], edges: [], notes: [] };
  store.writeBoard(root, 'native-comments', state, 'source');
  assert.deepEqual(store.readBoard(root, 'native-comments').state, state, 'Valid legacy native comments remain usable and unchanged.');
  for (const patch of [{ annotations: {} }, { annotations: [null] }, { annotations: [{ line: 1, comment: {} }] },
    { annotations: [{ line: 0, comment: 'bad position' }] }, { annotations: [{ line: 1.5, comment: 'not a source row' }] },
    { annotations: [{ line: 1, comment: 'x'.repeat(16001) }] }, { annotations: Array(2001).fill(card.annotations[0]) },
    { summary: {} }, { summary: 'x'.repeat(64001) }, { showAnnotations: 'yes' }]) {
    assert.throws(() => store.writeBoard(root, 'bad-comments', { ...state, cards: [{ ...card, ...patch }] }, 'source'), /cached native annotations/);
  }
  store.writeBoard(root, 'empty-comments', { ...state, cards: [{ ...card, summary: null, annotations: null, showAnnotations: false }] }, 'source');
  const malformed = { state: { ...state, cards: [{ ...card, annotations: {} }] } };
  p.atomicJson(root, '.flowboard/boards/bad-comments.json', malformed);
  assert.throws(() => store.readBoard(root, 'bad-comments'), /cached native annotations/);
  const backup = store.archiveBoardFile(root, 'bad-comments');
  assert.deepEqual(p.readWorkspaceJson(root, backup).state.cards[0].annotations, {}, 'Original corrupt bytes remain recoverable, not silently repaired as current evidence.');
});
test('graph layout follows calls even when citations are in reverse order, and survives cycles', () => {
  const nodes = [{ id: 'callee', code: 'function callee() {}' }, { id: 'caller', code: 'function caller() { callee(); }' }];
  layoutGraph(nodes, [{ from: 'caller', to: 'callee' }]);
  assert.ok(nodes[0].x > nodes[1].x);
  layoutGraph(nodes, [{ from: 'caller', to: 'callee' }, { from: 'callee', to: 'caller' }]);
  assert.ok(nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
});
test('long native source cards reserve their full height and do not overlap', () => {
  const nodes = [{ id: 'a', code: 'line\n'.repeat(150) }, { id: 'b', code: 'function b() {}' }];
  layoutGraph(nodes, []);
  assert.ok(nodes[1].y > nodes[0].y + 3000);
});
