'use strict';
// Integration-only editor IO shim. Uses the actual importer, board controller,
// source catalog and pinned native panel; it does not imitate their output.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
// Tests may point at the unpacked, installed VSIX. Keep fixtures/harness here,
// but load all product code and webview assets from that exact extension tree.
const productionExtension = fs.realpathSync(process.env.FLOWBOARD_TRIAGE_EXTENSION_PATH || path.resolve(__dirname, '../extension'));
const productionVersion = JSON.parse(fs.readFileSync(path.join(productionExtension, 'package.json'), 'utf8')).version;
// Instrument the real synchronous Git implementation, including each actual
// subprocess. No fake Git result or test-only cache is substituted.
let protocolTrace = () => {};
const protocolFile = path.join(productionExtension, 'protocol.js'), protocolModule = new Module(protocolFile, module);
protocolModule.filename = protocolFile; protocolModule.paths = Module._nodeModulePaths(productionExtension);
const protocolRequire = protocolModule.require.bind(protocolModule);
protocolModule.require = name => {
  const value = protocolRequire(name);
  return name === 'node:child_process' ? { ...value, execFileSync: (...args) => {
    const start = performance.now();
    try { return value.execFileSync(...args); }
    finally { if (args[0] === 'git') protocolTrace('git-operation', { operation: args[1][0], durationMs: performance.now() - start }); }
  } } : value;
};
require.cache[protocolFile] = protocolModule;
protocolModule._compile(fs.readFileSync(protocolFile, 'utf8'), protocolFile);
const p = require(path.join(productionExtension, 'protocol'));
const store = require(path.join(productionExtension, 'store'));
const { analyze } = require(path.join(productionExtension, 'runner-adapter'));
const { SourceCatalog } = require(path.join(productionExtension, 'source'));
const { importReport } = require(path.join(productionExtension, 'report'));

function boardClass(storage, invoke, trace) {
  // A read-only external workspace gets an isolated, in-memory canvas store.
  // Never replace process-wide fs/store modules or follow its request watcher.
  const filename = path.join(productionExtension, 'board.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const normalRequire = loaded.require.bind(loaded);
  loaded.require = name => {
    if (name === './store') return !trace ? storage : { ...storage, readBoard: (...args) => {
      const start = performance.now(); try { return storage.readBoard(...args); } finally { trace('saved-canvas-read', { durationMs: performance.now() - start }); }
    } };
    const value = normalRequire(name);
    if (trace && (name === './graph' || name === './investigation')) {
      const key = name === './graph' ? 'layoutGraph' : 'prepareInvestigation';
      return { ...value, [key]: (...args) => { const start = performance.now(); try { return value[key](...args); }
        finally { trace(key, { durationMs: performance.now() - start }); } } };
    }
    if (name === './investigation-engine') return { ...value,
      ...(invoke ? { advance: options => value.advance({ ...options, invoke }) } : {}),
      ...(trace ? { validateCurrent: (...args) => { const start = performance.now(); trace('saved-guide-validation-start');
        try { return value.validateCurrent(...args); } finally { trace('saved-guide-validation-end', { durationMs: performance.now() - start }); } } } : {}) };
    return value;
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports.TriageBoard;
}

async function start(options = {}) {
  const upstream = fs.realpathSync(options.upstream || process.env.FLOWBOARD_EXTENSION_PATH || '');
  const extension = productionExtension;
  const readOnly = !!options.workspace;
  const configuration = { semanticProvider: options.provider || 'none' };
  if (options.productionSelection && !options.routeFixture && !options.mixedFixture) throw new Error('Production selection measurement currently requires an isolated controlled native fixture.');
  if(options.mixedFixture&&options.routeFixture)throw new Error('Choose one controlled fixture.');
  if (options.mixedFixture || options.routeFixture) {
    if (readOnly || options.invoke || options.qualityCase || options.qualityBatch || options.qualityResponses || options.qualityRecording) throw new Error('Controlled preparation is an isolated fictional fixture.');
    configuration.semanticProvider = 'codex'; options.reportPreparation = true;
  }
  if (readOnly && (options.complex || options.reading || options.qualityCase || options.qualityBatch)) throw new Error('Choose an existing workspace or a fictional fixture, not both.');
  if (options.qualityCase && !/^(d[1-7]|h[1-3]|l1)$/.test(options.qualityCase)) throw new Error('Unknown fictional quality case.');
  if (options.qualityRecording && (!options.qualityCase || readOnly || configuration.semanticProvider !== 'none')) throw new Error('Recorded quality UI checks require a fresh fictional case and no provider calls.');
  const qualityFolder = options.qualityCase && path.join(__dirname, 'fixtures/quality-cases', options.qualityCase);
  const root = readOnly ? fs.realpathSync(options.workspace) : fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-workflow-'));
  if (!readOnly) {
    if (options.mixedFixture || options.routeFixture) {
      fs.cpSync(path.join(__dirname, options.routeFixture ? 'fixtures/route-preparation/project' : 'fixtures/mixed-preparation/project'), root, { recursive: true });
      if (options.productionSelection) {
        const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: root, stdio: 'pipe', timeout: 10000 });
        git('init', '-q'); git('add', '.');
        git('-c', 'user.name=Flowboard fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Tracked fictional route');
      }
    } else if (options.qualityBatch) {
      const base = path.join(__dirname, 'fixtures/quality-cases');
      for (const name of ['d3', 'd7']) fs.cpSync(path.join(base, name, 'project'), root, { recursive: true });
      fs.writeFileSync(path.join(root, 'report.md'), fs.readFileSync(path.join(base, 'd3/report.md'), 'utf8') + '\n\n' + fs.readFileSync(path.join(base, 'd7/report.md'), 'utf8').replace('[I-01]', '[I-02]'));
    } else fs.cpSync(qualityFolder ? path.join(qualityFolder, 'project') : path.resolve(__dirname, options.reading ? 'fixtures/reading-project' : options.complex ? '../examples/complex-project' : '../examples/project'), root, { recursive: true });
    await importReport(options.mixedFixture || options.routeFixture ? path.join(__dirname, options.routeFixture ? 'fixtures/route-preparation/report.md' : 'fixtures/mixed-preparation/report.md') : options.qualityBatch ? path.join(root, 'report.md') : qualityFolder ? path.join(qualityFolder, 'report.md') : path.join(__dirname, options.reading ? 'fixtures/reading-report.md' : options.complex ? 'fixtures/complex-report.md' : 'fixtures/workflow-report.md'), root, upstream, { deferMapping: !!options.deferMapping });
    if (options.qualityRecording) {
      const recorded = JSON.parse(fs.readFileSync(options.qualityRecording, 'utf8'));
      if (recorded.case !== options.qualityCase || recorded.draft?.phase !== 'ready') throw new Error('Recording does not match the selected fictional case.');
      for (const [file, expected] of Object.entries(recorded.fixtureHashes || {})) {
        if (!file.startsWith(`scripts/fixtures/quality-cases/${options.qualityCase}/`) || file.includes('..') ||
          crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex') !== expected) throw new Error('Recorded fixture has changed.');
      }
      // Reopen an actual saved response, not a fixed substitute for generation.
      // Ordinary board loading still validates the snapshot and every quote.
      delete recorded.draft.storageRevision;
      require(path.join(productionExtension, 'investigation-engine')).write(root, recorded.draft);
    }
  }
  const secret = crypto.randomBytes(24).toString('hex');
  const pending = [], received = [], opened = [], logs = [], errors = [], assets = new Map(), checkpoints = new Map();
  let html = '', board, panel, origin, selection = Promise.resolve(), serial = 0, productionEditor, materializeBoard;
  const productionTrace = [];
  const trace = (event, fields = {}) => productionTrace.push({ event, at: Date.now(), ...fields });
  protocolTrace = trace;
  const uri = file => ({ fsPath: file, toString: () => file });
  const disposable = () => ({ dispose() {} });
  const storage = readOnly ? { ...store,
    readBoard: (_root, id) => checkpoints.get(id) || null,
    writeBoard: (_root, id, state, fingerprint) => checkpoints.set(id, { version: 1, fingerprint, state: structuredClone(state) }),
    archiveBoard: () => '[read-only harness checkpoint retained in memory]',
    saveReview: () => { throw new Error('Read-only workspace: review writes are disabled in this integration harness.'); }
  } : store;
  if (options.report) {
    if (!readOnly) throw new Error('A supplied report requires a read-only workspace.');
    const { parseReport, draftIssue } = require(path.join(productionExtension, 'report'));
    const text = fs.readFileSync(options.report, 'utf8');
    const parsed = parseReport(text).filter(item => !options.reportFinding || item.id === options.reportFinding);
    if (!parsed.length) throw new Error('The requested finding is not in this report.');
    const { runner, result } = await analyze(upstream, root, { mode: 'source' });
    const catalog = new SourceCatalog(root, runner, result);
    const bundle = { version: 1, reportName: path.basename(options.report), reportHash: crypto.createHash('sha256').update(text).digest('hex'),
      issues: parsed.map(item => draftIssue(item, root, runner, result, p.gitState(root).head, catalog)) };
    // Normal parsing and resolution, with persistence replaced by memory only.
    // No private report, source, or researcher's decisions are changed.
    storage.readReport = () => structuredClone(bundle);
    storage.readDraft = (_root, id) => structuredClone(bundle.issues.find(item => item.id === id)?.request);
    storage.library = () => bundle.issues.map(item => ({ id: item.id, displayId: item.displayId, title: item.title, severity: item.severity,
      status: 'unreviewed', mapped: !!item.request, anchors: item.request?.cards || [], files: [...new Set((item.request?.cards || []).map(card => card.file))] }));
  }
  if (readOnly && options.invoke) throw new Error('Controlled responses are only for fictional fixtures.');
  // Observe the real provider without replacing its inputs or responses. Only
  // fictional quality cases expose these records; no private workspace capture.
  const providerCalls = [];
  let releaseMixed, mixedHeld = false, localChallengeFailed = false;
  const mixedWait = options.mixedFixture && new Promise(resolve => { releaseMixed = resolve; });
  const mixedInvoke = options.mixedFixture || options.routeFixture ? async (input, settings) => {
    const record = { input: structuredClone(input), fixture: options.routeFixture ? 'controlled-route-preparation' : 'controlled-mixed-preparation' }; providerCalls.push(record);
    if (input.finding.id === 'I-2' && input.phase === 'challenge') {
      if (options.localRetryFixture && !localChallengeFailed) {
        localChallengeFailed = true;
        throw new Error('Controlled challenge interruption; generation is retained.');
      }
      mixedHeld = true;
      await Promise.race([mixedWait, new Promise((_, reject) => {
        if (settings?.signal?.aborted) reject(new Error('Controlled challenge cancelled.'));
        else settings?.signal?.addEventListener('abort', () => reject(new Error('Controlled challenge cancelled.')), { once: true });
      })]);
      mixedHeld = false;
    }
    const result = { value: require(options.routeFixture ? './fixtures/route-ready-output' : './fixtures/mixed-ready-output').response(input), audit: { provider: options.routeFixture ? 'controlled-route-fixture' : 'controlled-mixed-fixture', phase: input.phase, outcome: 'completed' } };
    record.result = structuredClone(result); return result;
  } : undefined;
  let replay;
  if (options.qualityResponses) {
    if (!options.qualityCase || readOnly) throw new Error('Response playback is restricted to fictional cases.');
    const recording = JSON.parse(fs.readFileSync(options.qualityResponses, 'utf8'));
    if (recording.case !== options.qualityCase || !recording.providerCalls?.length) throw new Error('Mismatched fictional response recording.');
    let replayIndex = 0;
    replay = async input => {
      const recorded = recording.providerCalls[replayIndex++];
      if (!recorded?.result?.value || recorded.input.phase !== input.phase) throw new Error('Recording has no matching next provider phase.');
      const replacements = new Map();
      for (const old of recorded.input.sources) {
        const current = input.sources.find(unit => unit.file === old.file && unit.line === old.line && unit.signature === old.signature && unit.code === old.code);
        if (current) replacements.set(old.id, current.id);
      }
      // Only ephemeral source IDs are remapped, and only for identical complete
      // code units. Interpretations, lines and quotes are not manufactured.
      const result = { value: translateRecordedResponse(recorded.result.value, replacements), audit: { provider: 'recorded-fictional-response', phase: input.phase, outcome: 'completed' } };
      if (input.repairOnly && result.value.result === 'kept' && !result.value.problems?.length) {
        // Test transport migration only: the old unchanged check is expressed
        // as a zero-edit patch with its exact recorded evidence checks. This
        // supplies no fresh reasoning and never changes a claim or conclusion.
        result.value = { mode: 'review-patch-v1', updates: [], explanationReviews: result.value.explanationReviews, checks: result.value.checks };
        result.audit.recordedTransport = 'kept-check-to-zero-edit-patch';
      }
      providerCalls.push({ input, result }); return result;
    };
  }
  const invoke = mixedInvoke || options.invoke || replay || (options.qualityCase || options.qualityBatch ? async (input, settings) => {
    const record = { input: structuredClone(input) }; providerCalls.push(record);
    try { const result = await require(path.join(productionExtension, 'semantic-provider')).runProvider(input, settings); record.result = structuredClone(result); return result; }
    catch (error) { record.error = error.message; record.audit = error.audit; throw error; }
  } : undefined);
  // Observing the real adapter must not bypass its shared capacity/health
  // boundary. Controlled and recorded responses are deliberately unmarked.
  if (invoke && !options.invoke && !replay && !mixedInvoke) invoke.isProviderTransport = true;
  const TriageBoard = boardClass(storage, invoke, options.productionSelection ? trace : null);
  let reportPreparation, coordinatorOptions;
  if (options.reportPreparation && !options.productionSelection) {
    if (readOnly) throw new Error('Persistent report preparation requires a fresh fictional harness project. Use prepare-report.js for an explicitly requested real report run.');
    let cached;
    const Coordinator = require(path.join(productionExtension, 'report-preparation')).ReportPreparation;
    coordinatorOptions = {
      configuration: () => ({ provider: configuration.semanticProvider, requestLimit: options.requestLimit || 12 }),
      catalog: async () => { if (!cached) { const result = await analyze(upstream, root, { mode: 'source' }); cached = new SourceCatalog(root, result.runner, result.result); } return cached; },
      invoke, changed: () => board?.reportProgress(), log: text => logs.push(text)
    };
    reportPreparation = new Coordinator(root, coordinatorOptions);
  }
  function record(error) { errors.push(error.message || String(error)); }
  async function select(id) {
    let issue = storage.readReport(root).issues.find(value => value.id === id);
    if (!readOnly && issue?.mappingPending) issue = await require(path.join(productionExtension, 'report')).refreshFindingMap(root, id, upstream);
    if (issue && !issue.request) return board.showUnmapped(id, issue, 'No unambiguous code match was found. Check the report and the implementation it describes.');
    const draft = storage.readDraft(root, id);
    const request = p.validate(store.selectedDraft(draft, id));
    request.id = `workflow-${++serial}-${crypto.randomUUID()}`;
    request._draftFingerprint = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    const git = p.gitState(root);
    p.checkRevision(request, git);
    const references = p.sources(root, request);
    request.cards = request.cards.map((card, i) => ({ ...card, sourceHash: references[i].hash }));
    const { runner, result, diagnostics } = await analyze(upstream, root, { mode: 'source' });
    const catalog = new SourceCatalog(root, runner, result);
    await board.open(request, catalog, diagnostics, git, issue);
  }
  const api = {
    ViewColumn: { One: 1, Beside: 2 },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    Range: class { constructor(startLine, startCharacter, endLine, endCharacter) { Object.assign(this, { startLine, startCharacter, endLine, endCharacter }); } },
    env: { clipboard: { writeText: async () => {} } },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(root) }], getConfiguration: () => ({ get: (key, fallback) => configuration[key] ?? fallback,
      update: async (key, value) => { configuration[key] = value; } }),
      openTextDocument: async value => {
        const text = fs.readFileSync(value.fsPath, 'utf8'), lines = text.split(/\r?\n/);
        return { uri: value, isDirty: false, lineCount: lines.length, getText: () => text,
          lineAt: line => ({ text: lines[line] || '', firstNonWhitespaceCharacterIndex: Math.max(0, (lines[line] || '').search(/\S/)) }) };
      } },
    window: {
      showErrorMessage: async message => record(new Error(message)),
      showInformationMessage: async message => logs.push(message),
      showWarningMessage: async (message, _options, action) => {
        logs.push(message);
        return options.allowExistingRegression && action === 'Run existing regression' ? action : undefined;
      },
      showQuickPick: async choices => { logs.push(`Ambiguous source choice was not auto-selected (${choices.length} candidates).`); return undefined; },
      showTextDocument: async (document, config) => { opened.push({ file: path.relative(root, document.uri.fsPath).split(path.sep).join('/'), ...config }); return {}; },
      createWebviewPanel: (_type, title, viewColumn) => {
        const callbacks = [], disposed = [];
        panel = { title, viewColumn, visible: true, callbacks, reveal() {},
          onDidDispose: callback => { disposed.push(callback); return disposable(); },
          dispose() { if (!this.visible) return; this.visible = false; for (const callback of disposed) callback(); },
          webview: {
            get html() { return html; }, set html(value) { html = value; }, cspSource: origin,
            asWebviewUri: value => {
              const absolute = fs.realpathSync(value.fsPath);
              if (![path.join(extension, 'webview'), path.join(upstream, 'webview')].some(base => p.contained(base, absolute))) throw new Error('Non-webview asset refused.');
              const route = `/assets/${assets.size}/${path.basename(absolute)}`;
              assets.set(route, absolute); return origin + route;
            },
            onDidReceiveMessage: callback => { callbacks.push(callback); return disposable(); },
            postMessage: async message => {
              const start = performance.now(), bytes = Buffer.byteLength(JSON.stringify(message));
              pending.push(structuredClone(message));
              if (message.type === 'triage:load') trace('load-payload', { durationMs: performance.now() - start, bytes, findingId: message.issueId, token: message.token });
              return true;
            }
          } };
        return panel;
      }
    }
  };
  function createBoard() {
    if (options.productionSelection) {
      const available = new Promise(resolve => { materializeBoard = resolve; });
      productionEditor ||= require('./production-editor-io').activateProduct({ extension: productionExtension, upstream, root, api,
        Board: TriageBoard, invoke, onBoard: value => { board = value; materializeBoard?.(); }, onCoordinator: value => { reportPreparation = value; },
        onSelection: value => { selection = value.catch(record); }, trace });
      // Serve the actual panel once created; the product command still awaits
      // its real webview ready event. Waiting for that before serving HTML
      // deadlocks simulated IO, unlike a real editor which serves it immediately.
      return Promise.race([available, productionEditor.open().catch(record)]);
    }
    board = new TriageBoard(api, { extensionPath: extension, extensionUri: uri(extension) },
      { extensionPath: upstream, extensionUri: uri(upstream) }, root, {
        ...(reportPreparation ? { reportPreparation: () => reportPreparation } : {}),
        investigationPersistence: !readOnly || !!options.recordInvestigation,
        select: id => { selection = selection.then(() => select(id)).catch(async error => { record(error); await board.showUnmapped(id, null, error.message); }); return selection; },
        refresh: async () => { throw new Error('Use the product refresh command in the editor; this harness does not manufacture a refreshed review.'); }
      }, { appendLine: text => logs.push(text) });
    board.showLibrary().catch(record);
    reportPreparation?.ensure();
  }
  const server = http.createServer(async (request, response) => {
    const address = new URL(request.url, origin || 'http://127.0.0.1');
    const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET' && address.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(html); return;
    }
    if (request.method === 'GET' && assets.has(address.pathname)) {
      response.writeHead(200, { 'Content-Type': address.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
      response.end(fs.readFileSync(assets.get(address.pathname))); return;
    }
    if (request.headers['x-workflow-token'] !== secret) return json({ error: 'Unauthorized integration request.' }, 403);
    if (request.method === 'GET' && address.pathname === '/events') {
      const after = Math.max(0, Number(address.searchParams.get('after')) || 0);
      return json({ cursor: pending.length, messages: pending.slice(after) });
    }
    if (request.method === 'GET' && address.pathname === '/state') {
      const snapshots = {};
      for (const issue of storage.library(root)) { const saved = storage.readBoard(root, issue.id); if (saved) snapshots[issue.id] = saved; }
      return json({ readOnly, productionExtension, productionVersion, selectionRoute: options.productionSelection ? 'extension.activate/openFinding/sourceCatalog/board.open' : 'controller-harness', productionTrace, reportPreparation: reportPreparation?.status(), ...(options.mixedFixture ? { mixedHeld } : {}), panelTitle: panel.title, providerCalls, activeId: board.activeId, token: board.activeToken, opened, logs, errors, received, snapshots,
        investigation: board.models.get(board.activeId)?.investigationDraft || null,
        privatePreparationDraft: reportPreparation && board.activeId ? require(path.join(productionExtension, 'investigation-engine')).read(root, board.activeId) : null,
        debug: { nativeToken: board.native.triageToken, nativeFinding: board.native.triageFindingId, callbacks: panel.callbacks.length, disposed: board.disposed, trusted: api.workspace.isTrusted },
        library: storage.library(root), lastLoad: pending.findLast(message => message.type === 'triage:load') || null });
    }
    if (request.method !== 'POST' || !['/message', '/action'].includes(address.pathname)) return json({ error: 'Unknown route.' }, 404);
    let bytes = 0, text = '';
    try {
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 9 * 1024 * 1024) throw new Error('Message too large.'); text += chunk; }
      const message = JSON.parse(text);
      if (address.pathname === '/message') {
        if (message.type === 'annotate') throw new Error('Model execution is disabled in this deterministic integration harness.');
        if (message.type === 'triage:investigationTest' && !options.allowExistingRegression) throw new Error('Existing-test execution requires an explicit integration-run option.');
        if (readOnly && ['triage:save', 'triage:refresh'].includes(message.type)) throw new Error('Read-only workspace: review writes and refresh are disabled.');
        received.push({ type: message.type, issueId: message.issueId, token: message.token });
        // Mirror VS Code's event delivery: do not await a selection that waits
        // for a later webview render acknowledgement.
        for (const callback of panel.callbacks) Promise.resolve(callback(message)).catch(record);
      } else if (message.name === 'reopen') {
        await selection; panel.dispose(); pending.length = 0; await createBoard();
      } else if (message.name === 'release-mixed' && options.mixedFixture) {
        releaseMixed();
      } else if (message.name === 'restart-mixed-coordinator' && options.mixedFixture) {
        await selection; reportPreparation.dispose(); await reportPreparation.loop;
        panel.dispose(); pending.length = 0;
        reportPreparation = new (require(path.join(productionExtension, 'report-preparation')).ReportPreparation)(root, coordinatorOptions);
        createBoard();
      } else if (message.name === 'library') {
        await board.showLibrary();
      } else if (message.name === 'source-change' && !readOnly) {
        const file = options.qualityCase || options.routeFixture || options.mixedFixture ? board.models.get(board.activeId).catalog.functions[0].file : path.join(root, options.reading ? 'src/ReservationBook.sol' : options.complex ? 'src/QuotationDemo.sol' : 'src/Demo.sol');
        fs.appendFileSync(file, '\n// Integration fixture source revision changed.\n');
        reportPreparation?.invalidate('Code changed. The complete report must be rechecked.');
        await board.sourceChanged(file);
      } else if (message.name === 'report-change' && !readOnly) {
        reportPreparation?.invalidate('Report changed. The complete report must be rechecked.');
        const file = path.join(root, '.flowboard/report.json'), bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
        bundle.issues.find(issue => issue.id === board.activeId).reportText += '\n\nChanged fictional report.';
        fs.writeFileSync(file, JSON.stringify(bundle)); await board.reportChanged();
      } else throw new Error('Unsupported harness action.');
      json({ ok: true });
    } catch (error) { json({ error: error.message }, 400); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  await createBoard();
  return { origin, secret, root, readOnly, productionExtension, productionVersion, close: async () => {
    releaseMixed?.();
    reportPreparation?.dispose(); if (reportPreparation?.loop) await reportPreparation.loop;
    productionEditor?.dispose();
    panel.dispose(); await new Promise(resolve => server.close(resolve));
    // root is either a validated fresh mkdtemp directory or a read-only input.
    // Remove only the exact generated fixture, never a supplied workspace.
    if (!readOnly) fs.rmSync(root, { recursive: true, force: true });
  } };
}

if (require.main === module) {
  const value = process.argv.indexOf('--workspace');
  const providerIndex = process.argv.indexOf('--provider');
  const qualityIndex = process.argv.indexOf('--quality-case');
  const recordingIndex = process.argv.indexOf('--quality-recording');
  start({ workspace: value < 0 ? null : process.argv[value + 1], complex: process.argv.includes('--complex'), reading: process.argv.includes('--reading'),
    deferMapping: process.argv.includes('--defer-mapping'),
    reportPreparation: process.argv.includes('--report-preparation'),
    requestLimit: process.argv.includes('--request-limit') ? Number(process.argv[process.argv.indexOf('--request-limit') + 1]) : 12,
    qualityBatch: process.argv.includes('--quality-batch'),
    mixedFixture: process.argv.includes('--mixed-fixture'),
    localRetryFixture: process.argv.includes('--local-retry-fixture'),
    routeFixture: process.argv.includes('--route-fixture'),
    productionSelection: process.argv.includes('--production-selection'),
    report: process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null,
    reportFinding: process.argv.includes('--report-finding') ? process.argv[process.argv.indexOf('--report-finding') + 1] : null,
    qualityCase: qualityIndex < 0 ? null : process.argv[qualityIndex + 1],
    qualityRecording: recordingIndex < 0 ? null : process.argv[recordingIndex + 1],
    qualityResponses: process.argv.includes('--quality-responses') ? process.argv[process.argv.indexOf('--quality-responses') + 1] : null,
    provider: process.argv.includes('--fixture-model') ? 'codex' : providerIndex < 0 ? 'none' : process.argv[providerIndex + 1],
    invoke: process.argv.includes('--fixture-model') ? async input => require('./fixtures/reading-model-output').response(input) : undefined,
    recordInvestigation: process.argv.includes('--record-investigation'),
    allowExistingRegression: process.argv.includes('--allow-existing-regression') }).then(host => {
    process.stdout.write(JSON.stringify({ origin: host.origin, secret: host.secret, root: host.root, readOnly: host.readOnly,
      productionExtension: host.productionExtension, productionVersion: host.productionVersion }) + '\n');
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await host.close(); process.exit(0); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  }).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
function translateRecordedResponse(value, replacements) {
  const translate = item => typeof item === 'string' ? replacements.get(item) || item : Array.isArray(item) ? item.map(translate) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, translate(child)])) : item;
  const result = translate(value);
  // A targeted repair contains JSON-encoded field values. Translate exact
  // source identities there too, never substrings in prose or quotations.
  // Malformed recorded JSON still fails; playback does not repair reasoning.
  if (result?.mode === 'review-patch-v1' && Array.isArray(result.updates)) {
    result.updates = result.updates.map(update => ({ ...update, valueJSON: JSON.stringify(translate(JSON.parse(update.valueJSON))) }));
  }
  return result;
}
module.exports = { start, translateRecordedResponse };
