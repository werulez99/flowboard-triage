'use strict';
// Mechanism regressions. These assertions do not grade real model reasoning.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
const engine = require('../extension/investigation-engine');
const store = require('../extension/store');
const { prepareInvestigation } = require('../extension/investigation');
const { start } = require('../scripts/workflow-host');
const native = process.env.FLOWBOARD_EXTENSION_PATH;
test('bodyless imported declarations are readable context, not invented executable targets', { skip: !native }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-interface-context-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/IReader.sol'), 'pragma solidity ^0.8.20;\ninterface IReader {\n // function read(bytes32 key) external;\n function read(uint256 key) external view returns (uint256);\n}\n');
  fs.writeFileSync(path.join(root, 'src/Consumer.sol'), 'pragma solidity ^0.8.20;\nimport "./IReader.sol";\ncontract Consumer {\n function inspect(IReader reader) external view returns (uint256) { return reader.read(1); }\n}\n');
  const indexed = await analyze(native, root), catalog = new SourceCatalog(root, indexed.runner, indexed.result);
  const request = { findingId: 'I-01', finding: { title: 'Consumer.inspect reads a number', summary: 'Read the interface without guessing the deployed reader.' }, cards: [{ file: 'src/Consumer.sol', line: 4, function: 'inspect' }] };
  const context = engine.makeContext(catalog, request), entry = context.units.find(unit => unit.name === 'Consumer::inspect');
  const action = context.act({ id: 'q1', claimId: 'c1', action: 'symbol', target: 'IReader::read', text: 'Read the declared argument and return types.', why: 'Interface context is locally available.' }, { entry: entry.id });
  assert.equal(action.outcome, 'source-returned');
  const unit = context.units.find(unit => unit.name === 'IReader::read');
  assert.equal(unit.contextKind, 'declaration'); assert.equal(unit.source.line, 4); assert.equal(unit.source.endLine, 4);
  assert.match(unit.code, /read\(uint256 key\).*returns \(uint256\);/);
  assert.equal(catalog.resolveUnit(unit).kind, 'context'); assert.deepEqual(unit.relatedCalls, []);
  assert.equal(catalog.named('read').length, 0, 'A declaration is not placed in the implementation index.');
  const altered = structuredClone(unit); altered.source.line = 3;
  assert.throws(() => catalog.resolveUnit(altered), /declaration no longer matches/);
});
test('an unrelated same-named struct cannot hide an imported receiver and library operation', { skip: !native }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-struct-scope-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test/Unrelated.sol'), 'pragma solidity ^0.8.20;\nstruct Box { uint256 unrelated; }\n');
  fs.writeFileSync(path.join(root, 'src/Types.sol'), 'pragma solidity ^0.8.20;\ninterface IReader {}\nstruct Box { IReader reader; }\nlibrary ReaderLib {\n function read(IReader self, uint256 key) internal pure returns (uint256) { return key; }\n}\n');
  fs.writeFileSync(path.join(root, 'src/Consumer.sol'), 'pragma solidity ^0.8.20;\nimport "./Types.sol";\ncontract Consumer {\n using ReaderLib for IReader;\n function inspect(Box memory box) external pure returns (uint256) { return box.reader.read(2); }\n}\n');
  const indexed = await analyze(native, root);
  indexed.result.structFields.set('Box', new Map([['unrelated', 'uint256']])); // emulate the native global first-match collision
  const catalog = new SourceCatalog(root, indexed.runner, indexed.result), fn = catalog.named('inspect')[0];
  const link = catalog.callLinks(fn).find(link => link.expression.endsWith('read(…)'));
  assert.deepEqual(link.receiverTypes, ['IReader']);
  assert.deepEqual(link.candidates.map(fn => fn.contract + '::' + fn.name), ['ReaderLib::read']);
  assert.equal(link.relationship, 'hypothesis', 'A source-library candidate still needs argument and branch review.');
});
test('qualified inherited modifier questions read the imported guard and its internal helper', { skip: !native }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-imported-guard-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/Guard.sol'), 'pragma solidity ^0.8.20;\ncontract Guard {\n modifier onlyMember() {\n  _checkMember();\n  _;\n }\n function _checkMember() internal view { require(msg.sender != address(0)); }\n}\n');
  fs.writeFileSync(path.join(root, 'src/Entry.sol'), 'pragma solidity ^0.8.20;\nimport "./Guard.sol";\ncontract Entry is Guard {\n function update() external onlyMember { }\n}\n');
  const indexed = await analyze(native, root), catalog = new SourceCatalog(root, indexed.runner, indexed.result);
  const request = { findingId: 'I-01', finding: { title: 'Entry.update permissions', summary: 'Check the modifier before assessing reachability.' }, cards: [{file:'src/Entry.sol',line:4,function:'update'}] };
  const context = engine.makeContext(catalog, request), entry = context.units.find(unit => unit.name === 'Entry::update');
  const action = context.act({ id:'q',claimId:'c',action:'symbol',target:'Entry::onlyMember',text:'Read the guard.',why:'It determines entry.' }, {entry:entry.id});
  assert.ok(action.sourceIds.some(id => context.units.find(unit => unit.id === id)?.name === 'Guard::onlyMember'));
  assert.ok(context.units.some(unit => unit.name === 'Guard::_checkMember'));
  const guard = context.units.find(unit => unit.name === 'Guard::onlyMember');
  assert.deepEqual([guard.source.file,guard.source.line,guard.source.endLine], ['src/Guard.sol',3,6]);
});
test('large discovery reserves local-reading room and distinguishes a limit from missing code', { skip: !native }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-reading-budget-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  // Independently specified ordinary fixture: each distinct function returns
  // its own number. No call edges, state writes or security conclusions.
  fs.writeFileSync(path.join(root, 'src/Many.sol'), ['pragma solidity ^0.8.20;', 'contract Many {',
    ...Array.from({ length: 45 }, (_, i) => `function read${i}() external pure returns (uint256) { return ${i}; }`), '}'].join('\n'));
  const indexed = await analyze(native, root), catalog = new SourceCatalog(root, indexed.runner, indexed.result);
  const request = { findingId: 'I-01', finding: { title: 'Read the supplied declarations', summary: 'Check which number each declaration returns.' },
    cards: catalog.functions.slice(0, 35).map(fn => ({ file: 'src/Many.sol', line: fn.startLine, function: fn.name })) };
  const review = engine.makeContext(catalog, request, { reportText: request.finding.summary });
  assert.equal(review.units.length, 28, 'Initial candidates leave space within the existing forty-source bound.');
  const action = review.act({ id: 'q', action: 'symbol', target: 'read40', text: 'Inspect read40', why: 'Needed for the stated result.' });
  assert.equal(action.outcome, 'source-returned');
  assert.ok(review.units.some(unit => unit.name === 'Many::read40' && unit.code.includes('return 40;')));
  for (const fn of catalog.functions.slice(0, 40)) review.add(fn, 'Fill the bounded fixture context.');
  assert.equal(review.units.length, 40);
  const limited = review.act({ id: 'q2', action: 'symbol', target: 'read44', text: 'Inspect read44', why: 'Check remaining context.' });
  assert.equal(limited.outcome, 'reading-limit');
  assert.match(limited.result, /Available locally but not read.*Many::read44/);
  assert.equal(review.units.length, 40);
  const cited = review.units.find(unit => unit.name === 'Many::read0');
  const deferred = review.prioritize({ claims: [{ entry: cited.id }], evidence: [{ sourceId: cited.id }], questions: [], explanationReviews: [] });
  assert.equal(deferred.length, 8, 'Follow-up room comes from unbound candidates, not an increased source cap.');
  assert.ok(review.units.some(unit => unit.id === cited.id), 'Cited evidence cannot be evicted to pass a limit.');
  const reread = review.act({ id: 'q3', action: 'symbol', target: 'read44', text: 'Inspect read44', why: 'Required follow-up.' });
  assert.equal(reread.outcome, 'source-returned');
  assert.ok(review.units.some(unit => unit.name === 'Many::read44' && unit.code.includes('return 44;')));
});
async function context(t, id) {
  const host = await start({ qualityCase: id }); t.after(() => host.close());
  const indexed = await analyze(native, host.root), catalog = new SourceCatalog(host.root, indexed.runner, indexed.result);
  const request = store.readDraft(host.root, 'I-01'), issue = store.readReport(host.root).issues[0];
  return { host, catalog, request, issue, review: engine.makeContext(catalog, request, issue) };
}
test('local references read exact immutable declarations, and repeated checks identify already available code', { skip: !native }, async t => {
  const { catalog, review } = await context(t, 'd3'), entry = review.units.find(unit => unit.name === 'ReviewQueue::finalize');
  const question = { id: 'q', claimId: 'c', action: 'references', target: 'reviewer', text: 'Can reviewer change?', why: 'Check the role definition.' };
  const action = review.act(question, { entry: entry.id });
  assert.equal(action.outcome, 'source-returned');
  const declaration = review.units.find(unit => unit.contextKind === 'state' && unit.name === 'ReviewQueue::reviewer (state)');
  assert.equal(declaration.code, '    address public immutable reviewer;');
  assert.deepEqual([declaration.source.line, declaration.source.endLine], [5, 5]);
  assert.ok(action.sourceIds.includes(declaration.id));
  assert.equal(catalog.resolveUnit(declaration).kind, 'context');
  assert.equal(review.act(question, { entry: entry.id }).outcome, 'context-already-available');
  const altered = structuredClone(declaration); altered.source.line = 6;
  assert.throws(() => catalog.resolveUnit(altered), /declaration no longer matches/);
});
test('resumed context preserves a legacy evidence ID after exact code validation', { skip: !native }, async t => {
  const { review } = await context(t, 'd3'), entry = review.units.find(unit => unit.name === 'ReviewQueue::finalize');
  review.act({ id: 'q', action: 'references', target: 'reviewer', text: 'Read reviewer', why: 'Role' }, { entry: entry.id });
  const saved = structuredClone(review.units), state = saved.find(unit => unit.contextKind === 'state');
  const old = state.id; state.id = 'legacy-context-id';
  review.restore(saved, { evidence: [{ sourceId: 'legacy-context-id' }], claims: [], actions: [] });
  assert.ok(review.units.some(unit => unit.id === 'legacy-context-id' && unit.code === state.code));
  assert.ok(!review.units.some(unit => unit.id === old));
  const action = review.act({ id: 'q2', action: 'inspect', target: 'legacy-context-id', text: 'Read it', why: 'Existing evidence' });
  assert.ok(action.sourceIds.includes('legacy-context-id'));
});
test('an audit identifier alone cannot import another contract’s unrelated test cases', { skip: !native }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-test-report-identity-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'src/Clock.sol'), 'pragma solidity ^0.8.20;\ncontract Clock { function read() external pure returns (uint256) { return 1; } }');
  fs.writeFileSync(path.join(root, 'test/Elsewhere.t.sol'), '// M-01: audit of a different contract\npragma solidity ^0.8.20;\ncontract ElsewhereTest { function testM01() external pure { require(true); } }');
  const indexed = await analyze(native, root), catalog = new SourceCatalog(root, indexed.runner, indexed.result);
  const request = { findingId: 'M-01', finding: { title: 'Clock.read returns a value', summary: 'Read Clock.read.' }, cards: [{ file: 'src/Clock.sol', line: 2, function: 'read' }] };
  const prepared = engine.makeContext(catalog, request);
  assert.ok(prepared.units.some(unit => unit.name === 'Clock::read'));
  assert.ok(!prepared.units.some(unit => unit.kind === 'test-source'));
});
test('completion follows the selected route and reads storage without converting declarations or external calls into calls', { skip: !native }, async t => {
  const { catalog, review } = await context(t, 'd4');
  const remote = review.units.find(unit => unit.name === 'RemoteRoute::finish');
  const action = review.complete({ claims: [{ entry: remote.id }], evidence: [] });
  const added = review.units.filter(unit => action.sourceIds.includes(unit.id));
  assert.ok(added.some(unit => unit.code.includes('IRecorder public immutable recorder')));
  assert.ok(added.every(unit => unit.contract === 'RemoteRoute'));
  assert.ok(review.gaps.some(gap => gap.includes('recorder.record')));
  const functions = added.map(unit => catalog.resolveUnit(unit));
  assert.equal(catalog.graph(functions, functions.map((_, i) => ({ id: String(i) }))).length, 0);
  const packet = engine.modelSources(added);
  assert.ok(packet.filter(unit => unit.contextKind === 'state').every(unit => unit.relatedCalls.length === 0));
  assert.ok(packet.some(unit => unit.name === 'RemoteRoute::constructor' && /recorder\s*=/.test(unit.code)), 'Immutable receiver preparation reads its constructor instead of inferring a running implementation from the declaration.');
  assert.ok(packet.every(unit => unit.contextKind === 'state' || unit.name === 'RemoteRoute::constructor'));
});
test('a mixed missing-context request supplies the available local part without pretending to obtain a specification', { skip: !native }, async t => {
  const { review } = await context(t, 'd6'), entry = review.units.find(unit => unit.name === 'PointAccrual::finish');
  const action = review.act({ id: 'q', claimId: 'c', action: 'missing-context', target: 'Storage and specification', text: 'Inspect owner storage and the expected rule.', why: 'The two questions have different evidence.' }, { entry: entry.id });
  assert.equal(action.outcome, 'source-returned');
  const added = review.units.filter(unit => action.sourceIds.includes(unit.id));
  assert.ok(added.some(unit => unit.code.includes('mapping(uint256 => address) public owner;')));
  assert.ok(added.every(unit => unit.contextKind === 'state'));
});
test('old citation remains saved while Read code recommends the explicitly named current function', { skip: !native }, async t => {
  const { catalog, request, issue } = await context(t, 'd5');
  assert.equal(request.cards[0].line, 10);
  const preparation = prepareInvestigation(catalog, request, issue);
  assert.equal(preparation.readingRecommendation.source.name, 'QueueBook::finish');
  assert.equal(preparation.readingRecommendation.source.line, 19);
  assert.equal(request.cards[0].line, 10);
});
test('declaration positions ignore repeated comment text and initializers do not become variable names', { skip: !native }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-declaration-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/Values.sol'), 'pragma solidity ^0.8.20;\ncontract Values {\n // uint256 public total = START;\n uint256 public constant START = 3;\n uint256 public total = START;\n mapping(address => uint256) public amounts;\n function read() external view returns(uint256) { return total; }\n}\n');
  const indexed = await analyze(native, root), catalog = new SourceCatalog(root, indexed.runner, indexed.result);
  const declarations = catalog.stateDeclarations('src/Values.sol', 'Values');
  assert.deepEqual(declarations.map(item => [item.symbol, item.startLine]), [['START', 4], ['total', 5], ['amounts', 6]]);
});

test('ordinary selection supplies new declarations to challenge and exact declaration notes remain navigable after reopening', { skip: !native }, async t => {
  const inputs = [];
  // Explicit controlled response fixture: isolates source-completion/navigation.
  const host = await start({ qualityCase: 'd3', provider: 'codex', invoke: async input => {
    inputs.push(structuredClone(input));
    const entry = input.sources.find(unit => unit.name === 'ReviewQueue::finalize');
    const guard = input.sources.find(unit => unit.name === 'ReviewQueue::onlyReviewer');
    const declaration = input.sources.find(unit => unit.name === 'ReviewQueue::reviewer (state)');
    const evidence = [{ id: 'guard', claimId: 'c', sourceId: guard.id, line: 13, endLine: 13, quote: '        require(msg.sender == reviewer, "reviewer only");', stance: 'context', explanation: 'This guard compares the caller with reviewer.' }];
    if (input.phase === 'challenge') {
      assert.ok(declaration, 'Available local state must reach the actual challenge input.');
      evidence.push({ id: 'role', claimId: 'c', sourceId: declaration.id, line: 5, endLine: 5, quote: '    address public immutable reviewer;', stance: 'context', explanation: 'reviewer is an immutable address; its value cannot change after construction.' });
    }
    return { value: { inputReviews: (input.semanticInput?.premises || []).map(premise => ({ id: premise.id, status: 'unresolved',
      reason: 'This partial fixture checks guard and declaration navigation; it does not establish the saved premise or a complete call scenario.',
      claimIds: ['c'], eventIds: [], evidence: ['guard'] })),
      property: { text: 'Only the reviewer finalizes.', basis: 'report-assumption', evidence: [] }, claims: [{ id: 'c', allegation: 'Any caller can finalize.', actor: 'Caller', entry: entry.id, implementation: 'ReviewQueue::finalize(uint256,bool)', conditions: ['A successful call'], requiredFacts: [], supportsIf: '', contradictsIf: '', status: 'unresolved', reason: 'Controlled fixture, not a model quality judgment.', evidence: evidence.map(item => item.id), unknowns: [], nextQuestion: '' }], evidence,
      explanationReviews: input.phase === 'challenge' ? evidence.map(item => ({ evidenceId: item.id, result: item.id === 'guard' ? 'kept' : 'added', reason: 'Controlled fixture checking exact navigation.', checkedSourceIds: [item.sourceId] })) : [], transitions: [], questions: [], conclusion: { status: 'insufficient-evidence', text: 'Navigation fixture only.', limitations: [] } }, audit: { phase: input.phase, provider: 'controlled-test-fixture', outcome: 'completed' } };
  } }); t.after(() => host.close());
  const send = async message => (await fetch(host.origin + '/message', { method: 'POST', headers: { 'X-Workflow-Token': host.secret, 'Content-Type': 'application/json' }, body: JSON.stringify(message) })).json();
  const state = async () => (await fetch(host.origin + '/state', { headers: { 'X-Workflow-Token': host.secret } })).json();
  const wait = async predicate => { for (let i = 0; i < 500; i++) { const value = await state(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('State timeout'); };
  const open = async () => { await send({ type: 'triage:ready' }); await send({ type: 'triage:select', issueId: 'I-01' }); const value = await wait(s => s.lastLoad?.issueId === 'I-01'); await send({ type: 'triage:rendered', issueId: 'I-01', token: value.token }); return wait(s => s.investigation?.phase === 'blocked'); };
  let current = await open();
  assert.deepEqual(inputs.map(input => input.phase), ['generate', 'challenge']);
  assert.ok(current.investigation.actions.some(action => action.kind === 'code-completion' && action.sourceIds.length));
  await send({ type: 'triage:investigationFocus', issueId: 'I-01', token: current.token, evidenceId: 'role' });
  await send({ type: 'triage:investigationFocus', issueId: 'I-01', token: current.token, evidenceId: 'role', editor: true });
  current = await wait(s => s.opened.length === 1);
  assert.equal(current.opened[0].selection.startLine, 4);
  assert.equal(current.opened[0].selection.endLine, 4);
  assert.equal(current.investigation.evidence.find(item => item.id === 'role').function, null, 'A declaration is not a fake function.');
  const declaration = current.investigation.sources.find(unit => unit.name === 'ReviewQueue::reviewer (state)');
  const checkpoint = structuredClone(current.lastLoad.state);
  const declarationId = `finding:I-01:investigation-${declaration.id}`;
  checkpoint.cards.push({ id: declarationId, kind: 'context', name: 'reviewer (state)', contract: 'ReviewQueue',
    fsPath: path.join(host.root, declaration.source.file), file: 'ReviewQueue.sol', startLine: 5, endLine: 5,
    code: 'Untrusted cached text must be replaced.', x: 877, y: 411, calls: [], memberCalls: [], modifiers: [] });
  store.writeBoard(host.root, 'I-01', checkpoint, current.lastLoad.fingerprint);
  await fetch(host.origin + '/action', { method: 'POST', headers: { 'X-Workflow-Token': host.secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'reopen' }) });
  current = await open();
  assert.equal(inputs.length, 2);
  const restored = current.lastLoad.state.cards.find(card => card.id === declarationId);
  assert.equal(restored.code, declaration.code, 'Reopening must restore the checked declaration, not cached text or a missing-code placeholder.');
  assert.equal(restored.fsPath, path.join(host.root, declaration.source.file));
  assert.deepEqual([restored.x, restored.y], [877, 411], 'Declaration navigation must retain the saved native layout.');
  await send({ type: 'triage:investigationFocus', issueId: 'I-01', token: current.token, evidenceId: 'role', editor: true });
  current = await wait(s => s.opened.length === 2);
  assert.equal(current.opened[1].selection.startLine, 4);
  assert.equal(current.lastLoad.finding.status, 'unreviewed');
  assert.deepEqual(current.errors, []);
});
