'use strict';
// Minimal editor IO for the ACTUAL extension activation/selection/cache route.
// No replacement cache, selection implementation, snapshot or Ready response.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
function activateProduct({ extension, upstream, root, api, Board, invoke, storage, readOnly, onBoard, onCoordinator, onSelection, trace }) {
  const commands = new Map(), subscriptions = [], disposable = () => ({ dispose() {} });
  let initialPreparation;
  let selectedIO = null;
  const originalRead = fs.readFileSync;
  // Instrument only this disposable editor host. Count actual reads, not
  // inferred snapshot boundaries; never include private paths/content.
  fs.readFileSync = function(file, ...args) {
    const start=performance.now(); let result;
    try { return result=originalRead.call(this,file,...args); }
    finally {
      if (selectedIO) {
        const name=String(file).replaceAll('\\','/');
        const kind=name.endsWith('.sol')?'source':name.includes('/.flowboard/findings/')?'findingDraft':name.includes('/.flowboard/investigations/')?'investigation':name.endsWith('/.flowboard/report.json')?'report':'other';
        const row=selectedIO[kind] ||= {reads:0,bytes:0,ms:0}; row.reads++;
        row.bytes+=typeof result==='string'?Buffer.byteLength(result):result?.byteLength||0;row.ms+=performance.now()-start;
      }
    }
  };
  const watcher = () => ({ ...disposable(), onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable });
  Object.assign(api, { RelativePattern: class { constructor(_folder, pattern) { this.pattern = pattern; } }, ProgressLocation: { Notification: 15 },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable(); } },
    extensions: { getExtension: () => ({ extensionPath: upstream, extensionUri: api.Uri.file(upstream), packageJSON: { version: '1.2.0' }, activate: async () => {} }) } });
  Object.assign(api.workspace, { textDocuments: [], createFileSystemWatcher: watcher, onDidChangeWorkspaceFolders: disposable,
    onDidChangeConfiguration: disposable, onDidChangeTextDocument: disposable, onDidSaveTextDocument: disposable });
  Object.assign(api.window, { createOutputChannel: () => ({ appendLine(message) { trace('extension-log', { message }); }, show() {}, dispose() {} }),
    withProgress: async (_options, action) => action({ report() {} }) });
  const filename = path.join(extension, 'extension.js'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(extension);
  const normal = loaded.require.bind(loaded);
  loaded.require = name => {
    if (name === 'vscode') return api;
    if (name === './board') return { TriageBoard: class extends Board {
      constructor(...args) {
        super(...args); if (readOnly) this.callbacks.investigationPersistence = false; onBoard(this);
        const select = this.callbacks.select;
        this.callbacks.select = id => { selectedIO={}; trace('selection-received', { findingId: id }); const work = select(id); onSelection(work); return work; };
      }
      async open(...args) { trace('board-open', { cache: args[2]?.cache, findingId: args[0].findingId }); const result = await super.open(...args); trace('board-shell-ack', { findingId: this.activeId, token: this.activeToken }); return result; }
      async post(message) { if (message.type === 'triage:load') { trace('selected-input-io', {findingId:message.issueId,reads:selectedIO}); selectedIO=null;
        trace('load-send', { findingId: message.issueId, token: message.token }); } return super.post(message); }
    } };
    const value = normal(name);
    if (name === './store' && readOnly) return storage;
    if (name === './protocol' && readOnly) return { ...value, atomicJson: (project, file, data) => {
      if (file === '.flowboard/view-status.json') return; // Editor status IO, not source/currentness logic.
      throw new Error(`Saved-workspace renderer cannot write ${file}`);
    } };
    if (name === './report-preparation') return { ...value, ReportPreparation: class extends value.ReportPreparation {
      constructor(project, options) { super(project, { ...options, invoke, ...(readOnly ? {
        authorizeRequest: () => { throw new Error('Saved-workspace measurement authorizes zero provider reservations.'); }
      } : {}) }); initialPreparation = this; onCoordinator(this); }
    } };
    if (name === './runner-adapter') return { ...value, analyze: async (...args) => { const start = performance.now(); trace('index-start');
      try { return await value.analyze(...args); } finally { trace('index-end', { durationMs: performance.now() - start }); } } };
    if (name === './workspace-snapshot') return { ...value, validate: (...args) => { const start = performance.now();
      try { return value.validate(...args); } finally { trace('snapshot-validation', { force: !!args[1]?.force, durationMs: performance.now() - start }); } } };
    return value;
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  loaded.exports.activate({ extensionPath: extension, extensionUri: api.Uri.file(extension), subscriptions });
  return { open: async () => {
    // In saved-workspace measurements let the real activation-time local
    // revalidation finish before creating a simulated webview. Otherwise the
    // harness cannot serve its HTML while synchronous indexing owns the host,
    // and may time out the handshake before the browser can receive it. Index
    // time remains in the trace, outside the subsequent cached-open boundary.
    if (readOnly) await initialPreparation?.loop;
    return commands.get('flowboardTriage.report')();
  }, dispose: () => { fs.readFileSync=originalRead; subscriptions.forEach(item => item.dispose()); } };
}
module.exports = { activateProduct };
