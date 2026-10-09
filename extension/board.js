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
const { cleanCode } = require('./webview/inline-review');
const { prepareInvestigation } = require('./investigation');
const investigationEngine = require('./investigation-engine');
const experiment = require('./experiment');
const localDocumentation = require('./local-documentation');
const guidePolicy = require('./guide-policy');

class TriageBoard {
  constructor(vscode, context, upstream, root, callbacks, log) {
    this.vscode = vscode; this.root = root; this.callbacks = callbacks; this.log = log;
    this.models = new Map(); this.sessions = new Map(); this.renderWaiters = new Map(); this.activeId = null; this.disposed = false;
    this.native = createNativePanel(vscode, context, upstream, root);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Flowboard Triage did not load. Reload the editor and check the Output channel.')), 15000);
      this.resolveReady = () => { clearTimeout(timer); resolve(); };
      this.native.panel.onDidDispose(() => { clearTimeout(timer); this.disposed = true; resolve();
        for (const model of this.models.values()) { model.investigationAbort?.abort(); model.experimentAbort?.abort(); }
        for (const waiter of this.renderWaiters.values()) waiter.reject(new Error('Flowboard closed before rendering completed.')); });
    });
    this.native.panel.webview.onDidReceiveMessage(message => {
      const scope = this.scope(message);
      Promise.resolve(this.receive(message)).catch(async error => {
        if (typeof message?.navigationId === 'string' && ['triage:investigationFocus','triage:inspectEvidence'].includes(message.type) && this.isActive(scope)) {
          const model = this.models.get(scope.issueId);
          await this.post({ type:'triage:navigationFailed', ...scope, navigationId:message.navigationId.slice(0,100), reason:error.message,
            guideAvailability:model ? this.guideAvailability(model) : null });
        }
        return this.notify(error.message, true, scope);
      });
    });
    this.native.onOpenSource?.(message => {
      const scope = this.scope(message);
      this.openNativeSource(message).catch(error => this.notify(error.message, true, scope));
    });
    this.native.onAnnotateSource?.(message => {
      const scope = this.scope(message);
      this.annotateNativeSource(message).catch(async error => {
        if (!this.isActive(scope)) return;
        // Native aiError clears the current card's busy button and leaves all
        // source/reviewer rows intact. Do not show delayed errors on another map.
        await this.post({ type: 'aiError', kind: 'annotate', id: message.id,
          name: this.models.get(scope.issueId)?.sourceById.get(message.id)?.name || 'Source explanation', error: error.message, ...scope });
        await this.notify(error.message, true, scope);
      });
    });
    this.native.onExpandCall((...args) => {
      const scope = this.scope(), model = this.models.get(this.activeId);
      this.expand(...args).catch(async error => {
        if (model && !model.sourceById.has(args[2])) model.expandedIds.delete(args[2]);
        if (!this.isActive(scope)) return;
        await this.post({ type: 'triage:limit', ...scope }); await this.notify(error.message, true, scope);
      });
    });
  }
  async post(message) {
    if (Object.hasOwn(message, 'reportPreparation') || message.type === 'triage:reportPreparation') {
      // Order observations at capture/delivery, not when an async webview ACK
      // arrives. A delayed initial library must not roll back a live update.
      this.reportObservation = (this.reportObservation || 0) + 1;
      message = { ...message, reportObservation: this.reportObservation };
    }
    return this.native.panel.webview.postMessage(message);
  }
  profileMapping(){const relative=this.vscode?.workspace.getConfiguration?.('flowboardTriage',this.vscode.Uri.file(this.root)).get('engagementProfile','');return require('./assessment-profile').resolve(this.root,relative);}
  exposed(draft,mapping) {
    if(!draft)return null;
    mapping??=this.profileMapping();
    const evaluated=guidePolicy.evaluate(draft);
    const profiles=require('./assessment-profile');Object.assign(evaluated.assessment,profiles.project(draft,evaluated.assessment));
    evaluated.assessment=profiles.remap(evaluated.assessment,mapping);
    const report = this.callbacks?.reportPreparation?.();
    const status = report?.status(mapping);
    return guidePolicy.expose(draft, status ? { findingId: draft?.findingId, findingReady: report.published(draft,evaluated) } : this.callbacks?.reportPreparation ? {
      findingId: draft?.findingId, findingReady: false } : null,evaluated);
  }
  async remapProfile(){const model=this.models.get(this.activeId);if(!model?.investigationDraft)return;
    this.assertCurrent(model);
    const mapping=this.profileMapping(),projection=this.exposed(model.investigationDraft,mapping).assessmentProjection;
    await this.post({type:'triage:assessmentProjection',issueId:model.id,token:model.token,artifact:projection.artifact,projection,
      mapping,profileObservation:this.profileObservation=(this.profileObservation||0)+1});
    const report=this.callbacks.reportPreparation?.();if(report)await this.post({type:'triage:reportPreparation',report:report.status(mapping)});}
  async reportProgress() {
    if (this.disposed) return;
    const report = this.callbacks.reportPreparation?.();
    const status = report?.status();
    await this.post({ type: 'triage:reportPreparation', report: status });
    const model = this.models.get(this.activeId);
    // Token progress only updates status. No source scan, draft parse or digest
    // is needed until a different immutable report artifact is published.
    const artifact = report?.artifact(model?.id);
    if (!model || model.displayedArtifact === artifact || !this.investigationCurrent(model)) return;
    if (!artifact) {
      if (model.displayedArtifact) {
        model.displayedArtifact = null;
        await this.post({ type: 'triage:investigation', issueId: model.id, token: model.token, draft: this.exposed(model.investigationDraft) });
      }
      return;
    }
    const draft = investigationEngine.read(this.root, model.id);
    if (!draft || !investigationEngine.sameSnapshot(draft.snapshot, investigationEngine.snapshot(model.catalog, model.request, model.issue))) return;
    model.investigationDraft = draft;
    if (report?.published(draft)) await this.prepareInvestigationCards(model);
    await this.post({ type: 'triage:investigation', issueId: model.id, token: model.token, draft: this.exposed(draft), guideAvailability: this.guideAvailability(model) });
    model.displayedArtifact = artifact;
  }
  scope(message) { return { issueId: message?.issueId || this.activeId, token: message?.token || this.activeToken }; }
  isActive(scope) { return !this.disposed && scope.issueId === this.activeId && scope.token === this.activeToken; }
  notify(message, error = false, scope = this.scope()) {
    this.log.appendLine(message);
    return this.isActive(scope) ? this.post({ type: 'triage:notice', message, error, ...scope }) : Promise.resolve(false);
  }
  assertCurrent(model) {
    if (model.stale) throw new Error(model.stale.reason);
    model.catalog.assertFresh(); p.sources(this.root, model.request); p.checkRevision(model.request, p.gitState(this.root));
  }
  async sourceChanged(file, dirty = false) {
    if (this.disposed || typeof file !== 'string' || !file.endsWith('.sol') || !p.contained(path.resolve(this.root), path.resolve(file))) return;
    const relative = path.relative(this.root, file).split(path.sep).join('/');
    // Creation/deletion can change formerly unique dispatch just as editing a
    // displayed function can. Keep the current board and reviewer text in place,
    // but stop treating its index and AI results as current.
    for (const model of new Set([...this.models.values(), ...this.sessions.values()])) {
      model.investigationAbort?.abort(); model.experimentAbort?.abort();
      const files = [...new Set([...(model.stale?.files || []), relative])].slice(0, 30);
      model.stale = { files, dirty: !!(dirty || model.stale?.dirty),
        reason: dirty ? 'Unsaved Solidity edits may change source locations. Save the source, then refresh this investigation; existing notes are preserved.' : 'Solidity source changed after this investigation was prepared. Refresh the source map before binding evidence, expanding or saving an assessment.' };
    }
    const model = this.models.get(this.activeId);
    if (model) {
      this.native.triageSourceStale = true;
      await this.post({ type: 'triage:sourceStale', ...this.scope(), ...model.stale });
    }
  }
  async openNativeSource(message) {
    const scope = this.scope(message), model = this.models.get(scope.issueId);
    if (!this.isActive(scope) || !model || !this.vscode.workspace.isTrusted) return;
    if (typeof message.fsPath !== 'string' || !Number.isSafeInteger(message.startLine) || message.startLine < 1) throw new Error('Invalid native source reference.');
    const absolute = fs.realpathSync(message.fsPath);
    if (!p.contained(fs.realpathSync(this.root), absolute) || !absolute.endsWith('.sol')) throw new Error('Source must be Solidity inside the current workspace.');
    this.assertCurrent(model);
    // A native snapshot is layout data, not permission to open any source path.
    // Resolve card/modifier targets from the catalog instead of trusting cache
    // metadata; this also covers inherited modifier chips.
    const allowed = [...model.sourceById.values()].some(fn =>
      fn.file === absolute && fn.startLine === message.startLine ||
      (fn.modifiers || []).some(modifier => modifier.file === absolute && modifier.startLine === message.startLine));
    if (!allowed) throw new Error('This source location is not part of the current function or modifier map. Reload the investigation.');
    const file = model.catalog.relative(absolute), expected = crypto.createHash('sha256').update(model.catalog.document(file).text).digest('hex');
    p.sources(this.root, { cards: [{ file, line: message.startLine, sourceHash: expected }] });
    const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(absolute));
    if (!this.isActive(scope)) return;
    if (document.isDirty) throw new Error('Save the source before opening this original line. Unsaved edits may shift its location.');
    this.assertCurrent(model);
    p.sources(this.root, { cards: [{ file, line: message.startLine, sourceHash: expected }] });
    return this.vscode.window.showTextDocument(document, {
      viewColumn: this.native.panel.viewColumn === 1 ? this.vscode.ViewColumn?.Beside || 2 : this.vscode.ViewColumn?.One || 1,
      selection: new this.vscode.Range(message.startLine - 1, 0, message.startLine - 1, 0), preview: false
    });
  }
  async annotateNativeSource(message) {
    const scope = this.scope(message), model = this.models.get(scope.issueId);
    if (!this.isActive(scope) || !model || !this.vscode.workspace.isTrusted) return;
    const fn = model.sourceById.get(message.id);
    if (!fn) throw new Error('This source card is not part of the current investigation. Refresh the map before requesting an explanation.');
    this.assertCurrent(model);
    const file = model.catalog.relative(fn.file), source = { file, line: fn.startLine, endLine: fn.endLine,
      sourceHash: crypto.createHash('sha256').update(model.catalog.document(file).text).digest('hex') };
    let document;
    const isCurrent = () => {
      if (!this.isActive(scope) || this.models.get(model.id) !== model || !this.vscode.workspace.isTrusted) return false;
      this.assertCurrent(model);
      p.sources(this.root, { cards: [source] });
      const dirty = document?.isDirty || (this.vscode.workspace.textDocuments || []).some(item => item.isDirty &&
        item.uri.fsPath?.endsWith('.sol') && p.contained(path.resolve(this.root), path.resolve(item.uri.fsPath)));
      if (dirty) throw new Error('Save Solidity edits and refresh this investigation before requesting an optional explanation.');
      return true;
    };
    if (!isCurrent()) return;
    document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(fn.file));
    if (!isCurrent()) return;
    // Keep line-relative model comments aligned with the actual native code
    // renderer. Ignore message.code, name, fsPath and bounds entirely.
    return this.native.annotate(message.id, fn.name, cleanCode(model.catalog.code(fn)), fn.file, fn.startLine, fn.endLine, { source, isCurrent });
  }
  async addContext(model, message) {
    const scope = this.scope(message);
    if (!this.isActive(scope) || !this.vscode.workspace.isTrusted) return;
    this.assertCurrent(model);
    const source = message.source, preparation = model.investigation;
    const references = [
      ...(preparation?.contexts || []).flatMap(context => [context.source, ...(context.calls || []).flatMap(site => site.targets || [])]),
      ...(preparation?.candidates || []).map(candidate => candidate.source)
    ].filter(Boolean);
    const checked = references.find(item => source && item.file === source.file && item.line === source.line && item.sourceHash === source.sourceHash && item.name === source.name);
    if (!checked) throw new Error('This context reference is not part of the current source preparation. Refresh the investigation.');
    if (model.expandedIds.size >= 200) throw new Error('This finding reached 200 source cards. Remove unnecessary context or reopen a focused map.');
    const [entry] = p.sources(this.root, { cards: [{ file: checked.file, line: checked.line, sourceHash: checked.sourceHash }] });
    const fn = model.catalog.resolveCard({ file: checked.file, line: checked.line, function: checked.name?.split('::').pop() });
    const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(entry.absolute));
    if (!this.isActive(scope) || this.models.get(model.id) !== model) return;
    if (document.isDirty) throw new Error('Save the source before adding current code context.');
    this.assertCurrent(model); p.sources(this.root, { cards: [{ file: checked.file, line: checked.line, sourceHash: checked.sourceHash }] });
    const id = `finding:${model.id}:context-${crypto.randomUUID()}`;
    model.expandedIds.add(id); model.sourceById.set(id, fn);
    // Candidate selection is exploration, not proof of dispatch or reachability.
    this.native.addFunction(fn, model.catalog.code(fn), null, id);
    const candidate = preparation.candidates?.find(item => item.source.file === checked.file && item.source.line === checked.line && item.source.sourceHash === checked.sourceHash);
    await this.post({ type: 'triage:hint', ...scope, id, hint: { ...model.catalog.hints(fn),
      description: candidate?.reason || 'Related code for inspection. Check the conditions and relevance to the selected statement.' } });
    const visible = [...model.sourceById], relationships = model.catalog.graph(visible.map(([, value]) => value), visible.map(([id]) => ({ id }))).filter(edge => edge.from === id || edge.to === id);
    await this.post({ type: 'triage:investigationLinks', ...scope, connections: relationships });
    if (this.isActive(scope)) await this.post({ type: 'triage:contextAdded', ...scope, id, source: checked });
  }
  async inspectBlocker(model,message){
    const scope=this.scope(message);if(!this.isActive(scope)||!this.vscode.workspace.isTrusted)return;
    this.assertCurrent(model);
    const draft=investigationEngine.read(this.root,model.id);
    if(!draft||!investigationEngine.compatible(draft,model.catalog,model.request,model.issue))throw new Error('The diagnostic source changed. Reopen the finding.');
    const diagnostic=guidePolicy.gate(draft).details?.find(d=>d.id===message.diagnosticId);
    const source=diagnostic?.source;if(!source)throw new Error('This current blocker has no unambiguous source location. Inspect its named premise or field.');
    p.sources(this.root,{cards:[source]});
    let fn;try{fn=model.catalog.resolveCard({file:source.file,line:source.line});}catch{
      return this.receive({...message,type:'triage:openReference',file:source.file,line:source.line});
    }
    const document=await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(fn.file));
    if(!this.isActive(scope)||this.models.get(model.id)!==model)return;
    if(document.isDirty)throw new Error('Save changed code before inspecting this source-bound blocker.');
    this.assertCurrent(model);
    let id=[...model.sourceById].find(([,u])=>u.file===fn.file&&u.startLine===fn.startLine&&u.endLine===fn.endLine)?.[0];
    if(!id){if(model.expandedIds.size>=200)throw new Error('The source-card limit is reached; use the source editor link.');
      id=`finding:${model.id}:diagnostic-${crypto.randomUUID()}`;model.expandedIds.add(id);model.sourceById.set(id,fn);this.native.addFunction(fn,model.catalog.code(fn),null,id);}
    await this.post({type:'triage:hint',...scope,id,hint:model.catalog.hints(fn)});
    await this.post({type:'triage:blockerFocus',...scope,id,source,diagnosticId:diagnostic.id});
  }
  async open(request, catalog, diagnostics, git, issue = null, canPublish = () => true) {
    await this.ready;
    if (!canPublish()) throw Object.assign(new Error('Delivery superseded by a newer user selection.'), { code: 'FLOWBOARD_SUPERSEDED' });
    if (this.disposed) throw new Error('The Flowboard was closed before it became ready.');
    for (const old of this.models.values()) { old.investigationAbort?.abort(); old.experimentAbort?.abort(); }
    catalog.assertFresh(); p.sources(this.root, request); p.checkRevision(request, p.gitState(this.root));
    const id = store.findingKey(request);
    const applicability = require('./report-targets').inspect(catalog, request.finding.title, issue?.reportText || request.finding.summary);
    if (applicability.blockers.length) {
      await this.showUnmapped(id, issue || { title: request.finding.title, reportText: request.finding.summary }, applicability.blockers.join('\n'), canPublish);
      return [];
    }
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
    let cached = null, protectCache = false, cacheUnavailable = false;
    const warnings = [...(issue?.warnings || []), ...checked.warnings];
    try { cached = store.readBoard(this.root, id); }
    catch (error) {
      cacheUnavailable = true;
      try { warnings.push(`Invalid saved canvas was not used: ${error.message} Original bytes archived at ${store.archiveBoardFile(this.root, id)}.`); }
      catch { protectCache = true; warnings.push(`Saved canvas could not be safely archived: ${error.message} Canvas autosave is disabled for this view to preserve that file.`); }
    }
    if (cached && cached.fingerprint !== fingerprint) {
      const backup = store.archiveBoard(this.root, id, cached);
      warnings.push(`Source, configuration or index version changed. A fresh map is shown; your previous layout and notes were archived at ${backup}.`);
    }
    const previousReviewFingerprint = cached?.reviewSourceFingerprint || cached?.fingerprint || (cacheUnavailable ? 'unverified-source-context' : fingerprint);
    const priorReview = review.definitive.includes(request.finding.status) ||
      request.finding.triage?.evidence.some(item => !item.needsReview) || request.finding.triage?.checks.some(check => check.state !== 'unchecked') ||
      request.finding.triage?.claims?.some(claim => claim.state !== 'unreviewed');
    const reviewStale = !!priorReview && previousReviewFingerprint !== fingerprint;
    const historicalAssessment = reviewStale ? { status: request.finding.status, confidence: request.finding.confidence || null } : null;
    const displayedFinding = structuredClone(request.finding);
    if (reviewStale) {
      warnings.push('The saved assessment is historical because its source, configuration or index version differs. Current source remains navigable; refresh with review-reset consent before recording new evidence or saving a judgment. The saved draft was not changed.');
      if (displayedFinding.triage) {
        require('./webview/claim-model').invalidate(displayedFinding.triage);
        for (const check of displayedFinding.triage.checks) check.state = 'unchecked';
      }
    }
    const state = cached?.fingerprint === fingerprint ? cached.state : { cards: nodes, edges, notes: [], camera: { scale: 1, panX: 0, panY: 0 } };
    const model = { id, token: request.id, request, catalog, diagnostics, git, fingerprint, protectCache, reviewStale, issue, canPublish,
      reviewSourceFingerprint: reviewStale ? previousReviewFingerprint : fingerprint,
      connections: edges, nodes, expandedIds: new Set(state.cards.map(card => card.id)),
      sourceById: new Map(fns.map((fn, i) => [nodes[i].id, fn])),
      draftFingerprint: request._draftFingerprint || crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex') };
    for (const card of state.cards) if (!model.sourceById.has(card.id) && card.fsPath && card.kind !== 'context') {
      try {
        const fn = catalog.resolveCard({ file: catalog.relative(card.fsPath), line: card.startLine, function: card.name });
        model.sourceById.set(card.id, fn);
      } catch {
        warnings.push(`A cached source card (${card.name || card.id}) could not be resolved against this index. Its old source text was withheld.`);
      }
    }
    model.knownSources = new Map(model.sourceById);
    // Requested anchors can be removed from a saved exploration layout. They
    // are known source identities, not still-materialized native cards.
    for (const id of model.sourceById.keys()) if (!model.expandedIds.has(id)) model.sourceById.delete(id);
    const hints = Object.fromEntries(fns.map((fn, i) => [nodes[i].id, { ...catalog.hints(fn), description: request.cards[i].description || '', mapping: request.cards[i].mapping || null }]));
    for (const [cardId, fn] of model.sourceById) if (!hints[cardId]) hints[cardId] = catalog.hints(fn);
    // Expand only the latest finding's index. A delayed old expansion must not
    // appear in the new finding after the user switches.
    this.models.set(id, model); this.sessions.set(request.id, model); this.activeId = id; this.activeToken = request.id;
    this.native.triageToken = request.id; this.native.triageFindingId = id; this.native.triageSourceStale = false;
    if (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value);
    this.native.panel.reveal(this.native.panel.viewColumn, true);
    model.investigation = prepareInvestigation(catalog, request, issue);
    try {
      const saved = investigationEngine.read(this.root, id);
      if (saved && investigationEngine.compatible(saved, catalog, request, issue)) { investigationEngine.validateCurrent(catalog, saved); model.investigationDraft = saved; }
      else {
        const fresh = investigationEngine.create({ findingId: id, request, issue, catalog });
        if (saved && this.callbacks.investigationPersistence !== false) investigationEngine.archive(this.root, saved);
        // Corrections survive as explicitly unsupported researcher premises.
        if (saved) { fresh.corrections = saved.corrections; fresh.previousSnapshot = saved.snapshot; fresh.storageRevision = saved.revision; fresh.revision = saved.revision; }
        model.investigationDraft = fresh;
      }
    } catch (error) {
      model.investigationBlocked = error.message;
      warnings.push(`Saved investigation could not be loaded safely: ${error.message} Its file was preserved; source navigation remains available.`);
    }
    // Reopen checked declaration cards through the saved investigation, not
    // arbitrary coordinates supplied by a canvas snapshot.
    for (const card of state.cards.filter(card => card.kind === 'context' && !model.sourceById.has(card.id))) {
      const unit = model.investigationDraft?.sources.find(unit => unit.contextKind && unit.source.file === catalog.relative(card.fsPath || '') && unit.source.line === card.startLine);
      if (!unit) continue;
      const fn = catalog.resolveUnit(unit);
      model.sourceById.set(card.id, fn); hints[card.id] = { ...catalog.hints(fn), description: unit.reason };
    }
    // Resolve saved declarations before clearing unresolved locations. Layout is
    // cache data; code and bounds always come from the checked current catalog.
    for (const card of state.cards) {
      const fn = model.sourceById.get(card.id);
      if (fn) Object.assign(card, { code: catalog.code(fn), name: fn.name, contract: fn.contract, kind: fn.kind,
        file: path.basename(fn.file), fsPath: fn.file, startLine: fn.startLine, endLine: fn.endLine,
        calls: fn.calls || [], memberCalls: fn.memberCalls || [], callArity: fn.callArity || {},
        newCalls: fn.newCalls || [], modifiers: fn.modifiers || [], notFound: false });
      else if (card.fsPath) Object.assign(card, { code: 'Cached source target is unavailable. Reopen current source context; no old code is shown.',
        fsPath: '', file: '', startLine: 0, endLine: 0, calls: [], memberCalls: [], modifiers: [], notFound: true });
    }
    // Materialize required native functions in the SAME initial load as the
    // checked guide. Auto-start must never race addFunction/hint messages.
    const exposed = this.exposed(model.investigationDraft);
    if (exposed?.phase === 'ready') {
      let x = Math.max(0, ...state.cards.map(card => (card.x || 0) + 800));
      for (const unit of require('./event-source').units(exposed)) {
        const fn = this.resolveGuideUnit(model, unit);
        if (state.cards.some(card => model.sourceById.has(card.id) && catalog.key(model.sourceById.get(card.id)) === catalog.key(fn))) continue;
        if (state.cards.length >= 200) continue;
        const cardId = `finding:${id}:investigation-${unit.id}`;
        model.sourceById.set(cardId, fn); model.knownSources.set(cardId, fn); model.expandedIds.add(cardId);
        hints[cardId] = { ...catalog.hints(fn), description: exposed.causal.events.find(event => exposed.evidence.find(item => item.id === event.evidenceId)?.sourceId === unit.id)?.role || '' };
        state.cards.push({ id: cardId, name: fn.name, contract: fn.contract, kind: fn.kind, code: catalog.code(fn),
          file: path.basename(fn.file), fsPath: fn.file, startLine: fn.startLine, endLine: fn.endLine, x, y: 0,
          calls: fn.calls || [], memberCalls: fn.memberCalls || [], callArity: fn.callArity || {}, newCalls: fn.newCalls || [], modifiers: fn.modifiers || [], notFound: false });
        x += 800;
      }
      for (const edge of this.investigationLinks(model)) {
        if (!edges.some(item => item.from === edge.from && item.to === edge.to)) edges.push(edge);
        if (!state.edges.some(item => item.from === edge.from && item.to === edge.to)) state.edges.push(edge);
      }
      model.displayedArtifact = this.callbacks.reportPreparation?.()?.artifact(id);
    }
    // Preparation can fail before a load message exists. Do not leave a render
    // waiter for that failed selection to reject during a later panel close.
    const rendered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.renderWaiters.delete(request.id); reject(new Error('The canvas did not acknowledge rendering. Reload the window and retry.')); }, 15000);
      this.renderWaiters.set(request.id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    if (!canPublish()) return [];
    this.native.panel.title = `Flowboard Triage — ${issue?.displayId || id}`;
    await this.post({ type: 'triage:load', issueId: id, token: request.id, fingerprint, draftFingerprint: model.draftFingerprint,
      recoveryState: cached && cached.fingerprint !== fingerprint ? { workingCopy: cached.state.workingCopy, recoveries: cached.state.recoveries, view: cached.state.view } : null,
      state, connections: edges,
      finding: displayedFinding, readOnly: reviewStale, sourceStale: reviewStale, historicalAssessment,
      ...this.libraryObservation(), reportText: issue?.reportText || '',
      investigation: model.investigation,
      investigationDraft: exposed, guideAvailability: this.guideAvailability(model),
      semanticEnabled: ['claude', 'codex'].includes(this.vscode.workspace.getConfiguration?.('flowboardTriage', this.vscode.Uri.file(this.root))?.get('semanticProvider', 'none')),
      retrieval: issue?.retrieval || null, validation: { cards: nodes.length, sourceCalls: checked.sourceCalls, downgradedCalls: checked.warnings.length, semanticVerified: false },
      unresolved: issue?.unresolved || [], warnings,
      diagnostics, git, reportRevision: request.finding.reportRevision || null,
      hints });
    await rendered;
    this.startInvestigation(model).catch(error => this.notify(error.message, true, { issueId: id, token: request.id }));
    return nodes;
  }
  investigationCurrent(model) {
    let draftCurrent = true;
    try {
      draftCurrent = investigationEngine.hash(store.readDraft(this.root, model.id)) === model.draftFingerprint;
      if (model.issue) draftCurrent &&= store.readIssue(this.root, model.id)?.reportText === model.issue.reportText;
      if (model.investigationDraft) draftCurrent &&= (model.investigationDraft.snapshot.documentation || null) === localDocumentation.inspect(this.root, model.request.finding.title).digest;
    } catch { draftCurrent = false; }
    return draftCurrent && this.isActive({ issueId: model.id, token: model.token }) && this.models.get(model.id) === model &&
      !model.stale && !model.reviewStale && (model.canPublish?.() ?? true) && this.vscode.workspace.isTrusted &&
      !(this.vscode.workspace.textDocuments || []).some(doc => doc.isDirty && doc.uri.fsPath?.endsWith('.sol') && p.contained(this.root, doc.uri.fsPath));
  }
  async reportChanged(dirtyFile) {
    for (const model of new Set([...this.models.values(), ...this.sessions.values()])) {
      let changed = false;
      try {
        changed = investigationEngine.hash(store.readDraft(this.root, model.id)) !== model.draftFingerprint ||
          !!model.issue && store.readIssue(this.root, model.id)?.reportText !== model.issue.reportText ||
          !!model.investigationDraft && (model.investigationDraft.snapshot.documentation || null) !== localDocumentation.inspect(this.root, model.request.finding.title).digest;
      } catch { changed = true; }
      if (dirtyFile && p.contained(this.root, dirtyFile)) {
        const relative = path.relative(this.root, dirtyFile).split(path.sep).join('/');
        changed ||= relative === '.flowboard/report.json' || relative === `.flowboard/findings/${model.id}.json` ||
          /^(?:README\.md|SPECIFICATION\.md|(?:docs|specification)\/.*\.md)$/.test(relative);
      }
      if (!changed) continue;
      model.investigationAbort?.abort();
      model.stale = { files: ['Report or local documentation'], dirty: !!dirtyFile, reason: 'The finding, report or local documentation changed. Save edits and refresh to check its explanations and links again.' };
      if (this.isActive({ issueId: model.id, token: model.token })) {
        this.native.triageSourceStale = true;
        await this.post({ type: 'triage:sourceStale', issueId: model.id, token: model.token, ...model.stale });
      }
    }
  }
  async publishInvestigation(model, draft) {
    if (!this.investigationCurrent(model)) return;
    model.investigationDraft = draft;
    this.log.appendLine(`Investigation ${model.id}: ${draft.phase}; ${draft.claims.length} scoped claims; ${draft.runs.filter(run => run.outcome === 'completed').length} completed model passes. Draft is not a reviewed verdict.`);
    if (this.exposed(draft)?.phase === 'ready') await this.prepareInvestigationCards(model);
    await this.post({ type: 'triage:investigation', issueId: model.id, token: model.token, draft: this.exposed(draft), guideAvailability: this.guideAvailability(model) });
  }
  guideAvailability(model) {
    // Layout is only a remedy for an already publishable guide. Private
    // incomplete causal events must not cover an evidence/budget failure with
    // "make room" or imply that their explanation has been checked.
    const draft = this.exposed(model.investigationDraft);
    if (draft?.phase !== 'ready' || !draft.causal?.events) return null;
    const missingSourceIds = require('./event-source').units(draft).filter(unit => {
      return ![...model.sourceById].some(([cardId, fn]) => model.expandedIds.has(cardId) && model.catalog.relative(fn.file) === unit.source.file && fn.startLine === unit.source.line);
    }).map(unit => unit.id);
    const materializedCount = model.expandedIds.size, deficit = Math.max(0, materializedCount + missingSourceIds.length - 200);
    return { ready: !missingSourceIds.length, missingSourceIds, limit:200, materializedCount, deficit,
      reason: missingSourceIds.length ? `The walkthrough needs ${missingSourceIds.length} missing function card${missingSourceIds.length === 1 ? '' : 's'}.${deficit ? ` Remove ${deficit} exploration card${deficit === 1 ? '' : 's'} from the 200-card canvas, then resume.` : ' Start it to open the required code.'} Your layout, notes and checked explanation are preserved.` : '' };
  }
  reconcileMaterialized(model, state) {
    // Called only after the normal snapshot validator accepts the state. Undo
    // can restore an earlier exact identity; never infer it from display text.
    model.knownSources ||= new Map(model.sourceById);
    for (const [id, fn] of model.sourceById) model.knownSources.set(id, fn);
    const next = new Map();
    for (const card of state.cards) {
      const known = model.knownSources.get(card.id);
      if (known && known.file === card.fsPath && known.startLine === card.startLine && known.name === card.name) next.set(card.id, known);
    }
    model.sourceById = next; model.expandedIds = new Set(state.cards.map(card => card.id));
  }
  investigationLinks(model) {
    const draft = model.investigationDraft, visible = [...model.sourceById];
    const links = model.catalog.graph(visible.map(([, fn]) => fn), visible.map(([id]) => ({ id })));
    if (!draft) return links;
    const cardFor = source => [...model.sourceById].find(([, fn]) => model.catalog.relative(fn.file) === source.file && fn.startLine === source.line)?.[0];
    for (const unit of draft.sources) {
      const from = cardFor(unit.source); if (!from) continue;
      for (const site of unit.structure?.calls || []) {
        const to = cardFor(site.target); if (!to || from === to) continue;
        links.push({ from, to, kind: site.relationship === 'internal-call' ? 'call' : 'hypothesis',
          reason: `${site.relationship === 'internal-call' ? 'Compiler-resolved internal call' : 'Compiler declaration reference, not resolved external dispatch'} at ${site.source.file}:${site.source.line}. ${(site.conditions || []).map(condition => `${condition.branch} branch of (${condition.expression}) at L${condition.source.line}`).join('; ')}. ${site.caveat}` });
      }
    }
    return links.filter((edge, index) => links.findIndex(other => edge.from === other.from && edge.to === other.to) === index);
  }
  resolveGuideUnit(model, unit) {
    const fn = model.catalog.resolveUnit(unit);
    if (unit.projectedFrom && (fn.startLine !== unit.source.line || fn.endLine !== unit.source.endLine || model.catalog.code(fn) !== unit.code)) throw new Error('The checked containing-source slice is not the exact native function. Keep the source available and recheck this presentation capability.');
    return fn;
  }
  async prepareInvestigationCards(model) {
    if (!this.investigationCurrent(model)) return;
    const draft = model.investigationDraft, first = draft.claims[0];
    if (!first) return;
    const units = draft.causal?.events?.length ? require('./event-source').units(draft) : draft.sources.filter(unit => unit.id === first.entry || draft.evidence.some(item => first.evidence.includes(item.id) && item.sourceId === unit.id));
    const hints = {};
    for (const unit of units) {
      const fn = this.resolveGuideUnit(model, unit);
      if ([...model.sourceById.values()].some(value => model.catalog.key(value) === model.catalog.key(fn))) continue;
      if (model.expandedIds.size >= 200) continue;
      this.assertCurrent(model); p.sources(this.root, { cards: [unit.source] });
      const id = `finding:${model.id}:investigation-${unit.id}`;
      model.expandedIds.add(id); model.sourceById.set(id, fn);
      // Add-without-parent places only the NEW card; no camera or old-card move.
      this.native.addFunction(fn, model.catalog.code(fn), null, id);
      hints[id] = { ...model.catalog.hints(fn), description: draft.causal?.events.find(event => draft.evidence.find(item => item.id === event.evidenceId)?.sourceId === unit.id)?.role || 'Exploration code outside the checked walkthrough.' };
      if (!this.investigationCurrent(model)) return;
    }
    if (Object.keys(hints).length) await this.post({ type: 'triage:hints', issueId: model.id, token: model.token, hints });
    await this.post({ type: 'triage:investigationLinks', issueId: model.id, token: model.token, connections: this.investigationLinks(model) });
  }
  async startInvestigation(model, retry = false) {
    if (this.callbacks.reportPreparation) {
      const report = this.callbacks.reportPreparation();
      if (!this.investigationCurrent(model)) return;
      // Ready playback is not authority to reconcile/restart paused siblings.
      // Background work continues independently; explicit retry and changed or
      // rejected artifacts still use the normal owned recovery path below.
      if (!retry && this.exposed(model.investigationDraft)?.phase === 'ready') return;
      const work = retry ? report?.continueFinding(model.id) : report?.ensure();
      work?.catch(error => this.vscode.window.showErrorMessage(error.message)); // backend-owned, not view-owned
      return this.reportProgress();
    }
    if (!model.investigationDraft || model.investigationBlocked || !this.investigationCurrent(model)) return;
    if (model.investigationJob && !model.investigationAbort?.signal.aborted) return model.investigationJob;
    if (!retry && ['ready', 'blocked', 'provider-required'].includes(model.investigationDraft.phase)) return;
    const config = this.vscode.workspace.getConfiguration?.('flowboardTriage', this.vscode.Uri.file(this.root));
    const provider = config?.get('semanticProvider', 'none') || 'none';
    const executable = config?.get(provider === 'codex' ? 'codexPath' : 'claudePath', '') || undefined;
    if (executable && !path.isAbsolute(executable)) throw new Error('The model CLI path must be an absolute executable path without arguments.');
    const abort = new AbortController(); model.investigationAbort = abort;
    delete model.investigationDraft.error;
    model.investigationJob = investigationEngine.advance({ root: this.root, catalog: model.catalog, request: model.request,
      issue: model.issue, findingId: model.id, draft: structuredClone(model.investigationDraft), provider, executable,
      budget: config?.get('semanticBudgetUSD', 1), signal: abort.signal,
      current: () => this.investigationCurrent(model), publish: draft => this.publishInvestigation(model, structuredClone(draft)),
      persist: this.callbacks.investigationPersistence !== false });
    try {
      const result = await model.investigationJob;
      if (result.error && this.investigationCurrent(model)) await this.notify(result.error, true, { issueId: model.id, token: model.token });
      return result;
    } finally { model.investigationJob = null; }
  }
  async enableInvestigation(model) {
    if (!this.investigationCurrent(model)) return;
    const selected = await this.vscode.window.showQuickPick([{ label: 'Claude CLI', provider: 'claude' }, { label: 'Codex CLI', provider: 'codex' }], { placeHolder: 'Choose your authenticated local CLI for source-only drafts.' });
    if (!selected || !this.investigationCurrent(model)) return;
    const choice = await this.vscode.window.showWarningMessage(`Enable automatic source-only ${selected.label} reviews of every finding in this workspace's imported report? Report sections and bounded code excerpts go to that account. A shared report request limit pauses work before another allowance is used. Generation and challenge may need one repair and up to two new-code checks. Claude has a per-request USD cap; Codex uses your account limits plus a timeout (no USD cap). Tools/hooks/apps are disabled; any observed Codex tool action rejects the result. No exploit or generated-test execution.`, { modal: true }, 'Enable for this workspace');
    if (choice !== 'Enable for this workspace' || !this.investigationCurrent(model)) return;
    const config = this.vscode.workspace.getConfiguration('flowboardTriage', this.vscode.Uri.file(this.root));
    await config.update('semanticProvider', selected.provider, this.vscode.ConfigurationTarget?.WorkspaceFolder || 3);
    if (this.investigationCurrent(model)) return this.startInvestigation(model, true);
  }
  async focusInvestigation(model, message) {
    if (!this.investigationCurrent(model)) throw new Error('Refresh this source context before navigating investigation evidence.');
    const draft = model.investigationDraft;
    if (message.investigationRevision !== undefined && message.investigationRevision !== draft?.revision) throw new Error('A newer review is available. Update the walkthrough before opening this note; the old link was not moved.');
    const evidence = message.evidenceId ? draft?.evidence.find(item => item.id === message.evidenceId) : null;
    const exposed=this.exposed(draft);
    if(evidence&&!exposed?.causal)throw new Error('Use the checked assessment evidence action; this private explanation is not a walkthrough.');
    let unit = draft?.sources.find(item => item.id === (evidence?.sourceId || message.sourceId));
    if (!unit || message.evidenceId && !evidence) throw new Error('Unknown investigation evidence/source.');
    this.assertCurrent(model);
    const event = message.eventId ? draft?.causal?.events.find(item => item.id === message.eventId && item.evidenceId === evidence?.id) : null;
    if (message.eventId && (!event || !this.exposed(draft)?.causal || require('./source-bindings').integrity(draft).length)) throw new Error('The prepared step or its source binding is no longer available.');
    if (event) unit = require('./event-source').eventSource(draft, event);
    const source = event?.anchor?.source || evidence?.source || unit.source;
    const [checked] = p.sources(this.root, { cards: [source] });
    const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(checked.absolute));
    if (!this.investigationCurrent(model)) return;
    if (document.isDirty) throw new Error('Save source edits and refresh before using this reference.');
    this.assertCurrent(model); p.sources(this.root, { cards: [source] });
    if (message.editor) return this.vscode.window.showTextDocument(document, {
      viewColumn: this.native.panel.viewColumn === 1 ? this.vscode.ViewColumn?.Beside || 2 : this.vscode.ViewColumn?.One || 1,
      selection: new this.vscode.Range(source.line - 1, 0, source.endLine - 1, 0), preview: false });
    const fn = this.resolveGuideUnit(model, unit);
    let cardId = [...model.sourceById].find(([, value]) => model.catalog.key(value) === model.catalog.key(fn))?.[0];
    if (!cardId || message.materialize === true) {
      if (!cardId && model.expandedIds.size >= 200) throw new Error('The current map has reached its source-card limit.');
      // Exploration can remove a known native card. Restore that exact checked
      // function on an explicit walkthrough/evidence navigation, not on progress.
      cardId ||= `finding:${model.id}:investigation-${unit.id}`;
      model.expandedIds.add(cardId); model.sourceById.set(cardId, fn);
      this.native.addFunction(fn, model.catalog.code(fn), null, cardId);
      await this.post({ type: 'triage:hint', issueId: model.id, token: model.token, id: cardId,
        hint: { ...model.catalog.hints(fn), description: exposed?.causal?.events.find(event => exposed.evidence.find(item => item.id === event.evidenceId)?.sourceId === unit.id)?.role || 'Source inspection context; not a checked execution step.' } });
    }
    await this.post({ type: 'triage:investigationFocus', issueId: model.id, token: model.token, cardId, source,
      claimId: evidence?.claimId || draft.claims.find(claim => claim.id === message.claimId)?.id || null, evidenceId: evidence?.id || null,
      navigationId: typeof message.navigationId === 'string' ? message.navigationId.slice(0, 100) : null, guideAvailability: this.guideAvailability(model) });
    await this.post({ type: 'triage:investigationLinks', issueId: model.id, token: model.token, connections: this.investigationLinks(model) });
  }
  async inspectAssessmentEvidence(model,message){
    if(!this.investigationCurrent(model))throw new Error('Refresh changed source before inspecting checked evidence.');
    this.assertCurrent(model);
    const approved=()=>{const saved=investigationEngine.read(this.root,model.id);
      const projection=this.exposed(saved)?.assessmentProjection;
      if(!projection?.artifact||projection.artifact.identity!==message.assessmentIdentity||projection.technical.result==='not-assessed')throw new Error('This checked assessment identity is no longer current. Reopen the current result.');
      const entry=projection.technical.evidence?.find(e=>e.id===message.evidenceId);
      if(!entry)throw new Error('This evidence is not exposed by the checked assessment.');return{entry,artifact:projection.artifact};};
    const {entry,artifact}=approved(),source=entry.source;
    const [checked]=p.sources(this.root,{cards:[source]});
    let fn;try{fn=model.catalog.resolveCard({file:source.file,line:source.line});}catch{fn=null;}
    if(fn&&fn.endLine<source.endLine)fn=null;
    const document=await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(checked.absolute));
    if(!this.investigationCurrent(model))return;
    this.assertCurrent(model);approved();p.sources(this.root,{cards:[source]});
    if(document.isDirty)throw new Error('Save changed source before opening this checked reference.');
    if(!fn){
      await this.vscode.window.showTextDocument(document,{preview:false,selection:new this.vscode.Range(source.line-1,0,source.endLine-1,0)});
      if(!this.investigationCurrent(model))return;this.assertCurrent(model);approved();
      await this.post({type:'triage:assessmentFocus',issueId:model.id,token:model.token,id:null,editor:true,source,entry,artifact,navigationId:message.navigationId});return;
    }
    let id=[...model.sourceById].find(([,u])=>model.catalog.key(u)===model.catalog.key(fn))?.[0];
    if(!id){if(model.expandedIds.size>=200)throw new Error('The source-card limit is reached; remove an exploration card.');
      id=`finding:${model.id}:assessment-${crypto.randomUUID()}`;model.expandedIds.add(id);model.sourceById.set(id,fn);this.native.addFunction(fn,model.catalog.code(fn),null,id);}
    await this.post({type:'triage:hint',issueId:model.id,token:model.token,id,hint:{...model.catalog.hints(fn),description:'Checked evidence inspection, not a tutorial execution step.'}});
    await this.post({type:'triage:assessmentFocus',issueId:model.id,token:model.token,id,source,entry,artifact,navigationId:message.navigationId});
    // No private causal role, event or model-authored relationship is emitted.
  }
  async openDocumentation(model, message) {
    if (!this.investigationCurrent(model)) throw new Error('Refresh before opening this documentation reference.');
    const item = model.investigationDraft?.documentation?.excerpts.find(item => item.id === message.documentationId);
    if (!item) throw new Error('This documentation is not part of the selected investigation.');
    const absolute = fs.realpathSync(path.join(this.root, item.source.file));
    if (!p.contained(fs.realpathSync(this.root), absolute) || !absolute.endsWith('.md')) throw new Error('Documentation must remain inside the project.');
    const text = fs.readFileSync(absolute, 'utf8');
    if (investigationEngine.hash(text) !== item.source.sourceHash || text.split(/\r?\n/).slice(item.source.line - 1, item.source.endLine).join('\n') !== item.text) throw new Error('Documentation changed. Refresh its note.');
    const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(absolute));
    if (!this.investigationCurrent(model) || document.isDirty) return;
    return this.vscode.window.showTextDocument(document, { preview: false, selection: new this.vscode.Range(item.source.line - 1, 0, item.source.endLine - 1, 0) });
  }
  async correctInvestigation(model, message) {
    if (!this.investigationCurrent(model)) throw new Error('Refresh this source context before changing the investigation.');
    if (message.revision !== model.investigationDraft?.revision) throw new Error('The draft advanced while this correction was being written. Check the latest claim and try again.');
    const report = this.callbacks.reportPreparation?.();
    if (report) {
      report.holdCorrection(model.id,model.investigationDraft,message.change||{});
      const draft=await report.settleCorrection(model.id);
      if(this.investigationCurrent(model))await this.publishInvestigation(model,draft);
      return draft;
    }
    model.investigationAbort?.abort();
    if (model.investigationJob) await model.investigationJob;
    if (!this.investigationCurrent(model)) return;
    const draft = structuredClone(model.investigationDraft);
    investigationEngine.correct(draft, message.change || {});
    if (this.callbacks.investigationPersistence !== false) investigationEngine.write(this.root, draft);
    await this.publishInvestigation(model, draft);
    // Saving a human premise is local work, not permission to buy another
    // interpretation. The ordinary explicit continuation remains available.
    return draft;
  }
  async runInvestigationTest(model, message) {
    if (!this.investigationCurrent(model)) throw new Error('Refresh the source context before running an existing regression.');
    if (model.experimentJob) throw new Error('An existing regression is already running for this investigation.');
    const unit = model.investigationDraft?.sources.find(item => item.id === message.sourceId);
    const args = experiment.command(unit);
    if (message.claimId && !model.investigationDraft.claims.some(item => item.id === message.claimId)) throw new Error('Unknown claim for this experiment.');
    const confirmation = await this.vscode.window.showWarningMessage(
      `Run this existing project regression locally? forge ${args.join(' ')}. Uses repository setup and mocks, disables FFI, selects FORK_CHAINS=none and LOCAL_SHAPES=A. Test code is not sandboxed. No new reproduction code is generated.`,
      { modal: true }, 'Run existing regression');
    if (confirmation !== 'Run existing regression' || !this.investigationCurrent(model)) return;
    this.assertCurrent(model); p.sources(this.root, { cards: [unit.source] });
    // Do not let an older model pass replace a newly observed test result.
    model.investigationAbort?.abort(); if (model.investigationJob) await model.investigationJob;
    if (!this.investigationCurrent(model)) return;
    const abort = new AbortController(); model.experimentAbort = abort;
    const draft = model.investigationDraft;
    if(this.callbacks.investigationPersistence!==false){
      // Preserve the exact pre-observation assessment and available response
      // before a later review replaces the last-response checkpoint.
      const checkpoint=require('./provider-result'),run=draft.runs.at(-1),ref=run?.retainedResponse;
      if(ref&&!ref.archive)run.retainedResponse=checkpoint.retainOriginal(this.root,model.id,ref);
      investigationEngine.archive(this.root,draft);
    }
    draft.phase = 'running-regression'; draft.revision++;
    if (this.callbacks.investigationPersistence !== false) investigationEngine.write(this.root, draft);
    await this.publishInvestigation(model, draft);
    model.experimentJob = experiment.run(unit, { root: this.root, snapshot: draft.snapshot, claimId: message.claimId, signal: abort.signal });
    try {
      const result = await model.experimentJob;
      if (!this.investigationCurrent(model)) return;
      if (!investigationEngine.sameSnapshot(draft.snapshot, investigationEngine.snapshot(model.catalog, model.request, model.issue))) throw new Error('Sources changed during the regression. Its result was not attached to the current investigation.');
      draft.experiments.push(result); draft.experiments = draft.experiments.slice(-10);
      const stillCurrent=require('./technical-assessment').current(draft);
      draft.phase = stillCurrent&&draft.publication?.ready?'ready':'experiment-recorded'; draft.revision++;
      if (this.callbacks.investigationPersistence !== false) investigationEngine.write(this.root, draft);
      await this.publishInvestigation(model, draft);
    } finally { model.experimentJob = null; }
    if(require('./technical-assessment').current(draft))return draft;
    return this.startInvestigation(model, true);
  }
  async expand(name, fromId, childId, contract, isSuper, argCount) {
    const id = this.activeId, activeToken = this.activeToken, model = this.models.get(id);
    if (!model || !this.vscode.workspace.isTrusted) return;
    if (!model.expandedIds.has(fromId)) return;
    if (model.expandedIds.size >= 200 && !model.expandedIds.has(childId)) {
      await this.post({ type: 'triage:limit', issueId: id, token: activeToken }); return this.notify('This finding reached 200 source cards. Remove unneeded branches or reopen a focused draft before expanding further.', true);
    }
    model.expandedIds.add(childId);
    this.assertCurrent(model);
    const parent = model.sourceById.get(fromId);
    const candidates = parent ? model.catalog.expansionCandidates(parent, name, isSuper, argCount) : model.catalog.candidates(name, contract, isSuper, argCount);
    let fn = candidates[0];
    if (candidates.length > 1) {
      const picked = await this.vscode.window.showQuickPick(candidates.map(value => ({
        label: `${value.contract}::${value.name}`, description: `${model.catalog.relative(value.file)}:${value.startLine}`, fn: value
      })), { placeHolder: 'Ambiguous call target — choose the implementation to inspect (not a validity verdict).' });
      if (!picked) {
        model.expandedIds.delete(childId);
        if (this.activeToken === activeToken) await this.post({ type: 'triage:cancelExpansion', id: childId, issueId: id, token: activeToken });
        return;
      }
      fn = picked?.fn;
    }
    if (this.activeId !== id || this.activeToken !== activeToken) return;
    this.assertCurrent(model);
    if (!fn) { this.native.addMissing(name, fromId, childId); return; }
    fn = model.catalog.resolveCard({ file: model.catalog.relative(fn.file), line: fn.startLine, function: fn.name });
    const doc = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(fn.file));
    if (this.activeId !== id || this.activeToken !== activeToken) return;
    this.assertCurrent(model);
    if (doc.isDirty) throw new Error('Save the source before expanding the flow.');
    this.native.addFunction(fn, model.catalog.code(fn), fromId, childId);
    model.sourceById.set(childId, fn);
    await this.post({ type: 'triage:hint', token: activeToken, id: childId, hint: model.catalog.hints(fn) });
  }
  async receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'triage:ready') { this.resolveReady(); return; }
    if (message.type === 'triage:reportControl') {
      if (this.activeToken && message.token !== this.activeToken) return;
      const report = this.callbacks.reportPreparation?.();
      if (report) { report.control(message.action); return this.reportProgress(); }
    }
    if (message.type === 'triage:persist') {
      const model = this.sessions.get(message.token);
      if (model?.id === message.issueId && this.models.get(model.id) === model && !model.protectCache) {
        store.writeBoard(this.root, message.issueId, message.state, model.fingerprint, model.reviewSourceFingerprint || model.fingerprint);
        this.reconcileMaterialized(model, message.state);
      }
      return;
    }
    if (message.type === 'triage:rendered') { this.renderWaiters.get(message.token)?.resolve(); this.renderWaiters.delete(message.token); return; }
    if (message.type === 'triage:select') {
      if (this.activeToken && message.token !== this.activeToken) return;
      this.models.get(this.activeId)?.investigationAbort?.abort(); this.models.get(this.activeId)?.experimentAbort?.abort();
      p.identifier(message.issueId, 'finding ID'); return this.callbacks.select(message.issueId);
    }
    const model = this.models.get(this.activeId);
    if (message.issueId && message.issueId !== this.activeId) return;
    if(message.type==='triage:engagementSettings'){
      if(message.token!==this.activeToken)throw new Error('This view is out of date.');
      return this.vscode.commands.executeCommand('workbench.action.openSettings','@id:flowboardTriage.engagementProfile');
    }
    if ((message.type?.startsWith('triage:investigation')||['triage:repairSavedAnalysis','triage:recheckLocalPreparation'].includes(message.type)) && model) {
      if (message.token !== this.activeToken) throw new Error('This investigation view is out of date.');
      if (message.type === 'triage:investigationFocus') return this.focusInvestigation(model, message);
      if (message.type === 'triage:investigationEvidence') return this.inspectAssessmentEvidence(model,message);
      if (message.type === 'triage:investigationDocumentation') return this.openDocumentation(model, message);
      if (message.type === 'triage:investigationRetry') return this.startInvestigation(model, true);
      if(message.type==='triage:repairSavedAnalysis'){
        if(!this.investigationCurrent(model))return;
        const report=this.callbacks.reportPreparation?.();
        if(!report)throw new Error('Open this imported finding through its report preparation to repair saved analysis.');
        report.continueFinding(model.id,{repairSavedAnalysis:true})?.catch(error=>this.vscode.window.showErrorMessage(error.message));
        return this.reportProgress();
      }
      if(message.type==='triage:recheckLocalPreparation'){
        if(!this.investigationCurrent(model))return;
        const report=this.callbacks.reportPreparation?.();
        if(!report)throw new Error('Local preparation requires the imported report coordinator.');
        report.continueFinding(model.id,{recheckLocalPreparation:true})?.catch(error=>this.vscode.window.showErrorMessage(error.message));
        return this.reportProgress();
      }
      if (message.type === 'triage:investigationEnable') return this.enableInvestigation(model);
      if (message.type === 'triage:investigationCorrect') return this.correctInvestigation(model, message);
      if (message.type === 'triage:investigationTest') return this.runInvestigationTest(model, message);
    }
    if (['triage:save', 'triage:reload', 'triage:prompt', 'triage:refresh', 'triage:openReference', 'triage:copyReport', 'triage:bindEvidence', 'triage:inspectEvidence', 'triage:copyBrief', 'triage:addContext','triage:inspectBlocker'].includes(message.type) && message.token !== this.activeToken) throw new Error('This view is out of date. Reload the finding before continuing.');
    if(message.type==='triage:inspectBlocker'&&model)return this.inspectBlocker(model,message);
    if (model?.reviewStale && ['triage:save', 'triage:bindEvidence', 'triage:copyBrief'].includes(message.type)) throw new Error('The saved review belongs to a different source, configuration or index version. Refresh and re-review it before binding evidence or saving an assessment.');
    if (message.type === 'triage:addContext' && model) return this.addContext(model, message);
    if (['triage:bindEvidence', 'triage:inspectEvidence'].includes(message.type)) {
      if (!this.vscode.workspace.isTrusted || !model) throw new Error('Open a current, mapped finding before reviewing source evidence.');
      const activeToken = this.activeToken;
      const item = structuredClone(message.evidence);
      const profile = { version: 1, checks: [], evidence: [item] }; review.validate(profile);
      if (item.needsReview) throw new Error('This evidence belongs to a previous source/map review. Inspect the current code and add a new evidence entry; the old reference was not silently revalidated.');
      this.assertCurrent(model);
      let source = p.evidenceSources(this.root, profile, true)[0];
      if (source) {
        const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(source.absolute));
        if (activeToken !== this.activeToken) return;
        if (document.isDirty) throw new Error('Save the source before binding or inspecting evidence.');
        this.assertCurrent(model); source = p.evidenceSources(this.root, profile)[0];
        if (message.type === 'triage:inspectEvidence') {
          await this.vscode.window.showTextDocument(document, { viewColumn: this.native.panel.viewColumn === 1 ? this.vscode.ViewColumn?.Beside || 2 : this.vscode.ViewColumn?.One || 1,
            selection: new this.vscode.Range(item.source.line - 1, 0, (item.source.endLine || item.source.line) - 1, item.source.endLine ? source.source.split(/\r?\n/)[item.source.endLine - 1].length : 0), preview: false });
          if (activeToken !== this.activeToken) return;
          this.assertCurrent(model); p.evidenceSources(this.root, profile);
        }
      }
      if (activeToken !== this.activeToken) return;
      p.checkRevision(model.request, p.gitState(this.root));
      if (message.type === 'triage:bindEvidence') return this.post({ type: 'triage:evidenceBound', issueId: this.activeId, token: activeToken, evidence: item });
      const start = source ? Math.max(1, item.source.line - 2) : null;
      const excerpt = source ? source.source.split(/\r?\n/).slice(start - 1, (item.source.endLine || item.source.line) + 3).map((line, i) => `${start + i}  ${line}`).join('\n').slice(0, 24000) : '';
      return this.post({ type: 'triage:evidenceInspected', issueId: this.activeId, token: activeToken, evidence: item, excerpt,
        navigationId: typeof message.navigationId === 'string' ? message.navigationId.slice(0,100) : null });
    }
    if (message.type === 'triage:copyBrief' && model) {
      this.assertCurrent(model);
      const current = { ...model.request.finding, ...structuredClone(message.patch || {}) };
      if (current.triage) { review.validate(current.triage); p.evidenceSources(this.root, current.triage); }
      const projection=this.exposed(model.investigationDraft)?.assessmentProjection;
      const summary=projection?`\n\nScoped AI assessment: ${projection.technical.label}\n${projection.technical.why}\nSuggested severity (${projection.rubric}): ${projection.severity.label}\n${(projection.severity.conditions||[]).join('; ')}\nEngagement: ${projection.engagement.reason}\nTutorial: ${projection.tutorial.state}\n`:'';
      await this.vscode.env.clipboard.writeText(review.brief(current, { checkoutRevision: model.request.sourceRevision || model.git.head })+summary);
      return this.notify('Review brief copied. It records reviewer evidence and gaps, not a verified verdict.', false, this.scope(message));
    }
    if (message.type === 'triage:refresh' && this.activeId) return this.callbacks.refresh(this.activeId, model?.draftFingerprint);
    if (message.type === 'triage:copyReport') {
      let issue; try { issue = store.readReport(this.root).issues.find(value => value.id === this.activeId); } catch { /* standalone draft */ }
      await this.vscode.env.clipboard.writeText(issue?.reportText || model?.request.finding.summary || '');
      return this.notify('Original report text copied, without formatting changes.', false, this.scope(message));
    }
    if (message.type === 'triage:openReference') {
      if (!this.vscode.workspace.isTrusted || typeof message.file !== 'string' || message.file.length > 1000 || !Number.isSafeInteger(message.line) || message.line < 1) throw new Error('Invalid source reference.');
      if (model) this.assertCurrent(model);
      const file = mapFile(this.root, message.file, model?.catalog.functions.map(fn => fn.file) || []);
      if (!file) throw new Error('This citation cannot be resolved unambiguously in the current checkout.');
      const [source] = p.sources(this.root, { cards: [{ file, line: message.line }] });
      const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(source.absolute));
      if (message.token !== this.activeToken) return;
      if (document.isDirty) throw new Error('Save this source file before navigating to a report line. Unsaved edits can shift its location.');
      if (model) this.assertCurrent(model);
      p.sources(this.root, { cards: [{ file, line: message.line, sourceHash: source.hash }] });
      if (model) p.checkRevision(model.request, p.gitState(this.root));
      return this.vscode.window.showTextDocument(document, { viewColumn: this.native.panel.viewColumn === 1 ? this.vscode.ViewColumn?.Beside || 2 : this.vscode.ViewColumn?.One || 1,
        selection: new this.vscode.Range(message.line - 1, 0, message.line - 1, 0), preview: false });
    }
    if (message.type === 'triage:prompt' && this.activeId) {
      if (message.cardId) {
        if (!this.vscode.workspace.isTrusted || !model) throw new Error('Open a mapped finding before asking about a function.');
        this.assertCurrent(model);
        const fn = model.sourceById.get(message.cardId);
        if (!fn) throw new Error('The selected function is not part of this source map.');
        const location = `${model.catalog.relative(fn.file)}:${fn.startLine}`;
        await this.vscode.env.clipboard.writeText(`Use $solidity-flowboard-triage for ${this.activeId}. Focus on ${fn.contract || ''}::${fn.name} at ${location}. Read the saved finding draft and original source. Explain this function's normal purpose, inputs, state reads/writes, permissions/modifiers and immediate source relationships. Distinguish established facts from unresolved dispatch or specification assumptions. Relate relevant observations to the reported claim and record evidence for and against it. Do not infer an execution or attack sequence from diagram order. Do not execute exploits. Preserve unrelated review work. Unsaved UI edits are not included in this prompt; read the current draft and respect concurrent-edit checks. Save any requested draft changes before submitting a fresh delivery.`);
        return this.notify('Function review prompt copied. Unsaved form edits are not included; paste into your assistant.', false, this.scope(message));
      }
      await this.vscode.env.clipboard.writeText(store.reviewPrompt(this.activeId)); return this.notify('Review prompt copied. Paste it into your coding assistant.', false, this.scope(message));
    }
    if (message.type === 'triage:save' && model) {
      if (!this.vscode.workspace.isTrusted || !message.patch || typeof message.patch !== 'object') return;
      // openTextDocument is asynchronous: a later save must not finish first
      // and then be overwritten by an older patch when its document resolves.
      const pending = structuredClone(message);
      model.saveQueue = (model.saveQueue || Promise.resolve()).catch(() => {}).then(() => this.saveReviewMessage(model, pending));
      return model.saveQueue;
    }
    if (message.type === 'triage:reload' && this.activeId) return this.callbacks.select(this.activeId);
  }
  async saveReviewMessage(model, message) {
    const scope = this.scope(message);
    if (!this.isActive(scope) || this.models.get(model.id) !== model) return;
    this.assertCurrent(model);
    const pendingTriage = message.patch.triage || model.request.finding.triage;
    for (const source of p.evidenceSources(this.root, pendingTriage)) {
      const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.file(source.absolute));
      if (!this.isActive(scope) || this.models.get(model.id) !== model) return;
      if (document.isDirty) throw new Error('Save the evidence source before saving this review.');
    }
    this.assertCurrent(model);
    const next = store.saveReview(this.root, model.id, message.patch, model.draftFingerprint);
    model.request = next; model.draftFingerprint = crypto.createHash('sha256').update(JSON.stringify(next)).digest('hex');
    await this.post({ type: 'triage:reviewSaved', ...scope,
      editVersion: message.editVersion, draftFingerprint: model.draftFingerprint, finding: next.finding, ...this.libraryObservation() });
    return this.notify('Review saved locally. This is your assessment, not an automatic tool verdict.', false, scope);
  }
  libraryObservation() {
    let index; try { index = store.readReportIndex(this.root); } catch { /* No imported report yet. */ }
    const reportContext = { project: crypto.createHash('sha256').update(fs.realpathSync(this.root)).digest('hex'), reportHash: index?.reportHash || null };
    const status = this.callbacks?.reportPreparation?.()?.status() || null;
    const matches = status && status.project === reportContext.project && status.reportHash === reportContext.reportHash;
    return { library: store.library(this.root, index), reportContext, reportPreparation: matches ? status : null };
  }
  async showLibrary(canPublish = () => true) {
    await this.ready;
    if (this.disposed || !canPublish()) return;
    this.native.panel.reveal(this.native.panel.viewColumn, true);
    return this.post({ type: 'triage:library', ...this.libraryObservation() });
  }
  async showUnmapped(id, issue, error, canPublish = () => true) {
    await this.ready; if (!canPublish()) return;
    this.activeId = id; this.activeToken = `unmapped-${crypto.randomUUID()}`;
    this.models.delete(id); // A read-only explanation cannot reuse an older writable/source model.
    this.native.triageToken = this.activeToken; this.native.triageFindingId = id; this.native.triageSourceStale = false;
    this.native.panel.reveal(this.native.panel.viewColumn, true);
    this.native.panel.title = `Flowboard Triage — ${issue?.displayId || id}`;
    return this.post({ type: 'triage:load', issueId: id, token: this.activeToken,
      finding: issue?.request?.finding || { title: `${issue?.displayId || id}: ${issue?.title || 'Unmapped finding'}`, status: 'unreviewed' },
      state: { cards: [], edges: [], notes: [], camera: { scale: 1, panX: 0, panY: 0 } }, connections: [], hints: {},
      ...this.libraryObservation(), reportText: issue?.reportText || '', unresolved: issue?.unresolved || [],
      preparation: { state: 'blocked', reason: error, attempted: ['Checked report definitions against this project. No missing implementation was replaced.'] },
      retrieval: issue?.retrieval || null,
      warnings: [error, 'This finding needs source/revision review before it can show a current flow. No missing functions were guessed.'],
      git: p.gitState(this.root), diagnostics: { mode: 'source' }, readOnly: true });
  }
}
module.exports = { TriageBoard };
