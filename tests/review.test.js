'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const review = require('../extension/webview/review-model');
const p = require('../extension/protocol');
const store = require('../extension/store');
const { importReport, refreshFindingMap } = require('../extension/report');
const example = require('../examples/finding.json');
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-proof-'));
  fs.cpSync(path.join(__dirname, '../examples/project'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function entry(stance = 'contradicts') { return { id: 'e-1', stance, note: 'The fictional specification intends ordinary counter updates.', reference: 'Fictional specification: public counter update' }; }
function finding(status = 'invalid') { return { ...structuredClone(example.finding), status,
  triage: { ...review.create(), decisionReason: 'This fictional behavior is specified, not a reported deviation.', evidence: [entry(status === 'confirmed' ? 'supports' : 'contradicts')] } }; }
test('review queue searches source files and retains provisional assessments needing attention', () => {
  const issues = [
    { id: 'a', title: 'Counter', status: 'invalid', files: ['src/Demo.sol'], reviewGaps: 2 },
    { id: 'b', title: 'Other', status: 'confirmed', files: ['src/Other.sol'], reviewGaps: 0 },
    { id: 'c', title: 'Missing', status: 'unreviewed', mapped: false }
  ];
  assert.deepEqual(review.queue(issues, 'demo counter', 'attention').map(x => x.id), ['a']);
  assert.deepEqual(review.queue(issues, '', 'unmapped').map(x => x.id), ['c']);
  assert.equal(review.nextAttention(issues, 'c').id, 'a');
  assert.equal(review.nextAttention([issues[0]], 'a'), null);
  assert.equal(review.nextAttention([], 'a'), null);
});
test('related findings distinguish identical anchors from merely sharing a file', () => {
  const anchor = { file: 'src/Demo.sol', line: 8, function: 'increment' };
  const related = review.related([
    { id: 'self', anchors: [anchor], files: [anchor.file] },
    { id: 'file', anchors: [{ ...anchor, line: 12, function: '_add' }], files: [anchor.file] },
    { id: 'same', anchors: [anchor], files: [anchor.file] },
    { id: 'other', anchors: [{ ...anchor, file: 'src/Other.sol' }], files: ['src/Other.sol'] }
  ], 'self', [anchor]);
  assert.deepEqual(related.map(x => x.id), ['same', 'file']);
  assert.equal(related[0].shared.length, 1); assert.equal(related[1].shared.length, 0);
  assert.equal(related[0].status, undefined, 'Source overlap never infers another finding verdict.');
});
test('evidence review flags duplicate and opposed interpretations without changing a verdict', () => {
  const value = finding(); value.triage.evidence.push({ ...entry(), id: 'e-2' }, { ...entry('supports'), id: 'e-3' });
  assert.equal(review.quality(value).length, 2); assert.equal(value.status, 'invalid');
  value.triage.evidence[1].needsReview = true; value.triage.evidence[2].needsReview = true;
  assert.deepEqual(review.quality(value), []);
});
test('next review question prioritizes a stated blocker and brief preserves its reasoning', () => {
  const value = finding(); value.triage.checks[1] = { id: 'rule', state: 'blocked', note: 'Specification has not been supplied.' };
  assert.equal(review.nextQuestion(value).id, 'rule'); assert.match(review.brief(value), /Specification has not been supplied/);
  for (const check of value.triage.checks) { check.state = 'checked'; check.note = 'Reviewed in fixture.'; }
  assert.equal(review.nextQuestion(value), null);
});
test('library exposes saved review gaps and source anchors without source bodies', t => {
  const root = workspace(t), request = { ...structuredClone(example), findingId: 'I-01', finding: finding() };
  store.writeDraft(root, 'I-01', request);
  p.atomicJson(root, '.flowboard/report.json', { issues: [{ id: 'I-01', title: 'Counter', severity: 'Info' }] });
  const [issue] = store.library(root);
  assert.equal(issue.reviewGaps, 6); assert.equal(issue.status, 'invalid');
  assert.ok(issue.files.includes('src/Demo.sol')); assert.equal(issue.anchors[0].function, request.cards[0].function);
  assert.equal(issue.anchors[0].code, undefined);
});
test('review starts with explicit gaps, not a confidence score or automatic verdict', () => {
  const ready = review.readiness(example.finding);
  assert.equal(ready.gaps.length, 6); assert.equal(ready.checked, 0); assert.equal(ready.toolVerified, false);
  assert.deepEqual(ready.counts, { supports: 0, contradicts: 0, context: 0 });
});
test('structured definitive assessments require a decision explanation and relevant evidence stance', () => {
  for (const status of ['confirmed', 'invalid']) {
    const request = { ...structuredClone(example), finding: finding(status) }; p.validate(request);
    request.finding.triage.decisionReason = ''; assert.throws(() => p.validate(request), /Explain why/);
    request.finding = finding(status); request.finding.triage.evidence[0].stance = 'context';
    assert.throws(() => p.validate(request), status === 'confirmed' ? /supporting evidence/ : /contradicts/);
  }
});
test('old assessments remain readable without a forced migration or changed verdict', () => {
  const request = structuredClone(example); request.finding.status = 'invalid';
  assert.equal(p.validate(request).finding.status, 'invalid'); assert.equal(request.finding.triage, undefined);
});
test('a checkmark without reasoning is rejected; gaps remain visible in a provisional assessment', () => {
  const value = finding(); value.triage.checks[0].state = 'checked';
  assert.throws(() => review.validate(value.triage), /Checkpoint reasoning/);
  value.triage.checks[0].note = 'Compared the fictional checkout and report.';
  review.validate(value.triage); assert.equal(review.readiness(value).gaps.length, 5);
  assert.match(review.brief(value), /Unchecked \/ blocked/); assert.match(review.brief(value), /not tool-verified/);
});
test('evidence schema rejects duplicate IDs, unknown stances and unsafe paths', () => {
  const value = review.create(); value.evidence = [entry(), entry()]; assert.throws(() => review.validate(value), /duplicate/);
  value.evidence = [{ ...entry(), stance: 'proven' }]; assert.throws(() => review.validate(value), /stance/);
  for (const file of ['../Other.sol', '/tmp/Other.sol', 'C:/Other.sol', 'src\\Other.sol']) {
    value.evidence = [{ ...entry(), source: { file, line: 1 } }]; assert.throws(() => review.validate(value), /relative/);
  }
  value.evidence = [{ ...entry(), source: { file: 'src/Demo.sol', line: 0 } }]; assert.throws(() => review.validate(value), /positive/);
});
test('evidence notes need an actual reference and focused bounded entries', () => {
  const value = review.create(); value.evidence = [{ id: 'e-1', stance: 'supports', note: 'An unreferenced assertion.' }];
  assert.throws(() => review.validate(value), /reference/);
  value.evidence = Array.from({ length: 31 }, (_, i) => ({ ...entry(), id: `e-${i}` })); assert.throws(() => review.validate(value), /30/);
});
test('saved source evidence binds exact workspace file/line and retains history', t => {
  const root = workspace(t), request = structuredClone(example); request.findingId = 'I-01'; store.writeDraft(root, 'I-01', request);
  const value = finding(); value.triage.evidence = [{ ...entry(), reference: undefined, source: { file: 'src/Demo.sol', line: 13 } }];
  const next = store.saveReview(root, 'I-01', { status: 'invalid', triage: value.triage });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src/Demo.sol'), 'utf8')).digest('hex');
  assert.equal(next.finding.triage.evidence[0].source.sourceHash, hash);
  assert.equal(store.readDraft(root, 'I-01').finding.triage.evidence[0].source.line, 13);
  assert.equal(p.readWorkspaceJson(root, '.flowboard/history/I-01.json').entries[0].current.triage.evidence[0].source.sourceHash, hash);
});
test('changed evidence code cannot be silently rehashed by saving an unrelated review edit', t => {
  const root = workspace(t), request = structuredClone(example); request.findingId = 'I-01'; request.finding = finding();
  request.finding.triage.evidence = [{ ...entry(), source: { file: 'src/Demo.sol', line: 13 } }]; store.writeDraft(root, 'I-01', request);
  fs.appendFileSync(path.join(root, 'src/Demo.sol'), '\n// changed\n');
  assert.throws(() => store.saveReview(root, 'I-01', { impact: 'Edited note' }), /Stale evidence/);
  assert.deepEqual(store.readDraft(root, 'I-01'), request);
});
test('out-of-range evidence fails without replacing a draft or creating review history', t => {
  const root = workspace(t), request = structuredClone(example); store.writeDraft(root, 'I-01', request);
  const value = finding(); value.triage.evidence = [{ ...entry(), source: { file: 'src/Demo.sol', line: 9999 } }];
  assert.throws(() => store.saveReview(root, 'I-01', { triage: value.triage }), /line outside/);
  assert.deepEqual(store.readDraft(root, 'I-01'), request); assert.equal(fs.existsSync(path.join(root, '.flowboard/history/I-01.json')), false);
});
test('source evidence cannot read an out-of-workspace symlink', { skip: process.platform === 'win32' }, t => {
  const root = workspace(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'Other.sol'), 'pragma solidity ^0.8.20;');
  fs.symlinkSync(path.join(outside, 'Other.sol'), path.join(root, 'src/Linked.sol'));
  const value = review.create(); value.evidence = [{ ...entry(), source: { file: 'src/Linked.sol', line: 1 } }];
  assert.throws(() => p.evidenceSources(root, value, true), /escapes/);
});
test('old or unbound evidence does not count towards a new definitive assessment', () => {
  const value = finding(); value.triage.evidence[0].needsReview = true;
  assert.equal(review.readiness(value).outdated, 1); assert.equal(review.readiness(value).counts.contradicts, 0);
  assert.ok(review.readiness(value).errors.length > 0);
  delete value.triage.evidence[0].needsReview; value.triage.evidence[0].source = { file: 'src/Demo.sol', line: 13 };
  assert.equal(review.readiness(value).counts.contradicts, 0);
});
test('map refresh retains old evidence/hash as stale and resets review checkmarks only with consent', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  const root = workspace(t), report = path.join(root, 'report.md'), native = process.env.FLOWBOARD_EXTENSION_PATH;
  fs.writeFileSync(report, '### [I-01] Demo counter review\nThe increment operation updates the Demo counter.'); await importReport(report, root, native);
  const old = store.readDraft(root, 'I-01'); old.finding.status = 'invalid'; old.finding.triage = finding().triage;
  old.finding.triage.evidence = [{ ...entry(), source: { file: 'src/Demo.sol', line: 13 } }];
  old.finding.triage.checks[0] = { id: 'revision', state: 'checked', note: 'Original fictional revision checked.' }; store.writeDraft(root, 'I-01', old);
  const hash = old.finding.triage.evidence[0].source.sourceHash;
  fs.appendFileSync(path.join(root, 'src/Demo.sol'), '\n// changed\n');
  await assert.rejects(refreshFindingMap(root, 'I-01', native), error => error.code === 'REVIEW_RESET_REQUIRED');
  const refreshed = await refreshFindingMap(root, 'I-01', native, { allowReviewReset: true });
  const triage = refreshed.request.finding.triage;
  assert.equal(triage.evidence[0].needsReview, true); assert.equal(triage.evidence[0].source.sourceHash, hash);
  assert.equal(triage.checks[0].state, 'unchecked'); assert.equal(refreshed.request.finding.status, 'unreviewed');
  p.sources(root, refreshed.request); assert.equal(review.readiness(refreshed.request.finding).counts.contradicts, 0);
  assert.equal(p.readWorkspaceJson(root, refreshed.backup).finding.triage.evidence[0].needsReview, undefined);
});
test('review brief contains both sides, version uncertainty and a reason rather than an invented validity score', () => {
  const value = finding(); value.triage.evidence.push({ ...entry('supports'), id: 'e-2', note: 'A reported claim needs comparison with the fictional source.' });
  const brief = review.brief(value); assert.match(brief, /contradicts:/); assert.match(brief, /supports:/);
  assert.match(brief, /Source \/ report version/); assert.match(brief, /Decision explanation/); assert.doesNotMatch(brief, /\d+%/);
});
test('direct UI saves enforce the same overall JSON size bound as imported requests', () => {
  const request = structuredClone(example);
  for (const key of ['preconditions', 'evidence', 'openQuestions']) request.finding[key] = Array(40).fill('a'.repeat(4000));
  assert.throws(() => p.validate(request), /request limit/);
});
