'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const p = require('../extension/protocol');
const review = require('../extension/webview/review-model');
const inline = require('../extension/webview/inline-review');
const root = path.resolve(__dirname, '../examples/project');
test('source spans validate both boundaries and retain the exact source hash', () => {
  const profile = review.create(); profile.evidence = [{ id: 'span', stance: 'context', note: 'The fictional helper and its counter addition.', source: { file: 'src/Demo.sol', line: 12, endLine: 14 } }];
  p.evidenceSources(root, profile, true);
  const source = profile.evidence[0].source;
  assert.match(source.sourceHash, /^[a-f0-9]{64}$/);
  const hint = { file: source.file, line: 12, endLine: 14, sourceHash: source.sourceHash };
  assert.equal(inline.forSource(profile.evidence, hint).length, 1);
  assert.equal(inline.forSource(profile.evidence, { ...hint, endLine: 13 }).length, 0, 'A note cannot be placed on only part of the cited span.');
  source.endLine = 999; assert.throws(() => p.evidenceSources(root, profile), /focused span/);
  source.endLine = 30; assert.throws(() => p.evidenceSources(root, profile), /outside/);
  source.endLine = 11; assert.throws(() => review.validate(profile), /endLine/);
});
test('a selected legacy draft keeps its library identity and cannot borrow another draft ID', () => {
  const store = require('../extension/store'), original = require('../examples/finding.json');
  const legacy = structuredClone(original); delete legacy.findingId;
  assert.equal(store.selectedDraft(legacy, 'I-01').findingId, 'I-01');
  assert.equal(legacy.findingId, undefined, 'Selection does not rewrite the source draft.');
  assert.throws(() => store.selectedDraft({ ...legacy, findingId: 'different-review' }, 'I-01'), /different finding ID/);
});
test('provenance keeps report assertions and open questions out of independent support', () => {
  const profile = review.create(); profile.evidence = [{ id: 'report', stance: 'supports', basis: 'report-claim', note: 'The report alleges a behavior.', reference: 'Original report' }];
  assert.throws(() => review.validate(profile), /not independent/);
  profile.evidence[0].stance = 'context'; review.validate(profile);
  profile.evidence[0].basis = 'test-reference'; assert.match(review.brief({ triage: profile }), /check whether it ran/);
});
