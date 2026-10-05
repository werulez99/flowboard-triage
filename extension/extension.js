'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./protocol');
const store = require('./store');
const { analyze } = require('./runner-adapter');
const { SourceCatalog, projectConfigurationStamp: configurationStamp } = require('./source');
const { TriageBoard } = require('./board');
const { importReport, refreshFindingMap } = require('./report');
const { ReportPreparation } = require('./report-preparation');
const { relevantDirty, dirtyScope } = require('./workspace-snapshot');
const UPSTREAM = 'anchabadze.solidity-flowboard';
const VERSION = '1.2.0';
const TRIAGE_VERSION = require('./package.json').version;

function activate(context) {
  const log = vscode.window.createOutputChannel('Flowboard Triage');
  log.appendLine(`Activated Flowboard Triage ${TRIAGE_VERSION} from ${context.extensionPath}`);
  context.subscriptions.push(log);
  let queue = Promise.resolve();
  const boards = new Map(), processed = new Map(), watchers = new Map();
  const catalogs = new Map(), sourceEpochs = new Map(), selections = new Map(), dirtySources = new Set();
  const preparations = new Map();
  const owners = new Map();
  function invalidate(root) { catalogs.delete(root); sourceEpochs.set(root, (sourceEpochs.get(root) || 0) + 1); }
  function operation(folder, kind = 'delivery', selectedId) {
    const root = folder.uri.fsPath;
    if (kind === 'selection') selections.set(root, { epoch: (selections.get(root)?.epoch || 0) + 1, id: selectedId });
    return { root, kind, epoch: selections.get(root)?.epoch || 0, owner: owners.get(root) };
  }
  function current(work) { return !!work.owner && owners.get(work.root) === work.owner && (work.kind === 'background' || work.epoch === (selections.get(work.root)?.epoch || 0)); }
  function reportPreparation(folder) {
    const root = folder.uri.fsPath;
    if (!owners.has(root)) return null;
    if (!fs.existsSync(path.join(root, '.flowboard/report.json'))) return null;
    if (!preparations.has(root)) {
      const preparation = new ReportPreparation(root, {
        configuration: () => { const config = vscode.workspace.getConfiguration('flowboardTriage', folder.uri), provider = config.get('semanticProvider', 'none');
          return { provider, executable: config.get(provider === 'codex' ? 'codexPath' : 'claudePath', '') || undefined,
            budget: config.get('semanticBudgetUSD', 1), requestLimit: config.get('reportRequestLimit', 12), workers: config.get('preparationWorkers', 2) }; },
        // Unsaved project dependencies affect every analysis. A finding JSON
        // is an input only to that finding, not a report-wide reading barrier.
        // No ID means "project-wide dirty", not "any finding is dirty".
        dirty: findingId => !vscode.workspace.isTrusted || (vscode.workspace.textDocuments || []).some(doc => {
          if (!doc.isDirty) return false;
          const scope = dirtyScope(root, doc.uri.fsPath, preparation.state?.reportName);
          return !!scope && (scope.kind !== 'finding' || scope.findingId === findingId);
        }),
        catalog: async signal => { trust(); const result = await sourceCatalog(folder, upstream(), { mode: 'source', slitherPath: '' }, p.gitState(root), { ...operation(folder, 'background'), signal }); return result.catalog; },
        changed: () => { const board = boards.get(root); if (board && !board.disposed) return board.reportProgress?.(); },
        log: message => log.appendLine(message)
      });
      preparations.set(root, preparation); context.subscriptions.push({ dispose: () => preparation.dispose() });
    }
    return preparations.get(root);
  }
  function scheduleReport(folder, retry = false) {
    try { reportPreparation(folder)?.ensure({ retry }); } catch (error) { log.appendLine(`Report preparation: ${error.message}`); }
  }
  function assertSelected(work) {
    if (!current(work)) throw Object.assign(new Error('Delivery superseded by a newer user selection.'), { code: 'FLOWBOARD_SUPERSEDED' });
  }
  function writeStatus(work, value) {
    // status.json is the acknowledgement for request.json, not the most recent
    // arbitrary screen. Opening another finding must not erase that result.
    p.atomicJson(work.root, work.kind === 'delivery' ? p.STATUS : '.flowboard/view-status.json', value);
  }
  function hasDirtySource(root) {
    const documents = vscode.workspace.textDocuments;
    return Array.isArray(documents) ? documents.some(document => document.isDirty && document.uri.fsPath?.endsWith('.sol') && p.contained(root, document.uri.fsPath)) :
      [...dirtySources].some(file => p.contained(root, file));
  }
  async function sourceCatalog(folder, dependency, options, git, work) {
    const root = folder.uri.fsPath, generation = sourceEpochs.get(root) || 0;
    assertSelected(work);
    if (hasDirtySource(root)) throw new Error('Save unsaved Solidity files before preparing a source investigation; an edited dependency can change the selected route.');
    const key = JSON.stringify([dependency.extensionPath, VERSION, options.mode, options.slitherPath, git.head, configurationStamp(root)]);
    let cached = options.mode === 'source' ? catalogs.get(root) : null;
    if (cached?.key === key && cached.generation === generation) {
      try {
        cached.catalog.assertFresh();
        require('./workspace-snapshot').validate(cached.catalog, { force: true });
        return { catalog: cached.catalog, diagnostics: { ...cached.diagnostics, cache: 'reused' } };
      }
      catch { invalidate(root); cached = null; }
    }
    const before = sourceEpochs.get(root) || 0;
    const analyzed = await analyze(dependency.extensionPath, fs.realpathSync(root), { ...options, background: options.mode === 'source', signal: work.signal });
    if (owners.get(root) !== work.owner) assertSelected(work);
    if ((sourceEpochs.get(root) || 0) !== before || hasDirtySource(root) || key !== JSON.stringify([dependency.extensionPath, VERSION, options.mode, options.slitherPath, p.gitState(root).head, configurationStamp(root)])) {
      throw new Error('Source or project configuration changed during preparation. Save your edits and reopen the finding.');
    }
    const catalog = new SourceCatalog(root, analyzed.runner, analyzed.result);
    catalog.assertFresh();
    // Compilation is opt-in. Do not reuse compiler-backed results whose wider
    // toolchain/build dependencies are outside this source-only cache contract.
    if (options.mode === 'source') {
      require('./workspace-snapshot').validate(catalog);
      catalogs.set(root, { key, generation: before, catalog, diagnostics: analyzed.diagnostics });
    }
    // Source preparation is finding-independent. An obsolete selection can
    // still leave a fresh index for the newer selection, but never its view.
    assertSelected(work);
    return { catalog, diagnostics: { ...analyzed.diagnostics, cache: 'fresh' } };
  }
  function trust() { if (!vscode.workspace.isTrusted) throw new Error('Open a trusted workspace first. Default triage reads sources only; compilation remains optional.'); }
  function upstream() {
    const extension = vscode.extensions.getExtension(UPSTREAM);
    if (!extension || extension.packageJSON.version !== VERSION) throw new Error(`Flowboard Triage requires Solidity Flowboard ${VERSION}. Install the bundled dependency into this workspace host.`);
    return extension;
  }
  function enqueue(action) {
    const next = queue.then(action);
    queue = next.catch(error => { log.appendLine(error.stack || error.message); if (error.code !== 'FLOWBOARD_SUPERSEDED') vscode.window.showErrorMessage(`Flowboard Triage: ${error.message}`); });
    return queue;
  }
  function progress(title, action) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, action);
  }
  async function boardFor(folder) {
    trust(); const root = folder.uri.fsPath, ownership = operation(folder, 'background');
    assertSelected(ownership);
    let board = boards.get(root);
    if (!board || board.disposed) {
      const dependency = upstream();
      await dependency.activate();
      assertSelected(ownership);
      board = new TriageBoard(vscode, context, dependency, root, {
        ...(fs.existsSync(path.join(root, '.flowboard/report.json')) ? { reportPreparation: () => reportPreparation(folder) } : {}),
        select: id => {
          const work = operation(folder, 'selection', id);
          return enqueue(() => current(work) && openFinding(folder, id, work));
        },
        refresh: (id, fingerprint) => {
          const work = operation(folder, 'selection', id);
          return enqueue(() => current(work) && rebuildFinding(folder, id, fingerprint, work));
        }
      }, log);
      boards.set(root, board);
    }
    if (fs.existsSync(path.join(root, '.flowboard/report.json'))) board.callbacks.reportPreparation = () => reportPreparation(folder);
    scheduleReport(folder);
    return board;
  }
  async function rebuildFinding(folder, id, expectedFingerprint, work = operation(folder, 'selection', id)) {
    return progress(`Flowboard Triage: Preparing ${id}`, async status => {
      assertSelected(work);
      trust(); const dependency = upstream();
      status.report({ message: 'Reading project code…' });
      const { catalog } = await sourceCatalog(folder, dependency, { mode: 'source', slitherPath: '' }, p.gitState(folder.uri.fsPath), work);
      status.report({ message: 'Finding the relevant functions…' });
      let issue;
      try { issue = await refreshFindingMap(folder.uri.fsPath, id, dependency.extensionPath, { expectedFingerprint, catalog }); }
      catch (error) {
        assertSelected(work);
        if (error.code !== 'REVIEW_RESET_REQUIRED') throw error;
        const choice = await vscode.window.showWarningMessage(error.message, { modal: true }, 'Rebuild and mark unreviewed');
        assertSelected(work);
        if (choice !== 'Rebuild and mark unreviewed') return;
        issue = await refreshFindingMap(folder.uri.fsPath, id, dependency.extensionPath, { expectedFingerprint, catalog, allowReviewReset: true });
      }
      assertSelected(work);
      const board = await boardFor(folder); assertSelected(work);
      if (!issue.request) return board.showUnmapped(id, issue, 'No sufficiently specific source map could be generated. Previous draft work was preserved.', () => current(work));
      log.appendLine(`Rebuilt ${id}: ${issue.request.cards.length} current source cards; prior draft archived at ${issue.backup || 'not applicable'}.`);
      status.report({ message: 'Opening code…' });
      return openFinding(folder, id, work);
    });
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
  async function render(folder, request, issue = null, work = operation(folder)) {
    assertSelected(work);
    trust(); const root = folder.uri.fsPath;
    const refs = p.sources(root, request); const git = p.gitState(root); p.checkRevision(request, git);
    const config = vscode.workspace.getConfiguration('flowboardTriage', folder.uri);
    const mode = config.get('analysisMode', 'source');
    const isolated = path.join(root, '.flowboard/tools/slither-venv', process.platform === 'win32' ? 'Scripts/slither.exe' : 'bin/slither');
    const slitherPath = config.get('slitherPath', '') || (fs.existsSync(isolated) ? isolated : '');
    if (slitherPath && !path.isAbsolute(slitherPath)) throw new Error('slitherPath must be an absolute executable path, without shell arguments.');
    writeStatus(work, { requestId: request.id, state: 'analyzing', updatedAt: new Date().toISOString(), mode });
    const dependency = upstream();
    const { catalog, diagnostics } = await sourceCatalog(folder, dependency, { mode, slitherPath }, git, work);
    assertSelected(work);
    if (diagnostics.error) log.appendLine(diagnostics.error);
    for (let i = 0; i < refs.length; i++) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(refs[i].absolute));
      assertSelected(work);
      if (doc.isDirty) throw new Error(`Save ${request.cards[i].file} first. The canvas reads saved source, not editor buffers.`);
      catalog.resolveCard(request.cards[i]);
    }
    p.sources(root, { ...request, cards: request.cards.map((card, i) => ({ ...card, sourceHash: refs[i].hash })) });
    p.checkRevision(request, p.gitState(root)); catalog.assertFresh();
    const board = await boardFor(folder); assertSelected(work);
    const nodes = await board.open(request, catalog, diagnostics, git, issue, () => current(work));
    // A newer selection can arrive while the old view acknowledges rendering.
    // Preserve the delivery's real ACK, but never publish late selection state.
    if (work.kind !== 'delivery') assertSelected(work);
    writeStatus(work, { requestId: request.id, state: 'ready', rendered: true, findingId: store.findingKey(request),
      updatedAt: new Date().toISOString(), cards: nodes.map((node, i) => ({ id: request.cards[i].id, function: node.name,
        file: request.cards[i].file, line: node.startLine, sourceHash: refs[i].hash })), analysis: diagnostics, git,
      assessment: { status: request.finding.status, confidence: request.finding.confidence || null, toolVerified: false } });
    log.appendLine(`Rendered ${request.finding.title}: ${nodes.length} source cards in an isolated finding view.`);
  }
  async function openFinding(folder, id, work = operation(folder, 'selection', id)) {
    if (!current(work)) return;
    trust(); let issue;
    try { issue = store.readReport(folder.uri.fsPath).issues.find(value => value.id === id); } catch { /* individual finding */ }
    if (issue) reportPreparation(folder)?.prioritize(id);
    let draft;
    try { draft = store.readDraft(folder.uri.fsPath, id); }
    catch (error) {
      if (error.code === 'ENOENT' && issue) return rebuildFinding(folder, id, undefined, work);
      const board = await boardFor(folder); if (current(work)) await board.showUnmapped(id, issue, error.message, () => current(work)); return;
    }
    let request;
    try { request = prepare(folder.uri.fsPath, store.selectedDraft(draft, id)); }
    catch (error) { const board = await boardFor(folder); if (current(work)) await board.showUnmapped(id, issue, error.message, () => current(work)); return; }
    // Preserve stable draft ID/content for review concurrency; submission IDs only
    // identify delivery. The board receives the original draft fingerprint below.
    request._draftFingerprint = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    try { await render(folder, request, issue, work); }
    catch (error) {
      if (error.code === 'FLOWBOARD_SUPERSEDED' || !current(work)) return;
      writeStatus(work, { requestId: request.id, findingId: id, state: 'error', error: error.message, updatedAt: new Date().toISOString() });
      log.appendLine(error.stack || error.message);
      const board = await boardFor(folder); if (current(work)) await board.showUnmapped(id, issue, error.message, () => current(work));
    }
  }
  async function processFolder(folder, work = operation(folder)) {
    const root = folder.uri.fsPath;
    if (!fs.existsSync(path.join(root, p.REQUEST))) return;
    let request, fingerprint;
    try {
      trust(); request = p.validate(p.readWorkspaceJson(root, p.REQUEST));
      fingerprint = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const prior = processed.get(root);
      if (prior?.id === request.id) {
        if (prior.fingerprint !== fingerprint) throw new Error('Request ID already processed with different content. Submit using a fresh ID.');
        return;
      }
      assertSelected(work);
      request.findingId ||= store.findingKey(request);
      // Persist an individual finding only if no reviewed draft already exists.
      const draft = store.writeDraft(root, request.findingId, request, true);
      if (!store.sameDraft(draft, request)) throw new Error('This request differs from the saved finding draft. Edit the finding draft first, then submit it with a fresh ID; the existing review was not overwritten.');
      p.checkRevision(draft, p.gitState(root)); p.sources(root, draft);
      request._draftFingerprint = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
      let issue;
      try { issue = store.readReport(root).issues.find(value => value.id === request.findingId); } catch { /* no report */ }
      await render(folder, request, issue, work);
      processed.set(root, { id: request.id, fingerprint });
    } catch (error) {
      try { writeStatus(work, { requestId: request?.id || null, state: 'error', rendered: false, error: error.message,
        ...(error.code === 'FLOWBOARD_SUPERSEDED' ? { cancelled: true } : {}), updatedAt: new Date().toISOString() }); } catch { /* logged below */ }
      if (error.code === 'FLOWBOARD_SUPERSEDED') {
        if (request?.id && fingerprint) processed.set(root, { id: request.id, fingerprint });
        log.appendLine(error.message); return;
      }
      throw error;
    }
  }
  function addFolder(folder) {
    if (watchers.has(folder.uri.toString())) return;
    owners.set(folder.uri.fsPath, crypto.randomUUID());
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, p.REQUEST));
    const submit = () => { const work = operation(folder); return enqueue(() => processFolder(folder, work)); };
    const parts = [watcher, watcher.onDidCreate(submit), watcher.onDidChange(submit)];
    const sourceWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.sol'));
    const changed = uri => {
      invalidate(folder.uri.fsPath);
      preparations.get(folder.uri.fsPath)?.invalidate('Code changed. Report preparation must check the saved code again.');
      if (!hasDirtySource(folder.uri.fsPath)) scheduleReport(folder);
      const board = boards.get(folder.uri.fsPath);
      if (board && !board.disposed) board.sourceChanged(uri.fsPath).catch(error => log.appendLine(error.stack || error.message));
    };
    parts.push(sourceWatcher, sourceWatcher.onDidCreate(changed), sourceWatcher.onDidChange(changed));
    if (sourceWatcher.onDidDelete) parts.push(sourceWatcher.onDidDelete(changed));
    const reportWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '{.flowboard/report.json,.flowboard/findings/*.json,README.md,SPECIFICATION.md,docs/**/*.md,specification/**/*.md}'));
    const reportChanged = uri => {
      const preparation = preparations.get(folder.uri.fsPath);
      try { if (preparation?.state && store.readReport(folder.uri.fsPath).reportHash !== preparation.state.reportHash) { preparation.invalidate('The imported report changed. Rechecking affected findings.', { kind: 'report' }); scheduleReport(folder); } } catch (error) { log.appendLine(error.message); }
      const file = uri?.fsPath;
      const scope = dirtyScope(folder.uri.fsPath, file, preparation?.state?.reportName);
      if (scope?.kind === 'finding') {
        preparation?.invalidate('This finding changed. Rechecking its saved explanation.', { findingId: scope.findingId, saved: true }); scheduleReport(folder);
      } else if (scope?.kind === 'documentation') {
        preparation?.invalidate('Local documentation changed. The report must be rechecked.'); scheduleReport(folder);
      }
      const board = boards.get(folder.uri.fsPath);
      if (board && !board.disposed) board.reportChanged().catch(error => log.appendLine(error.stack || error.message));
    };
    parts.push(reportWatcher, reportWatcher.onDidCreate(reportChanged), reportWatcher.onDidChange(reportChanged));
    if (reportWatcher.onDidDelete) parts.push(reportWatcher.onDidDelete(reportChanged));
    const projectWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `{${require('./source').configurationFiles.join(',')}}`));
    const projectChanged = uri => configurationChanged(folder, path.basename(uri.fsPath));
    parts.push(projectWatcher, projectWatcher.onDidCreate(projectChanged), projectWatcher.onDidChange(projectChanged));
    if (projectWatcher.onDidDelete) parts.push(projectWatcher.onDidDelete(projectChanged));
    watchers.set(folder.uri.toString(), parts); context.subscriptions.push(...parts);
    submit();
    scheduleReport(folder);
  }
  function configurationChanged(folder, description) {
    const root = folder.uri.fsPath; invalidate(root);
    preparations.get(root)?.invalidate('Project configuration changed. Rechecking the report is required.'); scheduleReport(folder);
    const board = boards.get(root); if (!board || board.disposed) return;
    const stale = { files: [description], dirty: false, reason: 'Project or analysis configuration changed. Refresh this investigation before relying on its source map.' };
    for (const model of new Set([...(board.models?.values() || []), ...(board.sessions?.values() || [])])) model.stale = stale;
    if (board.native) board.native.triageSourceStale = true;
    if (board.activeId) board.post({ type: 'triage:sourceStale', issueId: board.activeId, token: board.activeToken, ...stale }).catch(error => log.appendLine(error.message));
  }
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (event.affectsConfiguration('flowboardTriage.analysisMode', folder.uri) || event.affectsConfiguration('flowboardTriage.slitherPath', folder.uri)) configurationChanged(folder, 'Flowboard Triage configuration');
      else if (event.affectsConfiguration('flowboardTriage', folder.uri)) {
        // Changing a display/model setting is not consent to another report
        // spending allowance. The explicit Resume action handles that.
        scheduleReport(folder);
        const board = boards.get(folder.uri.fsPath), model = board?.models.get(board.activeId);
        if (model && !board.callbacks.reportPreparation) { model.investigationAbort?.abort(); Promise.resolve(model.investigationJob).then(() => board.startInvestigation(model, true)).catch(error => log.appendLine(error.message)); }
      }
    }
  }));
  if (vscode.workspace.onDidChangeTextDocument) context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    const file = event.document.uri.fsPath;
    if (event.document.isDirty && file && !file.endsWith('.sol')) {
      for (const [root, preparation] of preparations) {
        const scope = dirtyScope(root, file, preparation.state?.reportName);
        if (scope?.kind === 'finding') preparation.invalidate('Unsaved finding edits. Save before resuming this finding.', { findingId: scope.findingId });
        else if (scope) preparation.invalidate('Relevant unsaved report, documentation or configuration edits. Save before resuming preparation.');
      }
      for (const [root, board] of boards) if (!board.disposed && relevantDirty(root, file, preparations.get(root)?.state?.reportName)) board.reportChanged(file).catch(error => log.appendLine(error.stack || error.message));
    }
    if (!file?.endsWith('.sol')) return;
    if (event.document.isDirty) dirtySources.add(file); else dirtySources.delete(file);
    for (const folder of vscode.workspace.workspaceFolders || []) if (p.contained(folder.uri.fsPath, file)) invalidate(folder.uri.fsPath);
    if (!event.document.isDirty) return;
    for (const [root, preparation] of preparations) if (p.contained(root, file)) preparation.invalidate('Unsaved Solidity edits. Save before resuming preparation.');
    for (const board of boards.values()) if (!board.disposed) {
      board.sourceChanged(event.document.uri.fsPath, true).catch(error => log.appendLine(error.stack || error.message));
    }
  }));
  if (vscode.workspace.onDidSaveTextDocument) context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    if (document.uri.fsPath?.endsWith('.sol')) dirtySources.delete(document.uri.fsPath);
    for (const folder of vscode.workspace.workspaceFolders || []) if (relevantDirty(folder.uri.fsPath, document.uri.fsPath, preparations.get(folder.uri.fsPath)?.state?.reportName)) scheduleReport(folder);
  }));
  for (const folder of vscode.workspace.workspaceFolders || []) addFolder(folder);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
    event.removed.forEach(folder => {
      const root = folder.uri.fsPath;
      owners.delete(root);
      watchers.get(folder.uri.toString())?.forEach(item => item.dispose()); watchers.delete(folder.uri.toString());
      preparations.get(root)?.dispose(); preparations.delete(root);
      invalidate(root); selections.delete(root); processed.delete(root);
      const board = boards.get(root);
      if (board) {
        for (const model of new Set([...(board.models?.values() || []), ...(board.sessions?.values() || [])])) {
          model.investigationAbort?.abort(); model.experimentAbort?.abort();
        }
        board.disposed = true; board.native?.panel?.dispose(); boards.delete(root);
      }
    });
    event.added.forEach(addFolder);
  }));
  async function pickFolder() {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
  }
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.process', () => {
    for (const folder of vscode.workspace.workspaceFolders || []) { const work = operation(folder); enqueue(() => processFolder(folder, work)); }
    return queue;
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.report', async () => {
    const folder = await pickFolder();
    if (folder) { const work = operation(folder, 'selection', null); return enqueue(async () => {
      if (!current(work)) return;
      const board = await boardFor(folder); if (current(work)) await board.showLibrary(() => current(work));
    }); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.refresh', async () => {
    const folder = await pickFolder(); if (!folder) return;
    const board = boards.get(folder.uri.fsPath);
    if (!board?.activeId) return vscode.window.showInformationMessage('Open a finding in Flowboard Triage first.');
    return board.post({ type: 'triage:requestRefresh', token: board.activeToken });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.importReport', async () => {
    try {
      log.appendLine('Import Report: choosing workspace and report.');
      if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open the project folder before importing a report.');
      const folder = await pickFolder(); if (!folder) { log.appendLine('Import Report: workspace selection cancelled.'); return; }
      trust(); const dependency = upstream();
      const selected = await vscode.window.showOpenDialog({ title: 'Import findings report', openLabel: 'Import report',
        defaultUri: folder.uri, canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        filters: { 'Solidity finding report': ['txt', 'md'] } });
      if (!selected?.length) { log.appendLine('Import Report: file selection cancelled.'); return; }
      const work = operation(folder, 'selection', null);
      return await progress('Flowboard Triage: Importing report', async status => {
        status.report({ message: 'Waiting for current work…' });
        return enqueue(async () => {
          if (!current(work)) return;
          status.report({ message: 'Reading report…' });
          const bundle = await importReport(selected[0].fsPath, folder.uri.fsPath, dependency.extensionPath, { deferMapping: true });
          assertSelected(work);
          log.appendLine(`Imported ${bundle.issues.length} findings. Report-wide preparation is scheduled with a shared request budget; saved reviews are preserved.`);
          scheduleReport(folder);
          status.report({ message: `Opening ${bundle.issues.length} findings…` });
          const board = await boardFor(folder); if (current(work)) await board.showLibrary(() => current(work));
        });
      });
    } catch (error) {
      log.appendLine(`Import Report: ${error.stack || error.message}`);
      if (error.code !== 'FLOWBOARD_SUPERSEDED') await vscode.window.showErrorMessage(`Flowboard Triage: ${error.message}`);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.submit', async () => {
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Finding draft': ['json'] } });
    if (!selected?.length) return;
    const folder = vscode.workspace.getWorkspaceFolder(selected[0]) || await pickFolder(); if (!folder) return;
    const work = operation(folder);
    return enqueue(async () => {
      assertSelected(work);
      trust(); const request = prepare(folder.uri.fsPath, p.readJson(selected[0].fsPath));
      store.writeDraft(folder.uri.fsPath, request.findingId, request, true);
      p.atomicJson(folder.uri.fsPath, p.REQUEST, request); await processFolder(folder, work);
    });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('flowboardTriage.doctor', async () => {
    const folder = await pickFolder(); if (!folder) return;
    const config = vscode.workspace.getConfiguration('flowboardTriage', folder.uri), provider = config.get('semanticProvider', 'none');
    const report = { workspace: folder.uri.fsPath, trusted: vscode.workspace.isTrusted,
      activeTriage: { version: TRIAGE_VERSION, extensionPath: context.extensionPath },
      dependency: vscode.extensions.getExtension(UPSTREAM)?.packageJSON.version || 'missing',
      dependencyPath: vscode.extensions.getExtension(UPSTREAM)?.extensionPath || null,
      requiredDependency: VERSION, mode: vscode.workspace.getConfiguration('flowboardTriage', folder.uri).get('analysisMode', 'source'),
      hasReport: fs.existsSync(path.join(folder.uri.fsPath, '.flowboard/report.json')), reportWarnings: [],
      pythonOrCompilerRequiredInSourceMode: false };
    try { const index = store.readReport(folder.uri.fsPath); report.findings = index.issues.length; }
    catch (error) { report.reportWarnings.push(error.message); }
    let receipts = [];
    try { receipts = Object.values(p.readWorkspaceJson(folder.uri.fsPath, '.flowboard/report-preparation.json', 8 * 1024 * 1024).resources?.receipts || {}); }
    catch (error) { if (error.code !== 'ENOENT') report.reportWarnings.push('Saved provider observations are unavailable.'); }
    report.provider = await require('./runtime-diagnostics').providerIdentity(provider,
      config.get(provider === 'codex' ? 'codexPath' : 'claudePath', '') || undefined, vscode.workspace.isTrusted, receipts);
    log.appendLine(JSON.stringify(report, null, 2)); log.show();
  }));
}
module.exports = { activate };
