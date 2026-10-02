'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./protocol');
const store = require('./store');
const { layoutGraph } = require('./graph');
const { createNativePanel } = require('./native-panel');
const { mapFile } = require('./report');
const review = require('./webview/review-model');

class TriageBoard {
  constructor(vscode, context, upstream, root, callbacks, log) {
    this.vscode = vscode; this.root = root; this.callbacks = callbacks; this.log = log;
    this.models = new Map(); this.sessions = new Map(); this.renderWaiters = new Map(); this.activeId = null; this.disposed = false;
    this.native = createNativePanel(vscode, context, upstream, root);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Flowboard Triage did not load. Reload the editor and check the Output channel.')), 15000);
      this.resolveReady = () => { clearTimeout(timer); resolve(); };
      this.native.panel.onDidDispose(() => { clearTimeout(timer); this.disposed = true; resolve();
        for (const waiter of this.renderWaiters.values()) waiter.reject(new Error('Flowboard closed before rendering completed.')); });
    });
    this.native.panel.webview.onDidReceiveMessage(message => {
      Promise.resolve(this.receive(message)).catch(error => this.notify(error.message, true));
    });
    this.native.onExpandCall((...args) => { this.expand(...args).catch(async error => {
      await this.post({ type: 'triage:limit' }); await this.notify(error.message, true);
    }); });
  }
  async post(message) { return this.native.panel.webview.postMessage(message); }
  notify(message, error = false) { this.log.appendLine(message); return this.post({ type: 'triage:notice', message, error }); }
  async open(request, catalog, diagnostics, git, issue = null) {
    await this.ready;
    if (this.disposed) throw new Error('The Flowboard was closed before it became ready.');
    catalog.assertFresh(); p.sources(this.root, request); p.checkRevision(request, p.gitState(this.root));
    const id = store.findingKey(request);
    const fns = request.cards.map(card => catalog.resolveCard(card));
    const prefix = `finding:${id}:`;
    const declared = request.connections || [];
    const requestedConnections = [...declared, ...request.cards.filter(card => card.parentId).map(card => ({
      from: card.parentId, to: card.id, kind: card.edgeKind || 'hypothesis', reason: card.reason || ''
    }))].filter((edge, index, all) => all.findIndex(other => other.from === edge.from && other.to === edge.to) === index);
    const checked = catalog.validateConnections(fns, request.cards, requestedConnections), connections = checked.connections;
    const nodes = fns.map((fn, i) => ({ id: prefix + request.cards[i].id, name: fn.name, contract: fn.contract, kind: fn.kind,
      code: catalog.code(fn), calls: fn.calls || [], memberCalls: fn.memberCalls || [], callArity: fn.callArity || {},
      newCalls: fn.newCalls || [], modifiers: fn.modifiers || [], file: path.basename(fn.file), fsPath: fn.file,
      startLine: fn.startLine, endLine: fn.endLine, notFound: false }));
    const edges = connections.map(edge => ({ ...edge, from: prefix + edge.from, to: prefix + edge.to }));
    for (const node of nodes) {
      const file = catalog.relative(node.fsPath);
      node.reviewNoteHeight = (request.finding.triage?.evidence || []).filter(item => !item.needsReview && item.source?.sourceHash && item.source.file === file && item.source.line >= node.startLine && item.source.line <= node.endLine)
        .reduce((height, item) => height + Math.min(230, Math.ceil(item.note.length / 55) * 22) + 100, 0);
    }
    layoutGraph(nodes, edges);
    const fingerprint = crypto.createHash('sha256').update(catalog.fingerprint(request.cards) + JSON.stringify(connections)).digest('hex');
    let cached = null, protectCache = false;
    const warnings = [...(issue?.warnings || []), ...checked.warnings];
    try { cached = store.readBoard(this.root, id); }
    catch (error) {
      try { warnings.push(`Invalid saved canvas was not used: ${error.message} Original bytes archived at ${store.archiveBoardFile(this.root, id)}.`); }
      catch { protectCache = true; warnings.push(`Saved canvas could not be safely archived: ${error.message} Canvas autosave is disabled for this view to preserve that file.`); }
    }
    if (cached && cached.fingerprint !== fingerprint) {
      const backup = store.archiveBoard(this.root, id, cached);
      warnings.push(`Source/flow changed. A fresh map is shown; your previous layout and notes were archived at ${backup}.`);
    }
    const state = cached?.fingerprint === fingerprint ? cached.state : { cards: nodes, edges, notes: [], camera: { scale: 1, panX: 0, panY: 0 } };
    const model = { id, request, catalog, diagnostics, git, fingerprint, protectCache, connections: edges, nodes, expandedIds: new Set(state.cards.map(card => card.id)),
      sourceById: new Map(fns.map((fn, i) => [nodes[i].id, fn])),
      draftFingerprint: request._draftFingerprint || crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex') };
    for (const card of state.cards) if (!model.sourceById.has(card.id) && card.fsPath && card.kind !== 'context') {
      const fn = catalog.functionAt(catalog.relative(card.fsPath), card.startLine, card.name);
      if (fn) model.sourceById.set(card.id, fn);
    }
    // Layout/notes are cache data; source text and bounds always come from the
    // checked catalog so inline source evidence cannot attach to edited cache text.
    for (const card of state.cards) {
      const fn = model.sourceById.get(card.id);
      if (fn) { card.code = catalog.code(fn); card.startLine = fn.startLine; card.endLine = fn.endLine; }
    }
    const hints = Object.fromEntries(fns.map((fn, i) => [nodes[i].id, { ...catalog.hints(fn), description: request.cards[i].description || '', mapping: request.cards[i].mapping || null }]));
    for (const [cardId, fn] of model.sourceById) if (!hints[cardId]) hints[cardId] = catalog.hints(fn);
    // Expand only the latest finding's index. A delayed old expansion must not
    // appear in the new finding after the user switches.
    this.models.set(id, model); this.sessions.set(request.id, model); this.activeId = id; this.activeToken = request.id;
    this.native.triageToken = request.id;
    if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value);
    this.native.panel.title = `Flowboard Triage — ${issue?.displayId || id}`;
    this.native.panel.reveal(this.native.panel.viewColumn, true);
    const rendered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.renderWaiters.delete(request.id); reject(new Error('The canvas did not acknowledge rendering. Reload the window and retry.')); }, 15000);
      this.renderWaiters.set(request.id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    await this.post({ type: 'triage:load', issueId: id, token: request.id, fingerprint, state, connections: edges,
      finding: request.finding, library: store.library(this.root), reportText: issue?.reportText || '',
      retrieval: issue?.retrieval || null, validation: { cards: nodes.length, sourceCalls: checked.sourceCalls, downgradedCalls: checked.warnings.length, semanticVerified: false },
      unresolved: issue?.unresolved || [], warnings,
      diagnostics, git, reportRevision: request.finding.reportRevision || null,
      hints });
    await rendered;
    return nodes;
  }
  async expand(name, fromId, childId, contract, isSuper, argCount) {
    const id = this.activeId, activeToken = this.activeToken, model = this.models.get(id);
    if (!model || !this.vscode.workspace.isTrusted) return;
    if (!model.expandedIds.has(fromId)) return;
    if (model.expandedIds.size >= 200 && !model.expandedIds.has(childId)) {
      await this.post({ type: 'triage:limit' }); return this.notify('This finding reached 200 source cards. Remove unneeded branches or reopen a focused draft before expanding further.', true);
    }
    model.expandedIds.add(childId);
    p.sources(this.root, model.request); p.checkRevision(model.request, p.gitState(this.root));
    model.catalog.assertFresh();
    const parent = model.sourceById.get(fromId);
    const candidates = parent ? model.catalog.expansionCandidates(parent, name, isSuper, argCount) : model.catalog.candidates(name, contract, isSuper, argCount);
    let fn = candidates[0];
    if (candidates.length > 1) {
      const picked = await this.vscode.window.showQuickPick(candidates.map(value => ({
        label: `${value.contract}::${value.name}`, description: `${model.catalog.relative(value.file)}:${value.startLine}`, fn: value
      })), { placeHolder: 'Ambiguous call target — choose the implementation to inspect (not a validity verdict).' });
      if (!picked) {
        model.expandedIds.delete(childId);
        if (this.activeToken === activeToken) await this.post({ type: 'triage:cancelExpansion', id: childId });
        return;
      }
      fn = picked?.fn;
    }
    if (this.activeId !== id || this.activeToken !== activeToken) return;
    model.catalog.assertFresh();
    if (!fn) { this.native.addMissing(name, fromId, childId); return; }
    fn = model.catalog.resolveCard({ file: model.catalog.relative(fn.file), line: fn.startLine, function: fn.name });
    const doc = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(fn.file));
    if (this.activeId !== id || this.activeToken !== activeToken) return;
    model.catalog.assertFresh();
    if (doc.isDirty) throw new Error('Save the source before expanding the flow.');
    this.native.addFunction(fn, model.catalog.code(fn), fromId, childId);
    model.sourceById.set(childId, fn);
    await this.post({ type: 'triage:hint', token: activeToken, id: childId, hint: model.catalog.hints(fn) });
  }
  async receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'triage:ready') { this.resolveReady(); return; }
    if (message.type === 'triage:persist') {
      const model = this.sessions.get(message.token);
      if (model?.id === message.issueId && !model.protectCache) store.writeBoard(this.root, message.issueId, message.state, model.fingerprint);
      return;
    }
    if (message.type === 'triage:rendered') { this.renderWaiters.get(message.token)?.resolve(); this.renderWaiters.delete(message.token); return; }
    if (message.type === 'triage:select') { p.identifier(message.issueId, 'finding ID'); return this.callbacks.select(message.issueId); }
    const model = this.models.get(this.activeId);
    if (message.issueId && message.issueId !== this.activeId) return;
    if (['triage:save', 'triage:reload', 'triage:prompt', 'triage:refresh', 'triage:openReference', 'triage:copyReport', 'triage:bindEvidence', 'triage:inspectEvidence', 'triage:copyBrief'].includes(message.type) && message.token !== this.activeToken) throw new Error('This view is out of date. Reload the finding before continuing.');
    if (['triage:bindEvidence', 'triage:inspectEvidence'].includes(message.type)) {
      if (!this.vscode.workspace.isTrusted || !model) throw new Error('Open a current, mapped finding before reviewing source evidence.');
      const activeToken = this.activeToken;
      const item = structuredClone(message.evidence);
      const profile = { version: 1, checks: [], evidence: [item] }; review.validate(profile);
      if (item.needsReview) throw new Error('This evidence belongs to a previous source/map review. Inspect the current code and add a new evidence entry; the old reference was not silently revalidated.');
      model.catalog.assertFresh(); p.sources(this.root, model.request); p.checkRevision(model.request, p.gitState(this.root));
      let source = p.evidenceSources(this.root, profile, true)[0];
      if (source) {
        const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(source.absolute));
        if (activeToken !== this.activeToken) return;
        if (document.isDirty) throw new Error('Save the source before binding or inspecting evidence.');
        model.catalog.assertFresh(); source = p.evidenceSources(this.root, profile)[0];
        if (message.type === 'triage:inspectEvidence') {
          await this.vscode.window.showTextDocument(document, { viewColumn: this.native.panel.viewColumn === 1 ? this.vscode.ViewColumn?.Beside || 2 : this.vscode.ViewColumn?.One || 1,
            selection: new this.vscode.Range(item.source.line - 1, 0, item.source.line - 1, 0), preview: false });
          if (activeToken !== this.activeToken) return;
          model.catalog.assertFresh(); p.evidenceSources(this.root, profile);
        }
      }
      if (activeToken !== this.activeToken) return;
      p.checkRevision(model.request, p.gitState(this.root));
      if (message.type === 'triage:bindEvidence') return this.post({ type: 'triage:evidenceBound', issueId: this.activeId, token: activeToken, evidence: item });
      const start = source ? Math.max(1, item.source.line - 2) : null;
      const excerpt = source ? source.source.split(/\r?\n/).slice(start - 1, item.source.line + 3).map((line, i) => `${start + i}  ${line}`).join('\n').slice(0, 12000) : '';
      return this.post({ type: 'triage:evidenceInspected', issueId: this.activeId, token: activeToken, evidence: item, excerpt });
    }
    if (message.type === 'triage:copyBrief' && model) {
      model.catalog.assertFresh(); p.sources(this.root, model.request); p.checkRevision(model.request, p.gitState(this.root));
      const current = { ...model.request.finding, ...structuredClone(message.patch || {}) };
      if (current.triage) { review.validate(current.triage); p.evidenceSources(this.root, current.triage); }
      await this.vscode.env.clipboard.writeText(review.brief(current, { checkoutRevision: model.request.sourceRevision || model.git.head }));
      return this.notify('Review brief copied. It records reviewer evidence and gaps, not a verified verdict.');
    }
    if (message.type === 'triage:refresh' && this.activeId) return this.callbacks.refresh(this.activeId, model?.draftFingerprint);
    if (message.type === 'triage:copyReport') {
      let issue; try { issue = store.readReport(this.root).issues.find(value => value.id === this.activeId); } catch { /* standalone draft */ }
      await this.vscode.env.clipboard.writeText(issue?.reportText || model?.request.finding.summary || '');
      return this.notify('Original report text copied, without formatting changes.');
    }
    if (message.type === 'triage:openReference') {
      if (!this.vscode.workspace.isTrusted || typeof message.file !== 'string' || message.file.length > 1000 || !Number.isSafeInteger(message.line) || message.line < 1) throw new Error('Invalid source reference.');
      model?.catalog.assertFresh();
      if (model) p.checkRevision(model.request, p.gitState(this.root));
      const file = mapFile(this.root, message.file, model?.catalog.functions.map(fn => fn.file) || []);
      if (!file) throw new Error('This citation cannot be resolved unambiguously in the current checkout.');
      const [source] = p.sources(this.root, { cards: [{ file, line: message.line }] });
      const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(source.absolute));
      if (message.token !== this.activeToken) return;
      if (document.isDirty) throw new Error('Save this source file before navigating to a report line. Unsaved edits can shift its location.');
      model?.catalog.assertFresh();
      p.sources(this.root, { cards: [{ file, line: message.line, sourceHash: source.hash }] });
      if (model) p.checkRevision(model.request, p.gitState(this.root));
      return this.vscode.window.showTextDocument(document, { viewColumn: this.native.panel.viewColumn === 1 ? this.vscode.ViewColumn?.Beside || 2 : this.vscode.ViewColumn?.One || 1,
        selection: new this.vscode.Range(message.line - 1, 0, message.line - 1, 0), preview: false });
    }
    if (message.type === 'triage:prompt' && this.activeId) {
      if (message.cardId) {
        if (!this.vscode.workspace.isTrusted || !model) throw new Error('Open a mapped finding before asking about a function.');
        model.catalog.assertFresh(); p.sources(this.root, model.request); p.checkRevision(model.request, p.gitState(this.root));
        const fn = model.sourceById.get(message.cardId);
        if (!fn) throw new Error('The selected function is not part of this source map.');
        const location = `${model.catalog.relative(fn.file)}:${fn.startLine}`;
        await this.vscode.env.clipboard.writeText(`Use $solidity-flowboard-triage for ${this.activeId}. Focus on ${fn.contract || ''}::${fn.name} at ${location}. Read the saved finding draft and original source. Explain this function's normal purpose, inputs, state reads/writes, permissions/modifiers and immediate source relationships. Distinguish established facts from unresolved dispatch or specification assumptions. Relate relevant observations to the reported claim and record evidence for and against it. Do not infer an execution or attack sequence from diagram order. Do not execute exploits. Preserve unrelated review work. Unsaved UI edits are not included in this prompt; read the current draft and respect concurrent-edit checks. Save any requested draft changes before submitting a fresh delivery.`);
        return this.notify('Function review prompt copied. Unsaved form edits are not included; paste into your assistant.');
      }
      await this.vscode.env.clipboard.writeText(store.reviewPrompt(this.activeId)); return this.notify('Review prompt copied. Paste it into your coding assistant.');
    }
    if (message.type === 'triage:save' && model) {
      if (!this.vscode.workspace.isTrusted || !message.patch || typeof message.patch !== 'object') return;
      p.sources(this.root, model.request); p.checkRevision(model.request, p.gitState(this.root));
      model.catalog.assertFresh();
      const pendingTriage = message.patch.triage || model.request.finding.triage;
      for (const source of p.evidenceSources(this.root, pendingTriage)) {
        const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(source.absolute));
        if (message.token !== this.activeToken) return;
        if (document.isDirty) throw new Error('Save the evidence source before saving this review.');
      }
      model.catalog.assertFresh();
      const next = store.saveReview(this.root, this.activeId, message.patch, model.draftFingerprint);
      model.request = next; model.draftFingerprint = crypto.createHash('sha256').update(JSON.stringify(next)).digest('hex');
      await this.post({ type: 'triage:reviewSaved', issueId: this.activeId, token: this.activeToken,
        editVersion: message.editVersion, finding: next.finding, library: store.library(this.root) });
      return this.notify('Review saved locally. This is your assessment, not an automatic tool verdict.');
    }
    if (message.type === 'triage:reload' && this.activeId) return this.callbacks.select(this.activeId);
  }
  async showLibrary() {
    await this.ready;
    this.native.panel.reveal(this.native.panel.viewColumn, true);
    return this.post({ type: 'triage:library', library: store.library(this.root) });
  }
  async showUnmapped(id, issue, error) {
    await this.ready; this.activeId = id; this.activeToken = `unmapped-${crypto.randomUUID()}`;
    this.models.delete(id); // A read-only explanation cannot reuse an older writable/source model.
    this.native.triageToken = this.activeToken;
    this.native.panel.reveal(this.native.panel.viewColumn, true);
    this.native.panel.title = `Flowboard Triage — ${issue?.displayId || id}`;
    return this.post({ type: 'triage:load', issueId: id, token: this.activeToken,
      finding: issue?.request?.finding || { title: `${issue?.displayId || id}: ${issue?.title || 'Unmapped finding'}`, status: 'unreviewed' },
      state: { cards: [], edges: [], notes: [], camera: { scale: 1, panX: 0, panY: 0 } }, connections: [], hints: {},
      library: store.library(this.root), reportText: issue?.reportText || '', unresolved: issue?.unresolved || [],
      retrieval: issue?.retrieval || null,
      warnings: [error, 'This finding needs source/revision review before it can show a current flow. No missing functions were guessed.'],
      git: p.gitState(this.root), diagnostics: { mode: 'source' }, readOnly: true });
  }
}
module.exports = { TriageBoard };
