// Runs after the unmodified native flowboard.js in the same webview. Reuses its
// canvas, source cards, highlighting, connection drawing, minimap, undo/search.
(() => {
  'use strict';
  let active = null, token = null, finding = {}, library = [], connections = [], hints = {}, report = '', warnings = [], unresolved = [], git = {}, diagnostics = {};
  let dirtyReview = false, drawerTab = 'findings', filter = '', noticeTimer, readOnly = false;
  let reviewEdits = {}, editVersion = 0;
  let rawReport = false, retrieval = null, validation = {};
  let evidenceInput = {}, evidencePreview = null;
  let queueMode = 'all', flowFilter = '', evidenceFilter = 'all', selectedCard = null, spotlight = false;
  let navigation = [], navigationIndex = -1, editingEvidence = null, renderedTab = null;
  let inlineVisible = true;
  let hintVersion = 0;
  let activeClaim = null, claimFocus = false, reportSelection = '';
  const disclosureState = new Map();
  const scrollPositions = new Map();
  const pendingEvidence = new Map();
  const statusLabel = value => ({ confirmed: 'confirmed bug', invalid: 'invalid / false positive', 'design-decision': 'design decision', 'insufficient-evidence': 'needs more evidence', 'already-fixed': 'already fixed', unreviewed: 'unreviewed' }[value] || value);
  const bar = document.createElement('div'); bar.id = 'triage-bar';
  const drawer = document.createElement('aside'); drawer.className = 'triage-drawer'; drawer.setAttribute('aria-label', 'Finding triage');
  const legend = document.createElement('div'); legend.id = 'triage-legend'; legend.textContent = '— source call   ┄ candidate link   ··· state relationship';
  document.body.append(bar, drawer, legend);
  const resize = document.createElement('div'); resize.className = 'triage-resize'; resize.tabIndex = 0;
  resize.setAttribute('role', 'separator'); resize.setAttribute('aria-label', 'Resize review panel'); resize.setAttribute('aria-orientation', 'vertical');
  const setWidth = width => { const value = Math.max(320, Math.min(680, window.innerWidth - 80, width)); document.body.style.setProperty('--triage-custom-width', value + 'px'); resize.setAttribute('aria-valuenow', String(value)); redrawEdges(); };
  resize.setAttribute('aria-valuemin', '320'); resize.setAttribute('aria-valuemax', '680'); resize.setAttribute('aria-valuenow', '380');
  resize.onpointerdown = event => { resize.setPointerCapture(event.pointerId); resize.dataset.dragging = 'true'; };
  resize.onpointermove = event => { if (resize.dataset.dragging) setWidth(event.clientX); };
  resize.onpointerup = resize.onlostpointercapture = () => { delete resize.dataset.dragging; };
  resize.onkeydown = event => { if (['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) { event.preventDefault(); setWidth(event.key === 'Home' ? 380 : drawer.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? -24 : 24)); } };
  resize.ondblclick = () => { document.body.style.removeProperty('--triage-custom-width'); redrawEdges(); };
  document.body.append(resize);
  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function button(text, action, className) { const node = element('button', className, text); node.type = 'button'; node.onclick = action; return node; }
  function rememberDisclosure(node, key, initial = false) {
    node.open = disclosureState.get(key) ?? initial;
    node.addEventListener('toggle', () => {
      if (!node.isConnected) return;
      disclosureState.set(key, node.open); requestAnimationFrame(() => redrawEdges());
    });
  }
  const visibleHints = () => [...cards.keys()].map(id => hints[id]).filter(Boolean);
  const selectedClaim = () => profile().claims.find(claim => claim.id === activeClaim);
  function claimSources() {
    const claim = selectedClaim();
    return claim ? FlowboardClaims.argument(claim, profile().evidence).links.filter(link => FlowboardClaims.current(link.entry)) : [];
  }
  function claimCardIds() {
    const sources = claimSources();
    return new Set([...cards.values()].filter(card => hints[card.id] && sources.some(link => FlowboardInline.forSource([link.entry], hints[card.id]).length)).map(card => card.id));
  }
  function focusClaim(id) {
    activeClaim = id; claimFocus = true; spotlight = false;
    const sources = claimSources();
    const card = [...cards.values()].find(card => hints[card.id] && sources.some(link => FlowboardInline.forSource([link.entry], hints[card.id]).length));
    selectedCard = card?.id || null;
    show('claims'); if (card) focusSourceLine(card, FlowboardInline.forSource(sources.map(link => link.entry), hints[card.id])[0]?.source.line); redrawEdges();
  }
  function addClaim(text) {
    if (readOnly || profile().claims.length >= 20) return;
    if (text.length > 2000) { window.alert('Select one focused statement of at most 2000 characters.'); return; }
    const id = `claim-${crypto.randomUUID()}`;
    editProfile(value => value.claims.push({ id, text, state: 'unreviewed', evidence: [], questions: [] }));
    activeClaim = id; claimFocus = false; selectedCard = null; show('claims'); drawer.querySelector('[aria-label="Claim statement"]')?.focus();
  }
  function saveArgument(copy = false) {
    if (readOnly) return;
    if (hasEvidenceDraft()) { window.alert('Add or clear the pending evidence entry first.'); return; }
    const value = currentFinding(), patch = { triage: profile() };
    for (const key of Object.keys(reviewEdits)) patch[key] = value[key];
    const ready = FlowboardReview.readiness(value);
    if (ready.errors.length) { window.alert(ready.errors.join('\n')); return; }
    if (!copy && FlowboardReview.definitive.includes(value.status) && ready.gaps.length && !window.confirm('Save a provisional reviewer judgment with unresolved review areas still visible?')) return;
    send(copy ? 'triage:copyBrief' : 'triage:save', { patch, editVersion });
  }
  function renderClaims() {
    drawer.append(FlowboardClaimView.render({ profile: profile(), finding: currentFinding(), activeId: activeClaim, readOnly, pendingEvidence: hasEvidenceDraft(),
      edit: (change, refresh = false) => { editProfile(change, refresh); FlowboardClaimView.status(drawer, currentFinding()); },
      editFinding: (key, value) => { reviewEdits[key] = value; editProfile(next => { for (const claim of next.claims) claim.state = 'unreviewed'; }); FlowboardClaimView.status(drawer, currentFinding()); },
      selectClaim: focusClaim, addClaim, focusClaim, fullMap: () => { claimFocus = false; redrawEdges(); fit(); },
      removeClaim: id => { editProfile(value => { value.claims = value.claims.filter(claim => claim.id !== id); }); activeClaim = null; claimFocus = false; renderDrawer(); redrawEdges(); },
      readReport: () => show('report'), addEvidence: () => show('review'), inspect: inspectEvidence,
      placement: entry => FlowboardInline.placement(entry, visibleHints()), save: () => saveArgument(), copy: () => saveArgument(true), overall: () => show('review') }));
    FlowboardClaimView.status(drawer, currentFinding());
  }
  function claimLinks(parent) {
    const claims = profile().claims; if (!claims.length) return;
    const group = element('section', 'triage-report-claims'); group.append(element('h3', '', 'Claim breakdown · reviewer statements'));
    for (const claim of claims) { const item = button(claim.text || 'Untitled claim', () => focusClaim(claim.id), 'triage-claim-select'); item.append(element('small', '', claim.state)); group.append(item); }
    parent.append(group);
  }
  function send(type, payload = {}) { vscode.postMessage({ type, issueId: active, token, ...payload }); }
  function show(tab) {
    drawerTab = tab; drawer.dataset.tab = tab; drawer.classList.add('visible'); document.body.classList.add('triage-drawer-open'); renderDrawer(); redrawEdges();
  }
  function currentFinding() {
    const value = { ...finding, ...reviewEdits, triage: profile() };
    for (const key of ['preconditions', 'evidence', 'openQuestions']) if (typeof value[key] === 'string') value[key] = value[key].split('\n').map(text => text.trim()).filter(Boolean);
    return value;
  }
  function inspectCard(card, remember = true) {
    if (!card) return;
    selectedCard = card.id;
    if (remember && navigation[navigationIndex] !== card.id) { navigation = navigation.slice(0, navigationIndex + 1); navigation.push(card.id); navigation = navigation.slice(-60); navigationIndex = navigation.length - 1; }
    show('brief'); focusReadable(card); decorateCards(); drawer.querySelector('#triage-inspector')?.scrollIntoView({ block: 'start' });
  }
  function moveHistory(offset) {
    let index = navigationIndex + offset;
    while (index >= 0 && index < navigation.length && !cards.has(navigation[index])) index += offset;
    if (index >= 0 && index < navigation.length) { navigationIndex = index; inspectCard(cards.get(navigation[index]), false); }
  }
  function toggle(tab) {
    drawerTab = tab; const same = drawer.dataset.tab === tab && drawer.classList.contains('visible');
    drawer.classList.toggle('visible', !same); drawer.dataset.tab = tab;
    document.body.classList.toggle('triage-drawer-open', !same); renderDrawer(); redrawEdges();
  }
  function select(id) {
    if ((dirtyReview || hasEvidenceDraft()) && !window.confirm('Your review has unsaved edits. Switch finding and discard those edits?')) return;
    send('triage:select', { issueId: id });
  }
  function renderBar() {
    bar.replaceChildren();
    bar.append(button('Findings', () => toggle('findings')));
    const index = library.findIndex(x => x.id === active);
    const prev = button('←', () => select(library[index - 1].id)); prev.title = 'Previous finding'; prev.setAttribute('aria-label', prev.title); prev.disabled = index <= 0;
    const next = button('→', () => select(library[index + 1].id)); next.title = 'Next finding'; next.setAttribute('aria-label', next.title); next.disabled = index < 0 || index === library.length - 1;
    bar.append(prev, next, element('span', '', index >= 0 ? `${index + 1}/${library.length}` : ''), element('span', '', '·'));
    const title = element('span', '', finding.title || 'Flowboard Triage'); title.id = 'triage-title'; bar.append(title);
    const current = { ...finding, ...reviewEdits };
    const gaps = current.triage && FlowboardReview.definitive.includes(current.status) && FlowboardReview.readiness(current).gaps.length;
    const status = element('span', '', statusLabel(current.status || 'Select a finding') + (gaps ? ' · review gaps' : '') + (dirtyReview ? ' · unsaved review' : '')); status.id = 'triage-status'; bar.append(status);
    const attention = FlowboardReview.nextAttention(library, active);
    const nextReview = button('Next review', () => attention && select(attention.id)); nextReview.disabled = !attention; nextReview.title = attention ? `Next needing attention: ${attention.title}` : 'No other finding needs attention in this saved index';
    bar.append(nextReview, button('Overview', () => toggle('brief')), button('Claims', () => show('claims')), button('Ask AI', () => send('triage:prompt')), button('Fit', fit));
    const inline = button(inlineVisible ? 'Notes on' : 'Notes off', () => { inlineVisible = !inlineVisible; renderBar(); redrawEdges(); }); inline.title = 'Show source-bound inline review notes'; inline.setAttribute('aria-pressed', String(inlineVisible)); bar.append(inline);
    const arrange = button('Arrange', arrangeCards); arrange.title = 'Space source cards using their displayed size; native Undo restores positions. Notes stay in place.'; bar.append(arrange);
    const help = button('?', () => show('help')); help.setAttribute('aria-label', 'Keyboard shortcuts'); bar.append(help);
  }
  function section(title) { const node = element('section', 'triage-section'); node.append(element('h3', '', title)); return node; }
  function resetViewportScroll() { flowboard.scrollLeft = 0; flowboard.scrollTop = 0; }
  function focusReadable(card) { resetViewportScroll(); if (scale < 0.8) scale = 0.9; focusOnModel(card); }
  function focusSourceLine(card, line) {
    focusReadable(card);
    const row = [...card.codeEl.querySelectorAll('[data-source-line]')].find(node => Number(node.dataset.sourceLine) === line);
    if (!row) return;
    const viewport = flowboard.getBoundingClientRect(), target = row.getBoundingClientRect();
    panY += viewport.top + Math.min(140, viewport.height * .2) - target.top;
    applyTransform(); schedulePersist();
  }
  const mappingLabel = value => ({ citation: 'report line', symbol: 'named symbol', description: 'description match', 'source-neighbor': 'source neighbor', reviewer: 'reviewer mapping' }[value] || 'source anchor');
  const stanceLabel = value => ({ supports: 'Supports claim', contradicts: 'Contradicts claim', context: 'Context only' }[value] || value);
  const profile = () => FlowboardReview.create(reviewEdits.triage || finding.triage);
  const hasEvidenceDraft = () => pendingEvidence.size > 0 || !!(evidenceInput.note?.trim() || evidenceInput.reference?.trim());
  function markDirty() {
    dirtyReview = true; editVersion++;
    document.getElementById('triage-status').textContent = statusLabel(reviewEdits.status || finding.status || 'unreviewed') + ' · unsaved review';
  }
  function editProfile(action, redraw = false) {
    const previous = profile(), next = structuredClone(previous); action(next); FlowboardClaims.reconcile(previous, next); reviewEdits.triage = next; markDirty();
    if (evidencePreview) { const current = next.evidence.find(item => item.id === evidencePreview.evidence.id); evidencePreview = current ? { ...evidencePreview, evidence: current } : null; }
    redrawEdges(); if (redraw) renderDrawer();
  }
  function addFromCard(card, sourceLine) {
    const info = hints[card.id]; if (!info?.file || readOnly) return;
    const line = sourceLine || info.line;
    if (pendingEvidence.size) { window.alert('Wait for the current source binding to finish.'); return; }
    if (hasEvidenceDraft() && (evidenceInput.cardId !== card.id || evidenceInput.line !== line)) {
      if (!window.confirm('Discard the unadded evidence entry and explain a different source line?')) return;
      evidenceInput = {};
    }
    evidenceInput = { ...evidenceInput, cardId: card.id, line, stance: evidenceInput.stance || 'context' };
    drawerTab = 'review'; drawer.dataset.tab = 'review'; drawer.classList.add('visible'); document.body.classList.add('triage-drawer-open');
    renderDrawer(); drawer.querySelector('#triage-evidence-note')?.focus();
  }
  function inspectEvidence(item) { send('triage:inspectEvidence', { evidence: item }); }
  function renderDrawer() {
    if (renderedTab) scrollPositions.set(renderedTab, drawer.scrollTop);
    renderDrawerContent(); renderedTab = drawerTab;
    drawer.scrollTop = scrollPositions.get(drawerTab) || 0;
  }
  function renderDrawerContent() {
    document.body.classList.toggle('triage-report-reading', drawerTab === 'report');
    document.body.classList.toggle('triage-reviewing', ['review', 'claims'].includes(drawerTab));
    requestAnimationFrame(() => redrawEdges());
    drawer.replaceChildren();
    const tabs = element('div', 'triage-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Finding views');
    for (const [tab, name] of [['findings', 'Findings'], ['brief', 'Overview'], ['flow', 'Flow'], ['review', 'Review'], ['report', 'Report'], ['claims', 'Claims']]) {
      const item = button(name, () => show(tab), tab === drawerTab ? 'selected' : '');
      item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(tab === drawerTab)); tabs.append(item);
      item.onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const nodes = [...tabs.children], index = nodes.indexOf(item), next = nodes[(index + (event.key === 'ArrowLeft' ? nodes.length - 1 : 1)) % nodes.length]; const name = next.textContent; next.click(); [...drawer.querySelectorAll('[role="tab"]')].find(node => node.textContent === name)?.focus(); } };
    }
    drawer.append(tabs);
    if (drawerTab === 'help') {
      const help = section('Keyboard shortcuts');
      for (const line of ['Alt+1…6: Findings, Overview, Flow, Review, Report, Claims', 'Alt+Left / Right: source inspection back / forward', 'Ctrl/Cmd+S in Review or Claims: save review', 'Escape: close panel; unsaved edits remain', 'Resize divider: Left / Right arrows; Home resets width']) help.append(element('p', '', line));
      help.append(element('p', 'triage-muted', 'Shortcuts do not navigate away while you type in an input. Native canvas shortcuts remain available.')); drawer.append(help); return;
    }
    if (drawerTab === 'findings') {
      const input = element('input'); input.placeholder = 'Search title, file, severity or status'; input.value = filter; input.setAttribute('aria-label', 'Search findings');
      input.oninput = () => { filter = input.value; renderDrawer(); const box = drawer.querySelector('input'); box.focus(); box.setSelectionRange(filter.length, filter.length); };
      drawer.append(input);
      const modes = element('select'); modes.setAttribute('aria-label', 'Finding queue filter');
      for (const [id, label] of [['all', 'All findings'], ['attention', 'Needs attention'], ['unreviewed', 'Unreviewed'], ['unmapped', 'Missing source map'], ['confirmed', 'Confirmed'], ['invalid', 'False positive'], ['design-decision', 'Design decision'], ['already-fixed', 'Already fixed']]) {
        const option = element('option', '', `${label} (${FlowboardReview.queue(library, '', id).length})`); option.value = id; modes.append(option);
      }
      modes.value = queueMode; modes.onchange = () => { queueMode = modes.value; renderDrawer(); }; drawer.append(modes);
      const visible = FlowboardReview.queue(library, filter, queueMode);
      drawer.append(element('p', 'triage-muted', `${visible.length} of ${library.length} findings · queue reflects saved reviews`));
      const list = element('div', 'triage-list');
      for (const issue of visible) {
        const item = button(`${issue.displayId || issue.id} · ${issue.title}`, () => select(issue.id), issue.id === active ? 'current' : '');
        item.append(element('small', '', `${issue.severity} · ${statusLabel(issue.status)}${issue.unresolved ? ` · ${issue.unresolved} unresolved` : ''}${issue.reviewGaps ? ` · ${issue.reviewGaps} review gaps` : ''}${issue.staleEvidence ? ' · old evidence' : ''}`)); list.append(item);
      }
      if (library.length && !visible.length) list.append(element('p', 'triage-muted', 'No matching findings. Clear the search or change the queue filter.'));
      if (!library.length) list.append(element('p', 'triage-muted', 'Import a .txt/.md report using Flowboard Triage: Import Report. Individual finding requests also work.'));
      drawer.append(list); return;
    }
    const context = element('details', 'triage-source-details'); context.open = readOnly;
    context.append(element('summary', '', `Source context${warnings.length ? ` · ${warnings.length} warnings` : ''}`));
    context.append(element('p', 'triage-muted', `Checkout ${(git.head || 'not versioned').slice(0, 12)}${git.dirty ? ' + modified files' : ''} · ${diagnostics.mode || 'source'} navigation`));
    context.append(element('p', 'triage-muted', 'Report revision: ' + (finding.reportRevision || 'unknown — confirm that the cited functions match.')));
    if (warnings.length) {
      const details = element('details', 'triage-context-warnings'); details.open = readOnly;
      details.append(element('summary', '', `${warnings.length} source / mapping warning${warnings.length === 1 ? '' : 's'}`));
      for (const warning of warnings) details.append(element('p', 'triage-warning', warning)); context.append(details);
    }
    if (diagnostics.success === false) context.append(element('p', 'triage-warning', 'Slither failed. This view uses source navigation only.'));
    drawer.append(context);
    if (active) {
      const actions = element('div', 'triage-report-actions');
      actions.append(button('Refresh source map', () => {
        if (!(dirtyReview || hasEvidenceDraft()) || window.confirm('Refresh the source map and discard unsaved form edits? Saved review work will be backed up.')) send('triage:refresh');
      })); context.append(actions);
    }
    if (drawerTab === 'brief') { renderBrief(); return; }
    if (drawerTab === 'claims') { renderClaims(); return; }
    if (drawerTab === 'flow') {
      const overview = section('Source map overview');
      overview.append(element('p', 'triage-muted', finding.summary || 'Inspect the report and source before assessing this finding.'),
        element('p', 'triage-warning', 'These are source relationships, not a proven execution sequence. Click a function to focus its native card.'));
      if (validation.cards) overview.append(element('p', 'triage-validation', `${validation.cards} source cards checked · ${validation.sourceCalls || 0} unique direct call relationships found. Report relevance and runtime reachability still require review.`));
      const search = element('input'); search.placeholder = 'Filter functions, files or explanations'; search.setAttribute('aria-label', 'Search mapped functions'); search.value = flowFilter;
      search.oninput = () => { flowFilter = search.value; renderDrawer(); const input = drawer.querySelector('[aria-label="Search mapped functions"]'); input.focus(); input.setSelectionRange(flowFilter.length, flowFilter.length); }; overview.append(search);
      let matched = 0;
      for (const card of cards.values()) {
        const info = hints[card.id];
        if (!`${card.name} ${card.data.contract || ''} ${info?.file || ''} ${info?.description || ''}`.toLowerCase().includes(flowFilter.toLowerCase())) continue;
        matched++;
        const item = button(`${card.data.contract ? card.data.contract + '::' : ''}${card.name}`, () => inspectCard(card), 'triage-flow-item');
        item.append(element('small', '', info?.range || `${card.data.file || 'Unknown source'}:${card.data.startLine || '?'}`));
        if (info?.description) item.append(element('p', 'triage-muted', info.description));
        if (info?.mapping) item.append(element('small', 'triage-mapping', `${mappingLabel(info.mapping.method)} · mapping confidence ${info.mapping.confidence} (not bug confidence)`));
        overview.append(item);
        if (info?.guards?.length) {
          const guards = element('details', 'triage-guards'); guards.append(element('summary', '', 'Source guards / branches'));
          guards.append(element('p', 'triage-muted', 'Conditions found in the function, not a complete reachability proof.'));
          for (const value of info.guards) guards.append(element('code', '', value)); overview.append(guards);
        }
      }
      if (cards.size && !matched) overview.append(element('p', 'triage-muted', 'No mapped function matches this filter. The canvas is unchanged.'));
      if (!cards.size) overview.append(element('p', 'triage-muted', 'No source cards are mapped yet. Check the Report tab and unresolved citations.'));
      drawer.append(overview);
      const links = section('Connection rationale');
      for (const edge of edges) {
        const from = cards.get(edge.from), to = cards.get(edge.to);
        if (!from || !to) continue;
        const meta = connections.find(x => x.from === edge.from && x.to === edge.to);
        const item = element('div', 'triage-flow-link');
        item.append(button(`${from.name} → ${to.name}`, () => inspectCard(to)), element('small', '', meta?.kind || 'hypothesis'),
          element('p', 'triage-muted', meta?.reason || 'Manually drawn or expanded candidate. Confirm dispatch and runtime context in source.'));
        links.append(item);
      }
      if (!links.querySelector('.triage-flow-link')) links.append(element('p', 'triage-muted', 'No connections established. The absence of an arrow does not prove that the claim is invalid.'));
      drawer.append(links);
      if (retrieval) {
        const candidates = section('Description-based source search');
        candidates.append(element('p', 'triage-muted', `${retrieval.searchedFunctions} function definitions searched. These are relevance suggestions, not automatically established finding targets.`));
        for (const candidate of retrieval.candidates || []) {
          const item = button(`${candidate.contract || ''}::${candidate.function}`, () => {
            const card = [...cards.values()].find(value => value.name === candidate.function && hints[value.id]?.range?.startsWith(`${candidate.file}:${candidate.line}-`));
            if (card) inspectCard(card); else send('triage:openReference', { file: candidate.file, line: candidate.line });
          }, 'triage-flow-item');
          item.append(element('small', '', `${candidate.file}:${candidate.line} · search score ${candidate.score}`), element('p', 'triage-muted', candidate.reason)); candidates.append(item);
        }
        if (!retrieval.candidates?.length) candidates.append(element('p', 'triage-warning', 'No sufficiently specific source candidate. Add a contract/function identifier or review with your assistant; an execution path was not guessed.'));
        drawer.append(candidates);
      }
      return;
    }
    if (drawerTab === 'report') {
      const original = section('Reported claim');
      original.append(element('p', 'triage-report-caption', 'Original report text — claims to review, not verified code facts.'));
      original.append(element('h2', 'triage-report-title', finding.title || 'Selected finding'));
      const actions = element('div', 'triage-report-actions');
      actions.append(button(rawReport ? 'Reading view' : 'Raw text', () => { rawReport = !rawReport; renderDrawer(); }), button('Copy original', () => send('triage:copyReport')));
      const fromSelection = button('Review selected text', () => { if (!reportSelection) { window.alert('Select one report statement first.'); return; } addClaim(reportSelection); });
      fromSelection.disabled = readOnly; fromSelection.onmousedown = event => event.preventDefault(); actions.append(fromSelection);
      original.append(actions);
      claimLinks(original);
      const value = report || finding.summary || 'No original report attached.';
      const body = rawReport ? element('pre', 'triage-report-raw', value) : FlowboardReport.render(document, value, reference => send('triage:openReference', reference));
      original.append(body); reportSelection = '';
      const captureSelection = () => { const selection = window.getSelection(); if (selection && !selection.isCollapsed && body.contains(selection.anchorNode) && body.contains(selection.focusNode)) reportSelection = selection.toString().trim(); else reportSelection = ''; };
      original.addEventListener('mouseup', captureSelection); original.addEventListener('keyup', captureSelection);
      drawer.append(original);
      if (unresolved.length) { const missing = section('Unresolved citations'); for (const ref of unresolved) missing.append(element('p', 'triage-warning', `${ref.file}:${ref.line} — ${ref.reason}`)); drawer.append(missing); }
      return;
    }
    const form = element('form'); form.onsubmit = event => event.preventDefault();
    const fields = {};
    function control(name, label, choices, array = false, parent = form) {
      const node = choices ? element('select') : element('textarea');
      if (choices) for (const value of choices) { const option = element('option', '', name === 'status' ? statusLabel(value) : value); option.value = value; node.append(option); }
      node.value = Object.hasOwn(reviewEdits, name) ? reviewEdits[name] : Array.isArray(finding[name]) ? finding[name].join('\n') : finding[name] || (choices ? choices[0] : '');
      node.id = `triage-field-${name}`; const labelNode = element('label', '', label); labelNode.htmlFor = node.id;
      node.oninput = () => {
        reviewEdits[name] = node.value;
        if (name === 'expectedBehavior') editProfile(next => { for (const claim of next.claims) claim.state = 'unreviewed'; }); else markDirty();
        updateReadiness(); redrawEdges();
      }; fields[name] = { node, array }; parent.append(labelNode, node);
    }
    function profileControl(name, label, parent) {
      const node = element('textarea'); node.id = `triage-field-${name}`; node.value = profile()[name];
      const caption = element('label', '', label); caption.htmlFor = node.id;
      node.oninput = () => { editProfile(value => { value[name] = node.value; }); updateReadiness(); };
      parent.append(caption, node);
    }
    const claim = section('1 · Understand the claim');
    claim.append(element('p', 'triage-claim', finding.summary || finding.title),
      element('p', 'triage-muted', 'First identify the rule that should hold. A call graph alone cannot distinguish a bug from intended behavior.'),
      button('Read original report', () => { drawerTab = 'report'; renderDrawer(); })); form.append(claim);
    const behavior = section('2 · Compare intended and actual behavior');
    behavior.append(element('p', 'triage-muted', 'Imported descriptions are unreviewed starting points. Replace them with what you checked in the specification and source.'));
    const comparison = element('div', 'triage-comparison'), intended = element('div'), actual = element('div');
    control('expectedBehavior', 'Intended behavior / invariant (from specification)', null, false, intended);
    control('actualBehavior', 'Observed behavior (from source)', null, false, actual); comparison.append(intended, actual); behavior.append(comparison);
    profileControl('actor', 'Who can invoke this code? Which permissions apply?', behavior);
    control('preconditions', 'Required state / conditions (one per line)', null, true, behavior); form.append(behavior);
    const proof = section('3 · Evidence for and against');
    proof.append(element('p', 'triage-muted', 'Attach facts to source lines or specification/test references. Stances are reviewer judgments, not automatically proven facts.'));
    const ledger = element('div', 'triage-evidence-ledger');
    const evidenceModes = element('select'); evidenceModes.setAttribute('aria-label', 'Filter evidence');
    for (const [id, label] of [['all', 'All evidence'], ['supports', 'Supports claim'], ['contradicts', 'Contradicts claim'], ['context', 'Context only'], ['stale', 'Needs re-review']]) {
      const option = element('option', '', label); option.value = id; evidenceModes.append(option);
    }
    evidenceModes.value = evidenceFilter; evidenceModes.onchange = () => { evidenceFilter = evidenceModes.value; renderDrawer(); }; proof.append(evidenceModes);
    for (const item of profile().evidence) {
      if (evidenceFilter !== 'all' && !(evidenceFilter === 'stale' ? item.needsReview || item.source && !item.source.sourceHash : item.stance === evidenceFilter)) continue;
      const row = element('div', `triage-evidence-entry ${item.stance}`);
      const caption = element('div', 'triage-evidence-caption'); caption.append(element('strong', '', stanceLabel(item.stance)),
        button(editingEvidence === item.id ? 'Done' : 'Edit note', () => { editingEvidence = editingEvidence === item.id ? null : item.id; renderDrawer(); }),
        button('Remove', () => {
          if (!window.confirm('Remove this evidence and its claim links? Affected claim assessments become unreviewed. The saved draft changes only when you save.')) return;
          if (evidencePreview?.evidence.id === item.id) { evidencePreview = null; for (const card of cards.values()) card.el.classList.remove('triage-evidence-focus'); }
          editProfile(value => FlowboardClaims.detach(value, item.id), true);
        }));
      row.append(caption, button(item.source ? `${item.source.file}:${item.source.line}` : item.reference, () => inspectEvidence(item), 'triage-evidence-reference'),
        element('p', 'triage-evidence-note', item.note)); ledger.append(row);
      if (item.needsReview) row.append(element('p', 'triage-warning', 'Needs re-review after source/map changes. Not counted as current evidence.'));
      const placement = FlowboardInline.placement(item, visibleHints());
      if (placement) row.append(element('p', 'triage-placement-warning', placement));
      if (editingEvidence === item.id) {
        const stance = element('select'); stance.setAttribute('aria-label', 'Edit evidence stance');
        for (const name of ['supports', 'contradicts', 'context']) { const option = element('option', '', stanceLabel(name)); option.value = name; stance.append(option); }
        stance.value = item.stance;
        const note = element('textarea'); note.value = item.note; note.setAttribute('aria-label', 'Edit evidence explanation'); note.maxLength = 4000;
        const category = categorySelect(item.category || FlowboardInline.category(item), 'Edit inline note category');
        const update = () => { editProfile(value => { const entry = value.evidence.find(entry => entry.id === item.id); entry.note = note.value; entry.stance = stance.value; entry.category = category.value; }); updateReadiness(); };
        stance.onchange = update; category.onchange = update; note.oninput = update; row.append(stance, category, note, element('p', 'triage-muted', 'Source binding and re-review state are preserved. Add a new entry after inspecting different source.'));
      }
    }
    if (!ledger.children.length) ledger.append(element('p', 'triage-muted', profile().evidence.length ? 'No evidence matches this filter.' : 'No structured evidence yet. Use + Evidence on a source card, or select a function below.'));
    proof.append(ledger);
    if (evidencePreview) {
      const preview = element('div', 'triage-evidence-preview'); preview.append(element('strong', '', stanceLabel(evidencePreview.evidence.stance)),
        element('p', '', evidencePreview.evidence.note));
      if (evidencePreview.excerpt) preview.append(element('p', 'triage-muted', 'Current saved source excerpt; exact line opened beside the canvas. Inspect the full function/modifiers in the editor.'), element('pre', '', evidencePreview.excerpt));
      else preview.append(element('p', '', evidencePreview.evidence.reference)); proof.append(preview);
    }
    const entry = element('details', 'triage-evidence-editor'); entry.open = !!evidenceInput.cardId || hasEvidenceDraft() || !profile().evidence.length; entry.append(element('summary', '', 'Add focused evidence'));
    const stance = element('select'); stance.id = 'triage-evidence-stance'; stance.setAttribute('aria-label', 'Evidence stance');
    for (const value of ['supports', 'contradicts', 'context']) { const option = element('option', '', stanceLabel(value)); option.value = value; stance.append(option); }
    stance.value = evidenceInput.stance || 'context'; stance.onchange = () => { evidenceInput.stance = stance.value; }; entry.append(stance);
    const category = categorySelect(evidenceInput.category || 'behavior', 'Inline note category'); category.onchange = () => { evidenceInput.category = category.value; }; entry.append(category);
    const source = element('select'); source.id = 'triage-evidence-source'; source.setAttribute('aria-label', 'Evidence source function');
    const other = element('option', '', 'Specification / test / other reference'); other.value = ''; source.append(other);
    for (const card of cards.values()) if (hints[card.id]?.file) {
      const option = element('option', '', `${card.data.contract || ''}::${card.name} · ${hints[card.id].range}`); option.value = card.id; source.append(option);
    }
    source.value = evidenceInput.cardId || '';
    const line = element('input'); line.type = 'number'; line.min = 1; line.id = 'triage-evidence-line'; line.setAttribute('aria-label', 'Evidence source line'); line.value = evidenceInput.line || '';
    line.placeholder = 'Source line (1-based)';
    line.oninput = () => { evidenceInput.line = Number(line.value); };
    const reference = element('input'); reference.id = 'triage-evidence-reference'; reference.placeholder = 'Specification section, test file, or design reference'; reference.setAttribute('aria-label', 'Evidence reference'); reference.value = evidenceInput.reference || '';
    reference.oninput = () => { evidenceInput.reference = reference.value; markDirty(); };
    const showInputs = () => { line.hidden = !source.value; reference.hidden = !!source.value; };
    source.onchange = () => { evidenceInput.cardId = source.value; if (source.value) { evidenceInput.line = hints[source.value].line; line.value = evidenceInput.line; } showInputs(); };
    showInputs(); entry.append(source, line, reference);
    const note = element('textarea'); note.id = 'triage-evidence-note'; note.placeholder = 'What does this establish, and why does it support or refute the claim?'; note.setAttribute('aria-label', 'Evidence explanation'); note.value = evidenceInput.note || '';
    note.oninput = () => { evidenceInput.note = note.value; markDirty(); }; entry.append(note);
    const add = button(pendingEvidence.size ? 'Checking source…' : 'Add evidence', () => {
      const item = { id: `e-${crypto.randomUUID()}`, stance: stance.value, category: category.value, note: note.value.trim(),
        ...(source.value ? { source: { file: hints[source.value].file, line: Number(line.value) } } : { reference: reference.value.trim() }) };
      try { FlowboardReview.validate({ version: 1, checks: [], evidence: [item] }); }
      catch (error) { window.alert(error.message); return; }
      if (profile().evidence.length >= 30) { window.alert('Keep at most 30 focused evidence entries.'); return; }
      pendingEvidence.set(item.id, JSON.stringify(evidenceInput)); send('triage:bindEvidence', { evidence: item }); renderDrawer();
    }); add.disabled = readOnly || pendingEvidence.size > 0;
    const clear = button('Clear unadded entry', () => { if (!hasEvidenceDraft() || window.confirm('Discard this unadded evidence entry?')) { evidenceInput = {}; renderDrawer(); } }); clear.disabled = pendingEvidence.size > 0;
    entry.append(add, clear); proof.append(entry);
    if (finding.evidence?.length || Object.hasOwn(reviewEdits, 'evidence')) {
      const legacy = element('details'); legacy.append(element('summary', '', 'Existing / additional evidence references'));
      control('evidence', 'Existing evidence (one per line; preserved for compatibility)', null, true, legacy); proof.append(legacy);
    }
    form.append(proof);
    const checks = section('4 · Review questions');
    checks.append(element('p', 'triage-muted', 'Record the reasoning where it helps. Checkmarks are your review notes, never automatic validation.'));
    for (const checkpoint of FlowboardReview.checkpoints) {
      const item = profile().checks.find(check => check.id === checkpoint.id), row = element('details', 'triage-checkpoint');
      row.append(element('summary', '', `${checkpoint.title} · ${item.state.replace('-', ' ')}`), element('p', 'triage-muted', checkpoint.question));
      const select = element('select'); select.setAttribute('aria-label', checkpoint.title + ' review state');
      for (const state of ['unchecked', 'checked', 'blocked', 'not-applicable']) { const option = element('option', '', state.replace('-', ' ')); option.value = state; select.append(option); }
      select.value = item.state;
      select.onchange = () => { editProfile(value => { value.checks.find(check => check.id === checkpoint.id).state = select.value; }); row.querySelector('summary').textContent = `${checkpoint.title} · ${select.value.replace('-', ' ')}`; updateReadiness(); };
      const reason = element('textarea'); reason.setAttribute('aria-label', checkpoint.title + ' reasoning'); reason.placeholder = 'Source/specification reasoning; explain blocked or not applicable too.'; reason.value = item.note;
      reason.oninput = () => { editProfile(value => { value.checks.find(check => check.id === checkpoint.id).note = reason.value; }); updateReadiness(); };
      row.append(select, reason); checks.append(row);
    }
    form.append(checks);
    const decision = section('5 · Assessment and remaining uncertainty');
    control('status', 'Your assessment', ['unreviewed', 'confirmed', 'invalid', 'design-decision', 'insufficient-evidence', 'already-fixed'], false, decision);
    control('confidence', 'Reviewer confidence (not calculated by the tool)', ['low', 'medium', 'high'], false, decision);
    profileControl('decisionReason', 'Why does the evidence justify this assessment?', decision);
    control('openQuestions', 'What is still uncertain? (one per line)', null, true, decision);
    control('impact', 'Consequence if the reported deviation holds', null, false, decision);
    control('remediation', 'Possible fix / design clarification', null, false, decision);
    const readiness = element('div', 'triage-readiness'); readiness.id = 'triage-readiness'; decision.append(readiness); form.append(decision);
    function collectPatch() {
      const patch = { triage: profile() };
      for (const [name, value] of Object.entries(fields)) patch[name] = value.array ? value.node.value.split('\n').map(x => x.trim()).filter(Boolean) : value.node.value.trim();
      return patch;
    }
    function updateReadiness() {
      const ready = FlowboardReview.readiness({ ...finding, ...collectPatch() }); readiness.replaceChildren();
      readiness.append(element('p', '', `${ready.counts.supports} supporting · ${ready.counts.contradicts} contradicting · ${ready.counts.context} context entries`));
      readiness.append(element('p', 'triage-muted', ready.gaps.length ? `Still unchecked / blocked: ${ready.gaps.join(', ')}.` : 'All review areas marked checked/not applicable by you — not a proof of correctness.'));
      if (ready.outdated) readiness.append(element('p', 'triage-warning', `${ready.outdated} stale/unbound evidence entries require re-review; not counted as current evidence.`));
      for (const error of ready.errors) readiness.append(element('p', 'triage-warning', error));
      for (const note of FlowboardReview.quality({ ...finding, ...collectPatch() })) readiness.append(element('p', 'triage-warning', note));
    }
    const saveRow = element('div', 'triage-save-row');
    const save = button('Save review', () => {
      if (hasEvidenceDraft()) { window.alert('Add the pending evidence entry, or clear its unadded note/reference, before saving. Your text is still here.'); return; }
      const patch = collectPatch(), ready = FlowboardReview.readiness({ ...finding, ...patch });
      if (ready.errors.length) { window.alert(ready.errors.join('\n')); return; }
      if (FlowboardReview.definitive.includes(patch.status) && ready.gaps.length && !window.confirm('Some review areas remain unchecked or blocked. Save this as your provisional reviewer judgment with those gaps still visible?')) return;
      send('triage:save', { patch, editVersion });
    }, 'primary'); save.disabled = readOnly || pendingEvidence.size > 0;
    const copy = button('Copy review brief', () => send('triage:copyBrief', { patch: collectPatch() })); copy.disabled = readOnly || pendingEvidence.size > 0;
    saveRow.append(save, copy, button('Reload draft', () => { if (!(dirtyReview || hasEvidenceDraft()) || window.confirm('Discard unsaved review edits and reload the draft?')) { dirtyReview = false; send('triage:reload'); } }));
    form.append(element('p', 'triage-muted', 'This records your judgment, not a tool-verified verdict. Definitive assessments require evidence.'), saveRow); drawer.append(form);
    updateReadiness();
  }
  function renderBrief() {
    const value = currentFinding(), ready = FlowboardReview.readiness(value);
    const hero = section('Finding overview'); hero.classList.add('triage-overview');
    hero.append(element('p', 'triage-eyebrow', `${statusLabel(value.status)}${dirtyReview ? ' · unsaved edits' : ''}`),
      element('h2', 'triage-report-title', value.title || 'Select a finding'), element('p', 'triage-brief-claim', value.summary || 'Read the original report to establish its claim.'));
    const actions = element('div', 'triage-report-actions'); actions.append(button('Read report', () => show('report')), button('Review claims', () => show('claims')), button('Edit review', () => show('review'))); hero.append(actions); drawer.append(hero);
    claimLinks(drawer);
    const behavior = section('What should happen / what the source does');
    for (const [label, text] of [['Intended rule', value.expectedBehavior], ['Observed behavior', value.actualBehavior]]) {
      const block = element('div', 'triage-brief-block'); block.append(element('strong', '', label), element('p', '', text || 'Not established yet.')); behavior.append(block);
    }
    drawer.append(behavior);
    const question = FlowboardReview.nextQuestion(value);
    if (question) {
      const next = section('A useful next question'); next.classList.add('triage-next-question');
      next.append(element('strong', '', question.title), element('p', '', question.question));
      if (question.note) next.append(element('p', 'triage-muted', question.note));
      next.append(button('Open review question', () => { show('review'); const row = [...drawer.querySelectorAll('.triage-checkpoint')].find(node => node.textContent.includes(question.title)); if (row) { row.open = true; row.scrollIntoView({ block: 'center' }); row.querySelector('textarea')?.focus(); } })); drawer.append(next);
    }
    const proof = section('Evidence balance');
    proof.append(element('p', 'triage-evidence-counts', `${ready.counts.supports} supporting · ${ready.counts.contradicts} contradicting · ${ready.counts.context} context`));
    if (ready.outdated) proof.append(element('p', 'triage-warning', `${ready.outdated} entries need re-review.`));
    proof.append(element('p', 'triage-muted', `${ready.gaps.length} review areas remain unchecked / blocked. Counts are review notes, not bug confidence.`));
    if (value.triage.decisionReason) proof.append(element('p', 'triage-decision-summary', value.triage.decisionReason));
    for (const note of FlowboardReview.quality(value)) proof.append(element('p', 'triage-warning', note));
    drawer.append(proof);
    const card = cards.get(selectedCard);
    const inspect = section(card ? 'Selected source' : 'Explore the source'); inspect.id = 'triage-inspector';
    if (!card) {
      inspect.append(element('p', 'triage-muted', 'Choose Inspect on a function card to see its role, conditions and nearby relationships.'));
      const first = cards.values().next().value;
      if (first) inspect.append(button('Inspect first mapped function', () => inspectCard(first)));
      else inspect.append(button('Review missing source references', () => show('report')));
    } else {
      const info = hints[card.id] || {}, nav = element('div', 'triage-report-actions');
      const back = button('Back', () => moveHistory(-1)), forward = button('Forward', () => moveHistory(1)); back.disabled = navigationIndex <= 0; forward.disabled = navigationIndex >= navigation.length - 1;
      nav.append(back, forward, button(spotlight ? 'Show all cards' : 'Focus neighborhood', () => { spotlight = !spotlight; renderDrawer(); redrawEdges(); }));
      inspect.append(nav, element('h3', '', `${card.data.contract || ''}::${card.name}`), element('p', 'triage-muted', info.range || 'Source context'),
        element('p', '', info.description || 'Role has not been explained yet. Inspect the source or ask your assistant to describe its normal behavior.'));
      if (info.mapping) inspect.append(element('p', 'triage-muted', `Mapped by ${mappingLabel(info.mapping.method)}; relevance still needs review.`));
      const actions = element('div', 'triage-report-actions');
      const open = button('Open source', () => send('triage:openReference', { file: info.file, line: info.line })); open.disabled = !info.file;
      const evidence = button('+ Evidence', () => addFromCard(card)); evidence.disabled = readOnly || !info.file;
      const ask = button('Ask AI about function', () => send('triage:prompt', { cardId: card.id })); ask.disabled = readOnly || !info.file;
      actions.append(open, evidence, ask); inspect.append(actions);
      if (info.modifiers?.length) inspect.append(element('p', '', `Modifiers: ${info.modifiers.join(', ')}`));
      if (info.guards?.length) { const guards = element('details'); guards.append(element('summary', '', 'Conditions found in this function')); for (const guard of info.guards) guards.append(element('pre', 'triage-inline-code', guard)); inspect.append(guards); }
      const neighbors = edges.filter(edge => edge.from === card.id || edge.to === card.id);
      inspect.append(element('p', 'triage-muted', 'Adjacent diagram relationships — not an execution order.'));
      for (const edge of neighbors) {
        const other = cards.get(edge.from === card.id ? edge.to : edge.from); if (!other) continue;
        const meta = connections.find(item => item.from === edge.from && item.to === edge.to);
        const link = button(`${edge.from === card.id ? '→' : '←'} ${other.name} · ${meta?.kind || 'hypothesis'}`, () => inspectCard(other), 'triage-neighbor');
        link.append(element('small', '', meta?.reason || 'Expanded/manual candidate; inspect its source binding.')); inspect.append(link);
      }
      if (!neighbors.length) inspect.append(element('p', 'triage-muted', 'No adjacent relationships drawn. Check modifiers and external implementations in source when relevant.'));
    }
    drawer.append(inspect);
    if (card) drawer.insertBefore(inspect, behavior);
    const anchors = [...cards.values()].filter(card => hints[card.id]?.file).map(card => ({ file: hints[card.id].file, line: hints[card.id].line, function: card.name }));
    const related = FlowboardReview.related(library, active, anchors);
    if (related.length) {
      const sectionNode = section('Other findings touching this code');
      sectionNode.append(element('p', 'triage-muted', 'Shared anchors/files suggest useful context, not the same root cause.'));
      for (const issue of related) { const item = button(`${issue.displayId || issue.id} · ${issue.title}`, () => select(issue.id), 'triage-neighbor'); item.append(element('small', '', issue.shared.length ? `${issue.shared.length} identical source anchors` : `Shared file: ${issue.sharedFiles.join(', ')}`)); sectionNode.append(item); }
      drawer.append(sectionNode);
    }
  }
  function decorateCards() {
    const neighborhood = new Set([selectedCard]);
    const claimCards = claimCardIds();
    if (spotlight && cards.has(selectedCard)) for (const edge of edges) { if (edge.from === selectedCard) neighborhood.add(edge.to); if (edge.to === selectedCard) neighborhood.add(edge.from); }
    for (const card of cards.values()) {
      card.el.classList.toggle('triage-selected-source', card.id === selectedCard);
      card.el.classList.toggle('triage-dimmed', claimFocus && claimCards.size ? !claimCards.has(card.id) : spotlight && cards.has(selectedCard) && !neighborhood.has(card.id));
      const info = hints[card.id];
      if (!info) continue;
      decorateInline(card, info);
      const claimLines = claimSources().filter(link => FlowboardInline.forSource([link.entry], info).length).map(link => link.entry.source.line);
      card.codeEl.querySelectorAll('.code-line').forEach(row => row.classList.toggle('triage-claim-line', claimLines.includes(Number(row.dataset.sourceLine))));
      let row = card.el.querySelector('.triage-card-info');
      if (!row) {
        row = element('div', 'triage-card-info');
        row.append(element('strong', '', info.context ? 'Source context · not a function step' : `${info.visibility}${info.readOnly ? ' · read-only' : ''}${info.modifiers.length ? ' · ' + info.modifiers.join(', ') : ''}`));
        if (info.mapping) row.append(element('span', 'triage-mapping-badge', mappingLabel(info.mapping.method)));
        if (info.description) row.title = info.description;
        const add = button('+ Evidence', () => addFromCard(card), 'triage-card-add-evidence'); add.disabled = readOnly;
        row.append(button('Inspect', () => inspectCard(card), 'triage-card-inspect'), add, element('div', 'triage-card-evidence'));
        if (info.description) {
          const role = element('details', 'triage-card-role');
          role.append(element('summary', '', 'Function role · reviewer explanation'), element('p', '', info.description));
          rememberDisclosure(role, `${card.id}:role`); row.append(role);
        }
        card.el.querySelector('.card-header').insertAdjacentElement('afterend', row);
      }
      const badges = row.querySelector('.triage-card-evidence'); badges.replaceChildren();
      for (const item of FlowboardInline.forSource(profile().evidence, info)) {
        const badge = button(`${stanceLabel(item.stance).replace('claim', 'finding')} · L${item.source.line}`, () => inspectEvidence(item), `triage-evidence-badge ${item.stance}`); badge.title = item.note; badges.append(badge);
      }
      if (info.context) card.el.querySelector('.card-title').textContent = 'Source context';
    }
  }
  function categorySelect(value, label) {
    const select = element('select'); select.setAttribute('aria-label', label);
    for (const [id, name] of Object.entries(FlowboardInline.categories)) { const option = element('option', '', name); option.value = id; select.append(option); }
    select.value = value; return select;
  }
  function decorateInline(card, info) {
    const key = `${token}:${editVersion}:${dirtyReview}:${inlineVisible}:${hintVersion}:${activeClaim}:${info.sourceHash}:${selectedCard || ''}:${[...cards.keys()].join(',')}`;
    if (card._triageInlineKey === key) return;
    card._triageInlineKey = key;
    card.el.querySelectorAll('.triage-inline-note,.triage-line-number,.triage-inline-unplaced,.triage-card-story').forEach(node => node.remove());
    const rows = [...card.codeEl.querySelectorAll('.code-line')];
    rows.forEach(row => { row.classList.remove('triage-explained-line'); delete row.dataset.sourceLine; });
    const numbers = FlowboardInline.lineMap(card.data.code, info.line, card.clean);
    const entries = FlowboardInline.forSource(profile().evidence, info), byLine = new Map();
    if (!numbers || rows.length !== numbers.length) {
      if (inlineVisible && entries.length) {
        const warning = element('div', 'triage-inline-unplaced');
        warning.append(element('p', '', 'Inline source mapping unavailable. Open the exact original lines from the evidence badges; no approximate placement is used.'));
        card.el.append(warning);
      }
      return;
    }
    for (const [index, row] of rows.entries()) {
      const line = numbers[index]; row.dataset.sourceLine = line; byLine.set(line, row);
      const gutter = button(String(line), event => { addFromCard(card, line); }, 'triage-line-number');
      gutter.title = `Explain ${info.file}:${line}`; gutter.setAttribute('aria-label', `Explain source line ${line} in ${card.name}`); gutter.disabled = readOnly;
      row.prepend(gutter);
    }
    if (!inlineVisible) return;
    const lastByLine = new Map();
    for (const item of entries) {
      const kind = FlowboardInline.category(item), note = element('details', `triage-inline-note ${kind}`);
      note.dataset.evidenceId = item.id;
      const caption = element('summary', '', `${FlowboardInline.categories[kind]} · L${item.source.line} · ${stanceLabel(item.stance).replace('claim', 'finding')}${dirtyReview ? ' · unsaved' : ''}`);
      note.append(caption, element('p', '', item.note));
      const claimLink = selectedClaim()?.evidence.find(link => link.evidenceId === item.id);
      if (claimLink) {
        const context = element('div', 'triage-inline-claim'); context.append(element('strong', '', `${claimLink.stance} selected claim`), element('p', '', claimLink.reason)); note.append(context);
      }
      const actions = element('div', 'triage-inline-actions');
      actions.append(button('Open exact source', () => inspectEvidence(item)), button('Edit explanation', () => { editingEvidence = item.id; evidenceFilter = 'all'; show('review'); drawer.querySelector('[aria-label="Edit evidence explanation"]')?.focus(); })); note.append(actions);
      const row = byLine.get(item.source.line);
      if (row) {
        row.classList.add('triage-explained-line'); (lastByLine.get(item.source.line) || row).after(note); lastByLine.set(item.source.line, note);
      } else {
        let unmapped = card.el.querySelector('.triage-inline-unplaced');
        if (!unmapped) { unmapped = element('div', 'triage-inline-unplaced'); unmapped.append(element('p', '', 'Notes on source lines hidden by the native comment filter:')); card.el.append(unmapped); }
        unmapped.append(note);
      }
      rememberDisclosure(note, `${card.id}:evidence:${item.id}`, true);
    }
    if ((!selectedClaim() || claimCardIds().has(card.id)) && (selectedCard === card.id || !cards.has(selectedCard) && cards.values().next().value === card)) {
      const claim = selectedClaim(), story = element('details', 'triage-card-story'); story.append(element('summary', '', claim ? 'Selected claim · evidence and reasoning' : 'Review story · claim, behavior, consequence'));
      story.append(element('p', 'triage-story-caption', 'Reviewer argument from supplied fields. These bullets do not establish execution order or bug validity.'));
      const list = element('ul');
      const parts = claim ? [
        { label: 'Intended rule', text: currentFinding().expectedBehavior || 'Not established.' },
        { label: `Claim · ${claim.state}`, text: claim.text || 'Untitled claim' },
        { label: 'Observed source behavior', text: claim.observed || 'Not established.' },
        { label: 'Permissions / state', text: claim.conditions || 'Not established.' },
        { label: 'Consequence / uncertainty', text: claim.consequence || 'Not established.' },
        { label: 'Reviewer reasoning', text: claim.reason || 'No conclusion recorded.' },
        ...(claim.questions || []).map(text => ({ label: 'Unresolved', text }))
      ] : FlowboardInline.story(currentFinding());
      for (const item of parts) { const row = element('li'); row.append(element('strong', '', item.label), element('p', '', item.text)); list.append(row); }
      if (!list.children.length) list.append(element('li', '', 'No description supplied. Read the report and add source-bound review notes.'));
      story.append(list);
      const evidence = profile().evidence.filter(item => !claim || claim.evidence.some(link => link.evidenceId === item.id)), currentHints = visibleHints();
      const observations = evidence.filter(item => item.source && !FlowboardInline.placement(item, currentHints));
      const excluded = evidence.filter(item => item.source && FlowboardInline.placement(item, currentHints));
      const trail = element('div', 'triage-story-evidence');
      trail.append(element('strong', '', 'Source observations · reviewer argument, not execution order'));
      for (const item of observations) {
        const entry = element('div', 'triage-story-observation');
        const link = claim?.evidence.find(link => link.evidenceId === item.id);
        entry.append(button(`${stanceLabel(link?.stance || item.stance)} · ${item.source.file}:${item.source.line}`, () => inspectEvidence(item)), element('p', '', item.note));
        if (link) entry.append(element('p', 'triage-muted', link.reason)); trail.append(entry);
      }
      if (!observations.length) trail.append(element('p', '', 'No current source-bound observations on this map. Add evidence after inspecting the source.'));
      if (excluded.length) trail.append(button(`${excluded.length} source observation(s) not placed — review why`, () => { evidenceFilter = 'all'; show('review'); }));
      story.append(trail); card.el.append(story); rememberDisclosure(story, `${card.id}:story`);
    }
  }
  // Native re-renders for tracing, annotations and Undo keep their own code and
  // call listeners. Our text-only notes are applied afterwards, independently.
  const nativeRenderCode = renderCodeBody;
  renderCodeBody = function(card) {
    nativeRenderCode(card); card._triageInlineKey = null;
    if (hints[card.id]) decorateInline(card, hints[card.id]);
  };
  function arrangeCards() {
    if (!cards.size) return;
    persistNow();
    const columns = [];
    for (const card of [...cards.values()].sort((a, b) => a.x - b.x || a.y - b.y)) {
      let column = columns.at(-1);
      if (!column || Math.abs(card.x - column.origin) > 80) { column = { origin: card.x, cards: [] }; columns.push(column); }
      column.cards.push(card);
    }
    let x = 30;
    for (const column of columns) {
      let y = 30, width = 0;
      for (const card of column.cards.sort((a, b) => a.y - b.y)) {
        card.x = x; card.y = y; card.el.style.left = `${x}px`; card.el.style.top = `${y}px`;
        y += card.el.offsetHeight + 90; width = Math.max(width, card.el.offsetWidth);
      }
      x += width + 100;
    }
    redrawEdges(); persistNow(); fit();
  }
  const nativeRedraw = redrawEdges;
  redrawEdges = function() {
    decorateCards(); nativeRedraw();
    const claimCards = claimCardIds();
    const visibleEdges = edges.filter(edge => (cards.has(edge.from) || notes.has(edge.from)) && (cards.has(edge.to) || notes.has(edge.to)));
    const paths = svg.querySelectorAll('.edge-line');
    paths.forEach((node, index) => {
      const edge = visibleEdges[index];
      const meta = connections.find(x => x.from === edge?.from && x.to === edge?.to);
      const kind = meta?.kind || 'hypothesis';
      node.classList.add(kind === 'call' ? 'triage-call' : kind === 'state-dependency' ? 'triage-state' : 'triage-hypothesis');
      node.classList.toggle('triage-dimmed', claimFocus && claimCards.size ? !claimCards.has(edge?.from) || !claimCards.has(edge?.to) : spotlight && cards.has(selectedCard) && edge?.from !== selectedCard && edge?.to !== selectedCard);
      const title = document.createElementNS(SVG_NS, 'title'); title.textContent = `${kind}: ${meta?.reason || 'User-expanded/manual connection; verify source and runtime context.'}`; node.append(title);
    });
  };
  const nativePersist = persistNow;
  persistNow = function() {
    nativePersist();
    if (active) send('triage:persist', { state: snapshot() });
  };
  // Upstream Undo posts an untagged snapshot directly. Persist its result in
  // the current finding too, including keyboard Undo; never another finding.
  const nativeUndo = undo;
  undo = function() { nativeUndo(); if (active) send('triage:persist', { state: snapshot() }); };
  undoBtn.addEventListener('click', () => { if (active) send('triage:persist', { state: snapshot() }); });
  function fit() {
    if (!cards.size) return;
    // Browser focus/scrollIntoView can scroll even an overflow:hidden viewport.
    // Native camera math assumes zero DOM scroll; clear it before fitting.
    resetViewportScroll();
    const rect = flowboard.getBoundingClientRect();
    const values = [...cards.values()];
    const left = Math.min(...values.map(c => c.x)), top = Math.min(...values.map(c => c.y));
    const right = Math.max(...values.map(c => c.x + c.el.offsetWidth)), bottom = Math.max(...values.map(c => c.y + c.el.offsetHeight));
    scale = Math.min(1, Math.max(MIN_SCALE, Math.min((rect.width - 60) / (right - left), (rect.height - 60) / (bottom - top))));
    panX = 30 - left * scale; panY = 30 - top * scale; applyTransform(); schedulePersist();
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'triage:load') {
      if (active) persistNow();
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      active = message.issueId; token = message.token; finding = message.finding; library = message.library || [];
      disclosureState.clear();
      activeClaim = null; claimFocus = false; reportSelection = '';
      connections = message.connections || []; hints = message.hints || {}; report = message.reportText || '';
      warnings = message.warnings || []; unresolved = message.unresolved || []; git = message.git || {}; diagnostics = message.diagnostics || {};
      retrieval = message.retrieval || null; validation = message.validation || {}; rawReport = false;
      readOnly = !!message.readOnly;
      dirtyReview = false; reviewEdits = {}; editVersion = 0;
      evidenceInput = {}; evidencePreview = null; pendingEvidence.clear(); editingEvidence = null;
      selectedCard = null; spotlight = false; navigation = []; navigationIndex = -1; flowFilter = ''; evidenceFilter = 'all'; scrollPositions.clear(); renderedTab = null;
      if (readOnly) drawerTab = 'report'; else if (drawerTab === 'findings') drawerTab = 'brief';
      undoStack.length = 0; lastSnapshotJson = null; lastContentKey = null;
      currentFlowRootId = null; flowPending.clear(); loadSnapshot(message.state);
      renderBar(); renderDrawer(); redrawEdges();
      if (!drawer.classList.contains('visible')) toggle(readOnly ? 'report' : 'brief');
      if (!message.state.camera?.scale || message.state.camera.scale === 1 && message.state.camera.panX === 0) fit();
      persistNow(); send('triage:rendered');
    } else if (message?.type === 'triage:library') {
      library = message.library || []; renderBar(); if (!drawer.classList.contains('visible')) toggle('findings'); else renderDrawer();
    } else if (message?.type === 'triage:requestRefresh' && message.token === token) {
      if (!(dirtyReview || hasEvidenceDraft()) || window.confirm('Refresh the source map and discard unsaved form edits? Saved review work will be backed up.')) send('triage:refresh');
    } else if (message?.type === 'triage:limit') { currentFlowRootId = null; flowPending.clear(); }
    else if (message?.type === 'triage:cancelExpansion') { flowPending.delete(message.id); if (!flowPending.size) currentFlowRootId = null; }
    else if (message?.type === 'triage:hint' && (!message.token || message.token === token)) { hints[message.id] = message.hint; hintVersion++; redrawEdges(); if (['flow', 'brief'].includes(drawerTab)) renderDrawer(); }
    else if (message?.type === 'triage:evidenceBound' && message.issueId === active && message.token === token && pendingEvidence.has(message.evidence.id)) {
      const before = pendingEvidence.get(message.evidence.id); pendingEvidence.delete(message.evidence.id);
      if (before === JSON.stringify(evidenceInput)) evidenceInput = {};
      editProfile(value => { if (!value.evidence.some(item => item.id === message.evidence.id)) value.evidence.push(message.evidence); }, true);
    }
    else if (message?.type === 'triage:evidenceInspected' && message.issueId === active && message.token === token && profile().evidence.some(item => item.id === message.evidence.id)) {
      evidencePreview = { ...message, evidence: profile().evidence.find(item => item.id === message.evidence.id) };
      for (const card of cards.values()) card.el.classList.remove('triage-evidence-focus');
      const source = message.evidence.source;
      const card = source && [...cards.values()].find(card => hints[card.id]?.file === source.file && source.line >= hints[card.id].line && source.line <= hints[card.id].endLine);
      if (card) { card.el.classList.add('triage-evidence-focus'); focusSourceLine(card, source.line); }
      if (drawerTab === 'review') renderDrawer();
    }
    else if (message?.type === 'triage:reviewSaved' && message.issueId === active && message.token === token) {
      finding = message.finding; library = message.library;
      // Keep edits typed while the preceding save was in flight.
      if (message.editVersion === editVersion) { dirtyReview = false; reviewEdits = {}; }
      renderBar(); renderDrawer(); redrawEdges();
    }
    else if (message?.type === 'triage:notice') {
      if (message.error && pendingEvidence.size) { pendingEvidence.clear(); renderDrawer(); }
      document.querySelector('.triage-notice')?.remove(); clearTimeout(noticeTimer);
      const notice = element('div', 'triage-notice', message.message); notice.setAttribute('role', message.error ? 'alert' : 'status'); document.body.append(notice);
      noticeTimer = setTimeout(() => notice.remove(), message.error ? 10000 : 5000);
    }
  });
  window.addEventListener('keydown', event => {
    const typing = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && ['review', 'claims'].includes(drawerTab) && drawer.classList.contains('visible')) {
      event.preventDefault(); event.stopImmediatePropagation(); drawer.querySelector('.triage-save-row .primary')?.click(); return;
    }
    if (typing) return;
    if (event.key === 'Escape' && drawer.classList.contains('visible')) {
      event.preventDefault(); drawer.classList.remove('visible'); document.body.classList.remove('triage-drawer-open'); redrawEdges(); bar.querySelector('button')?.focus();
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && ['1', '2', '3', '4', '5', '6', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key.startsWith('Arrow')) moveHistory(event.key === 'ArrowLeft' ? -1 : 1);
      else show(['findings', 'brief', 'flow', 'review', 'report', 'claims'][Number(event.key) - 1]);
    }
  }, true);
  window.addEventListener('beforeunload', () => { if (active) persistNow(); });
  renderBar(); send('triage:ready');
})();
