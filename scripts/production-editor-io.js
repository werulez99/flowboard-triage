'use strict';
// Minimal editor IO for the ACTUAL extension activation/selection/cache route.
// No replacement cache, selection implementation, snapshot or Ready response.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
function activateProduct({ extension, upstream, root, api, Board, invoke, onBoard, onCoordinator, onSelection, trace }) {
  const commands = new Map(), subscriptions = [], disposable = () => ({ dispose() {} });
  const watcher = () => ({ ...disposable(), onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable });
  Object.assign(api, { RelativePattern: class { constructor(_folder, pattern) { this.pattern = pattern; } }, ProgressLocation: { Notification: 15 },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable(); } },
    extensions: { getExtension: () => ({ extensionPath: upstream, extensionUri: api.Uri.file(upstream), packageJSON: { version: '1.2.0' }, activate: async () => {} }) } });
  Object.assign(api.workspace, { textDocuments: [], createFileSystemWatcher: watcher, onDidChangeWorkspaceFolders: disposable,
    onDidChangeConfiguration: disposable, onDidChangeTextDocument: disposable, onDidSaveTextDocument: disposable });
  Object.assign(api.window, { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    withProgress: async (_options, action) => action({ report() {} }) });
  const filename = path.join(extension, 'extension.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(extension);
  const normal = loaded.require.bind(loaded);
  loaded.require = name => {
    if (name === 'vscode') return api;
    if (name === './board') return { TriageBoard: class extends Board {
      constructor(...args) {
        super(...args); onBoard(this);
        const select = this.callbacks.select;
        this.callbacks.select = id => { trace('selection-received', { findingId: id }); const work = select(id); onSelection(work); return work; };
      }
      async open(...args) { trace('board-open', { cache: args[2]?.cache, findingId: args[0].findingId }); const result = await super.open(...args); trace('board-readable-ack', { findingId: this.activeId }); return result; }
      async post(message) { if (message.type === 'triage:load') trace('load-send', { findingId: message.issueId, token: message.token }); return super.post(message); }
    } };
    const value = normal(name);
    if (name === './report-preparation') return { ...value, ReportPreparation: class extends value.ReportPreparation {
      constructor(project, options) { super(project, { ...options, invoke }); onCoordinator(this); }
    } };
    if (name === './runner-adapter') return { ...value, analyze: async (...args) => { const start = performance.now(); trace('index-start');
      try { return await value.analyze(...args); } finally { trace('index-end', { durationMs: performance.now() - start }); } } };
    if (name === './workspace-snapshot') return { ...value, validate: (...args) => { const start = performance.now();
      try { return value.validate(...args); } finally { trace('snapshot-validation', { force: !!args[1]?.force, durationMs: performance.now() - start }); } } };
    return value;
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  loaded.exports.activate({ extensionPath: extension, extensionUri: api.Uri.file(extension), subscriptions });
  return { open: () => commands.get('flowboardTriage.report')(), dispose: () => subscriptions.forEach(item => item.dispose()) };
}
module.exports = { activateProduct };
