'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog, sourceDocument } = require('../extension/source');
const { parseReport, draftIssue, importReport, mapFile } = require('../extension/report');
const p = require('../extension/protocol');
const native = process.env.FLOWBOARD_EXTENSION_PATH;
function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-source-'));
  fs.cpSync(path.join(__dirname, '../examples/project'), directory, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
test('source-document offsets preserve CRLF and mixed newline positions', t => {
  const directory = root(t), file = path.join(directory, 'src/Demo.sol');
  fs.writeFileSync(file, 'first\r\nsecond\nthird');
  const doc = sourceDocument(file); assert.equal(doc.offsetAt({ line: 2, character: 0 }), 14);
});
test('code fences are not parsed as finding headings', () => {
  const issues = parseReport('### [H-01] Real title\n```md\n### [H-02] Fake embedded heading\n```\nText');
  assert.equal(issues.length, 1); assert.match(issues[0].body, /Fake embedded/);
});
test('generic Markdown findings, Windows citations and GitHub-style line anchors', () => {
  const issues = parseReport('## Normal behavior review\n**Severity**: Info\n**Location**: C:\\repo\\src\\Demo.sol:8; src/Demo.sol#L12-L14\n');
  assert.equal(issues.length, 1); assert.deepEqual(issues[0].locations.map(x => x.line), [8, 12]);
});
test('report prefix mapping is portable and does not follow traversal', t => {
  const directory = root(t);
  assert.equal(mapFile(directory, 'some-audit-checkout/src/Demo.sol'), 'src/Demo.sol');
  assert.equal(mapFile(directory, '../src/Demo.sol'), null);
});
test('declaration citations become honest context cards, not fabricated function calls', { skip: !native }, async t => {
  const directory = root(t), { runner, result } = await analyze(native, directory);
  const issue = parseReport('### [I-01] Storage declaration\n**Location**: src/Demo.sol:6\nText')[0];
  const draft = draftIssue(issue, directory, runner, result);
  assert.equal(draft.request.cards[0].kind, 'context'); assert.equal(draft.request.connections.length, 0);
});
test('explicit function mentions produce unique source anchors without line citations', { skip: !native }, async t => {
  const directory = root(t), { runner, result } = await analyze(native, directory);
  const issue = parseReport('### [I-01] Describe flow\nThe increment(amount) function calls _add(amount).')[0];
  const draft = draftIssue(issue, directory, runner, result);
  assert.deepEqual(draft.request.cards.map(x => x.function), ['increment', '_add']);
  assert.equal(draft.request.finding.status, 'unreviewed');
});
test('same-arity overloads are ambiguous rather than silently auto-connected', { skip: !native }, async t => {
  const directory = root(t);
  fs.writeFileSync(path.join(directory, 'src/Overload.sol'), 'pragma solidity ^0.8.20; contract Overload { function route(uint256 x) internal {} function route(address x) internal {} function entry() external { route(uint256(1)); } }');
  const { runner, result } = await analyze(native, directory); const catalog = new SourceCatalog(directory, runner, result);
  assert.equal(catalog.candidates('route', 'Overload', false, 1).length, 2);
  assert.equal(catalog.functionAt('src/Overload.sol', 1), null);
  assert.throws(() => catalog.resolveCard({ file: 'src/Overload.sol', line: 1, function: 'route' }), /No unique function/);
  assert.equal(catalog.resolveCard({ file: 'src/Overload.sol', line: 1, function: 'entry' }).name, 'entry');
});
test('source changes after indexing block later navigation', { skip: !native }, async t => {
  const directory = root(t), { runner, result } = await analyze(native, directory), catalog = new SourceCatalog(directory, runner, result);
  fs.appendFileSync(path.join(directory, 'src/Demo.sol'), '\n// changed\n');
  assert.throws(() => catalog.assertFresh(), /Source changed/);
});
test('expanded dependency changes invalidate saved boards even without changing original anchors', { skip: !native }, async t => {
  const directory = root(t), dependency = path.join(directory, 'src/Extra.sol');
  fs.writeFileSync(dependency, 'pragma solidity ^0.8.20; contract Extra { function helper() external {} }');
  const first = await analyze(native, directory), before = new SourceCatalog(directory, first.runner, first.result);
  const cards = [{ id: 'anchor', file: 'src/Demo.sol', line: 8, function: 'increment' }];
  const hash = before.fingerprint(cards);
  fs.appendFileSync(dependency, '\n// unrelated to the original anchor, but present in an expanded source card\n');
  const second = await analyze(native, directory), after = new SourceCatalog(directory, second.runner, second.result);
  assert.notEqual(after.fingerprint(cards), hash);
});
test('another report gets separate draft IDs and archives the previous report', { skip: !native }, async t => {
  const directory = root(t), file = path.join(directory, 'report.md');
  fs.writeFileSync(file, '### [I-01] First report\n**Location**: src/Demo.sol:8\n');
  const first = await importReport(file, directory, native);
  fs.writeFileSync(file, '### [I-01] Unrelated second report\n**Location**: src/Demo.sol:12\n');
  const second = await importReport(file, directory, native);
  assert.notEqual(first.issues[0].id, second.issues[0].id);
  assert.equal(p.readWorkspaceJson(directory, '.flowboard/findings/I-01.json').finding.title, 'I-01: First report');
  assert.equal(p.readWorkspaceJson(directory, `.flowboard/reports/${first.reportHash}.json`).reportHash, first.reportHash);
});
