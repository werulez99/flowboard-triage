'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reading = require('../extension/webview/reading-model');
const hash = 'a'.repeat(64), hints = { card: { file: 'src/Demo.sol', line: 8, endLine: 14, sourceHash: hash, mapping: { method: 'citation' } } };
const cards = [{ id: 'card', data: {} }];
const entry = { id: 'e', stance: 'contradicts', note: 'An ordinary update.', source: { file: 'src/Demo.sol', line: 13, sourceHash: hash } };

test('reading labels do not turn a supported statement into a confirmed issue', () => {
  assert.equal(reading.issue('confirmed'), 'Confirmed bug');
  assert.equal(reading.issue('invalid'), 'Not a bug');
  assert.equal(reading.issue('design-decision'), 'By design');
  assert.equal(reading.statement('supported'), 'Supported in this case');
  assert.equal(reading.issue('unreviewed'), 'Not checked');
});
test('one note can oppose the issue and support a narrower statement with exact targets', () => {
  const claims = [{ id: 'C-1', text: 'The counter changes.', evidence: [{ evidenceId: 'e', stance: 'supports', reason: 'The addition changes it.' }] }];
  const before = JSON.stringify({ entry, claims });
  const result = reading.relationships(entry, 'H-01', claims);
  assert.deepEqual(result.map(item => item.label), ['Against issue H-01', 'Supports statement C-1']);
  assert.equal(result[1].text, claims[0].text);
  assert.equal(JSON.stringify({ entry, claims }), before);
});
test('generated statement evidence never acquires an invented issue relationship', () => {
  const result = reading.relationships({ ...entry, origin: 'model-interpretation', claimId: 'C-2' }, 'H-01', [{ id: 'C-2', allegation: 'A different route.' }]);
  assert.deepEqual(result.map(item => item.label), ['Against statement C-2']);
  assert.equal(result[0].text, 'A different route.');
});
test('Read code highlights only a checked exact location, not an unchecked citation', () => {
  assert.equal(reading.start(cards, hints, [entry]).entry.source.line, 13);
  const candidate = reading.start(cards, hints, []);
  assert.equal(candidate.kind, 'related'); assert.equal(candidate.entry, undefined);
  assert.match(candidate.message, /still matches/);
});
test('changed, missing, out-of-range and question-only references cannot be highlighted', () => {
  for (const note of [{ ...entry, needsReview: true }, { ...entry, basis: 'report-claim' }, { ...entry, basis: 'open-question' },
    { ...entry, source: { ...entry.source, line: 0 } }, { ...entry, source: { ...entry.source, endLine: 25 } },
    { ...entry, source: { ...entry.source, sourceHash: 'b'.repeat(64) } }]) assert.equal(reading.start(cards, hints, [note]).entry, undefined);
  assert.equal(reading.start(cards, hints, [entry], true).kind, 'changed');
  assert.equal(reading.start([], {}, [entry]).kind, 'missing');
});
test('no missing end line is guessed and repeated code text is never searched', () => {
  assert.equal(reading.start(cards, hints, [entry]).entry.source.endLine, undefined);
  assert.equal(reading.current({ ...entry, source: { ...entry.source, endLine: 12 } }, hints.card), false);
});
