'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { TriageBoard } = require('../extension/board');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
const store = require('../extension/store');
const p = require('../extension/protocol');
const review = require('../extension/webview/review-model');
const example = require('../examples/finding.json');
const native = process.env.FLOWBOARD_EXTENSION_PATH;

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-lifecycle-'));
  fs.cpSync(path.join(__dirname, '../examples/project'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const analyzed = await analyze(native, root), catalog = new SourceCatalog(root, analyzed.runner, analyzed.result);
  const request = { ...structuredClone(example), id: 'session-A', findingId: 'finding-A' };
  const triage = review.create();
  triage.evidence.push({ id: 'observation', stance: 'context', note: 'Fictional counter source.', source: { file: 'src/Demo.sol', line: 13 } });
  request.finding.triage = triage; store.writeDraft(root, request.findingId, request);
  const model = { id: request.findingId, request, catalog, sourceById: new Map(), expandedIds: new Set(),
    draftFingerprint: crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'), fingerprint: 'fixture-index' };
  for (const card of request.cards) { model.sourceById.set(card.id, catalog.resolveCard(card)); model.expandedIds.add(card.id); }
  const messages = [], opened = [], added = [];
  const board = Object.create(TriageBoard.prototype);
  Object.assign(board, { root, activeId: request.findingId, activeToken: request.id, disposed: false,
    models: new Map([[model.id, model]]), sessions: new Map([[request.id, model]]),
    post: async message => { messages.push(message); return true; }, log: { appendLine() {} },
    native: { panel: { viewColumn: 2 }, addFunction: (...args) => added.push(args) },
    vscode: { Uri: { file: fsPath => ({ fsPath }) }, ViewColumn: { One: 1, Beside: 2 },
      Range: class { constructor(startLine, startCharacter, endLine, endCharacter) { Object.assign(this, { startLine, startCharacter, endLine, endCharacter }); } },
      workspace: { isTrusted: true, openTextDocument: async uri => ({ uri, isDirty: false }) },
      window: { showTextDocument: async (document, options) => opened.push({ document, options }) } } });
  return { root, board, model, messages, opened, added, source: path.join(root, 'src/Demo.sol'),
    message: { issueId: board.activeId, token: board.activeToken } };
}

test('native source navigation checks membership, hashes, dirty buffers and late session changes', { skip: !native }, async t => {
  const { board, source, model, message, opened } = await setup(t);
  const request = { ...message, fsPath: source, startLine: 8 };
  await board.openNativeSource(request);
  assert.equal(opened.length, 1); assert.equal(opened[0].options.selection.startLine, 7);
  await assert.rejects(board.openNativeSource({ ...request, startLine: 13 }), /not part of the current/);
  await board.openNativeSource({ ...request, token: 'old-session' }); assert.equal(opened.length, 1);
  board.vscode.workspace.openTextDocument = async uri => ({ uri, isDirty: true });
  await assert.rejects(board.openNativeSource(request), /Unsaved edits/); assert.equal(opened.length, 1);
  let release;
  board.vscode.workspace.openTextDocument = uri => new Promise(resolve => { release = () => resolve({ uri, isDirty: false }); });
  const pending = board.openNativeSource(request); board.activeToken = 'new-session'; release(); await pending;
  assert.equal(opened.length, 1, 'An earlier card click cannot open an editor after a finding switch.');
  board.activeToken = message.token;
  fs.appendFileSync(source, '\n// changed after mapping\n');
  await assert.rejects(board.openNativeSource(request), /Source changed|Stale/);
  assert.equal(model.request.finding.status, 'unreviewed');
});
test('evidence inspection selects the whole checked span with surrounding context', { skip: !native }, async t => {
  const { board, message, opened, messages } = await setup(t);
  const evidence = { id: 'span', stance: 'context', note: 'Fictional helper source.', source: { file: 'src/Demo.sol', line: 12, endLine: 14 } };
  await board.receive({ ...message, type: 'triage:bindEvidence', evidence });
  const bound = messages.at(-1).evidence;
  await board.receive({ ...message, type: 'triage:inspectEvidence', evidence: bound });
  assert.equal(opened[0].options.selection.startLine, 11); assert.equal(opened[0].options.selection.endLine, 13);
  assert.match(messages.at(-1).excerpt, /13.*counter \+= amount/);
  assert.match(messages.at(-1).excerpt, /14.*}/);
});

test('optional native explanations use checked catalog code and recheck freshness after asynchronous work', { skip: !native }, async t => {
  const { board, model, message, source } = await setup(t), calls = [], before = structuredClone(model.request);
  board.native.annotate = (...args) => { calls.push(args); };
  const cardId = model.sourceById.keys().next().value, fn = model.sourceById.get(cardId);
  const input = { ...message, id: cardId, name: 'fabricatedName', code: 'Arbitrary stale payload', fsPath: '/outside.sol', startLine: 1000, endLine: 2000 };
  await board.annotateNativeSource(input);
  assert.equal(calls.length, 1);
  const [id, name, code, file, startLine, endLine, checked] = calls[0];
  assert.equal(id, cardId); assert.equal(name, fn.name); assert.equal(file, source);
  assert.equal(startLine, fn.startLine); assert.equal(endLine, fn.endLine);
  assert.equal(code, require('../extension/webview/inline-review').cleanCode(model.catalog.code(fn)));
  assert.equal(checked.source.sourceHash, crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'));
  assert.equal(checked.isCurrent(), true);
  assert.deepEqual(model.request, before, 'Optional model comments are never copied into evidence or a verdict.');
  await assert.rejects(board.annotateNativeSource({ ...input, id: 'not-on-this-map' }), /not part of the current investigation/);
  board.vscode.workspace.textDocuments = [{ uri: { fsPath: source }, isDirty: true }];
  await assert.rejects(board.annotateNativeSource(input), /Save Solidity edits/);
  assert.throws(checked.isCurrent, /Save Solidity edits/);
  board.vscode.workspace.textDocuments = [];
  board.activeToken = 'new-session'; assert.equal(checked.isCurrent(), false);
  await board.annotateNativeSource(input); assert.equal(calls.length, 1);
  board.activeToken = message.token;
  board.vscode.workspace.openTextDocument = async uri => ({ uri, isDirty: true });
  await assert.rejects(board.annotateNativeSource(input), /Save Solidity edits/);
  board.vscode.workspace.openTextDocument = async uri => ({ uri, isDirty: false });
  let release;
  board.vscode.workspace.openTextDocument = uri => new Promise(resolve => { release = () => resolve({ uri, isDirty: false }); });
  const pending = board.annotateNativeSource(input); board.activeToken = 'later-session'; release(); await pending;
  assert.equal(calls.length, 1, 'A delayed document load cannot start a provider after switching findings.');
  board.activeToken = message.token;
  fs.appendFileSync(source, '\n// Source changed while a fictional provider was running.\n');
  assert.throws(checked.isCurrent, /Source changed|Stale/);
});

test('proactive source changes preserve the board and review while marking all old indexes stale', { skip: !native }, async t => {
  const { board, source, model, messages, message } = await setup(t);
  const before = structuredClone(model.request);
  await board.sourceChanged(source, true);
  assert.equal(messages.at(-1).type, 'triage:sourceStale');
  assert.equal(messages.at(-1).token, message.token); assert.equal(messages.at(-1).dirty, true);
  assert.deepEqual(messages.at(-1).files, ['src/Demo.sol']);
  assert.deepEqual(model.request, before, 'Review judgments are not silently changed by a file-system event.');
  assert.equal(board.native.triageSourceStale, true);
  assert.throws(() => board.assertCurrent(model), /Unsaved Solidity edits/);
  await board.sourceChanged(path.join(board.root, 'src/NewImplementation.sol'));
  assert.ok(model.stale.files.includes('src/NewImplementation.sol'), 'Creating a possible implementation also invalidates dispatch preparation.');
  assert.equal(messages.some(item => item.type === 'triage:load'), false, 'A background edit must not replace the active cards or camera.');
  const count = messages.length;
  await board.notify('Old finding error', true, { issueId: 'another', token: 'old' });
  assert.equal(messages.length, count);
});

test('review saves serialize document loading so an old patch cannot overtake a newer save', { skip: !native }, async t => {
  const { board, root, model, message, messages } = await setup(t);
  let release, opened = 0;
  board.vscode.workspace.openTextDocument = async uri => {
    opened++;
    if (opened === 1) await new Promise(resolve => { release = resolve; });
    return { uri, isDirty: false };
  };
  const first = board.receive({ ...message, type: 'triage:save', editVersion: 1, patch: { summary: 'First saved draft' } });
  const second = board.receive({ ...message, type: 'triage:save', editVersion: 2, patch: { summary: 'Later saved draft' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened, 1, 'The second save waits instead of racing the same draft fingerprint.');
  release(); await Promise.all([first, second]);
  assert.equal(store.readDraft(root, model.id).finding.summary, 'Later saved draft');
  assert.deepEqual(messages.filter(item => item.type === 'triage:reviewSaved').map(item => item.editVersion), [1, 2]);
  assert.ok(messages.filter(item => item.type === 'triage:reviewSaved').every(item => /^[a-f0-9]{64}$/.test(item.draftFingerprint)));
});

test('switching findings while a save awaits a document cannot save into either new or old session', { skip: !native }, async t => {
  const { board, root, model, message, messages } = await setup(t);
  const before = store.readDraft(root, model.id); let release;
  board.vscode.workspace.openTextDocument = uri => new Promise(resolve => { release = () => resolve({ uri, isDirty: false }); });
  const pending = board.receive({ ...message, type: 'triage:save', patch: { summary: 'Unwanted late save' } });
  await new Promise(resolve => setImmediate(resolve));
  board.activeId = 'finding-B'; board.activeToken = 'session-B'; release(); await pending;
  assert.deepEqual(store.readDraft(root, model.id), before);
  assert.equal(messages.some(item => item.type === 'triage:reviewSaved'), false);
});

test('late same-finding snapshots cannot overwrite the latest finding session', { skip: !native }, async t => {
  const { board, root, model, message } = await setup(t);
  board.models.set(model.id, { ...model, fingerprint: 'new-index' });
  await board.receive({ ...message, type: 'triage:persist', state: { cards: [], edges: [], notes: [] } });
  assert.equal(fs.existsSync(path.join(root, '.flowboard/boards', model.id + '.json')), false);
});

test('malformed native comments are archived before opening a usable fresh source map', { skip: !native }, async t => {
  const { board, root, model, source, messages } = await setup(t);
  const malformed = { fingerprint: 'old-cache', state: { cards: [{ id: 'bad', name: 'increment', fsPath: source,
    startLine: 8, code: 'Old source', showAnnotations: true, annotations: {} }], edges: [], notes: [{ text: 'Recover this researcher note.' }] } };
  p.atomicJson(root, `.flowboard/boards/${model.id}.json`, malformed);
  board.ready = Promise.resolve(); board.renderWaiters = new Map(); board.native.panel.reveal = () => {};
  board.post = async message => { messages.push(message); if (message.type === 'triage:load') board.renderWaiters.get(message.token).resolve(); return true; };
  await board.open(model.request, model.catalog, { mode: 'source' }, p.gitState(root));
  const loaded = messages.find(message => message.type === 'triage:load');
  assert.ok(loaded.warnings.some(warning => /Invalid saved canvas.*cached native annotations.*archived/.test(warning)));
  assert.ok(loaded.state.cards.length); assert.ok(loaded.state.cards.every(card => card.annotations === undefined));
  assert.equal(loaded.finding.status, 'unreviewed');
  const history = path.join(root, '.flowboard/board-history', model.id);
  const archives = fs.readdirSync(history); assert.equal(archives.length, 1);
  assert.deepEqual(p.readWorkspaceJson(root, path.relative(root, path.join(history, archives[0]))), malformed);
});

test('prepared source context adds an independent card without asserting a call edge', { skip: !native }, async t => {
  const { board, model, message, added, messages } = await setup(t);
  const fn = model.catalog.resolveCard({ file: 'src/Demo.sol', line: 12, function: '_add' });
  const source = { file: 'src/Demo.sol', line: fn.startLine, endLine: fn.endLine,
    sourceHash: model.catalog.hints(fn).sourceHash, name: 'Demo::_add' };
  model.investigation = { contexts: [], candidates: [{ source }] };
  await assert.rejects(board.receive({ ...message, type: 'triage:addContext', source: { ...source, line: 8 } }), /not part of the current/);
  await board.receive({ ...message, type: 'triage:addContext', source });
  assert.equal(added.length, 1); assert.equal(added[0][2], null, 'No source call edge is manufactured from candidate selection.');
  assert.equal(added[0][0].name, '_add');
  assert.equal(messages.at(-1).type, 'triage:contextAdded'); assert.equal(messages.at(-1).token, message.token);
  board.vscode.workspace.openTextDocument = async uri => ({ uri, isDirty: true });
  await assert.rejects(board.receive({ ...message, type: 'triage:addContext', source }), /Save the source/);
  assert.equal(added.length, 1);
});

test('refresh detects changed expanded dependencies even when original anchors and evidence are unchanged', { skip: !native }, async t => {
  const { root, model } = await setup(t), dependency = path.join(root, 'src/Dependency.sol');
  fs.writeFileSync(dependency, 'pragma solidity ^0.8.20;\ncontract Dependency {\n function normal() external pure returns (uint) { return 1; }\n}\n');
  const analyzed = await analyze(native, root), catalog = new SourceCatalog(root, analyzed.runner, analyzed.result);
  const request = model.request;
  request.finding.summary = 'The fictional report alleges a decrease at src/Demo.sol:8 and src/Demo.sol:12.';
  request.finding.status = 'invalid'; request.finding.triage.decisionReason = 'The counter fixture adds the supplied amount; no bug is established.';
  request.finding.triage.evidence[0].stance = 'contradicts';
  request.finding.triage.claims = [{ id: 'counter', text: 'The fictional counter decreases.', state: 'contradicted', reason: 'Addition contradicts this narrow allegation.',
    evidence: [{ evidenceId: 'observation', stance: 'contradicts', reason: 'The cited statement adds the supplied amount.' }] }];
  request.finding.triage.checks[0] = { id: 'revision', state: 'checked', note: 'The fictional source was inspected.' };
  store.writeDraft(root, model.id, request);
  const fns = request.cards.map(card => catalog.resolveCard(card));
  const edges = request.cards.filter(card => card.parentId).map(card => ({ from: card.parentId, to: card.id, kind: card.edgeKind || 'hypothesis', reason: card.reason || '' }));
  const fingerprint = crypto.createHash('sha256').update(catalog.fingerprint(request.cards) + JSON.stringify(catalog.validateConnections(fns, request.cards, edges).connections)).digest('hex');
  const state = { cards: [{ id: 'expanded-context', name: 'normal', fsPath: dependency, startLine: 3, code: 'Old source snapshot' }], edges: [], notes: [{ text: 'Researcher context note' }] };
  store.writeBoard(root, model.id, state, fingerprint);
  const beforeBoard = store.readBoard(root, model.id), evidenceHash = request.finding.triage.evidence[0].source.sourceHash;
  fs.appendFileSync(dependency, '\n// changed outside the finding anchors\n');
  const { refreshFindingMap } = require('../extension/report');
  await assert.rejects(refreshFindingMap(root, model.id, native), error => error.code === 'REVIEW_RESET_REQUIRED');
  assert.equal(store.readDraft(root, model.id).finding.status, 'invalid', 'Consent is required before resetting the prior judgment.');
  const refreshed = await refreshFindingMap(root, model.id, native, { allowReviewReset: true });
  assert.equal(refreshed.request.finding.status, 'unreviewed');
  assert.equal(refreshed.request.finding.triage.evidence[0].needsReview, true);
  assert.equal(refreshed.request.finding.triage.evidence[0].source.sourceHash, evidenceHash);
  assert.equal(refreshed.request.finding.triage.claims[0].state, 'unreviewed');
  assert.equal(refreshed.request.finding.triage.checks[0].state, 'unchecked');
  assert.equal(p.readWorkspaceJson(root, refreshed.backup).finding.status, 'invalid');
  assert.deepEqual(store.readBoard(root, model.id), beforeBoard, 'Refresh leaves cached researcher notes recoverable for the later board archive.');
});

test('configuration-only changes keep reopened judgments historical until consented reset, then remain unlocked', { skip: !native }, async t => {
  const { root, board, model, messages, opened } = await setup(t), request = model.request;
  request.finding.summary = 'The fictional report alleges a decrease at src/Demo.sol:8 and src/Demo.sol:12.';
  request.finding.status = 'invalid'; request.finding.triage.decisionReason = 'The inspected fictional counter uses addition.';
  request.finding.triage.evidence[0].stance = 'contradicts';
  request.finding.triage.checks[0] = { id: 'revision', state: 'checked', note: 'The prior source context was inspected.' };
  store.writeDraft(root, model.id, request);
  const savedBefore = store.readDraft(root, model.id);
  board.ready = Promise.resolve(); board.renderWaiters = new Map(); board.native.panel.reveal = () => {};
  board.post = async message => { messages.push(message); if (message.type === 'triage:load') board.renderWaiters.get(message.token).resolve(); return true; };
  let delivery = 0;
  const open = async (draft, catalog) => {
    await board.open({ ...structuredClone(draft), id: `config-open-${++delivery}` }, catalog, { mode: 'source' }, p.gitState(root));
    return messages.filter(message => message.type === 'triage:load').at(-1);
  };
  const persist = loaded => board.receive({ type: 'triage:persist', issueId: loaded.issueId, token: loaded.token, state: loaded.state });
  const first = await open(request, model.catalog); await persist(first);
  fs.writeFileSync(path.join(root, 'remappings.txt'), 'fictional/=src/\n');
  assert.throws(() => model.catalog.assertFresh(), /Project configuration changed/);
  const analyzed = await analyze(native, root), current = new SourceCatalog(root, analyzed.runner, analyzed.result);
  assert.notEqual(current.fingerprint(request.cards), model.catalog.fingerprint(request.cards));
  const historical = await open(savedBefore, current);
  assert.equal(historical.readOnly, true); assert.equal(historical.sourceStale, true);
  assert.equal(historical.historicalAssessment.status, 'invalid'); assert.equal(historical.finding.triage.evidence[0].needsReview, true);
  assert.equal(historical.finding.triage.checks[0].state, 'unchecked');
  assert.deepEqual(store.readDraft(root, model.id), savedBefore, 'Opening current code cannot silently rewrite the prior reviewer judgment.');
  const scope = { issueId: historical.issueId, token: historical.token };
  await board.openNativeSource({ ...scope, fsPath: historical.state.cards[0].fsPath, startLine: historical.state.cards[0].startLine });
  assert.equal(opened.length, 1, 'Current source navigation remains usable beside historical review notes.');
  await assert.rejects(board.receive({ ...scope, type: 'triage:save', patch: { summary: 'Must not apply' } }), /different source, configuration or index version/);
  await assert.rejects(board.receive({ ...scope, type: 'triage:bindEvidence', evidence: request.finding.triage.evidence[0] }), /different source, configuration or index version/);
  await persist(historical);
  const pending = store.readBoard(root, model.id);
  assert.equal(pending.fingerprint, historical.fingerprint); assert.equal(pending.reviewSourceFingerprint, first.fingerprint);
  const { refreshFindingMap } = require('../extension/report');
  await assert.rejects(refreshFindingMap(root, model.id, native), error => error.code === 'REVIEW_RESET_REQUIRED');
  assert.deepEqual(store.readDraft(root, model.id), savedBefore);
  const refreshed = await refreshFindingMap(root, model.id, native, { allowReviewReset: true });
  assert.equal(refreshed.request.finding.status, 'unreviewed'); assert.equal(refreshed.request.finding.triage.evidence[0].needsReview, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = await open(store.readDraft(root, model.id), current);
    assert.equal(reopened.readOnly, false); assert.equal(reopened.sourceStale, false); assert.equal(reopened.historicalAssessment, null);
    await persist(reopened);
    assert.equal(store.readBoard(root, model.id).reviewSourceFingerprint, reopened.fingerprint, 'An explicit reset rebases context and does not permanently lock later reopenings.');
  }
});

test('report-only unreviewed seeded claims are not mistaken for a historical assessment on index migration', { skip: !native }, async t => {
  const { root, board, model, messages } = await setup(t), request = model.request;
  request.finding.triage = review.create();
  request.finding.triage.claims = require('../extension/investigation').reportClaims(request.finding);
  assert.ok(request.finding.triage.claims.length);
  store.writeDraft(root, model.id, request);
  store.writeBoard(root, model.id, { cards: [], edges: [], notes: [{ text: 'Existing report-only layout note.' }] }, 'pre-index-v4');
  board.ready = Promise.resolve(); board.renderWaiters = new Map(); board.native.panel.reveal = () => {};
  board.post = async message => { messages.push(message); if (message.type === 'triage:load') board.renderWaiters.get(message.token).resolve(); return true; };
  await board.open(request, model.catalog, { mode: 'source' }, p.gitState(root));
  const loaded = messages.find(message => message.type === 'triage:load');
  assert.equal(loaded.readOnly, false); assert.equal(loaded.sourceStale, false); assert.equal(loaded.historicalAssessment, null);
  assert.ok(loaded.warnings.some(warning => /Source, configuration or index version changed/.test(warning)));
  assert.equal(loaded.finding.status, 'unreviewed');
});
