'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const p = require('../extension/protocol');
const example = require('../examples/finding.json');

test('editor protocol, stale-name failures and idempotence with real source runner', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-host-'));
  fs.cpSync(path.join(__dirname, '../examples/project'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extensionPath = path.resolve(process.env.FLOWBOARD_EXTENSION_PATH);
  const commands = new Map(), messages = [], errors = [], state = new Map(), panels = [], opened = [], clipboard = [];
  let dirtySource = false;
  const dispose = () => ({ dispose() {} });
  const uri = file => ({ fsPath: file, toString: () => file });
  const folder = { uri: uri(root) };
  class Panel {
    static stateKey = 'solidityFlowboard.state';
    static currentPanel;
    static createOrShow(context) {
      if (!this.currentPanel) this.currentPanel = new Panel(context);
      return this.currentPanel;
    }
    constructor(context) {
      this.context = context;
      this.panel = { webview: {
        onDidReceiveMessage: callback => { this.receive = callback; setImmediate(() => callback({ type: 'triage:ready' })); return dispose(); },
        postMessage: async message => { messages.push(message); if (message.type === 'triage:load') setImmediate(() => this.receive({ type: 'triage:rendered', token: message.token })); return true; }
      }, onDidDispose: dispose, reveal() {} };
    }
    onExpandCall(callback) { this.expand = callback; }
    addMissing() {}
    addFunction() {}
  }
  const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(startLine, startCharacter, endLine, endCharacter) { Object.assign(this, { startLine, startCharacter, endLine, endCharacter }); } },
    RelativePattern: class {},
    env: { clipboard: { writeText: async text => { clipboard.push(text); } } },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), showErrorMessage: message => errors.push(message),
      showTextDocument: async (document, options) => { opened.push({ file: document.uri.fsPath, options }); } },
    workspace: { isTrusted: true, workspaceFolders: [folder],
      createFileSystemWatcher: () => ({ ...dispose(), onDidCreate: dispose, onDidChange: dispose }),
      onDidChangeWorkspaceFolders: dispose, getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      openTextDocument: async source => {
        const text = fs.readFileSync(source.fsPath, 'utf8'); const lines = text.split('\n');
        return { uri: source, isDirty: dirtySource, lineCount: lines.length, getText: () => text,
          lineAt: line => ({ firstNonWhitespaceCharacterIndex: Math.max(0, lines[line].search(/\S/)) }),
          offsetAt: position => lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character };
      }
    },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return dispose(); } },
    extensions: { getExtension: () => ({ packageJSON: { version: '1.2.0' }, extensionPath, extensionUri: uri(extensionPath), activate: async () => {} }) }
  };
  const originalLoad = Module._load;
  Module._load = function(name, ...rest) {
    if (name === 'vscode') return vscode;
    if (name === './native-panel') return { createNativePanel: (_api, ctx) => { const panel = new Panel(ctx); panels.push(panel); return panel; } };
    return originalLoad.call(this, name, ...rest);
  };
  t.after(() => { Module._load = originalLoad; });
  const { activate } = require('../extension/extension');
  activate({ extensionUri: uri(path.resolve(__dirname, '../extension')), subscriptions: [],
    workspaceState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => state.set(key, value) } });
  const processRequest = commands.get('flowboardTriage.process');
  p.atomicJson(root, p.REQUEST, example);
  await processRequest();
  assert.equal(p.readJson(path.join(root, p.STATUS)).state, 'ready');
  const payload = messages.find(x => x.type === 'triage:load');
  assert.equal(payload.state.cards.length, 2);
  assert.equal(payload.state.edges.length, 1);
  assert.equal(payload.finding.status, 'unreviewed');
  assert.equal(payload.state.notes.length, 0, 'Review fields are in the drawer, not a giant canvas note.');
  assert.ok(payload.state.cards[1].x > payload.state.cards[0].x);
  panels[0].receive({ type: 'triage:save', issueId: payload.issueId, token: payload.token, patch: { status: 'invalid', evidence: ['src/Demo.sol:8 — normal fixture behavior'] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.readWorkspaceJson(root, `.flowboard/findings/${payload.issueId}.json`).finding.status, 'invalid');
  assert.ok(messages.some(message => message.type === 'triage:reviewSaved'));
  const count = messages.length;
  await processRequest(); assert.equal(messages.length, count);
  const changed = structuredClone(example); changed.finding.title = 'Same ID, different content';
  p.atomicJson(root, p.REQUEST, changed); await processRequest();
  assert.match(p.readJson(path.join(root, p.STATUS)).error, /fresh ID/);
  changed.id = 'fresh-but-stale-function'; changed.findingId = 'separate-invalid-draft'; changed.cards[0].function = 'doesNotExist';
  p.atomicJson(root, p.REQUEST, changed); await processRequest();
  assert.match(p.readJson(path.join(root, p.STATUS)).error, /Expected doesNotExist/);
  assert.equal(messages.length, count, 'No partial cards on preflight failure.');
  assert.equal(errors.length, 2);
  const conflict = structuredClone(example); conflict.id = 'fresh-conflicting-review';
  conflict.findingId = payload.issueId; conflict.finding.summary = 'A different assessment that was not saved to the draft';
  p.atomicJson(root, p.REQUEST, conflict); await processRequest();
  assert.match(p.readJson(path.join(root, p.STATUS)).error, /Edit the finding draft first/);
  assert.equal(p.readWorkspaceJson(root, `.flowboard/findings/${payload.issueId}.json`).finding.status, 'invalid');
  assert.equal(messages.length, count);
  await panels[0].receive({ type: 'triage:openReference', issueId: payload.issueId, token: payload.token, file: 'src/Demo.sol', line: 8 });
  assert.equal(opened[0].file, path.join(root, 'src/Demo.sol'));
  assert.equal(opened[0].options.selection.startLine, 7);
  assert.equal(opened[0].options.viewColumn, 1, 'Open report/source references beside the canvas.');
  await panels[0].receive({ type: 'triage:copyReport', issueId: payload.issueId, token: payload.token });
  assert.equal(clipboard[0], example.finding.summary);
  assert.ok(commands.has('flowboardTriage.refresh'));
  const before = storeDraft();
  await panels[0].receive({ type: 'triage:openReference', issueId: payload.issueId, token: 'stale-session', file: 'src/Demo.sol', line: 8 });
  await panels[0].receive({ type: 'triage:openReference', issueId: payload.issueId, token: payload.token, file: '../outside.sol', line: 8 });
  await panels[0].receive({ type: 'triage:openReference', issueId: payload.issueId, token: payload.token, file: 'src/Demo.sol', line: 999 });
  assert.equal(opened.length, 1, 'Stale, escaped and out-of-range references do not navigate.');
  assert.deepEqual(storeDraft(), before);
  const evidence = { id: 'e-host', stance: 'contradicts', note: 'The normal counter update is intended in the fictional demo.', source: { file: 'src/Demo.sol', line: 13 } };
  panels[0].receive({ type: 'triage:bindEvidence', issueId: payload.issueId, token: payload.token, evidence });
  await new Promise(resolve => setImmediate(resolve));
  const bound = messages.findLast(message => message.type === 'triage:evidenceBound');
  assert.match(bound.evidence.source.sourceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(storeDraft(), before, 'Binding evidence alone does not save/overwrite a review.');
  panels[0].receive({ type: 'triage:inspectEvidence', issueId: payload.issueId, token: payload.token, evidence: bound.evidence });
  await new Promise(resolve => setImmediate(resolve));
  const inspected = messages.findLast(message => message.type === 'triage:evidenceInspected');
  assert.match(inspected.excerpt, /13.*counter \+= amount/);
  assert.equal(opened[1].options.selection.startLine, 12);
  assert.equal(opened[1].options.viewColumn, 1, 'Inspect evidence beside the native canvas, not by replacing it.');
  const triage = require('../extension/webview/review-model').create(); triage.decisionReason = 'Normal source behavior matches the fictional intended counter update.'; triage.evidence = [bound.evidence];
  panels[0].receive({ type: 'triage:save', issueId: payload.issueId, token: payload.token, patch: { status: 'invalid', triage } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storeDraft().finding.triage.evidence[0].source.sourceHash, bound.evidence.source.sourceHash);
  panels[0].receive({ type: 'triage:copyBrief', issueId: payload.issueId, token: payload.token });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(clipboard[1], /contradicts: src\/Demo.sol:13/); assert.match(clipboard[1], /not tool-verified/);
  const totalBound = messages.filter(message => message.type === 'triage:evidenceBound').length;
  panels[0].receive({ type: 'triage:bindEvidence', issueId: payload.issueId, token: 'wrong-session', evidence });
  panels[0].receive({ type: 'triage:bindEvidence', issueId: payload.issueId, token: payload.token, evidence: { ...evidence, source: { file: '../Outside.sol', line: 1 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.filter(message => message.type === 'triage:evidenceBound').length, totalBound);
  dirtySource = true;
  const navigationCount = opened.length;
  panels[0].receive({ type: 'triage:openReference', issueId: payload.issueId, token: payload.token, file: 'src/Demo.sol', line: 8 });
  panels[0].receive({ type: 'triage:bindEvidence', issueId: payload.issueId, token: payload.token, evidence });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, navigationCount, 'Dirty buffers cannot silently shift exact source navigation.');
  assert.equal(messages.filter(message => message.type === 'triage:evidenceBound').length, totalBound);
  dirtySource = false;
  panels[0].receive({ type: 'triage:prompt', issueId: payload.issueId, token: payload.token, cardId: payload.state.cards[0].id });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(clipboard.at(-1), /Focus on Demo::increment at src\/Demo.sol:8/);
  assert.match(clipboard.at(-1), /Unsaved UI edits are not included/);
  const copied = clipboard.length;
  panels[0].receive({ type: 'triage:prompt', issueId: payload.issueId, token: payload.token, cardId: 'unknown-card' });
  panels[0].receive({ type: 'triage:prompt', issueId: payload.issueId, token: 'old-token', cardId: payload.state.cards[0].id });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clipboard.length, copied, 'Unknown cards and stale sessions cannot create a function prompt.');
  const editedCache = structuredClone(payload.state);
  editedCache.cards[0].code = 'function fictionalReplacement() {}';
  editedCache.cards[0].startLine = 999;
  editedCache.cards[0].x = 321;
  panels[0].receive({ type: 'triage:persist', issueId: payload.issueId, token: payload.token, state: editedCache });
  await new Promise(resolve => setImmediate(resolve));
  const delivery = storeDraft(); delivery.id = 'reload-current-source';
  p.atomicJson(root, p.REQUEST, delivery); await processRequest();
  assert.equal(p.readJson(path.join(root, p.STATUS)).state, 'ready');
  const restored = messages.findLast(message => message.type === 'triage:load');
  assert.equal(restored.state.cards[0].x, 321, 'A valid saved layout is retained.');
  assert.equal(restored.state.cards[0].code, payload.state.cards[0].code, 'Cache text cannot masquerade as hash-bound source.');
  assert.equal(restored.state.cards[0].startLine, 8, 'Original source coordinates are restored from the current catalog.');
  function storeDraft() { return p.readWorkspaceJson(root, `.flowboard/findings/${payload.issueId}.json`); }
});
