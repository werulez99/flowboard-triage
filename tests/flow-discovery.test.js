'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
const { parseReport, draftIssue, importReport, refreshFindingMap } = require('../extension/report');
const store = require('../extension/store');
const p = require('../extension/protocol');
const { lexicalCode, functionParts } = require('../extension/solidity-text');
const native = process.env.FLOWBOARD_EXTENSION_PATH;
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-discovery-'));
  fs.cpSync(path.join(__dirname, '../examples/project'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
async function catalog(root) { const { runner, result } = await analyze(native, root); return new SourceCatalog(root, runner, result); }
function write(root, source) { fs.writeFileSync(path.join(root, 'src/Fixture.sol'), source); }
function graph(c, names) {
  const fns = names.map(([contract, name, arity]) => c.functions.find(fn => fn.contract === contract && fn.name === name && (arity == null || fn.paramCount === arity)));
  assert.ok(fns.every(Boolean), 'All fixture definitions indexed.');
  const cards = fns.map((fn, i) => ({ id: String(i), file: c.relative(fn.file), line: fn.startLine, function: fn.name }));
  return { fns, cards, edges: c.graph(fns, cards) };
}
test('comments and string contents are not executable calls or definitions', () => {
  const source = 'function entry() external { string memory x = "function ghost() { fake(); }"; /* fake(); */ real("a,b"); }';
  const clean = lexicalCode(source); assert.equal(clean.length, source.length); assert.doesNotMatch(clean, /ghost|fake/);
  assert.match(clean, /real\("\s*"\)/); assert.equal(functionParts(source, 'ghost'), null);
});
test('GitHub-style colon-L citations and receiver calls keep their different identities', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract NamedHook {\n function inspect() external { manager.take(currency, recipient, fee); }\n}');
  const c = await catalog(root);
  const report = parseReport('### [I-01] NamedHook.inspect differs from its rule\n**Location**: src/Fixture.sol:L3-L3\n**Description**\nThe call manager.take(currency, recipient, fee) needs context.')[0];
  assert.deepEqual(report.locations, [{ file: 'src/Fixture.sol', line: 3 }]);
  const draft = draftIssue(report, root, c.runner, c.result, undefined, c);
  assert.equal(draft.request.cards[0].function, 'inspect');
  assert.ok(!draft.warnings.some(w => /No exact definition.*manager.take/.test(w)), 'A member expression is not searched as a declaration signature.');
  const absent = parseReport('### [I-01] MissingHook.inspect differs from its rule\nDescription: inspect the swap fee in the manager.')[0];
  const blocked = draftIssue(absent, root, c.runner, c.result, undefined, c);
  assert.equal(blocked.request, null); assert.match(blocked.applicability.blockers[0], /MissingHook/);
});
test('unresolved modifier metadata cannot pass an undefined path into path.relative', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Partial is AbsentBase {\n function act() external onlyOwner { }\n}');
  const c = await catalog(root), fn = c.functions.find(fn => fn.contract === 'Partial' && fn.name === 'act');
  const request = { finding: { title: 'Partial.act caller check', summary: 'Check the missing inherited guard.' }, cards: [{ id: 's', file: 'src/Fixture.sol', line: 3, function: 'act' }] };
  const prepared = require('../extension/investigation').prepareInvestigation(c, request);
  assert.ok(fn); assert.ok(prepared.contexts.length);
  assert.ok(prepared.missing.some(text => /onlyOwner.*(guard|declaration)|guard.*onlyOwner/.test(text)), 'The unavailable guard remains explicit instead of crashing.');
});
test('an explicit local import disambiguates duplicate library names without proving external dispatch', { skip: !native }, async t => {
  const root = workspace(t);
  for (const side of ['right', 'other']) {
    fs.mkdirSync(path.join(root, 'lib', side), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib', side, 'Maths.sol'), `pragma solidity ^0.8.20;\nlibrary Maths {\n function advance(uint256 x) internal pure returns(uint256) { return x + ${side === 'right' ? 1 : 2}; }\n}`);
  }
  fs.writeFileSync(path.join(root, 'remappings.txt'), '@right/=lib/right/\n');
  write(root, 'pragma solidity ^0.8.20;\nimport {Maths} from "@right/Maths.sol";\ncontract Uses {\n function next(uint256 x) external pure returns(uint256) { return Maths.advance(x); }\n}');
  const c = await catalog(root), fn = c.functions.find(fn => fn.contract === 'Uses');
  const definitions = c.mentioned({ contract: 'Maths', name: 'advance' });
  assert.equal(definitions.length, 2);
  const candidates = c.relevantDefinitions(definitions, fn.file);
  assert.equal(candidates.length, 1); assert.equal(c.relative(candidates[0].file), 'lib/right/Maths.sol');
  assert.match(c.code(candidates[0]), /x \+ 1/);
  const links = c.callLinks(fn); assert.equal(links[0].candidates.length, 1); assert.equal(c.relative(links[0].candidates[0].file), 'lib/right/Maths.sol');
});
test('no-line prose with a bare name discovers anchors plus actual source neighbors', { skip: !native }, async t => {
  const root = workspace(t), c = await catalog(root);
  const issue = parseReport('### [I-01] Counter update\nThe increment operation changes the Demo counter. No vulnerability claim.')[0];
  assert.equal(issue.locations.length, 0); assert.equal(issue.names.length, 0);
  const draft = draftIssue(issue, root, c.runner, c.result, undefined, c);
  assert.ok(draft.request.cards.some(card => card.function === 'increment'));
  assert.ok(draft.request.cards.some(card => card.function === '_add'));
  assert.equal(draft.request.connections.length, 1); assert.match(draft.request.connections[0].reason, /src\/Demo.sol:9/);
  assert.equal(draft.request.finding.status, 'unreviewed');
});
test('description identifiers discover code even without any function name or citation', { skip: !native }, async t => {
  const root = workspace(t), c = await catalog(root);
  const issue = parseReport('### [I-01] Demo counter adjustment\n**Description**: In Demo, updating the counter changes its stored quantity.')[0];
  const draft = draftIssue(issue, root, c.runner, c.result, undefined, c);
  assert.ok(draft.request?.cards.some(card => card.function === '_add' && card.mapping.method === 'description'));
  assert.ok(draft.request.cards.some(card => card.function === 'increment' && card.mapping.method === 'source-neighbor'));
  assert.equal(draft.retrieval.searchedFunctions, 2);
});
test('vague prose never invents a function or execution order', { skip: !native }, async t => {
  const root = workspace(t), c = await catalog(root);
  const draft = draftIssue(parseReport('### [I-01] Strange behavior\nSomething unexpected happens at runtime.')[0], root, c.runner, c.result, undefined, c);
  assert.equal(draft.request, null); assert.equal(draft.retrieval.candidates.length, 0);
});
test('file mentions without lines scope description retrieval to the cited source', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Another {\n function increment(uint amount) external {}\n}');
  const c = await catalog(root), issue = parseReport('### [I-01] Update review\nInspect the increment operation in src/Fixture.sol, without any line citation.')[0];
  const draft = draftIssue(issue, root, c.runner, c.result, undefined, c);
  assert.ok(draft.retrieval.candidates.length); assert.ok(draft.retrieval.candidates.every(candidate => candidate.file === 'src/Fixture.sol'));
});
test('similar description matches show multiple candidates with explicit uncertainty', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract First {\n function refreshReward(uint quantity) external {}\n}\ncontract Second {\n function refreshReward(uint quantity) external {}\n}');
  const c = await catalog(root), issue = parseReport('### [I-01] Reward refresh review\nA reward refresh changes quantity.')[0];
  const draft = draftIssue(issue, root, c.runner, c.result, undefined, c);
  assert.equal(draft.retrieval.ambiguous, true); assert.ok(draft.retrieval.candidates.length >= 2);
  assert.ok(draft.warnings.some(warning => /similar relevance/.test(warning)));
  assert.equal(draft.request.finding.status, 'unreviewed');
});
test('a quoted function-like string cannot become an imported source function', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Example {\n function entry() external pure {\n string memory text = "function ghost() { hidden(); }";\n }\n}');
  const c = await catalog(root);
  const issue = parseReport('### [I-01] Source citation review\nInspect ghost() in src/Fixture.sol:4.')[0];
  const draft = draftIssue(issue, root, c.runner, c.result, undefined, c);
  assert.ok(!draft.request?.cards.some(card => card.function === 'ghost'));
  if (draft.request) assert.ok(draft.request.cards.every(card => card.kind === 'context' || c.anatomy(c.resolveCard(card))));
});
test('member calls use the receiver contract and include the actual source call line', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Meter {\n function bump(uint amount) external {}\n}\ncontract Sender {\n Meter meter;\n function forward(uint amount) external {\n  meter.bump(amount);\n }\n}');
  const c = await catalog(root), value = graph(c, [['Sender', 'forward'], ['Meter', 'bump']]);
  assert.deepEqual(value.edges.map(edge => [edge.from, edge.to]), [['0', '1']]);
  assert.match(value.edges[0].reason, /Fixture.sol:8.*meter.bump/);
  assert.equal(c.candidates('Meter::bump', 'Sender', false, 1)[0].contract, 'Meter');
});
test('super resolves the base rather than reconnecting to the override', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Base {\n function bump(uint amount) internal virtual {}\n}\ncontract Child is Base {\n function bump(uint amount) internal override { super.bump(amount); }\n}');
  const c = await catalog(root), value = graph(c, [['Child', 'bump'], ['Base', 'bump']]);
  assert.deepEqual(value.edges.map(edge => [edge.from, edge.to]), [['0', '1']]);
});
test('competing inherited super implementations require review instead of native first-match dispatch', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Left { function bump(uint x) internal virtual {} }\ncontract Right { function bump(uint x) internal virtual {} }\ncontract Child is Left, Right {\n function bump(uint x) internal override(Left, Right) { super.bump(x); }\n}');
  const c = await catalog(root), value = graph(c, [['Child', 'bump'], ['Left', 'bump'], ['Right', 'bump']]);
  assert.equal(c.callLinks(value.fns[0])[0].candidates.length, 2); assert.equal(value.edges.length, 0);
});
test('a single inherited branch keeps its nearest source definition', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Root { function bump(uint x) internal virtual {} }\ncontract Middle is Root { function bump(uint x) internal virtual override {} }\ncontract Child is Middle {\n function bump(uint x) internal override { super.bump(x); }\n}');
  const c = await catalog(root), value = graph(c, [['Child', 'bump'], ['Middle', 'bump'], ['Root', 'bump']]);
  assert.deepEqual(value.edges.map(edge => [edge.from, edge.to]), [['0', '1']]);
});
test('each overload call keeps its own arity; unmatched arities do not fall back', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Router {\n function route() internal {}\n function route(uint x) internal {}\n function entry() external { route(); route(1); }\n}');
  const c = await catalog(root), value = graph(c, [['Router', 'entry'], ['Router', 'route', 0], ['Router', 'route', 1]]);
  assert.deepEqual(value.edges.map(edge => [edge.from, edge.to]), [['0', '1'], ['0', '2']]);
  assert.equal(c.candidates('route', 'Router', false, 2).length, 0);
});
test('native last-name arity cannot silently choose the wrong clicked overload', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Router {\n function route() internal {}\n function route(uint x) internal {}\n function entry() external { route(); route(1); }\n}');
  const c = await catalog(root), entry = c.named('entry')[0];
  assert.deepEqual(c.expansionCandidates(entry, 'route', false, 1).map(fn => fn.paramCount).sort(), [0, 1]);
});
test('parameter types do not contaminate another function state receiver type', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract First { function bump(uint x) external {} }\ncontract Second { function bump(uint x) external {} }\ncontract Sender {\n First target;\n function forward(Second target) external { target.bump(1); }\n function ordinary() external { target.bump(2); }\n}');
  const c = await catalog(root);
  const forward = c.named('forward')[0], ordinary = c.named('ordinary')[0];
  assert.equal(c.callLinks(forward)[0].candidates[0].contract, 'Second');
  assert.equal(c.callLinks(ordinary)[0].candidates[0].contract, 'First');
});
test('using-for library calls include the implicit receiver parameter', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\nlibrary Arithmetic {\n function bump(uint self, uint amount) internal pure returns(uint) { return self + amount; }\n}\ncontract Counter {\n using Arithmetic for uint;\n uint counter;\n function increment(uint amount) external { counter = counter.bump(amount); }\n}');
  const c = await catalog(root), value = graph(c, [['Counter', 'increment'], ['Arithmetic', 'bump']]);
  assert.equal(value.edges.length, 1);
});
test('later or nested receiver shadowing cannot silently change an earlier call target', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract First { function bump(uint x) external {} }\ncontract Second { function bump(uint x) external {} }\ncontract Sender {\n First target;\n function forward() external { target.bump(1); { Second target; target.bump(2); } }\n}');
  const c = await catalog(root), value = graph(c, [['Sender', 'forward'], ['First', 'bump'], ['Second', 'bump']]);
  assert.equal(c.callLinks(value.fns[0]).length, 2);
  assert.ok(c.callLinks(value.fns[0]).every(link => link.candidates.length === 2));
  assert.equal(value.edges.length, 0);
});
test('multiple applicable using-for libraries stay ambiguous instead of taking the first', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\nlibrary First { function bump(uint self, uint x) internal pure returns(uint) { return self + x; } }\nlibrary Second { function bump(uint self, uint x) internal pure returns(uint) { return self + x; } }\ncontract Sender {\n using First for uint; using Second for uint; uint counter;\n function forward() external { counter = counter.bump(1); }\n}');
  const c = await catalog(root), value = graph(c, [['Sender', 'forward'], ['First', 'bump'], ['Second', 'bump']]);
  assert.equal(c.callLinks(value.fns[0])[0].candidates.length, 2); assert.equal(value.edges.length, 0);
});
test('string/comment mentions do not become call arrows; false declared calls are downgraded', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ncontract Example {\n function hidden() internal {}\n function entry() external pure { string memory x = "hidden()"; /* hidden(); */ }\n}');
  const c = await catalog(root), value = graph(c, [['Example', 'entry'], ['Example', 'hidden']]);
  assert.equal(value.edges.length, 0);
  const checked = c.validateConnections(value.fns, value.cards, [{ from: '0', to: '1', kind: 'call', reason: 'A reported but nonexistent source connection.' }]);
  assert.equal(checked.connections[0].kind, 'hypothesis'); assert.equal(checked.warnings.length, 1);
});
test('multiple interface implementations are visible ambiguity, not an arbitrary dispatch choice', { skip: !native }, async t => {
  const root = workspace(t);
  write(root, 'pragma solidity ^0.8.20;\ninterface IMeter { function bump(uint amount) external; }\ncontract First is IMeter { function bump(uint amount) external {} }\ncontract Second is IMeter { function bump(uint amount) external {} }\ncontract Sender {\n IMeter meter;\n function forward(uint amount) external { meter.bump(amount); }\n}');
  const c = await catalog(root), value = graph(c, [['Sender', 'forward'], ['First', 'bump'], ['Second', 'bump']]);
  assert.ok(c.callLinks(value.fns[0])[0].candidates.length > 1); assert.equal(value.edges.length, 0);
});
test('refreshing a map preserves review fields and archives the previous draft', { skip: !native }, async t => {
  const root = workspace(t), file = path.join(root, 'report.md');
  fs.writeFileSync(file, '### [I-01] Counter review\nThe increment operation updates the Demo counter.');
  await importReport(file, root, native);
  const old = store.readDraft(root, 'I-01'); old.finding.expectedBehavior = 'A reviewer-authored explanation'; store.writeDraft(root, 'I-01', old);
  const updated = await refreshFindingMap(root, 'I-01', native);
  assert.equal(updated.request.finding.expectedBehavior, 'A reviewer-authored explanation');
  assert.equal(p.readWorkspaceJson(root, updated.backup).finding.expectedBehavior, 'A reviewer-authored explanation');
  assert.notEqual(updated.request.id, old.id);
});
test('changed source needs consent before resetting a definitive prior review', { skip: !native }, async t => {
  const root = workspace(t), file = path.join(root, 'report.md');
  fs.writeFileSync(file, '### [I-01] Counter review\nThe increment operation updates the Demo counter.');
  await importReport(file, root, native);
  const old = store.readDraft(root, 'I-01'); delete old.finding.triage; // legacy assessment without structured review
  old.finding.status = 'invalid'; old.finding.evidence = ['src/Demo.sol:8 — fictional intended behavior']; store.writeDraft(root, 'I-01', old);
  fs.appendFileSync(path.join(root, 'src/Demo.sol'), '\n// source changed\n');
  await assert.rejects(refreshFindingMap(root, 'I-01', native), error => error.code === 'REVIEW_RESET_REQUIRED');
  assert.equal(store.readDraft(root, 'I-01').finding.status, 'invalid');
  const updated = await refreshFindingMap(root, 'I-01', native, { allowReviewReset: true });
  assert.equal(updated.request.finding.status, 'unreviewed'); assert.equal(p.readWorkspaceJson(root, updated.backup).finding.status, 'invalid');
});
test('map refresh refuses an outdated form fingerprint', { skip: !native }, async t => {
  const root = workspace(t), file = path.join(root, 'report.md');
  fs.writeFileSync(file, '### [I-01] Counter review\nThe increment operation updates the Demo counter.'); await importReport(file, root, native);
  const old = store.readDraft(root, 'I-01'), fingerprint = crypto.createHash('sha256').update(JSON.stringify(old)).digest('hex');
  old.finding.summary = 'Edited concurrently'; store.writeDraft(root, 'I-01', old);
  await assert.rejects(refreshFindingMap(root, 'I-01', native, { expectedFingerprint: fingerprint }), /edited elsewhere/);
});
test('an unsuccessful refresh does not replace or reset saved review work', { skip: !native }, async t => {
  const root = workspace(t), example = structuredClone(require('../examples/finding.json'));
  example.findingId = 'I-01'; example.finding.status = 'invalid'; example.finding.title = 'Unmapped claim';
  example.finding.summary = 'Something unexpected happens at runtime.'; store.writeDraft(root, 'I-01', example);
  const updated = await refreshFindingMap(root, 'I-01', native);
  assert.equal(updated.request, null); assert.deepEqual(store.readDraft(root, 'I-01'), example);
});
test('changed anchors need consent before carrying a definitive verdict onto a new map', { skip: !native }, async t => {
  const root = workspace(t), file = path.join(root, 'report.md');
  fs.writeFileSync(file, '### [I-01] Counter review\nThe increment operation updates the Demo counter.'); await importReport(file, root, native);
  const old = store.readDraft(root, 'I-01'); delete old.finding.triage; // legacy assessment remains readable
  old.finding.status = 'invalid'; old.finding.evidence = ['Fictional intended behavior'];
  old.cards.push({ id: 'reviewer-context', file: 'src/Demo.sol', line: 3, kind: 'context' }); store.writeDraft(root, 'I-01', old);
  await assert.rejects(refreshFindingMap(root, 'I-01', native), error => error.code === 'REVIEW_RESET_REQUIRED');
  assert.deepEqual(store.readDraft(root, 'I-01'), old);
  const updated = await refreshFindingMap(root, 'I-01', native, { allowReviewReset: true });
  assert.equal(updated.request.finding.status, 'unreviewed'); assert.equal(p.readWorkspaceJson(root, updated.backup).cards.length, old.cards.length);
});
