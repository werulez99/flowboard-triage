'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const inline = require('../extension/webview/inline-review');
const review = require('../extension/webview/review-model');

test('inline mapping retains original coordinates across hidden comments and repeated statements', () => {
  const raw = 'function f() {\n  count++;\n  // rationale\n  count++;\n}\n';
  assert.deepEqual(inline.lineMap(raw, 40, 'function f() {\n  count++;\n  count++;\n}\n'), [40, 41, 43, 44, 45]);
  assert.equal(inline.lineMap(raw, 40, 'different code'), null);
});
test('inline mapping respects literal comment markers, multiline comments and CRLF', () => {
  const raw = 'function f() {\r\n /* note\r\n more */ count++; // tail\r\n string memory s = "https://example/*";\r\n}';
  assert.deepEqual(inline.lineMap(raw, 1, 'function f() {\n count++;\n string memory s = "https://example/*";\n}'), [1, 3, 4, 5]);
});
test('line mapping matches the real pinned native comment filter', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, () => {
  const source = fs.readFileSync(path.join(process.env.FLOWBOARD_EXTENSION_PATH, 'webview/flowboard.js'), 'utf8');
  const start = source.indexOf('function stripComments(code) {');
  const fn = vm.runInNewContext('(' + source.slice(start, source.indexOf('\n/**', start)) + ')');
  for (const raw of ['// heading\nfunction f() {}', '/* a\n\n b */\nf();\nf();', 'x/* comment */++; // tail\n\n// end', 'string s = "a\\\"//b";\r\n// tail\r\nx();']) {
    const clean = fn(raw), mapping = inline.lineMap(raw, 11, clean);
    assert.equal(inline.cleanCode(raw), clean, 'Provider input is regenerated with exactly the pinned native comment filter.');
    assert.ok(mapping); assert.equal(mapping.length, clean.split('\n').length);
    assert.ok(mapping.every((line, i) => line >= 11 && (!i || line > mapping[i - 1])));
  }
});
test('inline placement rejects old hashes, unbound evidence, other files and out-of-function lines', () => {
  const hint = { file: 'src/Demo.sol', line: 8, endLine: 14, sourceHash: 'a'.repeat(64) };
  const entry = { id: 'e', stance: 'context', note: 'Counter update.', source: { file: hint.file, line: 13, sourceHash: hint.sourceHash } };
  const items = [entry, { ...entry, needsReview: true }, { ...entry, source: { ...entry.source, sourceHash: 'b'.repeat(64) } },
    { ...entry, source: { ...entry.source, sourceHash: undefined } }, { ...entry, source: { ...entry.source, line: 2 } }, { ...entry, source: { ...entry.source, file: 'src/Other.sol' } }];
  assert.deepEqual(inline.forSource(items, hint), [entry]);
});
test('explanation categories do not change evidence stance or assessment', () => {
  const value = review.create(); value.evidence = [{ id: 'e', stance: 'context', category: 'impact', note: 'Review the stated consequence.', reference: 'Fictional report' }];
  review.validate(value); assert.equal(review.readiness({ status: 'unreviewed', triage: value }).counts.supports, 0);
  value.evidence[0].category = 'proven-bug'; assert.throws(() => review.validate(value), /category/);
});
test('review story labels supplied claims and unknowns without inventing intermediate steps', () => {
  const finding = { summary: 'Reported counter behavior.', impact: 'Stated consequence.', openQuestions: ['Which rule is intended?'] };
  const story = inline.story(finding);
  assert.deepEqual(story.map(item => item.text), [finding.summary, finding.impact, finding.openQuestions[0]]);
  assert.match(story[1].label, /Reported impact/); assert.deepEqual(inline.story({}), []);
});
test('placement diagnostics distinguish stale, unbound, off-map and current evidence', () => {
  const hint = { file: 'src/Demo.sol', line: 8, endLine: 14, sourceHash: 'a'.repeat(64) };
  const entry = { id: 'e', stance: 'context', note: 'Counter update.', source: { file: hint.file, line: 13, sourceHash: hint.sourceHash } };
  assert.equal(inline.placement(entry, [hint]), null);
  assert.match(inline.placement(entry, []), /not on the board/);
  assert.match(inline.placement({ ...entry, needsReview: true }, [hint]), /Code has changed/);
  assert.match(inline.placement({ ...entry, source: undefined }, [hint]), /links to a reference/);
  assert.match(inline.placement({ ...entry, source: { ...entry.source, sourceHash: undefined } }, [hint]), /not been checked/);
  assert.match(inline.placement({ ...entry, source: { ...entry.source, line: 99 } }, [hint]), /outside the functions/);
  assert.match(inline.placement({ ...entry, source: { ...entry.source, sourceHash: 'b'.repeat(64) } }, [hint]), /Code has changed/);
});
