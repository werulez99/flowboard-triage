'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
const { parseReport, draftIssue } = require('../extension/report');
const { reportClaims, preparedReview, prepareInvestigation } = require('../extension/investigation');
const review = require('../extension/webview/review-model');
const store = require('../extension/store');
const native = process.env.FLOWBOARD_EXTENSION_PATH;
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-preparation-'));
  fs.cpSync(path.join(__dirname, '../examples/project'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('mechanical claim preparation quotes report prose, never asserts observed behavior or support', () => {
  const finding = { summary: 'The counter allegedly changes. A separate behavior requires review.' };
  const claims = reportClaims(finding);
  assert.deepEqual(claims.map(claim => claim.text), [finding.summary], 'Related sentences stay together; preparation does not make a separate task for every sentence.');
  assert.deepEqual(claims, reportClaims(finding));
  assert.ok(claims.every(claim => claim.state === 'unreviewed' && !claim.observed && !claim.evidence.length));
  assert.equal(preparedReview(finding).evidence.length, 0);
  assert.equal(preparedReview({ ...finding, triage: review.create() }).claims.length, 0, 'Respect intentional existing empty claims.');
  assert.equal(reportClaims({ summary: 'x'.repeat(2100) }).length, 0, 'Do not truncate a claim into another meaning.');
});
test('existing valid citations do not suppress alternative description search or invent evidence', { skip: !native }, async t => {
  const root = workspace(t), indexed = await analyze(native, root), catalog = new SourceCatalog(root, indexed.runner, indexed.result);
  const issue = parseReport('### [I-01] Counter addition\n**Location**: src/Demo.sol:8\n**Summary**: The _add helper updates the counter.')[0];
  const draft = draftIssue(issue, root, indexed.runner, indexed.result, null, catalog);
  assert.equal(draft.request.finding.triage.claims.length, 1);
  const prepared = prepareInvestigation(catalog, draft.request, draft);
  assert.equal(prepared.semanticReview, false);
  assert.ok([...prepared.contexts, ...prepared.candidates].some(candidate => candidate.source.name === 'Demo::_add'), 'Relevant helper remains available, even when citation preparation now opens it automatically.');
  assert.ok(prepared.contexts[0].excerpt.includes('increment'));
  assert.equal(prepared.contexts[0].calls[0].source.line, 9);
  assert.equal(prepared.contexts[0].calls[0].targets[0].line, 12);
  assert.match(prepared.contexts[0].source.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(draft.request.finding.triage.evidence.length, 0);
  assert.ok(prepared.missing.some(text => text.includes('code version')));
  let calls = 0; const callLinks = catalog.callLinks.bind(catalog);
  catalog.callLinks = (...args) => { calls++; return callLinks(...args); };
  const again = prepareInvestigation(catalog, { ...draft.request, id: 'new-delivery' }, draft);
  assert.deepEqual(again, prepared); assert.equal(calls, 0, 'A delivery UUID does not redo exploration work.');
  again.contexts.length = 0;
  assert.ok(prepareInvestigation(catalog, draft.request, draft).contexts.length, 'Consumers cannot mutate cached context.');
  prepareInvestigation(catalog, { ...draft.request, finding: { ...draft.request.finding, preconditions: ['A new researcher premise.'] } }, draft);
  assert.ok(calls > 0, 'Changed researcher inputs invalidate context reuse.');
});
test('reported actual behavior is a hypothesis, not automatically an inspected source observation', { skip: !native }, async t => {
  const root = workspace(t), { runner, result } = await analyze(native, root);
  const issue = parseReport('### [I-01] Counter review\n**Location**: src/Demo.sol:8\n**Expected behavior**: The normal counter increases.\n**Actual behavior**: The report alleges an unexpected result.')[0];
  const draft = draftIssue(issue, root, runner, result).request;
  assert.equal(draft.finding.actualBehavior, undefined);
  assert.equal(draft.finding.triage.ruleOrigin.kind, 'report');
  assert.ok(draft.finding.triage.claims.some(claim => claim.text === 'The report alleges an unexpected result.' && claim.state === 'unreviewed'));
});
test('unresolved member implementation remains visible and cannot create a graph arrow', { skip: !native }, async t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'src/Unknown.sol'), 'pragma solidity ^0.8.20;\ncontract Unknown {\n function read(address target) external {\n  target.call("");\n }\n}\n');
  const { runner, result } = await analyze(native, root), catalog = new SourceCatalog(root, runner, result);
  const fn = catalog.resolveCard({ file: 'src/Unknown.sol', line: 3 });
  const links = catalog.callLinks(fn); assert.equal(links.length, 1); assert.equal(links[0].candidates.length, 0);
  assert.equal(links[0].line, 4); assert.deepEqual(catalog.graph([fn], [{ id: 'unknown' }]), []);
});
test('events, custom errors and casts do not masquerade as unresolved implementation calls', { skip: !native }, async t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'src/Syntax.sol'), 'pragma solidity ^0.8.20;\ncontract Syntax {\n event Changed(uint value);\n error Bad();\n function entry(address target) external {\n  emit Changed(1);\n  if(target == address(0)) revert Bad();\n  Syntax(target);\n  abi.encode(target);\n }\n}\n');
  const { runner, result } = await analyze(native, root), catalog = new SourceCatalog(root, runner, result);
  const fn = catalog.resolveCard({ file: 'src/Syntax.sol', line: 5 });
  assert.deepEqual(catalog.callLinks(fn), []);
});
test('working copies preserve incomplete typing, but never merge across a changed draft', t => {
  const root = workspace(t), triage = review.create();
  triage.claims.push({ id: 'unfinished', text: '', state: 'unreviewed', evidence: [], questions: [] });
  const copy = { version: 1, baseDraftFingerprint: 'old', baseSourceFingerprint: 'source', patch: { triage }, editVersion: 4 };
  assert.equal(review.workingCopy(copy, 'old', 'source').matches, true);
  assert.equal(review.workingCopy(copy, 'new', 'source').matches, false);
  assert.equal(review.workingCopy(copy, 'old', 'changed-source').matches, false, 'Same draft does not imply the same dependency source.');
  assert.equal(review.workingCopy({ ...copy, patch: { executable: 'not review data' } }, 'old'), null);
  const state = { cards: [], edges: [], view: { version: 1, drawerTab: 'claims', activeClaim: 'first' }, workingCopy: copy };
  store.writeBoard(root, 'first', state, 'source-fingerprint');
  assert.deepEqual(store.readBoard(root, 'first').state, state);
  assert.equal(store.readBoard(root, 'second'), null);
});
