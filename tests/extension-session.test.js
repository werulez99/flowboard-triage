'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const p = require('../extension/protocol');
const store = require('../extension/store');
const { analyze } = require('../extension/runner-adapter');
const { importReport } = require('../extension/report');
const { TriageBoard } = require('../extension/board');
const native = process.env.FLOWBOARD_EXTENSION_PATH;

function gate() {
  let release, entered;
  return { held: new Promise(resolve => { release = resolve; }), started: new Promise(resolve => { entered = resolve; }),
    release: () => release(), entered: () => entered() };
}
async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-session-'));
  fs.cpSync(path.resolve(__dirname, '../examples/project'), root, { recursive: true });
  if (!options.empty) await importReport(path.resolve(__dirname, '../scripts/fixtures/workflow-report.md'), root, native);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = new Map(), callbacks = {}, watchers = new Map(), instances = [], opened = [], errors = [], logs = [], progress = [];
  const analysis = { count: 0, hold: null }, documents = { hold: null }, configuration = { analysisMode: 'source' };
  const uri = fsPath => ({ fsPath, toString: () => fsPath }), disposable = () => ({ dispose() {} });
  const folder = { uri: uri(root) };
  class Board {
    constructor(_api, _context, _upstream, _root, handlers) {
      this.callbacks = handlers; this.ready = Promise.resolve(); this.disposed = false; this.models = new Map(); this.sessions = new Map(); this.native = {};
      instances.push(this);
    }
    async open(request, catalog, diagnostics, _git, _issue, canPublish = () => true) {
      await this.ready;
      if (!canPublish()) throw Object.assign(new Error('Delivery superseded by a newer user selection.'), { code: 'FLOWBOARD_SUPERSEDED' });
      this.activeId = store.findingKey(request); this.activeToken = request.id;
      opened.push({ request, catalog, diagnostics });
      return request.cards.map(card => catalog.resolveCard(card));
    }
    async showLibrary(canPublish = () => true) { await this.ready; if (canPublish()) { this.libraryShown = true; this.library = store.library(root); } }
    async showUnmapped(id, _issue, error, canPublish = () => true) { await this.ready; if (canPublish()) this.unmapped = { id, error }; }
    async post(message) { this.messages ||= []; this.messages.push(message); }
    async sourceChanged(file, dirty) { this.changed = { file, dirty }; }
  }
  const vscode = {
    Uri: { file: uri }, RelativePattern: class { constructor(_folder, pattern) { this.pattern = pattern; } },
    ProgressLocation: { Notification: 15 },
    window: { createOutputChannel: () => ({ appendLine: message => logs.push(message), dispose() {} }), showErrorMessage: message => errors.push(message),
      showOpenDialog: async () => undefined,
      withProgress: async (options, action) => { const entry = { ...options, reports: [] }; progress.push(entry); return action({ report: value => entry.reports.push(value) }); } },
    workspace: { isTrusted: true, workspaceFolders: [folder], textDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => configuration[key] ?? fallback }),
      createFileSystemWatcher: pattern => {
        const handlers = {}; watchers.set(pattern.pattern, handlers);
        return { ...disposable(), onDidCreate: handler => { handlers.create = handler; return disposable(); },
          onDidChange: handler => { handlers.change = handler; return disposable(); }, onDidDelete: handler => { handlers.delete = handler; return disposable(); } };
      },
      onDidChangeWorkspaceFolders: handler => { callbacks.folders = handler; return disposable(); },
      onDidChangeConfiguration: handler => { callbacks.configuration = handler; return disposable(); },
      onDidChangeTextDocument: handler => { callbacks.document = handler; return disposable(); },
      onDidSaveTextDocument: handler => { callbacks.save = handler; return disposable(); },
      openTextDocument: async value => {
        const hold = documents.hold; documents.hold = null;
        if (hold) { hold.entered(); await hold.held; }
        return { uri: value, isDirty: vscode.workspace.textDocuments.some(doc => doc.uri.fsPath === value.fsPath && doc.isDirty) };
      }
    },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); } },
    extensions: { getExtension: () => ({ extensionPath: native, packageJSON: { version: '1.2.0' }, activate: async () => {} }) }
  };
  const filename = path.resolve(__dirname, '../extension/extension.js');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === 'vscode' ? vscode : name === './board' ? { TriageBoard: Board } : name === './runner-adapter' ? {
    analyze: async (...args) => {
      analysis.count++; const hold = analysis.hold; analysis.hold = null;
      if (hold) { hold.entered(); await hold.held; }
      return analyze(...args);
    }
  } : original(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const context = { subscriptions: [] };
  loaded.exports.activate(context);
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  await commands.get('flowboardTriage.report')();
  const board = instances[0];
  return { root, board, opened, analysis, documents, configuration, callbacks, watchers, commands, vscode, uri, errors, logs, progress,
    select: id => board.callbacks.select(id) };
}

test('Import Report command opens a large report library before indexing; only selected findings are mapped', { skip: !native }, async t => {
  const env = await setup(t, { empty: true }), report = path.join(env.root, 'report.md');
  // The function identity occurs ONLY in the title. Deferred mapping must keep
  // that title when it reparses the saved original report for the chosen issue.
  fs.writeFileSync(report, Array.from({ length: 301 }, (_, i) => `## I-${i + 1}: Demo.increment report ${i + 1}\n**Severity**: Low\n\nReview the normal bookkeeping operation.\n`).join('\n'));
  env.vscode.window.showOpenDialog = async options => {
    assert.equal(options.defaultUri.fsPath, env.root, 'The WSL workspace URI supplies the file picker location.');
    assert.equal(options.canSelectFolders, false);
    return [env.uri(report)];
  };
  await env.commands.get('flowboardTriage.importReport')();
  assert.equal(env.errors.length, 0);
  assert.equal(env.analysis.count, 0, 'Import must not index any project code.');
  assert.equal(env.opened.length, 0, 'Import must not start preparing an arbitrary first finding.');
  assert.equal(env.board.library.length, 301);
  assert.ok(env.board.library.every(issue => issue.mappingPending && !issue.mapped));
  assert.equal(require('../extension/webview/review-model').queue(env.board.library, '', 'unmapped').length, 0, 'Not yet searched is not a failed match.');
  assert.ok(env.progress[0].reports.some(value => /Opening 301/.test(value.message)));
  assert.equal(fs.existsSync(path.join(env.root, store.draftPath('I-1'))), false);
  await env.select('I-2');
  assert.equal(env.errors.length, 0);
  assert.equal(env.opened.at(-1).request.findingId, 'I-2');
  assert.equal(env.opened.at(-1).request.cards[0].function, 'increment');
  assert.equal(env.analysis.count, 1, 'Mapping and rendering share one source index.');
  assert.equal(fs.existsSync(path.join(env.root, store.draftPath('I-1'))), false);
  await env.select('I-301');
  assert.equal(env.analysis.count, 1, 'Selecting another finding reuses a current source index.');
  const draftFile = path.join(env.root, store.draftPath('I-2'));
  const draft = store.readDraft(env.root, 'I-2'); draft.finding.summary = 'Researcher note retained during import.';
  store.writeDraft(env.root, 'I-2', draft); const saved = fs.readFileSync(draftFile, 'utf8');
  await env.commands.get('flowboardTriage.importReport')();
  assert.equal(fs.readFileSync(draftFile, 'utf8'), saved);
  assert.equal(env.board.library.find(issue => issue.id === 'I-2').mappingPending, false);
  assert.equal(env.analysis.count, 1);
});

test('Import Report command explains picker/workspace failures and treats cancellation as cancellation', { skip: !native }, async t => {
  const env = await setup(t, { empty: true });
  await env.commands.get('flowboardTriage.importReport')();
  assert.ok(env.logs.some(value => /file selection cancelled/.test(value)));
  assert.equal(env.errors.length, 0);
  env.vscode.window.showOpenDialog = async () => { throw new Error('Fictional picker failure'); };
  await env.commands.get('flowboardTriage.importReport')();
  assert.match(env.errors.at(-1), /Fictional picker failure/);
  env.vscode.workspace.workspaceFolders = [];
  await env.commands.get('flowboardTriage.importReport')();
  assert.match(env.errors.at(-1), /Open the project folder/);
  assert.equal(env.analysis.count, 0);
  assert.equal(fs.existsSync(path.join(env.root, '.flowboard/report.json')), false);
});

test('extension.activate reuses only fresh source catalogs and invalidates added/deleted/dirty/configured source', { skip: !native }, async t => {
  const env = await setup(t), { select, root, analysis, opened, watchers, callbacks, uri, vscode } = env;
  await select('I-01'); await select('I-02');
  assert.equal(analysis.count, 1);
  assert.equal(opened[0].catalog, opened[1].catalog);
  assert.equal(opened[1].diagnostics.cache, 'reused');
  const file = path.join(root, 'src/Dependency.sol');
  fs.writeFileSync(file, 'pragma solidity ^0.8.20;\ncontract Dependency { function normal() external pure returns (uint256) { return 1; } }\n');
  watchers.get('**/*.sol').create(uri(file)); await select('I-01');
  assert.equal(analysis.count, 2);
  assert.ok(opened.at(-1).catalog.functions.some(fn => fn.contract === 'Dependency'));
  fs.appendFileSync(file, '\n// saved dependency edit without a watcher notification\n');
  await select('I-02'); assert.equal(analysis.count, 3, 'assertFresh catches saved edits even if a change event was missed.');
  fs.unlinkSync(file); watchers.get('**/*.sol').delete(uri(file)); await select('I-01');
  assert.equal(analysis.count, 4);
  fs.writeFileSync(path.join(root, 'foundry.toml'), '[profile.default]\nremappings = []\n');
  await select('I-02'); assert.equal(analysis.count, 5, 'Project configuration bytes are part of the cache key.');
  callbacks.configuration({ affectsConfiguration: () => true }); await select('I-01');
  assert.equal(analysis.count, 6);
  const dirty = { uri: uri(path.join(root, 'src/Demo.sol')), isDirty: true };
  vscode.workspace.textDocuments.push(dirty); callbacks.document({ document: dirty });
  await select('I-02'); assert.equal(analysis.count, 6);
  assert.match(env.board.unmapped.error, /Save unsaved Solidity files/);
  dirty.isDirty = false; callbacks.save(dirty); await select('I-02');
  assert.equal(analysis.count, 7, 'Saving an edited buffer cannot revive the previous catalog.');
});

test('queued and in-flight old selections cannot publish after the newer selection', { skip: !native }, async t => {
  const env = await setup(t);
  await Promise.all([env.select('I-01'), env.select('I-02')]);
  assert.deepEqual(env.opened.map(item => item.request.findingId), ['I-02']);
  assert.equal(env.analysis.count, 1, 'The obsolete queued selection is skipped before analysis.');
  env.callbacks.configuration({ affectsConfiguration: () => true });
  const hold = gate(); env.analysis.hold = hold;
  const old = env.select('I-01'); await hold.started;
  const latest = env.select('I-02'); hold.release(); await Promise.all([old, latest]);
  assert.deepEqual(env.opened.map(item => item.request.findingId), ['I-02', 'I-02']);
  assert.equal(env.analysis.count, 2, 'The completed source-only index can serve the newer selection, not the older view.');
  const source = gate(); env.documents.hold = source;
  const oldDocument = env.select('I-01'); await source.started;
  const newDocument = env.select('I-02'); source.release(); await Promise.all([oldDocument, newDocument]);
  assert.deepEqual(env.opened.map(item => item.request.findingId), ['I-02', 'I-02', 'I-02']);
  assert.equal(env.errors.length, 0, 'Expected supersession is not an error popup.');
});

test('delivery cancellation is acknowledged and later selections do not overwrite request status', { skip: !native }, async t => {
  const env = await setup(t);
  const delivery = store.readDraft(env.root, 'I-01'); delivery.id = 'delivery-before-switch';
  p.atomicJson(env.root, p.REQUEST, delivery);
  const hold = gate(); env.analysis.hold = hold;
  const pending = env.commands.get('flowboardTriage.process')(); await hold.started;
  const selected = env.select('I-02'); hold.release(); await Promise.all([pending, selected]);
  const acknowledgement = p.readWorkspaceJson(env.root, p.STATUS);
  assert.equal(acknowledgement.requestId, delivery.id);
  assert.equal(acknowledgement.state, 'error'); assert.equal(acknowledgement.cancelled, true); assert.equal(acknowledgement.rendered, false);
  assert.match(acknowledgement.error, /superseded/);
  assert.deepEqual(env.opened.map(item => item.request.findingId), ['I-02']);
  assert.equal(p.readWorkspaceJson(env.root, '.flowboard/view-status.json').findingId, 'I-02');
  await env.commands.get('flowboardTriage.process')();
  assert.equal(env.opened.length, 1, 'An old duplicate watcher event cannot revive the cancelled delivery.');
  await env.select('I-01');
  assert.deepEqual(p.readWorkspaceJson(env.root, p.STATUS), acknowledgement, 'Opening a view retains the actual request ACK.');
  delivery.id = 'delivery-after-switch'; p.atomicJson(env.root, p.REQUEST, delivery);
  await env.commands.get('flowboardTriage.process')();
  const rendered = p.readWorkspaceJson(env.root, p.STATUS);
  assert.equal(rendered.requestId, delivery.id); assert.equal(rendered.state, 'ready'); assert.equal(rendered.rendered, true);
  await env.select('I-02');
  assert.deepEqual(p.readWorkspaceJson(env.root, p.STATUS), rendered, 'A successful rendered delivery ACK also survives later library navigation.');
});

test('extension.activate preserves legacy selected finding identity and refuses mismatched explicit IDs', { skip: !native }, async t => {
  const env = await setup(t), legacy = store.readDraft(env.root, 'I-01');
  legacy.finding.title = 'H-01: Fictional ordinary source review'; delete legacy.findingId;
  store.writeDraft(env.root, 'H-01', legacy);
  const hashId = store.findingKey(legacy), other = { ...structuredClone(legacy), findingId: hashId };
  other.finding.summary = 'Separate reviewed finding that must not be selected or changed.';
  store.writeDraft(env.root, hashId, other);
  await env.select('H-01');
  assert.equal(env.opened.at(-1).request.findingId, 'H-01');
  assert.equal(env.opened.at(-1).request.cards.length, legacy.cards.length);
  assert.deepEqual(store.readDraft(env.root, hashId), other);
  store.writeDraft(env.root, 'I-mismatch', { ...structuredClone(legacy), findingId: 'somewhere-else' });
  const count = env.opened.length; await env.select('I-mismatch');
  assert.equal(env.opened.length, count); assert.equal(env.board.unmapped.id, 'I-mismatch');
  assert.match(env.board.unmapped.error, /different finding ID/);
});

test('native board publication guard is rechecked after waiting for the webview to become ready', async () => {
  const pending = gate(), board = Object.create(TriageBoard.prototype);
  board.ready = pending.held;
  let current = true;
  const opening = board.open({}, null, null, null, null, () => current);
  current = false; pending.release();
  await assert.rejects(opening, error => error.code === 'FLOWBOARD_SUPERSEDED');
});
