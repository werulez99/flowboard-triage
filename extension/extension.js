'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./protocol');
const store = require('./store');
const { analyze } = require('./runner-adapter');
const { SourceCatalog } = require('./source');
const { TriageBoard } = require('./board');
const { importReport, refreshFindingMap } = require('./report');
const UPSTREAM = 'anchabadze.solidity-flowboard';
const VERSION = '1.2.0';

function activate(context) {
  const log = vscode.window.createOutputChannel('Flowboard Triage');
  context.subscriptions.push(log);
  let queue = Promise.resolve();
  const boards = new Map(), processed = new Map(), watchers = new Map();
  function trust() { if (!vscode.workspace.isTrusted) throw new Error('Open a trusted workspace first. Default triage reads sources only; compilation remains optional.'); }
  function upstream() {
    const extension = vscode.extensions.getExtension(UPSTREAM);
    if (!extension || extension.packageJSON.version !== VERSION) throw new Error(`Flowboard Triage requires Solidity Flowboard ${VERSION}. Install the bundled dependency into this workspace host.`);
    return extension;
  }
  function enqueue(action) {
    const next = queue.then(action);
    queue = next.catch(error => { log.appendLine(error.stack || error.message); vscode.window.showErrorMessage(`Flowboard Triage: ${error.message}`); });
    return queue;
  }
  async function boardFor(folder) {
    trust(); const root = folder.uri.fsPath;
    let board = boards.get(root);
    if (!board || board.disposed) {
      const dependency = upstream();
      await dependency.activate();
      board = new TriageBoard(vscode, context, dependency, root, {
        select: id => enqueue(() => openFinding(folder, id)),
        refresh: (id, fingerprint) => enqueue(() => rebuildFinding(folder, id, fingerprint))
      }, log);
      boards.set(root, board);
    }
    return board;
  }
  async function rebuildFinding(folder, id, expectedFingerprint) {
    trust(); const dependency = upstream();
    let issue;
    try { issue = await refreshFindingMap(folder.uri.fsPath, id, dependency.extensionPath, { expectedFingerprint }); }
    catch (error) {
      if (error.code !== 'REVIEW_RESET_REQUIRED') throw error;
      const choice = await vscode.window.showWarningMessage(error.message, { modal: true }, 'Rebuild and mark unreviewed');
      if (choice !== 'Rebuild and mark unreviewed') return;
      issue = await refreshFindingMap(folder.uri.fsPath, id, dependency.extensionPath, { expectedFingerprint, allowReviewReset: true });
    }
    const board = await boardFor(folder);
    if (!issue.request) return board.showUnmapped(id, issue, 'No sufficiently specific source map could be generated. Previous draft work was preserved.');
    log.appendLine(`Rebuilt ${id}: ${issue.request.cards.length} current source cards; prior draft archived at ${issue.backup || 'not applicable'}.`);
    return openFinding(folder, id);
  }
  function prepare(root, request) {
    const copy = structuredClone(p.validate(request));
    const git = p.gitState(root); p.checkRevision(copy, git);
    const refs = p.sources(root, copy);
    copy.id = `review-${crypto.randomUUID()}`;
    copy.findingId ||= store.findingKey(copy);
    copy.sourceRevision ||= git.head || undefined;
    copy.cards = copy.cards.map((card, i) => ({ ...card, sourceHash: refs[i].hash }));
    return copy;
  }
  async function render(folder, request, issue = null) {
    trust(); const root = folder.uri.fsPath;
    const refs = p.sources(root, request); const git = p.gitState(root); p.checkRevision(request, git);
    const config = vscode.workspace.getConfiguration('flowboardTriage', folder.uri);
    const mode = config.get('analysisMode', 'source');
    const isolated = path.join(root, '.flowboard/tools/slither-venv', process.platform === 'win32' ? 'Scripts/slither.exe' : 'bin/slither');
    const slitherPath = config.get('slitherPath', '') || (fs.existsSync(isolated) ? isolated : '');
    if (slitherPath && !path.isAbsolute(slitherPath)) throw new Error('slitherPath must be an absolute executable path, without shell arguments.');
    p.atomicJson(root, p.STATUS, { requestId: request.id, state: 'analyzing', updatedAt: new Date().toISOString(), mode });
    const dependency = upstream();
    const { runner, result, diagnostics } = await analyze(dependency.extensionPath, fs.realpathSync(root), { mode, slitherPath });
    if (diagnostics.error) log.appendLine(diagnostics.error);
    const catalog = new SourceCatalog(root, runner, result);
    for (let i = 0; i < refs.length; i++) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(refs[i].absolute));
      if (doc.isDirty) throw new Error(`Save ${request.cards[i].file} first. The canvas reads saved source, not editor buffers.`);
      catalog.resolveCard(request.cards[i]);
    }
    p.sources(root, { ...request, cards: request.cards.map((card, i) => ({ ...card, sourceHash: refs[i].hash })) });
    p.checkRevision(request, p.gitState(root)); catalog.assertFresh();
    const board = await boardFor(folder);
    const nodes = await board.open(request, catalog, diagnostics, git, issue);
    p.atomicJson(root, p.STATUS, { requestId: request.id, state: 'ready', rendered: true, findingId: store.findingKey(request),
      updatedAt: new Date().toISOString(), cards: nodes.map((node, i) => ({ id: request.cards[i].id, function: node.name,
        file: request.cards[i].file, line: node.startLine, sourceHash: refs[i].hash })), analysis: diagnostics, git,
      assessment: { status: request.finding.status, confidence: request.finding.confidence || null, toolVerified: false } });
    log.appendLine(`Rendered ${request.finding.title}: ${nodes.length} source cards in an isolated finding view.`);
  }
  async function openFinding(folder, id) {
    trust(); let issue;
    try { issue = store.readReport(folder.uri.fsPath).issues.find(value => value.id === id); } catch { /* individual finding */ }
    let draft;
    try { draft = store.readDraft(folder.uri.fsPath, id); }
    catch (error) {
      if (error.code === 'ENOENT' && issue) return rebuildFinding(folder, id);
      const board = await boardFor(folder); await board.showUnmapped(id, issue, error.message); return;
    }
    let request;
    try { request = prepare(folder.uri.fsPath, draft); }
    catch (error) { const board = await boardFor(folder); await board.showUnmapped(id, issue, error.message); return; }
    // Preserve stable draft ID/content for review concurrency; submission IDs only
    // identify delivery. The board receives the original draft fingerprint below.
    request._draftFingerprint = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    try { await render(folder, request, issue); }
    catch (error) {
      p.atomicJson(folder.uri.fsPath, p.STATUS, { requestId: request.id, findingId: id, state: 'error', error: error.message, updatedAt: new Date().toISOString() });
      log.appendLine(error.stack || error.message);
      const board = await boardFor(folder); await board.showUnmapped(id, issue, error.message);
    }
  }
  async function processFolder(folder) {
    const root = folder.uri.fsPath;
    if (!fs.existsSync(path.join(root, p.REQUEST))) return;
    let request;
    try {
      trust(); request = p.validate(p.readWorkspaceJson(root, p.REQUEST));
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const prior = processed.get(root);
      if (prior?.id === request.id) {
        if (prior.fingerprint !== fingerprint) throw new Error('Request ID already processed with different content. Submit using a fresh ID.');
        return;
      }
      request.findingId ||= store.findingKey(request);
      // Persist an individual finding only if no reviewed draft already exists.
      const draft = store.writeDraft(root, request.findingId, request, true);
      if (!store.sameDraft(draft, request)) throw new Error('This request differs from the saved finding draft. Edit the finding draft first, then submit it with a fresh ID; the existing review was not overwritten.');
      p.checkRevision(draft, p.gitState(root)); p.sources(root, draft);
      request._draftFingerprint = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
      let issue;
      try { issue = store.readReport(root).issues.find(value => value.id === request.findingId); } catch { /* no report */ }
      await render(folder, request, issue);
      processed.set(root, { id: request.id, fingerprint });
    } catch (error) {
      try { p.atomicJson(root, p.STATUS, { requestId: request?.id || null, state: 'error', error: error.message, updatedAt: new Date().toISOString() }); } catch { /* logged below */ }
      throw error;
    }
  }
  function addFolder(folder) {
    if (watchers.has(folder.uri.toString())) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, p.REQUEST));
    const parts = [watcher, watcher.onDidCreate(() => enqueue(() => processFolder(folder))), watcher.onDidChange(() => enqueue(() => processFolder(folder)))];
    watchers.set(folder.uri.toString(), parts); context.subscriptions.push(...parts);
    enqueue(() => processFolder(folder));
  }
  for (const folder of vscode.workspace.workspaceFolders || []) addFolder(folder);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
    event.removed.forEach(folder => { watchers.get(folder.uri.toString())?.forEach(item => item.dispose()); watchers.delete(folder.uri.toString()); });
    event.added.forEach(addFolder);
  }));
  async function pickFolder() {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
  }
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.process', () => {
    for (const folder of vscode.workspace.workspaceFolders || []) enqueue(() => processFolder(folder));
    return queue;
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.report', async () => {
    const folder = await pickFolder();
    if (folder) return enqueue(async () => { const board = await boardFor(folder); await board.showLibrary(); });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.refresh', async () => {
    const folder = await pickFolder(); if (!folder) return;
    const board = boards.get(folder.uri.fsPath);
    if (!board?.activeId) return vscode.window.showInformationMessage('Open a finding in Flowboard Triage first.');
    return board.post({ type: 'triage:requestRefresh', token: board.activeToken });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.importReport', async () => {
    const folder = await pickFolder(); if (!folder) return;
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Solidity finding report': ['txt', 'md'] } });
    if (!selected?.length) return;
    return enqueue(async () => {
      trust(); const dependency = upstream();
      const bundle = await importReport(selected[0].fsPath, folder.uri.fsPath, dependency.extensionPath);
      log.appendLine(`Imported ${bundle.issues.length} findings. All source suggestions remain unreviewed.`);
      const first = bundle.issues.find(issue => issue.request);
      if (first) await openFinding(folder, first.id);
      else { const board = await boardFor(folder); await board.showLibrary(); }
    });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.submit', async () => {
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Finding draft': ['json'] } });
    if (!selected?.length) return;
    const folder = vscode.workspace.getWorkspaceFolder(selected[0]) || await pickFolder(); if (!folder) return;
    return enqueue(async () => {
      trust(); const request = prepare(folder.uri.fsPath, p.readJson(selected[0].fsPath));
      store.writeDraft(folder.uri.fsPath, request.findingId, request, true);
      p.atomicJson(folder.uri.fsPath, p.REQUEST, request); await processFolder(folder);
    });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.doctor', async () => {
    const folder = await pickFolder(); if (!folder) return;
    const report = { workspace: folder.uri.fsPath, trusted: vscode.workspace.isTrusted,
      dependency: vscode.extensions.getExtension(UPSTREAM)?.packageJSON.version || 'missing',
      requiredDependency: VERSION, mode: vscode.workspace.getConfiguration('flowboardTriage', folder.uri).get('analysisMode', 'source'),
      hasReport: fs.existsSync(path.join(folder.uri.fsPath, '.flowboard/report.json')), reportWarnings: [],
      pythonOrCompilerRequiredInSourceMode: false };
    try { const index = store.readReport(folder.uri.fsPath); report.findings = index.issues.length; }
    catch (error) { report.reportWarnings.push(error.message); }
    log.appendLine(JSON.stringify(report, null, 2)); log.show();
  }));
}
module.exports = { activate };
