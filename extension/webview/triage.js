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
  let navigationViews = [];
  let inlineVisible = true;
  const hintVersions = new Map();
  let activeClaim = null, claimFocus = false, reportSelection = '';
  let investigation = null, draftFingerprint = '', sourceFingerprint = '', recoveries = [], sourceStale = false, historicalAssessment = null;
  let investigationDraft = null, visibleInvestigation = null, activeInvestigationClaim = null, investigationCorrection = {};
  let preparing = null;
  let checkedLocation = null;
  let guide = null, guideIndex = 0, guideMode = 'closed', guideReturn = null, guideNavigation = null, guidePending = false, guideOpinion = window.innerWidth > 800;
  let guideDetour = null, guideError = null, guideRequest = null;
  let guideIntent = 'waiting', preparationState = null, guideWrap = true;
  let reportPreparation = null;
  let guideAvailability = null;
  let preparationExpanded = false;
  const guidePositions = new Map();
  const checkpoints = new Map();
  const disclosureState = new Map();
  const scrollPositions = new Map();
  const pendingEvidence = new Map();
  const preparationLabel = state => ({ completed: 'Ready', ready: 'Ready', queued: 'Queued', running: 'Checking', 'retry-scheduled': 'Queued for another check',
    'waiting-for-provider-capacity': 'Waiting for capacity', blocked: 'Blocked', failed: 'Failed', stale: 'Code changed', paused: 'Paused', cancelled: 'Cancelled' }[state] || 'Not prepared');
  const preparationJob = id => reportPreparation?.jobs?.find(job => job.id === id);
  const canContinueFinding = () => {
    const job = preparationJob(active);
    return job && !job.publishable && !['running', 'waiting-for-provider-capacity'].includes(job.state) && (job.state !== 'queued' || reportPreparation.mode !== 'running');
  };
  const jobLabel = job => job?.publishable ? 'Ready' : job?.state === 'completed' ? 'Checking saved walkthrough' :
    ['running', 'waiting-for-provider-capacity', 'queued'].includes(job?.state) ? preparationLabel(job.state) :
    job?.failureKind === 'material-evidence' ? 'Needs evidence' : ['validation', 'structural'].includes(job?.failureKind) ? 'Invalid review response' :
    job?.failureKind === 'provider' ? 'Operational failure' : preparationLabel(job?.state);
  const readyDraft = draft => !!(draft?.phase === 'ready' && draft.publication?.ready && !draft.preparation);
  function updatePreparationRows() {
    for (const row of drawer.querySelectorAll('[data-finding-id]')) {
      const job = preparationJob(row.dataset.findingId), badge = row.querySelector('.triage-preparation-badge'), action = row.querySelector('.triage-ready-action');
      if (badge) { badge.textContent = jobLabel(job); badge.dataset.state = job?.publishable ? 'ready' : job?.state || 'not-started'; badge.title = job?.reason || ''; }
      if (action) action.hidden = !job?.publishable;
      const reason = row.querySelector('.triage-job-reason');
      if (reason) { reason.textContent = job?.reason || ''; reason.hidden = !job?.reason || !['blocked', 'failed', 'paused', 'stale'].includes(job.state); }
      if (queueMode.startsWith('preparation:')) row.hidden = queueMode === 'preparation:ready' ? !job?.publishable : job?.state !== queueMode.slice(12);
    }
    const counts = drawer.querySelector('.triage-preparation-counts');
    if (counts) counts.textContent = preparationCounts();
  }
  function preparationCounts() {
    const jobs = reportPreparation?.jobs || [];
    const ready = jobs.filter(job => job.publishable).length, working = jobs.filter(job => ['running', 'queued', 'retry-scheduled', 'waiting-for-provider-capacity'].includes(job.state)).length;
    return jobs.length ? `${ready} ready · ${working} preparing · ${jobs.filter(job => job.state === 'blocked').length} blocked · ${jobs.filter(job => job.state === 'failed').length} failed` : 'Preparation is separate from your saved review result.';
  }
  const statusLabel = FlowboardReading.issue;
  const bar = document.createElement('div'); bar.id = 'triage-bar';
  const drawer = document.createElement('aside'); drawer.className = 'triage-drawer'; drawer.setAttribute('aria-label', 'Finding triage');
  const legend = document.createElement('div'); legend.id = 'triage-legend'; legend.textContent = '— Call   ┄ Possible link   ··· Shared state'; legend.title = 'Connections show relationships, not a proven execution order.';
  document.body.append(bar, drawer, legend);
  const guideControls = element('nav', 'guide-controls'); guideControls.setAttribute('aria-label', 'Guided review'); guideControls.hidden = true;
  const guideAside = element('aside', 'guide-aside'); guideAside.setAttribute('aria-label', 'Current review step'); guideAside.hidden = true;
  document.body.append(guideControls, guideAside);
  function measureGuideControls() {
    if (guideControls.hidden) return;
    document.body.style.setProperty('--guide-controls-bottom', `${Math.ceil(guideControls.getBoundingClientRect().bottom)}px`);
  }
  new ResizeObserver(measureGuideControls).observe(guideControls);
  const preparationSurface = element('section', 'guide-preparation'); preparationSurface.hidden = true;
  preparationSurface.setAttribute('aria-label', 'Walkthrough preparation'); document.body.append(preparationSurface);
  const guideAnchor = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); guideAnchor.classList.add('guide-anchor'); guideAnchor.setAttribute('aria-hidden', 'true'); document.body.append(guideAnchor);
  let anchorFrame;
  function placeGuideAnchor() {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = requestAnimationFrame(() => {
      guideAnchor.replaceChildren();
      if (guideMode !== 'guided' || guideAside.hidden || !checkedLocation) return;
      const card = cards.get(selectedCard), row = card?.codeEl.querySelector(`[data-source-line="${checkedLocation.line}"]`), note = guideAside.querySelector('.guide-line-link');
      if (!row || !note) return;
      const r = row.getBoundingClientRect(), c = card.codeEl.parentElement.getBoundingClientRect(), n = note.getBoundingClientRect(), a = guideAside.getBoundingClientRect();
      if (r.bottom < c.top || r.top > c.bottom || n.bottom < a.top || n.top > a.bottom) return;
      const x = Math.min(c.right, flowboard.getBoundingClientRect().right) - 3, y = Math.max(c.top, r.top) + Math.min(r.height, 24) / 2;
      // Overlaid explanation anchors must never draw over original code,
      // including a neighboring card crossed by a return connection.
      const defs = document.createElementNS(guideAnchor.namespaceURI, 'defs'), mask = document.createElementNS(guideAnchor.namespaceURI, 'mask');
      mask.id = 'guide-outside-cards'; mask.setAttribute('maskUnits', 'userSpaceOnUse');
      const background = document.createElementNS(guideAnchor.namespaceURI, 'rect');
      for (const [key, value] of Object.entries({ x: 0, y: 0, width: innerWidth, height: innerHeight, fill: 'white' })) background.setAttribute(key, String(value));
      mask.append(background);
      for (const node of flowboard.querySelectorAll('.card')) {
        const box = node.getBoundingClientRect();
        if (box.right < 0 || box.left > innerWidth || box.bottom < 0 || box.top > innerHeight) continue;
        const cutout = document.createElementNS(guideAnchor.namespaceURI, 'rect');
        for (const [key, value] of Object.entries({ x: box.left - 2, y: box.top - 2, width: box.width + 4, height: box.height + 4, fill: 'black' })) cutout.setAttribute(key, String(value));
        mask.append(cutout);
      }
      defs.append(mask); guideAnchor.append(defs);
      const line = document.createElementNS(guideAnchor.namespaceURI, 'path');
      line.setAttribute('mask', 'url(#guide-outside-cards)');
      line.setAttribute('d', `M${x},${y} L${x + 8},${y} L${a.left + 4},${n.top + n.height / 2}`); guideAnchor.append(line);
      const step = guide?.steps[guideIndex], prior = guide?.steps[guideIndex - 1];
      if (prior?.unit && step?.handoff && prior.unit.id !== step.unit?.id) {
        const previous = cards.get(guideCard(prior.unit));
        const origin = previous?.codeEl.querySelector(`[data-source-line="${prior.evidence.source.line}"]`);
        if (origin) {
          const o = origin.getBoundingClientRect(), frame = flowboard.getBoundingClientRect();
          const sx = Math.max(frame.left + 10, Math.min(frame.right - 10, o.right)), sy = Math.max(frame.top + 28, Math.min(frame.bottom - 28, o.top + 12));
          const targetX = Math.max(frame.left + 10, r.left), targetY = Math.max(c.top + 8, Math.min(c.bottom - 8, r.top + 12));
          const connection = document.createElementNS(guideAnchor.namespaceURI, 'path'); connection.classList.add('guide-checked-handoff');
          connection.setAttribute('mask', 'url(#guide-outside-cards)');
          connection.setAttribute('d', `M${sx},${sy} C${sx + 30},${sy} ${targetX - 30},${targetY} ${targetX},${targetY}`);
          if (['data','context','later-transaction'].includes(step.handoff.kind)) connection.setAttribute('stroke-dasharray', '6 4');
          const label = document.createElementNS(guideAnchor.namespaceURI, 'text'); label.classList.add('guide-checked-label');
          label.setAttribute('x', String(frame.left + 24));
          label.setAttribute('y', String(frame.top + 16));
          label.setAttribute('mask', 'url(#guide-outside-cards)');
          label.textContent = `${({ data:'Data', context:'Context', 'later-transaction':'Later transaction' })[step.handoff.kind] || step.handoff.kind} · ${prior.unit.name}`;
          guideAnchor.append(connection, label);
        }
      }
    });
  }
  document.addEventListener('scroll', placeGuideAnchor, true); window.addEventListener('resize', () => {
    document.body.style.setProperty('--guide-card-width', `${Math.max(300, Math.min(680, flowboard.clientWidth - 48))}px`);
    requestAnimationFrame(() => {
      const card = cards.get(selectedCard);
      if (guideMode === 'guided' && card && !sourceStale) {
        // Keep the same node, scale and line when a smaller viewport would
        // otherwise clip the entire long card. Never fit the whole graph.
        resetViewportScroll();
        const bounds = flowboard.getBoundingClientRect(), header = card.el.querySelector('.card-header').getBoundingClientRect();
        if (header.left < bounds.left || header.right > bounds.right) panX += bounds.left + 24 - header.left;
        if (header.top < bounds.top || header.bottom > bounds.bottom - 72) panY += bounds.top + 24 - header.top;
        applyTransform();
        const step = guide?.steps[guideIndex]; if (step?.evidence) guideReveal(step.evidence.source.line);
      }
      placeGuideAnchor();
    });
  });
  function preparationContent(parent) {
    if (guideAvailability?.ready === false) {
      parent.append(element('h2', '', 'Your saved board is available'), element('p', '', guideAvailability.reason || 'The walkthrough needs another function card.'),
        element('p', 'triage-muted', 'Free the requested card slots, then start the walkthrough again. Your notes, layout and checked review are preserved; this does not request another AI review.'),
        button('Explore code', () => { guideIntent = 'explore'; renderPreparation(); show('flow'); }), button('Start walkthrough', guideStart));
      return;
    }
    if (reportPreparation) {
      const progress = reportPreparation, running = progress.mode === 'running', selectedJob = preparationJob(active);
      parent.append(element('h2', '', selectedJob ? jobLabel(selectedJob) : running ? 'Preparing report' : 'Preparation incomplete'),
        element('p', '', `${progress.ready} of ${progress.total} walkthroughs ready · ${progress.reportName}`),
        element('p', '', preparationJob(active)?.reason || progress.reason || 'Ready walkthroughs are available immediately. Other findings continue preparing in the background.'),
        element('small', 'triage-muted', `${progress.requests} of ${progress.requestLimit} model requests used${progress.ambiguities ? ` · ${progress.ambiguities} report sections need classification` : ''}`));
      for (const job of progress.active || []) parent.append(element('p', '', `${job.id} · ${job.stage || 'Locating code'}`));
      if (selectedJob?.missingInputs?.length) {
        const needed = element('details'); needed.append(element('summary', '', 'Evidence needed before this finding can finish'));
        for (const item of selectedJob.missingInputs) needed.append(element('p', '', `${item.claimId}: ${item.text}`), element('small', 'triage-muted', item.why));
        needed.append(element('p', 'triage-muted', 'Provide the named source or observation first. Continuing unchanged cannot establish an unavailable external fact.'));
        parent.append(needed);
      }
      if (selectedJob?.validationProblems?.length) {
        const invalid = element('details'); invalid.append(element('summary', '', 'Retained response: targeted repair needed'));
        for (const item of selectedJob.validationProblems) invalid.append(element('p', '', `${item.code}: ${item.message}`));
        parent.append(invalid);
      }
      const controls = element('div', 'guide-preparation-actions');
      if (canContinueFinding()) {
        parent.append(element('small', 'triage-muted', 'Continue uses remaining shared allowance and may renew only this finding’s limit. Paused siblings stay paused. It never adds report allowance.'));
      }
      controls.append(button(running ? 'Pause report preparation' : 'Resume entire report', () => send('triage:reportControl', { action: running ? 'pause' : 'resume' })),
        button('Cancel', () => send('triage:reportControl', { action: 'cancel' })), button('Keep exploring', () => { guideIntent = 'explore'; renderPreparation(); }));
      parent.append(controls);
      const details = element('details'); details.append(element('summary', '', 'Progress and stopped checks'));
      details.append(element('p', '', Object.entries(progress.counts || {}).map(([state, count]) => `${state}: ${count}`).join(' · ')));
      if (progress.plan) details.append(element('p', '', `${progress.plan.eligible} queued findings · about ${progress.plan.estimatedRequests} further requests before repairs · ${progress.plan.remainingAllowance} requests left.`),
        element('p', 'triage-muted', progress.plan.basis));
      if (progress.plan?.estimatedRequests > progress.plan?.remainingAllowance) details.append(element('p', 'triage-warning', 'The current allowance is unlikely to finish this report. No extra requests are authorized automatically.'));
      if (progress.concurrency) details.append(element('p', 'triage-muted', `${progress.concurrency.configured} configured workers · ${progress.active?.length || 0} active tasks · ${(progress.jobs || []).filter(job => job.state === 'waiting-for-provider-capacity').length} waiting for provider capacity. Task count is not provider concurrency.`));
      for (const job of progress.stopped || []) details.append(element('p', '', `${job.id} · ${job.stage || job.state}: ${job.reason || job.state}`));
      parent.append(details); return;
    }
    const state = sourceStale ? { state: 'stale', reason: 'Code or report changed. Prepare the explanation again for these files.' } : preparationState || investigationDraft?.preparation || { state: 'preparing', reason: '' };
    const stages = { 'not-started': 'Review provider required', preparing: 'Preparing walkthrough', checking: 'Checking the explanation', blocked: 'Walkthrough blocked', failed: 'Review could not finish', stale: 'Walkthrough needs updating' };
    const heading = element('h2', '', stages[state.state] || stages.preparing); heading.setAttribute('role', 'status');
    parent.append(element('small', 'triage-muted', issueIdentifier() || 'Finding'), heading,
      element('p', '', state.reason || ({ generating: 'Reading the relevant code.', 'checking-source': 'Reading the local code needed to check this explanation.', challenging: 'Checking the explanation against guards, other branches and counterevidence.' }[investigationDraft?.phase] || 'Locating the report’s functions and current code.')));
    const actions = element('div', 'guide-preparation-actions');
    actions.append(button('Read report', () => { guideIntent = 'explore'; renderPreparation(); show('report'); }), button('Explore code', () => { guideIntent = 'explore'; renderPreparation(); show('flow'); }));
    if (state.state === 'not-started') actions.prepend(button('Configure review provider', () => send('triage:investigationEnable')));
    else if (['blocked', 'failed', 'stale'].includes(state.state)) actions.prepend(button(state.state === 'stale' || readOnly ? 'Refresh code' : 'Retry preparation', () => { guideIntent = 'waiting'; send(state.state === 'stale' || readOnly ? 'triage:refresh' : 'triage:investigationRetry'); }));
    parent.append(actions);
    if (state.attempted?.length || state.problems?.length) {
      const details = element('details'); details.append(element('summary', '', 'Checks attempted'));
      for (const line of [...(state.attempted || []), ...(state.problems || []).slice(1)]) details.append(element('p', '', line)); parent.append(details);
    }
    parent.append(element('p', 'triage-muted', 'No generated guide has been published. Your saved notes and judgment are unchanged.'));
  }
  function renderPreparation() {
    const waiting = !!preparing || guideIntent === 'waiting' && !!active && (sourceStale || !FlowboardWalkthrough.build(investigationDraft, report) || guideAvailability?.ready === false);
    preparationSurface.hidden = !waiting; document.body.classList.toggle('guide-preparing', waiting);
    const scroll = preparationSurface.scrollTop;
    const openDetails = [...preparationSurface.querySelectorAll('details')].map(node => node.open);
    preparationSurface.replaceChildren(); preparationSurface.classList.toggle('expanded', preparationExpanded);
    if (waiting) {
      const progress = reportPreparation, state = preparationState || investigationDraft?.preparation;
      const job = preparationJob(active);
      const title = preparing ? 'Opening finding' : guideAvailability?.ready === false ? 'Make room for the walkthrough' : job ? `${jobLabel(job)} · ${progress.ready}/${progress.total} ready` : state?.state === 'failed' ? 'Review could not finish' : state?.state === 'blocked' ? 'Walkthrough blocked' : 'Preparing walkthrough';
      const row = element('div', 'guide-status-row'), heading = element('strong', '', title); heading.setAttribute('role', 'status');
      const expand = button(preparationExpanded ? 'Less detail' : 'Details', () => { preparationExpanded = !preparationExpanded; renderPreparation(); preparationSurface.querySelector('.guide-status-row button')?.focus({ preventScroll: true }); }); expand.setAttribute('aria-expanded', String(preparationExpanded));
      row.append(heading, expand);
      if (!preparing && canContinueFinding()) row.append(button('Continue this finding', () => send('triage:investigationRetry')));
      row.append(button('Close status', () => { guideIntent = 'explore'; renderPreparation(); }, 'guide-status-close')); preparationSurface.append(row);
      const selected = issueIdentifier() || preparing || 'No finding selected';
      const stageLabel = stage => ({ generate: 'Reading code', generating: 'Reading code', challenge: 'Checking the explanation', challenging: 'Checking the explanation', 'locating-code': 'Locating code' })[stage] || stage || 'Reading code';
      const activeWork = (progress?.active || []).map(job => `${job.id}: ${stageLabel(job.stage)}${job.startedAt ? ` (${Math.max(0, Math.floor((Date.now() - Date.parse(job.startedAt)) / 1000))}s)` : ''}`).join(' · ');
      preparationSurface.append(element('p', 'guide-status-context', `Selected: ${selected}${activeWork ? ` · Working: ${activeWork}` : ''}`));
      const stopped = progress?.stopped?.find(job => job.id === active);
      const reason = guideAvailability?.ready === false ? guideAvailability.reason : job?.reason || stopped?.reason || state?.reason || progress?.reason;
      if (reason) preparationSurface.append(element('p', 'guide-status-reason', reason));
      if (preparationExpanded && !preparing) {
        const body = element('div', 'guide-status-details'); preparationContent(body); preparationSurface.append(body);
        [...preparationSurface.querySelectorAll('details')].forEach((node, index) => { node.open = !!openDetails[index]; });
      }
      preparationSurface.scrollTop = scroll;
    }
  }
  function guideReveal(line) {
    const card = cards.get(selectedCard), scroller = card?.codeEl.parentElement;
    const row = card?.codeEl.querySelector(`[data-source-line="${line}"]`);
    if (!row || !scroller) return;
    const box = scroller.getBoundingClientRect(), rect = row.getBoundingClientRect();
    const contextInset = Math.min(48, Math.max(8, box.height / 4));
    if (rect.top < box.top + 24 || rect.bottom > box.bottom - 24) scroller.scrollTop += (rect.top - box.top - contextInset) / scale;
    placeGuideAnchor();
  }
  function highlightCallOccurrence() {
    for (const row of flowboard.querySelectorAll('[data-call-site-id]')) delete row.dataset.callSiteId;
    if (globalThis.CSS?.highlights) CSS.highlights.delete('flowboard-call-occurrence');
    if (!guide || !['guided', 'detour'].includes(guideMode) || sourceStale) return;
    const step = guideMode === 'detour' ? detourStep() : guide.steps[guideIndex], site = step.unit?.relatedCalls?.find(item => item.id === step.callSiteId), span = step.span || site?.span;
    const card = cards.get(selectedCard);
    if (!span || !card || hints[card.id]?.sourceHash !== step.unit.source.sourceHash) return;
    const ranges = [];
    for (let line = span.line; line <= span.endLine; line++) {
      const row = card.codeEl.querySelector(`[data-source-line="${line}"]`); if (!row) continue;
      const expected = step.unit.code.replace(/\r\n/g, '\n').split('\n')[line - step.unit.source.line];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement.closest('button,.triage-note-marker,.triage-line-number') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      if (nodes.map(node => node.data).join('') !== expected) continue;
      const start = line === span.line ? span.column : 0, end = line === span.endLine ? span.endColumn : expected.length;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || start < 0 || end > expected.length) continue;
      let offset = 0, startNode, endNode, startOffset, endOffset;
      for (const node of nodes) {
        if (!startNode && start < offset + node.length) { startNode = node; startOffset = start - offset; }
        if (!endNode && end <= offset + node.length) { endNode = node; endOffset = end - offset; }
        offset += node.length;
      }
      if (!startNode || !endNode) continue;
      const range = document.createRange(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset); ranges.push(range);
      row.dataset.callSiteId = site?.id || step.id;
    }
    if (ranges.length && globalThis.CSS?.highlights && globalThis.Highlight) CSS.highlights.set('flowboard-call-occurrence', new Highlight(...ranges));
  }
  const nativeToolbar = document.getElementById('toolbar');
  const nativeUndoButton = document.getElementById('undo-btn');
  const readingLocation = element('div', 'triage-reading-location'); document.body.append(readingLocation);
  function updateReadingLocation() {
    const card = cards.get(selectedCard), header = card?.el.querySelector('.card-header');
    readingLocation.replaceChildren();
    readingLocation.hidden = !header || header.getBoundingClientRect().top >= flowboard.getBoundingClientRect().top;
    if (!readingLocation.hidden) {
      const info = hints[card.id], line = checkedLocation?.file === info?.file && checkedLocation.sourceHash === info?.sourceHash ? checkedLocation.line : card.data.startLine;
      readingLocation.append(button(`${card.data.contract || ''}::${card.name}`, () => focusReadable(card)),
        button(`${info?.file || card.data.file}:${line}`, () => send('triage:openReference', { file: info?.file, line })));
    }
  }
  const nativeApplyTransform = applyTransform;
  applyTransform = function() { nativeApplyTransform(); updateReadingLocation(); placeGuideAnchor(); };
  // The native canvas keeps pan, zoom, text selection, editing and Undo. Only
  // code-scroll gestures stay within the original function's scroll container.
  flowboard.addEventListener('wheel', event => {
    if (document.body.classList.contains('guide-reading') && event.target.closest('.card-code') && !event.ctrlKey && !event.metaKey) event.stopImmediatePropagation();
  }, { capture: true, passive: true });
  function updateStickyOffsets() {
    const tabs = drawer.querySelector('.triage-tabs');
    if (tabs) drawer.style.setProperty('--triage-tabs-bottom', `${tabs.offsetHeight + (parseFloat(getComputedStyle(tabs).top) || 0)}px`);
  }
  new ResizeObserver(updateStickyOffsets).observe(drawer);
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
  function guideCard(unit) {
    return [...cards.values()].find(card => {
      const hint = hints[card.id];
      return hint && hint.file === unit.source.file && hint.sourceHash === unit.source.sourceHash && hint.line === unit.source.line &&
        (!unit.contract || hint.identity?.contract === unit.contract) && (!unit.signature || hint.identity?.signature === unit.signature);
    })?.id;
  }
  function guideCapture() {
    return { ...location(), checkedLocation: checkedLocation && { ...checkedLocation }, guideIndex,
      drawerOpen: drawer.classList.contains('visible'), scrollLeft: flowboard.scrollLeft, scrollTopCode: flowboard.scrollTop, guideScroll: guideAside.scrollTop,
      codeScroll: cards.get(selectedCard)?.codeEl.parentElement.scrollTop || 0, wrap: guideWrap };
  }
  function guideRestore() {
    if (!guide || sourceStale) return;
    const saved = guideReturn; guideReturn = null; guideMode = 'guided'; guideNavigation = null; guidePending = false; guideDetour = null; guideError = null; guideRequest = null;
    if (!saved) { guideGo(guideIndex); return; }
    const expected = guide.steps[saved.guideIndex];
    if (!expected?.unit || saved.selectedCard !== guideCard(expected.unit) || JSON.stringify(saved.checkedLocation) !== JSON.stringify(expected.evidence?.source)) {
      // Old navigation checkpoints may contain the card selected AFTER the
      // guide was paused. Reconstruct from the accepted step, never pair that
      // unrelated card with the current explanation.
      guideGo(saved.guideIndex); return;
    }
    ({ selectedCard, activeClaim, activeInvestigationClaim, claimFocus, spotlight, checkedLocation, guideIndex } = saved);
    if (!cards.has(selectedCard)) { guideGo(guideIndex); return; }
    guideWrap = saved.wrap !== false; guideIntent = 'guided';
    drawerTab = saved.drawerTab;
    drawer.classList.toggle('visible', saved.drawerOpen); document.body.classList.toggle('triage-drawer-open', saved.drawerOpen);
    renderGuide(); renderDrawer(); redrawEdges();
    ({ scale, panX, panY } = saved.camera); applyTransform();
    drawer.scrollTop = saved.scrollTop; flowboard.scrollLeft = saved.scrollLeft; flowboard.scrollTop = saved.scrollTopCode; schedulePersist();
    guideAside.scrollTop = saved.guideScroll || 0;
    if (cards.has(selectedCard)) cards.get(selectedCard).codeEl.parentElement.scrollTop = saved.codeScroll || 0;
  }
  function guidePause() {
    guideRequest = null;
    guideNavigation = null; guidePending = false;
    guideIntent = 'explore'; renderPreparation();
    if (!guide || guideMode === 'closed') return;
    if (!guideReturn) guideReturn = guideCapture();
    guideMode = 'explore'; guideNavigation = null; renderGuide(); schedulePersist();
  }
  function beginGuideDetour(identity) {
    // Manual source ownership exists before a guide is ready too. A newer
    // gutter/editor selection invalidates every older async inspection.
    guideNavigation = null; guidePending = false; guideRequest = null;
    if (!guide || sourceStale || guideMode === 'closed') return false;
    if (!guideReturn) guideReturn = guideCapture();
    guideMode = 'detour'; guideIntent = 'explore'; guideNavigation = null; guidePending = false; guideError = null;
    guideDetour = identity || null;
    return true;
  }
  function detourStep() {
    if (guideMode !== 'detour') return null;
    if (guideDetour?.startsWith('input:')) {
      let reference; try { reference = JSON.parse(guideDetour.slice(6)); } catch { /* Old or invalid local presentation state is not guessed. */ }
      const event = Array.isArray(reference) && guide.steps.find(step => step.id === reference[0]), input = event?.inputs?.find(item => item.name === reference[1]);
      const link = input && FlowboardWalkthrough.inputLinks(guide, event, input)[reference[2]];
      if (link) {
        const source = { ...link.unit.source, line: link.span.line, endLine: link.span.endLine };
        return { id: guideDetour, title: reference[2] === 'argument' ? 'Read the caller argument' : 'Read the callee parameter', unit: link.unit, span: link.span, inputReference: true,
          claimId: event.claimId, what: `${link.text}. ${input.origin} (${input.units}).`, transitions: [],
          evidence: { id: guideDetour, claimId: event.claimId, sourceId: link.unit.id, source, stance: 'context', note: input.origin } };
      }
    }
    const manual = profile().evidence.find(item => item.id === guideDetour);
    const entry = guide.draft.evidence.find(item => item.id === guideDetour) || manual;
    if (entry) {
      const candidates = guide.steps.filter(step => step.evidence?.id === entry.id);
      // A shared source note can describe several invocations. Do not borrow
      // a caller/state from an arbitrary occurrence just because code matches.
      const event = candidates.length === 1 ? candidates[0] : null;
      return event || { id: `detour-${entry.id}`, title: manual ? 'Researcher note' : 'Inspect this evidence', evidence: entry,
        unit: guide.draft.sources.find(unit => unit.id === entry.sourceId), claimId: entry.claimId,
        claim: guide.draft.claims.find(item => item.id === entry.claimId), what: entry.note, transitions: [] };
    }
    if (guideDetour === 'new-note') {
      const card = cards.get(evidenceInput.cardId), info = card && hints[card.id];
      return { id: 'new-note', title: 'Add your code note', kind: 'manual-note', source: info && { file: info.file, sourceHash: info.sourceHash, line: evidenceInput.line, endLine: evidenceInput.line },
        text: 'Your note is separate from the checked explanation. Return keeps the unfinished text and restores the review step.' };
    }
    return { id: 'evidence-detour', title: 'Evidence detour', kind: 'detour', text: 'Inspecting a separate code or documentation reference. The numbered review is paused; Return restores its exact position.' };
  }
  function navigateNote(item, card) {
    const detour = beginGuideDetour(item.id);
    checkedLocation = { ...item.source }; selectedCard = card.id;
    if (detour) renderGuide();
    redrawEdges(); schedulePersist();
  }
  function navigateInput(event, input, kind) {
    const link = FlowboardWalkthrough.inputLinks(guide, event, input)[kind]; if (!link) return;
    beginGuideDetour('input:' + JSON.stringify([event.id, input.name, kind]));
    const card = cards.get(guideCard(link.unit));
    if (card) {
      const changed = card.id !== selectedCard;
      selectedCard = card.id; checkedLocation = detourStep().evidence.source;
      renderGuide(); redrawEdges(); if (changed) focusReadable(card); guideReveal(checkedLocation.line); schedulePersist();
    } else {
      guideNavigation = crypto.randomUUID(); guidePending = true;
      send('triage:investigationFocus', { sourceId: link.unit.id, claimId: event.claimId, navigationId: guideNavigation, materialize: true });
      renderGuide();
    }
  }
  function guideStart() {
    guideIntent = 'waiting'; renderPreparation();
    if (sourceStale || readOnly) return false;
    const prepared = FlowboardWalkthrough.build(investigationDraft, report);
    if (!prepared) return false;
    const missing = [...new Map(prepared.steps.filter(step => step.unit && !guideCard(step.unit)).map(step => [step.unit.id, step.unit])).keys()];
    const limit = guideAvailability?.limit || 200, deficit = Math.max(0, cards.size + missing.length - limit);
    if (deficit) {
      guideAvailability = { ready:false, missingSourceIds:missing, limit, materializedCount:cards.size, deficit,
        reason:`This walkthrough needs ${missing.length} missing function card${missing.length === 1 ? '' : 's'}. Remove ${deficit} exploration card${deficit === 1 ? '' : 's'}, then start again.` };
      renderPreparation(); return false;
    }
    // A native deletion normally saves after 400 ms. Reconcile its freed
    // slots before asking the host to materialize the missing guide card;
    // otherwise an immediate Start can still see the old full canvas.
    if (missing.length) persistNow();
    guideAvailability = null;
    if (guide?.key === prepared.key) { guideRestore(); return true; }
    guide = prepared; guidePositions.clear(); guideIndex = 0; guideReturn = null; guideGo(0); return true;
  }
  function guideGo(index) {
    if (!guide || sourceStale || preparing) return;
    const oldCard = selectedCard;
    if (guideMode === 'guided') guidePositions.set(guideIndex, guideCapture());
    guideIndex = Math.max(0, Math.min(guide.steps.length - 1, index)); guideMode = 'guided'; guideIntent = 'guided'; guideReturn = null;
    guideDetour = null; guideError = null; guideRequest = null;
    const step = guide.steps[guideIndex];
    activeInvestigationClaim = step.claimId || activeInvestigationClaim; activeClaim = null; claimFocus = false; spotlight = false;
    visibleInvestigation = guide.draft;
    drawer.classList.remove('visible'); document.body.classList.remove('triage-drawer-open');
    guideNavigation = null;
    checkedLocation = null; guidePending = !!step.evidence; guideAside.scrollTop = 0;
    const cardId = step.unit && guideCard(step.unit);
    if (cardId && step.evidence) {
      selectedCard = cardId; checkedLocation = step.evidence.source; guidePending = false;
      renderGuide(); redrawEdges();
      const previous = guidePositions.get(guideIndex);
      if (previous?.selectedCard === cardId) { ({ scale, panX, panY } = previous.camera); applyTransform(); cards.get(cardId).codeEl.parentElement.scrollTop = previous.codeScroll; }
      else if (oldCard !== cardId || !guidePositions.size) focusReadable(cards.get(cardId));
      guideReveal(step.evidence.source.line); schedulePersist();
    } else if (step.evidence) {
      renderGuide(); redrawEdges();
      guideNavigation = crypto.randomUUID();
      send('triage:investigationFocus', { evidenceId: step.evidence.id, claimId: step.claimId, navigationId: guideNavigation, materialize: true });
    } else { checkedLocation = null; renderGuide(); redrawEdges(); schedulePersist(); }
  }
  function guideEvidence(entry, editor = false) {
    if (!guide || sourceStale) return;
    beginGuideDetour(entry.id); guideNavigation = crypto.randomUUID();
    const unit = guide.draft.sources.find(source => source.id === entry.sourceId);
    send('triage:investigationFocus', { evidenceId: entry.id, claimId: entry.claimId, navigationId: guideNavigation, editor, materialize: !!unit && !guideCard(unit) });
    renderGuide(); schedulePersist();
  }
  function evidenceActions(parent, ids, label = 'Where this comes from') {
    for (const id of [...new Set(ids || [])]) {
      const entry = guide?.draft.evidence.find(item => item.id === id);
      if (!entry) continue;
      const action = button(`${label} · ${entry.source.file}:${entry.source.line}`, () => guideEvidence(entry));
      action.dataset.evidenceId = id; parent.append(action);
    }
  }
  function guideReport(parent, step) {
    const detail = element('details', 'guide-report'); detail.open = true;
    detail.append(element('summary', '', 'Report'));
    if (!step.report) {
      detail.append(element('p', 'triage-muted', 'No exact report paragraph is linked to this saved note.'), button('Read full report', () => { guidePause(); show('report'); }));
    } else {
      const quote = element('blockquote'); quote.dataset.paragraphId = step.report.id;
      quote.tabIndex = 0; quote.setAttribute('aria-label', 'Original report paragraph');
      const relative = step.report.phraseStart === null ? -1 : step.report.phraseStart - step.report.start;
      if (relative < 0) quote.textContent = step.report.text;
      else quote.append(document.createTextNode(step.report.text.slice(0, relative)), element('mark', '', step.report.phrase), document.createTextNode(step.report.text.slice(relative + step.report.phrase.length)));
      detail.append(quote);
      requestAnimationFrame(() => { const mark = quote.querySelector('mark'); if (mark && quote.isConnected) quote.scrollTop = Math.max(0, mark.offsetTop - quote.offsetTop - 32); });
      detail.append(button('Read full report', () => { guidePause(); show('report'); }));
    }
    parent.append(detail);
  }
  function renderOpinion(parent, draft = investigationDraft) {
    if (!readyDraft(draft)) return;
    const assessment = FlowboardWalkthrough.assessment(draft, sourceStale);
    const opinion = element('div', 'guide-opinion');
    const part = (heading, key) => { const node = element('section', 'guide-ai-part'); node.dataset.part = key; node.append(element('h3', '', heading)); opinion.append(node); return node; };
    const result = part('Preliminary assessment', 'assessment');
    result.append(element('strong', `guide-result ${assessment.result}`, assessment.label), element('small', 'triage-muted', 'AI opinion · your saved judgment is separate'));
    const why = part('Why', 'why'); why.append(element('p', '', assessment.why));
    if (draft?.snapshot) {
      const scope = element('details'); scope.append(element('summary', '', 'Checked scope and code version'));
      scope.append(element('p', '', draft.claims.map(item => `${item.id}: ${item.implementation}; ${item.conditions.join('; ')}`).join('\n')),
        element('p', '', `Expected behavior: ${draft.property.text}`),
        element('p', 'triage-muted', draft.property.basis === 'report-assumption' ? 'The expected rule is still an assumption from the report.' : 'The stated rule is linked to code, tests or local documentation; its interpretation still needs review.'),
        element('p', 'triage-muted', `Code snapshot ${draft.snapshot.sourceDigest.slice(0, 12)} · revision ${draft.snapshot.revision?.slice(0, 12) || 'local files'}. File contents include local changes. AI explanations are not independently proved.`));
      why.append(scope);
      for (const id of draft.property.documentation || []) {
        const item = draft.documentation?.excerpts.find(item => item.id === id); if (!item) continue;
        scope.append(button(`${item.source.file}:${item.source.line} · Read expected rule`, () => {
          if (beginGuideDetour(`documentation:${id}`)) renderGuide();
          send('triage:investigationDocumentation', { documentationId: id });
        }));
      }
    }
    const decisive = part('Decisive code', 'code');
    for (const [key, label] of [['supports', 'Supports this statement'], ['contradicts', 'Challenges this statement']]) {
      const entry = assessment[key];
      if (!entry) { decisive.append(element('p', 'triage-muted', key === 'supports' ? 'No supporting code established.' : 'No opposing code established.')); continue; }
      const index = guide?.steps.findIndex(step => step.evidence?.id === entry.id) ?? -1;
      decisive.append(button(`${label} ${entry.claimId}${index >= 0 ? ` · Step ${index + 1}` : ''}`, () => guideEvidence(entry)), element('p', '', entry.note));
    }
    const remains = part('What remains', 'remains'), unknowns = assessment.remaining;
    remains.append(element('p', '', unknowns[0] || (assessment.result === 'unavailable' ? 'Finish preparing the review to see its open questions.' : 'No further material gap was listed in this scoped AI review. This is not a guarantee of correctness.')));
    if (unknowns.length > 1) { const more = element('details'); more.append(element('summary', '', `${unknowns.length - 1} more open questions`)); for (const text of unknowns.slice(1)) more.append(element('p', '', text)); remains.append(more); }
    parent.append(opinion);
  }
  function syncReadingLayout() {
    const open = !!guide && guideMode !== 'closed' && !sourceStale;
    document.body.classList.toggle('guide-open', open); guideControls.hidden = guideAside.hidden = !open;
    document.body.classList.toggle('guide-reading', open && ['guided', 'detour'].includes(guideMode) && !sourceStale);
    document.body.classList.toggle('guide-note-editing', open && guideMode === 'detour' && drawerTab === 'review' && drawer.classList.contains('visible'));
    document.body.classList.toggle('guide-wrap', guideWrap);
    for (const card of cards.values()) card.el.classList.toggle('guide-active-card', card.id === selectedCard);
    document.body.style.setProperty('--guide-card-width', `${Math.max(300, Math.min(680, flowboard.clientWidth - 48))}px`);
    placeGuideAnchor();
    return open;
  }
  function renderGuide() {
    renderPreparation();
    const focusedControl = guideControls.contains(document.activeElement) ? document.activeElement.textContent : null;
    const open = syncReadingLayout();
    guideControls.replaceChildren(); guideAside.replaceChildren();
    document.querySelectorAll('.guide-handoff').forEach(node => node.remove());
    if (!open) return;
    const step = detourStep() || guide.steps[guideIndex];
    guideAside.append(element('header', 'guide-caption', `${guideMode === 'detour' ? 'Detour from step' : 'Step'} ${guideIndex + 1} · ${step.title}`));
    const counter = element('strong', '', `Step ${guideIndex + 1} of ${guide.steps.length}`); counter.setAttribute('aria-live', 'polite');
    const back = button('Previous step', () => guideGo(guideIndex - 1)), next = button('Next step', () => guideGo(guideIndex + 1));
    back.disabled = guideIndex === 0 || sourceStale || !!preparing; next.disabled = guideIndex === guide.steps.length - 1 || sourceStale || !!preparing;
    guideControls.append(counter, back, next, element('span', 'guide-current-title', step.title));
    guideControls.append(guideMode === 'guided' ? button('Explore freely', guidePause) : button(guideMode === 'detour' ? 'Return to step' : 'Resume walkthrough', guideRestore));
    const opinionLabel = FlowboardWalkthrough.assessment(investigationDraft?.phase === 'ready' ? guide.draft : investigationDraft, sourceStale);
    const extras = element('details', 'guide-options'); extras.append(element('summary', '', 'Options'));
    extras.append(button('Restart', () => guideGo(0)), button('Readable size', () => { const card = cards.get(selectedCard); if (card) focusReadable(card); }), button(guideWrap ? 'Turn wrapping off' : 'Wrap code', () => { guideWrap = !guideWrap; renderGuide(); schedulePersist(); }),
      button(guideOpinion ? 'Hide assessment' : 'Show assessment', () => { guideOpinion = !guideOpinion; renderGuide(); schedulePersist(); }));
    guideControls.append(extras);
    guideControls.append(button('Step outline', () => { disclosureState.set('guide-outline', true); const outline = guideAside.querySelector('.guide-outline'); if (outline) { outline.open = true; guideAside.scrollTop += outline.getBoundingClientRect().top - guideAside.getBoundingClientRect().top - 12; } }));
    if (focusedControl) ([...guideControls.querySelectorAll('button')].find(item => item.textContent === focusedControl && !item.disabled) || next.disabled && back || next).focus({ preventScroll: true });
    measureGuideControls();
    guideAside.append(element('small', 'triage-muted', `${issueIdentifier()} · Checked against saved code, not an executed trace`));
    const mechanism = element('details', 'guide-mechanism'); mechanism.append(element('summary', '', 'Finding explanation'), element('p', '', guide.summary));
    const outline = element('details', 'guide-outline'); outline.open = disclosureState.get('guide-outline') === true;
    outline.append(element('summary', '', 'Step outline'));
    const order = element('ol');
    for (const [i, event] of guide.steps.entries()) {
      const li = element('li'), link = button(event.title, () => guideGo(i));
      if (i === guideIndex) { link.setAttribute('aria-current', 'step'); li.className = 'current'; }
      li.append(link); order.append(li);
    }
    outline.append(order); outline.ontoggle = () => disclosureState.set('guide-outline', outline.open);
    if (sourceStale) {
      guideAside.append(element('p', 'triage-warning', 'Code or report changed. Refresh before using these steps.'), button('Refresh code', () => { persistNow(); send('triage:refresh'); })); return;
    }
    if (guide.key !== FlowboardWalkthrough.build(investigationDraft, report)?.key && investigationDraft?.phase === 'ready') guideAside.append(button('New review ready · update steps', () => { guide = null; guideStart(); }));
    if (guideMode !== 'guided') guideAside.append(element('p', 'guide-paused', guideMode === 'detour' ? 'Evidence detour. Return restores your step and reading position.' : 'Exploring freely. Your step is saved.'));
    const note = element('section', 'guide-annotation'); note.dataset.stepId = step.id;
    note.append(element('h2', '', step.title));
    if (guideError) note.append(element('p', 'triage-warning', `Could not open this step's code. ${guideError}`),
      button('Retry opening code', retryGuideNavigation), button('Explore freely', guidePause));
    if (guideMode === 'guided' && step.role && !guide.steps.slice(0, guideIndex).some(prior => prior.unit?.id === step.unit?.id)) note.append(element('p', 'guide-function-role', step.role));
    if (guidePending) { const loading = element('p', 'triage-muted', 'Opening the checked code…'); loading.setAttribute('role', 'status'); note.append(loading); }
    let statement;
    if (step.claim) {
      statement = element('details', 'guide-statement'); statement.append(element('summary', '', `Statement ${step.claimId} · ${FlowboardReading.statement(step.claim.status)}`), element('p', '', step.claim.allegation));
      const conditions = [step.claim.actor && `Actor: ${step.claim.actor}`, ...step.claim.conditions].filter(Boolean);
      for (const text of conditions) statement.append(element('p', '', text));
    }
    if (step.evidence) {
      const entry = step.evidence;
      note.append(button(`Code line ${entry.source.line}${entry.source.endLine !== entry.source.line ? '–' + entry.source.endLine : ''}`, () => guideReveal(entry.source.line), 'guide-line-link'),
        element('h3', '', 'What happens here'),
        element('p', 'guide-explanation', step.what || entry.note));
      if (step.why) note.append(element('h3', '', 'Why it matters'), element('p', '', step.why));
      note.append(element('p', `guide-stance ${entry.stance}`, `${entry.stance === 'supports' ? 'Supports this statement' : entry.stance === 'contradicts' ? 'Challenges this statement' : 'Code context'}${step.claimId ? ' · ' + step.claimId : ' · Researcher note'}`));
      if (statement) note.append(statement);
      if (step.caller || step.actor) note.append(element('p', 'guide-caller', `Who: ${step.actor || step.caller}${step.caller && step.caller !== step.actor ? ' · Caller: ' + step.caller : ''}${step.receiver ? ' → ' + step.receiver : ''}`));
      if (step.conditions?.length) note.append(element('p', 'guide-condition', `When: ${step.conditions.join('; ')}`));
      if (step.transaction || step.invocationId) note.append(element('p', 'guide-frame', `${step.transaction || 'Source context'} · ${step.phase || 'Reading step'} · ${step.invocationId || ''}`));
      if (step.handoff?.dispatch && step.handoff.dispatch.kind !== 'not-applicable') {
        const dispatch = step.handoff.dispatch;
        const detail = element('details', 'guide-execution-context'); detail.append(element('summary', '', 'Caller and execution context'),
          element('p', '', `Receiver expression: ${dispatch.receiver}`),
          element('p', '', `Implementation: ${guide.draft.sources.find(unit => unit.id === dispatch.implementation)?.name || dispatch.implementation}`));
        const context = { same: 'Internal call: the execution address and EVM msg.sender stay the same.', call: 'External call: the callee executes in its own address context.', delegatecall: 'Delegate call: implementation code executes in the caller’s address context.', staticcall: 'Static call: the callee cannot write state.', creation: 'Contract creation starts a constructor context.' }[dispatch.context];
        if (context) detail.append(element('p', '', context));
        const failure = { propagates: 'Failure propagates to the caller on this checked route.', caught: 'The caller catches this failure; check its handler before claiming a full transaction rollback.', 'returns-status': 'The call reports success or failure as a value. Check how the caller uses it.' }[dispatch.failure];
        if (failure) detail.append(element('p', '', failure));
        evidenceActions(detail, dispatch.evidence); note.append(detail);
      }
      if (step.inputs?.length || step.changes?.length || step.effect) {
        const values = element('details', 'guide-values'); values.open = true; values.append(element('summary', '', 'Inputs and changes · source interpretation'));
        if (step.inputs?.length) {
          const table = element('div', 'guide-parameter-table');
          for (const input of step.inputs) {
            const row = element('div', 'guide-input-row'), links = element('div', 'guide-input-evidence');
            for (const [label, value] of [['Caller expression', input.expression], ['Callee parameter', input.name]]) {
              const cell = element('div'); cell.append(element('strong', 'guide-value-label', label), element('code', '', value)); row.append(cell);
            }
            const meaning = element('div', 'guide-input-meaning'); meaning.append(element('strong', 'guide-value-label', 'Meaning / units'), element('span', '', `${input.origin} · ${input.units}`)); row.append(meaning);
            const anchors = FlowboardWalkthrough.inputLinks(guide, step, input);
            if (anchors.argument) links.append(button('Read caller argument', () => navigateInput(step, input, 'argument')));
            if (anchors.parameter) links.append(button('Read callee parameter', () => navigateInput(step, input, 'parameter')));
            evidenceActions(links, input.evidence, 'Read origin'); row.append(links); table.append(row);
          }
          values.append(table);
        }
        if (step.changes?.length) {
          const table = element('table'), header = element('tr');
          for (const label of ['Value', 'Before', 'Operation / after', 'Evidence']) header.append(element('th', '', label)); table.append(header);
          for (const change of step.changes) {
            const row = element('tr'); for (const value of [`${change.name} (${change.units})`, change.before, `${change.operation} → ${change.after}`]) row.append(element('td', '', value));
            const links = element('td'); evidenceActions(links, change.evidence); row.append(links); table.append(row);
          }
          values.append(table);
        }
        values.append(element('p', 'triage-muted', ({intermediate: 'Intermediate effects; reverting this invocation rolls back its writes.', committed: 'Predicted successful transaction outcome, not an executed observation.', 'rolled-back': 'This invocation reverts. Writes within the reverted call do not persist.', condition: 'This step checks the stated condition. See the checked operations for any side effects.', read: 'This step reads context; no write is claimed.', return: 'Control returns to the caller. A return alone does not transfer funds or change the execution address.'})[step.effect]));
        note.append(values);
      }
      const source = button(`${entry.source.file}:${entry.source.line} · Open in editor`, () => step.inputReference ? send('triage:openReference', { file: entry.source.file, line: entry.source.line }) : guide.draft.evidence.some(item => item.id === entry.id) ? guideEvidence(entry, true) : inspectEvidence(entry), 'guide-file-link'); note.append(source);
      if (guideIndex && guideMode === 'guided') note.append(element('p', 'guide-relationship', FlowboardWalkthrough.relationship(guide.steps[guideIndex - 1], step, connections, guideCard)));
      const transitions = step.transitions;
      if (transitions.length) {
        const state = element('details', 'guide-state'); state.append(element('summary', '', 'State change · code interpretation'));
        for (const item of transitions) state.append(element('p', '', `Before: ${item.before}`), element('p', '', `After: ${item.after}`), element('p', 'triage-muted', `${item.timing === 'within-transaction' ? 'Within this function; a later revert can undo this change.' : item.timing === 'later-action' ? 'A separate later action, under the stated conditions.' : item.timing === 'transaction-outcome' ? 'Predicted successful transaction outcome; not an executed observation.' : 'Transaction boundary is not established.'} ${item.conditions.join(' ')}`));
        note.append(state);
      }
      guideReport(note, step);
    } else if (step.kind === 'detour' || step.kind === 'manual-note') {
      note.append(element('p', '', step.text));
      if (step.source) note.append(element('p', 'guide-line-link', `${step.source.file}:${step.source.line}`));
    } else if (step.kind === 'gap') note.append(element('p', 'triage-warning', step.text), button('Read statement details', () => { guidePause(); show('claims'); }));
    else note.append(element('p', '', 'Compare the evidence on both sides. These steps do not decide your final judgment.'), button('Read report', () => { guidePause(); show('report'); }));
    guideAside.append(note, outline, mechanism);
    const watched = guideMode === 'guided' ? FlowboardWalkthrough.watchedChanges(guide, guideIndex) : [];
    if (watched.length) {
      const watch = element('details', 'guide-state-watch'); watch.append(element('summary', '', 'Values in this invocation'),
        element('p', 'triage-muted', 'Last shown changes in this invocation only. Code interpretation, not an executed trace.'));
      for (const change of watched) {
        const row = element('div', 'guide-watched-value');
        row.append(element('strong', '', change.name), element('p', '', `${change.effect === 'rolled-back' ? 'Attempted value, not persisted: ' : ''}${change.after} (${change.units})`),
          element('small', 'triage-muted', `${change.effect === 'rolled-back' ? 'Rolled back · not persisted' : change.effect === 'committed' ? 'Predicted successful outcome' : 'Provisional change'} · ${change.title}`));
        evidenceActions(row, change.evidence); watch.append(row);
      }
      guideAside.append(watch);
    }
    const card = cards.get(selectedCard), nextStep = guide.steps[guideIndex + 1];
    if (card && guideMode === 'guided') {
      const handoff = element('section', 'guide-handoff');
      if (nextStep?.handoff) {
        handoff.append(element('strong', '', `Next · ${nextStep.unit.name}`), element('p', '', FlowboardWalkthrough.relationship(step, nextStep, connections, guideCard)));
      } else {
        const result = FlowboardWalkthrough.assessment(guide.draft);
        handoff.append(element('strong', '', `End of the checked explanation · ${result.label}`), element('p', '', result.why), button('Review assessment', () => {
          guideOpinion = true; renderGuide();
          const opinion = guideAside.querySelector('.guide-opinion');
          if (opinion) guideAside.scrollTop += opinion.getBoundingClientRect().top - guideAside.getBoundingClientRect().top - 12;
          schedulePersist();
        }, 'guide-conclusion-action'));
      }
      card.el.append(handoff);
    }
    if (guideOpinion || guideIndex === guide.steps.length - 1) renderOpinion(guideAside, investigationDraft?.phase === 'ready' ? guide.draft : investigationDraft);
  }
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
    rememberLocation(); guidePause();
    checkedLocation = null;
    activeInvestigationClaim = null;
    activeClaim = id; claimFocus = true; spotlight = false;
    const sources = claimSources();
    const card = [...cards.values()].find(card => hints[card.id] && sources.some(link => FlowboardInline.forSource([link.entry], hints[card.id]).length));
    selectedCard = card?.id || null;
    show('claims'); if (card) focusSourceLine(card, FlowboardInline.forSource(sources.map(link => link.entry), hints[card.id])[0]?.source.line); redrawEdges();
    pushLocation('claim:' + id);
  }
  function addClaim(text) {
    if (readOnly || profile().claims.length >= 20) return;
    if (text.length > 2000) { window.alert('Select one focused statement of at most 2000 characters.'); return; }
    guidePause();
    const id = `claim-${crypto.randomUUID()}`;
    editProfile(value => value.claims.push({ id, text, state: 'unreviewed', evidence: [], questions: [] }));
    activeClaim = id; claimFocus = false; selectedCard = null; show('claims'); drawer.querySelector('[aria-label="Report statement"]')?.focus();
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
    if (reportPreparation && !readyDraft(investigationDraft)) {
      const status = element('section', 'inv-preparation'); status.append(element('h3', '', 'Walkthrough not published'),
        element('p', '', preparationJob(active)?.reason || 'This finding is still being checked. Ready findings, your notes and original code remain available.'),
        button('Open preparation', () => { guideIntent = 'waiting'; renderPreparation(); })); drawer.append(status);
    }
    if (investigationDraft && cards.has(selectedCard)) {
      const card = cards.get(selectedCard), navigationBar = element('div', 'inv-navigation');
      const back = button('Back', () => moveHistory(-1)), forward = button('Forward', () => moveHistory(1));
      back.disabled = navigationIndex <= 0; forward.disabled = navigationIndex >= navigation.length - 1;
      const title = element('strong', '', `${activeInvestigationClaim ? activeInvestigationClaim + ' · ' : ''}${card.data.contract || ''}::${card.name}`);
      title.title = `${hints[card.id]?.file || card.data.file}:${card.data.startLine}`;
      navigationBar.append(title, back, forward, button('Function header', () => focusReadable(card)), button('Explore callers / callees', () => inspectCard(card)));
      drawer.append(navigationBar);
    }
    if (investigationDraft && typeof FlowboardInvestigation !== 'undefined') {
      drawer.append(FlowboardInvestigation.render({ draft: investigationDraft, selected: activeInvestigationClaim,
        disabled: readOnly || sourceStale, correction: investigationCorrection, changed: () => schedulePersist(),
        select: id => {
          rememberLocation(); guidePause(); activeInvestigationClaim = id; visibleInvestigation = structuredClone(investigationDraft); activeClaim = null; claimFocus = false;
          show('claims'); pushLocation('investigation:' + id);
          const claim = investigationDraft.claims.find(item => item.id === id), item = investigationDraft.evidence.find(item => claim?.evidence.includes(item.id));
          if (item) send('triage:investigationFocus', { evidenceId: item.id, claimId: id });
        },
        focus: payload => { rememberLocation(); guidePause(); visibleInvestigation = structuredClone(investigationDraft); activeInvestigationClaim = payload.claimId || activeInvestigationClaim; send('triage:investigationFocus', payload); },
        correct: (change, revision) => send('triage:investigationCorrect', { change, revision }),
        retry: () => send('triage:investigationRetry'), enable: () => send('triage:investigationEnable'),
        runTest: (sourceId, claimId) => send('triage:investigationTest', { sourceId, claimId }) }));
      for (const [index, detail] of [...drawer.querySelectorAll('.inv-workbench details')].entries()) rememberDisclosure(detail, `investigation:${activeInvestigationClaim || 'first'}:${index}`);
    }
    const researcher = FlowboardClaimView.render({ profile: profile(), finding: currentFinding(), issueId: issueIdentifier(), activeId: activeClaim, readOnly, pendingEvidence: hasEvidenceDraft(),
      edit: (change, refresh = false) => { editProfile(change, refresh); FlowboardClaimView.status(drawer, currentFinding()); },
      editFinding: (key, value) => { reviewEdits[key] = value; editProfile(next => { for (const claim of next.claims) claim.state = 'unreviewed'; }); FlowboardClaimView.status(drawer, currentFinding()); },
      selectClaim: focusClaim, addClaim, focusClaim, fullMap: () => { claimFocus = false; redrawEdges(); fit(); },
      removeClaim: id => { editProfile(value => { value.claims = value.claims.filter(claim => claim.id !== id); }); activeClaim = null; claimFocus = false; renderDrawer(); redrawEdges(); },
      readReport: () => show('report'), addEvidence: () => show('review'), inspect: inspectEvidence,
      placement: entry => FlowboardInline.placement(entry, visibleHints()), save: () => saveArgument(), copy: () => saveArgument(true), overall: () => show('review') });
    if (investigationDraft) {
      const manual = element('details', 'inv-manual'); manual.append(element('summary', '', 'Your notes and issue result'), researcher);
      rememberDisclosure(manual, 'investigation:researcher', !!activeClaim); drawer.append(manual);
    } else drawer.append(researcher);
    FlowboardClaimView.status(drawer, currentFinding());
    if (investigation && !claimSources().length) {
      const context = section('Related code is ready');
      context.append(element('p', 'triage-muted', 'No code note is linked yet. Check the related functions before deciding.'),
        button('Browse related code', () => { show('brief'); drawer.querySelector('#triage-preparation')?.scrollIntoView({ block: 'start' }); })); drawer.append(context);
    }
  }
  function claimLinks(parent) {
    const claims = profile().claims; if (!claims.length) return;
    const group = element('section', 'triage-report-claims'); group.append(element('h3', '', 'Report statements'));
    for (const claim of claims) { const item = button(claim.text || 'Untitled statement', () => focusClaim(claim.id), 'triage-claim-select'); item.append(element('small', '', claim.state)); group.append(item); }
    parent.append(group);
  }
  function retryGuideNavigation() {
    const request = guideRequest;
    if (!request || sourceStale || request.issueId !== active || request.token !== token || request.guideKey !== (guide?.key || null)) {
      guidePending = false; guideError = 'This source target is no longer current. Select the evidence again or return to the step.'; renderGuide(); return;
    }
    const payload = { ...request.payload };
    if (request.type === 'triage:inspectEvidence') {
      const current = profile().evidence.find(item => item.id === payload.evidence.id);
      if (!current || current.needsReview || JSON.stringify(current.source) !== JSON.stringify(payload.evidence.source) || current.quote !== payload.evidence.quote) {
        guidePending = false; guideError = 'This note was removed or its source changed. Select its current source again.'; renderGuide(); return;
      }
      payload.evidence = current;
    }
    guideNavigation = crypto.randomUUID(); guidePending = true; guideError = null;
    send(request.type, { ...payload, navigationId: guideNavigation }); renderGuide();
  }
  function send(type, payload = {}) {
    if (type === 'triage:investigationFocus' && guide && guideMode !== 'closed' && !payload.navigationId) {
      beginGuideDetour(payload.evidenceId); guideNavigation = crypto.randomUUID();
      payload = { ...payload, navigationId: guideNavigation }; renderGuide();
    }
    if (type === 'triage:investigationFocus' && payload.navigationId && guide) payload = { ...payload, investigationRevision: guide.draft.revision };
    if (['triage:investigationFocus', 'triage:inspectEvidence'].includes(type) && payload.navigationId) {
      guideRequest = { type, payload: structuredClone(payload), issueId: active, token, guideKey: guide?.key || null };
    }
    vscode.postMessage({ type, issueId: active, token, ...payload });
  }
  function show(tab) {
    if (guideMode === 'guided') guidePause();
    else { guideIntent = 'explore'; renderPreparation(); }
    drawerTab = tab; drawer.dataset.tab = tab; drawer.classList.add('visible'); document.body.classList.add('triage-drawer-open'); syncReadingLayout(); renderDrawer(); redrawEdges();
    schedulePersist();
  }
  function currentFinding() {
    const value = { ...finding, ...reviewEdits, triage: profile() };
    for (const key of ['preconditions', 'evidence', 'openQuestions']) if (typeof value[key] === 'string') value[key] = value[key].split('\n').map(text => text.trim()).filter(Boolean);
    return value;
  }
  function inspectCard(card, remember = true) {
    if (!card) return;
    if (remember) rememberLocation();
    guidePause();
    selectedCard = card.id;
    claimFocus = false; checkedLocation = null;
    disclosureState.set('brief:code', true);
    show('brief'); focusReadable(card); decorateCards(); drawer.querySelector('#triage-inspector')?.scrollIntoView({ block: 'start' });
    if (remember) { pushLocation(card.id); renderDrawer(); }
  }
  function location() { return { selectedCard, activeClaim, activeInvestigationClaim, claimFocus, spotlight, drawerTab, scrollTop: drawer.scrollTop, camera: { scale, panX, panY } }; }
  function rememberLocation() { if (navigationIndex >= 0) navigationViews[navigationIndex] = location(); }
  function pushLocation(key) {
    if (navigation[navigationIndex] === key) { rememberLocation(); return; }
    navigation = [...navigation.slice(0, navigationIndex + 1), key].slice(-60);
    navigationViews = [...navigationViews.slice(0, navigationIndex + 1), location()].slice(-60); navigationIndex = navigation.length - 1;
    schedulePersist();
  }
  function moveHistory(offset) {
    rememberLocation();
    let index = navigationIndex + offset;
    while (index >= 0 && index < navigation.length && !cards.has(navigation[index]) && !navigationViews[index]?.activeClaim && !navigationViews[index]?.activeInvestigationClaim) index += offset;
    if (index >= 0 && index < navigation.length) {
      // Pausing must capture the complete step before history changes its
      // function, highlight or drawer. Otherwise Resume pairs B's explanation
      // with A's card and loses B's exact range.
      guidePause();
      navigationIndex = index; const view = navigationViews[index];
      if (!view) { inspectCard(cards.get(navigation[index]), false); return; }
      checkedLocation = null;
      ({ selectedCard, activeClaim, activeInvestigationClaim, claimFocus, spotlight } = view); show(view.drawerTab);
      ({ scale, panX, panY } = view.camera); applyTransform(); drawer.scrollTop = view.scrollTop; redrawEdges(); schedulePersist();
    }
  }
  function toggle(tab) {
    if (guideMode === 'guided') guidePause();
    else { guideIntent = 'explore'; renderPreparation(); }
    drawerTab = tab; const same = drawer.dataset.tab === tab && drawer.classList.contains('visible');
    drawer.classList.toggle('visible', !same); drawer.dataset.tab = tab;
    document.body.classList.toggle('triage-drawer-open', !same); syncReadingLayout(); renderDrawer(); redrawEdges();
  }
  function select(id) {
    if ((dirtyReview || hasEvidenceDraft()) && !window.confirm('Switch finding? Your unfinished review will be checkpointed locally, not submitted as an assessment.')) return;
    persistNow();
    guideNavigation = null; guideMode = 'closed'; guide = null; guideReturn = null; checkedLocation = null;
    visibleInvestigation = null; activeInvestigationClaim = null; selectedCard = null;
    guideIntent = 'waiting';
    preparing = id; renderGuide(); redrawEdges(); renderBar();
    send('triage:select', { issueId: id });
  }
  function renderBar() {
    // Move the original native controls, rather than replacing their listeners
    // or implementing a second canvas history.
    nativeToolbar?.remove(); nativeUndoButton?.remove();
    bar.replaceChildren();
    bar.append(button('Findings', () => show('findings')));
    const index = library.findIndex(x => x.id === active);
    const prev = button('←', () => select(library[index - 1].id)); prev.title = 'Previous finding'; prev.setAttribute('aria-label', prev.title); prev.disabled = index <= 0;
    const next = button('→', () => select(library[index + 1].id)); next.title = 'Next finding'; next.setAttribute('aria-label', next.title); next.disabled = index < 0 || index === library.length - 1;
    bar.append(prev, next);
    const title = element('span', '', finding.title || 'Flowboard Triage'); title.id = 'triage-title'; bar.append(title);
    const current = { ...finding, ...reviewEdits };
    const gaps = current.triage && FlowboardReview.definitive.includes(current.status) && FlowboardReview.readiness(current).gaps.length;
    const status = element('span', sourceStale || readOnly ? 'triage-warning' : '', (preparing ? `Preparing ${preparing}… current view retained` : sourceStale ? 'Code changed · refresh needed' : readOnly ? 'Code unavailable' : statusLabel(current.status || 'Select a finding')) + (gaps ? ' · review gaps' : '') + (dirtyReview ? ' · unsaved review' : '')); status.id = 'triage-status'; status.setAttribute('role', 'status'); bar.append(status);
    if (sourceStale || readOnly) bar.scrollLeft = 0;
    const attention = FlowboardReview.nextAttention(library, active);
    const nextReview = button('Next review', () => attention && select(attention.id)); nextReview.disabled = !attention; nextReview.title = attention ? `Next needing attention: ${attention.title}` : 'No other finding needs attention in this saved index';
    bar.append(button('Walkthrough', () => guideStart(), 'primary'), button('Summary', () => { guidePause(); show('brief'); }), button('All functions', () => { guidePause(); claimFocus = false; spotlight = false; redrawEdges(); fit(); }));
    if (guide && guideMode === 'closed') bar.append(button('Resume review', guideRestore));
    if (nativeUndoButton) bar.append(nativeUndoButton);
    const more = element('details', 'triage-more'); more.append(element('summary', '', 'More'));
    const menu = element('div', 'triage-more-menu');
    menu.append(button('Report statements', () => { more.open = false; show('claims'); }), button('Edit review', () => { more.open = false; show('review'); }), nextReview,
      button('Copy AI prompt', () => send('triage:prompt')));
    const inline = button(inlineVisible ? 'Hide code notes' : 'Show code notes', () => { inlineVisible = !inlineVisible; renderBar(); redrawEdges(); }); inline.setAttribute('aria-pressed', String(inlineVisible)); menu.append(inline);
    const arrange = button('Arrange functions', arrangeCards); arrange.title = 'Space function cards. Undo restores their positions.'; menu.append(arrange);
    if (nativeToolbar) menu.append(nativeToolbar);
    menu.append(button('Keyboard shortcuts', () => { more.open = false; show('help'); })); more.append(menu); bar.append(more);
    more.addEventListener('keydown', event => { if (event.key === 'Escape') { more.open = false; more.querySelector('summary').focus(); event.stopPropagation(); } });
  }
  function section(title) { const node = element('section', 'triage-section'); node.append(element('h3', '', title)); return node; }
  function resetViewportScroll() { flowboard.scrollLeft = 0; flowboard.scrollTop = 0; }
  function focusReadable(card) {
    resetViewportScroll(); scale = 1;
    // Start at the function header, not halfway down a tall source card.
    panX = 24 - card.x * scale; panY = 24 - card.y * scale; applyTransform(); schedulePersist();
  }
  function focusSourceLine(card, line) {
    if (document.body.classList.contains('guide-reading')) { guideReveal(line); return; }
    focusReadable(card);
    const row = [...card.codeEl.querySelectorAll('[data-source-line]')].find(node => Number(node.dataset.sourceLine) === line);
    if (!row) return;
    const viewport = flowboard.getBoundingClientRect(), target = row.getBoundingClientRect();
    panY += viewport.top + Math.min(140, viewport.height * .2) - target.top;
    applyTransform(); schedulePersist();
  }
  const issueIdentifier = () => FlowboardReading.issueId(finding, library, active);
  function readingStart() {
    const ready = investigationDraft?.phase === 'ready';
    const claim = ready && (investigationDraft.claims.find(item => item.id === activeInvestigationClaim) || investigationDraft.claims[0]);
    const unit = claim && investigationDraft.sources.find(item => item.id === claim.entry);
    const mechanical = investigation?.readingRecommendation;
    const sameStart = unit && mechanical?.source.file === unit.source.file && mechanical.source.line === unit.source.line;
    const name = unit && (unit.signature ? unit.name.replace(/[^:]+$/, unit.signature) : unit.name);
    const recommended = unit ? { source: unit.source, sourceId: unit.id, claimId: claim.id, reason: sameStart ? mechanical.reason : `Start with ${name} to check statement ${claim.id} under its stated conditions.` } : mechanical;
    return FlowboardReading.start([...cards.values()], hints, [...profile().evidence, ...(ready ? investigationDraft.evidence : [])], sourceStale, recommended);
  }
  function readCode(start = readingStart()) {
    if (arguments.length === 0) { guideStart(); return; }
    guidePause();
    if (start.kind === 'context' && start.source) { rememberLocation(); send('triage:addContext', { source: start.source }); return; }
    if (start.kind === 'investigation') { rememberLocation(); visibleInvestigation = structuredClone(investigationDraft); send('triage:investigationFocus', { sourceId: start.sourceId, claimId: start.claimId }); return; }
    const card = cards.get(start.cardId); if (!card) { show('report'); return; }
    rememberLocation(); guidePause(); selectedCard = card.id;
    if (start.claimId) { activeInvestigationClaim = start.claimId; visibleInvestigation = structuredClone(investigationDraft); }
    if (start.entry) {
      checkedLocation = { ...start.entry.source };
      if (start.entry.origin === 'model-interpretation') { visibleInvestigation = structuredClone(investigationDraft); activeInvestigationClaim = start.entry.claimId; }
    } else checkedLocation = null;
    redrawEdges();
    if (window.innerWidth <= 700) { drawer.classList.remove('visible'); document.body.classList.remove('triage-drawer-open'); syncReadingLayout(); }
    if (start.entry) focusSourceLine(card, start.entry.source.line); else focusReadable(card);
    pushLocation(card.id); updateReadingLocation();
  }
  const mappingLabel = value => ({ citation: 'report line', symbol: 'named symbol', description: 'description match', 'source-neighbor': 'source neighbor', reviewer: 'reviewer mapping' }[value] || 'source anchor');
  const stanceLabel = value => ({ supports: 'Supports issue', contradicts: 'Against issue', context: 'Context only' }[value] || value);
  const connectionLabel = value => ({ call: 'Call', 'state-dependency': 'Shared state', hypothesis: 'Possible link' }[value] || 'Possible link');
  const profile = () => {
    const value = FlowboardReview.create(reviewEdits.triage || finding.triage);
    if (!reviewEdits.triage && !finding.triage && investigation?.claims) value.claims = structuredClone(investigation.claims);
    return value;
  };
  const hasEvidenceDraft = () => pendingEvidence.size > 0 || !!(evidenceInput.note?.trim() || evidenceInput.reference?.trim());
  function markDirty() {
    dirtyReview = true; editVersion++;
    document.getElementById('triage-status').textContent = (sourceStale ? 'Code changed · refresh needed' : readOnly ? 'Code unavailable' : statusLabel(reviewEdits.status || finding.status || 'unreviewed')) + ' · unsaved review';
    schedulePersist();
  }
  function editProfile(action, redraw = false) {
    const previous = profile(), next = structuredClone(previous); action(next); FlowboardClaims.reconcile(previous, next); reviewEdits.triage = next; markDirty();
    if (evidencePreview) { const current = next.evidence.find(item => item.id === evidencePreview.evidence.id); evidencePreview = current ? { ...evidencePreview, evidence: current } : null; }
    redrawEdges(); if (redraw) renderDrawer();
  }
  function addFromCard(card, sourceLine) {
    const info = hints[card.id]; if (!info?.file || readOnly) return;
    const line = sourceLine || info.line;
    if (pendingEvidence.size) { window.alert('Wait for the code check to finish.'); return; }
    if (hasEvidenceDraft() && (evidenceInput.cardId !== card.id || evidenceInput.line !== line)) {
      if (!window.confirm('Discard the unadded evidence entry and explain a different source line?')) return;
      evidenceInput = {};
    }
    evidenceInput = { ...evidenceInput, cardId: card.id, line, stance: evidenceInput.stance || 'context' };
    beginGuideDetour('new-note');
    guideIntent = 'explore';
    selectedCard = card.id; checkedLocation = { file: info.file, sourceHash: info.sourceHash, line, endLine: line };
    drawerTab = 'review'; drawer.dataset.tab = 'review'; drawer.classList.add('visible'); document.body.classList.add('triage-drawer-open');
    renderDrawer(); renderGuide(); redrawEdges();
    if (guideMode === 'detour') { focusReadable(card); guideReveal(line); }
    const field = drawer.querySelector('#triage-evidence-note');
    if (field) {
      drawer.scrollTop += field.getBoundingClientRect().top - drawer.getBoundingClientRect().top - Math.min(120, drawer.clientHeight / 3);
      field.focus({ preventScroll: true });
    }
    schedulePersist();
  }
  function inspectEvidence(item) {
    beginGuideDetour(item.id); guideNavigation = crypto.randomUUID();
    if (guide) renderGuide();
    send('triage:inspectEvidence', { evidence:item, navigationId:guideNavigation });
  }
  function renderDrawer() {
    syncReadingLayout();
    if (renderedTab) scrollPositions.set(renderedTab, drawer.scrollTop);
    renderDrawerContent(); renderedTab = drawerTab;
    updateStickyOffsets();
    drawer.scrollTop = scrollPositions.get(drawerTab) || 0;
  }
  function renderDrawerContent() {
    drawer.dataset.tab = drawerTab;
    document.body.classList.toggle('triage-report-reading', drawerTab === 'report');
    document.body.classList.toggle('triage-reviewing', ['review', 'claims'].includes(drawerTab));
    requestAnimationFrame(() => redrawEdges());
    drawer.replaceChildren();
    const tabs = element('div', 'triage-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Finding views');
    for (const [tab, name] of [['brief', 'Summary'], ['flow', 'Functions'], ['claims', 'Statements']]) {
      const item = button(name, () => show(tab), tab === drawerTab ? 'selected' : '');
      item.setAttribute('role', 'tab'); item.setAttribute('aria-selected', String(tab === drawerTab)); tabs.append(item);
      item.onkeydown = event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const nodes = [...tabs.children], index = nodes.indexOf(item), next = nodes[(index + (event.key === 'ArrowLeft' ? nodes.length - 1 : 1)) % nodes.length]; const name = next.textContent; next.click(); [...drawer.querySelectorAll('[role="tab"]')].find(node => node.textContent === name)?.focus(); } };
    }
    const close = button('×', () => { drawer.classList.remove('visible'); document.body.classList.remove('triage-drawer-open'); renderGuide(); redrawEdges(); bar.querySelector('button')?.focus(); });
    close.setAttribute('aria-label', 'Close review panel'); close.title = 'Return to code (Escape)'; tabs.append(close);
    drawer.append(tabs);
    if (sourceStale) {
      const stale = element('div', 'triage-warning'); stale.setAttribute('role', 'status');
      stale.append(element('strong', '', historicalAssessment ? `Historical saved assessment: ${statusLabel(historicalAssessment.status)}` : 'Code has changed. Check this note again.'),
        element('p', '', historicalAssessment ? 'Code or settings changed. The saved review is preserved, but its notes and result need checking again.' : 'Your place and notes are preserved. Save your code, then refresh to check these notes again.'),
        button('Refresh code', () => { persistNow(); send('triage:refresh'); })); drawer.append(stale);
    }
    if (recoveries.length) {
      const recover = element('details', 'triage-warning'); recover.append(element('summary', '', 'Earlier unfinished review is preserved'));
      recover.append(element('p', '', 'A newer draft or source map arrived. Your previous text was not merged into it. Copy the earlier notes to compare; any evidence needs re-review.'));
      const text = element('textarea'); text.readOnly = true; text.setAttribute('aria-label', 'Recovered review text');
      text.value = JSON.stringify(recoveries.map(copy => ({ patch: copy.patch, pendingEvidence: copy.evidenceInput })), null, 2); recover.append(text); drawer.append(recover);
    }
    if (active && drawerTab === 'brief' && (reportPreparation || investigationDraft || preparationState) && (!FlowboardWalkthrough.build(investigationDraft, report) || sourceStale)) {
      // The publication gate hides generated reasoning, not the independently
      // available code explorer and the researcher's manual note controls.
      if (guideIntent === 'explore' && cards.has(selectedCard)) {
        drawer.append(sourceInspector(), button('Preparation status', () => { guideStart(); renderDrawer(); }));
        return;
      }
      if (!preparationSurface.hidden) {
        const original = section('The issue'); original.append(element('h2', '', finding.title),
          element('p', 'triage-muted', `Reported severity: ${finding.reportedSeverity || 'Not supplied'} · Your result: ${statusLabel(finding.status)}`),
          element('p', '', 'Preparation details are beside the code. The original report and your saved review remain available.'),
          button('Read report', () => show('report')), button('Edit your review', () => show('review')));
        drawer.append(original);
      } else preparationContent(drawer);
      return;
    }
    if (active && drawerTab === 'brief' && investigationDraft?.causal) {
      const overview = section('The issue'); overview.append(element('h2', '', finding.title), element('p', '', investigationDraft.causal.summary),
        element('p', 'triage-muted', `Reported severity: ${finding.reportedSeverity || 'Not supplied'} · Your result: ${statusLabel(finding.status)}`));
      overview.append(button(guide ? 'Resume walkthrough' : 'Start walkthrough', guideStart, 'primary'), button('Read report', () => show('report')));
      const scope = element('details'); scope.append(element('summary', '', 'Reviewed scope'), element('p', '', investigationDraft.causal.scope)); overview.append(scope); drawer.append(overview);
      renderOpinion(drawer);
      if (guideIntent === 'explore' && cards.has(selectedCard)) drawer.append(sourceInspector());
      return;
    }
    if (drawerTab === 'help') {
      const help = section('Keyboard shortcuts');
      for (const line of ['Alt+1…6: Findings, Summary, Functions, Edit review, Report, Statements', 'Alt+Left / Right: previous / next code location', 'Ctrl/Cmd+S while editing: save review', 'Escape: close panel; unsaved edits remain', 'Resize divider: Left / Right arrows; Home resets width']) help.append(element('p', '', line));
      help.append(element('p', 'triage-muted', 'Shortcuts do not navigate away while you type in an input. Native canvas shortcuts remain available.')); drawer.append(help); return;
    }
    if (drawerTab === 'findings') {
      const input = element('input'); input.placeholder = 'Search title, file, severity or status'; input.value = filter; input.setAttribute('aria-label', 'Search findings');
      input.oninput = () => { filter = input.value; renderDrawer(); const box = drawer.querySelector('input'); box.focus(); box.setSelectionRange(filter.length, filter.length); };
      drawer.append(input);
      const modes = element('select'); modes.setAttribute('aria-label', 'Finding queue filter');
      for (const [id, label] of [['all', 'All findings'], ['attention', 'Needs attention'], ['unreviewed', 'Not checked'], ['unmapped', 'No matching code'], ['confirmed', 'Confirmed bug'], ['invalid', 'Not a bug'], ['design-decision', 'By design'], ['already-fixed', 'Already fixed']]) {
        const option = element('option', '', `${label} (${FlowboardReview.queue(library, '', id).length})`); option.value = id; modes.append(option);
      }
      for (const [state, label] of [['ready', 'Ready walkthroughs'], ['queued', 'Queued'], ['running', 'Checking'], ['waiting-for-provider-capacity', 'Waiting for capacity'], ['blocked', 'Blocked'], ['failed', 'Failed'], ['stale', 'Code changed']]) {
        const option = element('option', '', label); option.value = `preparation:${state}`; modes.append(option);
      }
      modes.value = queueMode; modes.onchange = () => { queueMode = modes.value; renderDrawer(); }; drawer.append(modes);
      const visible = FlowboardReview.queue(library, filter, queueMode.startsWith('preparation:') ? 'all' : queueMode);
      drawer.append(element('p', 'triage-muted triage-preparation-counts', preparationCounts()));
      if (library.some(issue => issue.mappingPending)) drawer.append(element('p', 'triage-muted', reportPreparation ? 'Report preparation runs in the background. Choose a finding to explore its code; saved reviews are kept.' : 'Choose a finding to read its code. Your saved reviews are kept.'));
      const list = element('div', 'triage-list');
      for (const issue of visible) {
        const item = button(`${issue.displayId || issue.id} · ${issue.title}`, () => select(issue.id), issue.id === active ? 'current' : '');
        item.dataset.findingId = issue.id;
        item.append(element('small', '', `Reported severity: ${issue.severity} · Your result: ${issue.status === 'unreviewed' ? 'Not reviewed' : statusLabel(issue.status)}${issue.staleEvidence ? ' · old evidence' : ''}`),
          element('span', 'triage-preparation-badge'), element('span', 'triage-ready-action', 'Open walkthrough'), element('small', 'triage-job-reason'));
        list.append(item);
      }
      if (library.length && !visible.length) list.append(element('p', 'triage-muted', 'No matching findings. Clear the search or change the queue filter.'));
      if (!library.length) list.append(element('p', 'triage-muted', 'Import a .txt/.md report using Flowboard Triage: Import Report. Individual finding requests also work.'));
      drawer.append(list); updatePreparationRows(); return;
    }
    const context = element('details', 'triage-source-details'); context.open = readOnly;
    context.append(element('summary', '', `Code details${warnings.length ? ' · check warnings' : ''}`));
    context.append(element('p', 'triage-muted', `Checkout ${(git.head || 'not versioned').slice(0, 12)}${git.dirty ? ' + modified files' : ''} · ${diagnostics.mode || 'source'} navigation`));
    context.append(element('p', 'triage-muted', 'Report revision: ' + (finding.reportRevision || 'unknown — confirm that the cited functions match.')));
    if (warnings.length) {
      const details = element('details', 'triage-context-warnings'); details.open = readOnly;
      details.append(element('summary', '', `${warnings.length} code warning${warnings.length === 1 ? '' : 's'}`));
      for (const warning of warnings) details.append(element('p', 'triage-warning', warning)); context.append(details);
    }
    if (diagnostics.success === false) context.append(element('p', 'triage-warning', 'Slither could not run. You can still read and navigate the code.'));
    rememberDisclosure(context, 'code-details');
    if (active) {
      const actions = element('div', 'triage-report-actions');
      actions.append(button('Refresh code', () => {
        if (!(dirtyReview || hasEvidenceDraft()) || window.confirm('Refresh the source map? Your unfinished review will be preserved separately for comparison, not silently merged into new source.')) { persistNow(); send('triage:refresh'); }
      })); context.append(actions);
    }
    if (drawerTab === 'brief') { renderBrief(context); return; }
    if (drawerTab === 'claims') { renderClaims(); drawer.append(context); return; }
    drawer.append(context);
    if (drawerTab === 'flow') {
      const overview = section('Related functions');
      overview.append(button('Read original report', () => show('report')),
        element('p', 'triage-muted', 'Connections show code relationships, not a proven execution order. Select a function to read it.'));
      if (validation.cards) overview.append(element('p', 'triage-validation', `${validation.cards} source cards checked · ${validation.sourceCalls || 0} unique direct call relationships found. Report relevance and runtime reachability still require review.`));
      const search = element('input'); search.placeholder = 'Filter functions, files or explanations'; search.setAttribute('aria-label', 'Search mapped functions'); search.value = flowFilter;
      search.oninput = () => { flowFilter = search.value; renderDrawer(); const input = drawer.querySelector('[aria-label="Search mapped functions"]'); input.focus(); input.setSelectionRange(flowFilter.length, flowFilter.length); }; overview.append(search);
      let matched = 0;
      for (const card of cards.values()) {
        const info = hints[card.id];
        if (!`${card.name} ${card.data.contract || ''} ${info?.file || ''} ${info?.description || ''}`.toLowerCase().includes(flowFilter.toLowerCase())) continue;
        matched++;
        const item = button(`${card.data.contract ? card.data.contract + '::' : ''}${card.name}`, () => inspectCard(card), 'triage-flow-item');
        item.append(element('small', '', info?.range || `${card.data.file || 'Unknown file'}:${card.data.startLine || '?'}`));
        const checkedSteps = readyDraft(investigationDraft) ? FlowboardWalkthrough.build(investigationDraft, report)?.steps.filter(step => guideCard(step.unit) === card.id) || [] : [];
        if (checkedSteps.length) {
          for (const step of checkedSteps) item.append(element('p', 'triage-muted', `${step.claimId} · ${step.role || step.why}`));
          item.append(element('small', 'triage-mapping', 'Checked for these statements only'));
        } else {
          if (info?.description) item.append(element('p', 'triage-muted', info.description));
          if (info?.mapping) item.append(element('small', 'triage-mapping', `${mappingLabel(info.mapping.method)} · Exploration code`));
        }
        overview.append(item);
        if (info?.guards?.length) {
          const guards = element('details', 'triage-guards'); guards.append(element('summary', '', 'Conditions and branches'));
          guards.append(element('p', 'triage-muted', 'Conditions found in the function, not a complete reachability proof.'));
          for (const value of info.guards) guards.append(element('code', '', value)); overview.append(guards);
        }
      }
      if (cards.size && !matched) overview.append(element('p', 'triage-muted', 'No mapped function matches this filter. The canvas is unchanged.'));
      if (!cards.size) overview.append(element('p', 'triage-muted', 'No matching code was found. Read the report and check the repository.'));
      drawer.append(overview);
      const links = section('Connection rationale');
      for (const edge of edges) {
        const from = cards.get(edge.from), to = cards.get(edge.to);
        if (!from || !to) continue;
        const meta = connections.find(x => x.from === edge.from && x.to === edge.to);
        const item = element('div', 'triage-flow-link');
        item.append(button(`${from.name} → ${to.name}`, () => inspectCard(to)), element('small', '', connectionLabel(meta?.kind)),
          element('p', 'triage-muted', meta?.reason || 'Manually drawn or expanded candidate. Confirm dispatch and runtime context in source.'));
        links.append(item);
      }
      if (!links.querySelector('.triage-flow-link')) links.append(element('p', 'triage-muted', 'No connections established. The absence of an arrow does not prove that the claim is invalid.'));
      drawer.append(links);
      if (retrieval) {
        const candidates = section('Related code from report wording');
        candidates.append(element('p', 'triage-muted', `${retrieval.searchedFunctions} function definitions searched. These are relevance suggestions, not automatically established finding targets.`));
        for (const candidate of retrieval.candidates || []) {
          const item = button(`${candidate.contract || ''}::${candidate.function}`, () => {
            const card = [...cards.values()].find(value => value.name === candidate.function && hints[value.id]?.range?.startsWith(`${candidate.file}:${candidate.line}-`));
            if (card) inspectCard(card); else send('triage:openReference', { file: candidate.file, line: candidate.line });
          }, 'triage-flow-item');
          item.append(element('small', '', `${candidate.file}:${candidate.line}`), element('p', 'triage-muted', candidate.reason)); candidates.append(item);
        }
        if (!retrieval.candidates?.length) candidates.append(element('p', 'triage-warning', 'No matching code was found. Check the report and repository; no path was guessed.'));
        drawer.append(candidates);
      }
      return;
    }
    if (drawerTab === 'report') {
      const original = section('Reported claim');
      original.append(element('p', 'triage-report-caption', 'Original report · statements to check against the code.'));
      original.append(element('h2', 'triage-report-title', finding.title || 'Selected finding'));
      const actions = element('div', 'triage-report-actions');
      actions.append(button(rawReport ? 'Reading view' : 'Raw text', () => { rawReport = !rawReport; renderDrawer(); }), button('Copy original', () => send('triage:copyReport')));
      const fromSelection = button('Review selected text', () => { if (!reportSelection) { window.alert('Select one report statement first.'); return; } addClaim(reportSelection); });
      fromSelection.disabled = readOnly; fromSelection.onmousedown = event => event.preventDefault(); actions.append(fromSelection);
      original.append(actions);
      const route = FlowboardWalkthrough.build(investigationDraft, report);
      if (route) {
        const linked = element('details', 'guide-report-links'); linked.append(element('summary', '', 'Linked report statements'));
        for (const paragraph of FlowboardWalkthrough.paragraphs(report)) {
          const steps = route.steps.filter(step => step.report?.id === paragraph.id); if (!steps.length) continue;
          const quote = element('blockquote', '', paragraph.text); quote.dataset.paragraphId = paragraph.id; linked.append(quote);
          for (const step of steps) linked.append(button(`Step ${route.steps.indexOf(step) + 1}: ${step.title}`, () => { guide = route; guideGo(route.steps.indexOf(step)); }));
        }
        original.append(linked);
      }
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
    const claim = section('The report statement');
    claim.append(element('p', 'triage-claim', finding.summary || finding.title),
      element('p', 'triage-muted', 'First identify the rule that should hold. A call graph alone cannot distinguish a bug from intended behavior.'),
      button('Read report', () => { drawerTab = 'report'; renderDrawer(); })); form.append(claim);
    const behavior = section('2 · Compare intended and actual behavior');
    behavior.append(element('p', 'triage-muted', 'Imported descriptions are unreviewed starting points. Replace them with what you checked in the specification and source.'));
    const comparison = element('div', 'triage-comparison'), intended = element('div'), actual = element('div');
    control('expectedBehavior', 'Expected behavior', null, false, intended);
    control('actualBehavior', 'What the code does', null, false, actual); comparison.append(intended, actual); behavior.append(comparison);
    profileControl('actor', 'Who can invoke this code? Which permissions apply?', behavior);
    control('preconditions', 'Required state / conditions (one per line)', null, true, behavior); form.append(behavior);
    const proof = section('3 · Evidence for and against');
    proof.append(element('p', 'triage-muted', 'Attach facts to source lines or specification/test references. Stances are reviewer judgments, not automatically proven facts.'));
    const ledger = element('div', 'triage-evidence-ledger');
    const evidenceModes = element('select'); evidenceModes.setAttribute('aria-label', 'Filter evidence');
    for (const [id, label] of [['all', 'All evidence'], ['supports', 'Supports issue'], ['contradicts', 'Against issue'], ['context', 'Context only'], ['stale', 'Needs re-review']]) {
      const option = element('option', '', label); option.value = id; evidenceModes.append(option);
    }
    evidenceModes.value = evidenceFilter; evidenceModes.onchange = () => { evidenceFilter = evidenceModes.value; renderDrawer(); }; proof.append(evidenceModes);
    for (const item of profile().evidence) {
      if (evidenceFilter !== 'all' && !(evidenceFilter === 'stale' ? item.needsReview || item.source && !item.source.sourceHash : item.stance === evidenceFilter)) continue;
      const row = element('div', `triage-evidence-entry ${item.stance}`);
      const caption = element('div', 'triage-evidence-caption'); caption.append(element('strong', '', FlowboardReading.relation(item.stance, 'issue', issueIdentifier())),
        button(editingEvidence === item.id ? 'Done' : 'Edit note', () => { editingEvidence = editingEvidence === item.id ? null : item.id; renderDrawer(); }),
        button('Remove', () => {
          if (!window.confirm('Remove this evidence and its claim links? Affected claim assessments become unreviewed. The saved draft changes only when you save.')) return;
          if (evidencePreview?.evidence.id === item.id) { evidencePreview = null; for (const card of cards.values()) card.el.classList.remove('triage-evidence-focus'); }
          editProfile(value => FlowboardClaims.detach(value, item.id), true);
        }));
      row.append(caption, button(item.source ? `${item.source.file}:${item.source.line}${item.source.endLine && item.source.endLine !== item.source.line ? '-' + item.source.endLine : ''}` : item.reference, () => inspectEvidence(item), 'triage-evidence-reference'),
        element('p', 'triage-evidence-note', item.note)); ledger.append(row);
      row.append(element('small', 'triage-muted', FlowboardReview.bases[item.basis] || 'Reviewer interpretation · origin not recorded'));
      if (item.needsReview) row.append(element('p', 'triage-warning', 'Code has changed. Check this note again.'));
      const placement = FlowboardInline.placement(item, visibleHints());
      if (placement) row.append(element('p', 'triage-placement-warning', placement));
      if (editingEvidence === item.id) {
        const stance = element('select'); stance.setAttribute('aria-label', 'Edit evidence stance');
        for (const name of ['supports', 'contradicts', 'context']) { const option = element('option', '', stanceLabel(name)); option.value = name; stance.append(option); }
        stance.value = item.stance;
        const note = element('textarea'); note.value = item.note; note.setAttribute('aria-label', 'Edit evidence explanation'); note.maxLength = 4000;
        const category = categorySelect(item.category || FlowboardInline.category(item), 'Edit inline note category');
        const update = () => { editProfile(value => { const entry = value.evidence.find(entry => entry.id === item.id); entry.note = note.value; entry.stance = stance.value; entry.category = category.value; }); updateReadiness(); };
        stance.onchange = update; category.onchange = update; note.oninput = update; row.append(stance, category, note, element('p', 'triage-muted', 'The code location and check status stay unchanged. Add a new note to use a different location.'));
      }
    }
    if (!ledger.children.length) ledger.append(element('p', 'triage-muted', profile().evidence.length ? 'No evidence matches this filter.' : 'No code notes yet. Select a function below or choose More → Add code note on a function.'));
    proof.append(ledger);
    if (evidencePreview) {
      const preview = element('div', 'triage-evidence-preview'); preview.append(element('strong', '', stanceLabel(evidencePreview.evidence.stance)),
        element('p', '', evidencePreview.evidence.note));
      if (evidencePreview.excerpt) preview.append(element('p', 'triage-muted', 'The code at this exact location is open in the editor. Check its function and modifiers there.'), element('pre', '', evidencePreview.excerpt));
      else preview.append(element('p', '', evidencePreview.evidence.reference)); proof.append(preview);
    }
    const entry = element('details', 'triage-evidence-editor'); entry.open = !!evidenceInput.cardId || hasEvidenceDraft() || !profile().evidence.length; entry.append(element('summary', '', 'Add focused evidence'));
    const stance = element('select'); stance.id = 'triage-evidence-stance'; stance.setAttribute('aria-label', 'Evidence stance');
    for (const value of ['supports', 'contradicts', 'context']) { const option = element('option', '', stanceLabel(value)); option.value = value; stance.append(option); }
    stance.value = evidenceInput.stance || 'context'; stance.onchange = () => { evidenceInput.stance = stance.value; }; entry.append(stance);
    const category = categorySelect(evidenceInput.category || 'behavior', 'Inline note category'); category.onchange = () => { evidenceInput.category = category.value; }; entry.append(category);
    const basis = element('select'); basis.setAttribute('aria-label', 'Evidence basis');
    for (const [id, label] of Object.entries(FlowboardReview.bases)) { const option = element('option', '', label); option.value = id; basis.append(option); }
    basis.value = evidenceInput.basis || 'inference'; basis.onchange = () => { evidenceInput.basis = basis.value; if (['report-claim', 'open-question'].includes(basis.value)) { stance.value = 'context'; evidenceInput.stance = 'context'; } schedulePersist(); }; entry.append(basis);
    const source = element('select'); source.id = 'triage-evidence-source'; source.setAttribute('aria-label', 'Function for this note');
    const other = element('option', '', 'Specification / test / other reference'); other.value = ''; source.append(other);
    for (const card of cards.values()) if (hints[card.id]?.file) {
      const option = element('option', '', `${card.data.contract || ''}::${card.name} · ${hints[card.id].range}`); option.value = card.id; source.append(option);
    }
    source.value = evidenceInput.cardId || '';
    const line = element('input'); line.type = 'number'; line.min = 1; line.id = 'triage-evidence-line'; line.setAttribute('aria-label', 'First code line'); line.value = evidenceInput.line || '';
    line.placeholder = 'Code line number';
    line.oninput = () => { evidenceInput.line = Number(line.value); };
    const endLine = element('input'); endLine.type = 'number'; endLine.min = 1; endLine.setAttribute('aria-label', 'Last code line');
    endLine.placeholder = 'Through line (optional)'; endLine.value = evidenceInput.endLine || ''; endLine.oninput = () => { if (endLine.value) evidenceInput.endLine = Number(endLine.value); else delete evidenceInput.endLine; schedulePersist(); };
    const reference = element('input'); reference.id = 'triage-evidence-reference'; reference.placeholder = 'Specification section, test file, or design reference'; reference.setAttribute('aria-label', 'Evidence reference'); reference.value = evidenceInput.reference || '';
    reference.oninput = () => { evidenceInput.reference = reference.value; markDirty(); };
    const showInputs = () => { line.hidden = !source.value; endLine.hidden = !source.value; reference.hidden = !!source.value; };
    source.onchange = () => { evidenceInput.cardId = source.value; if (source.value) { evidenceInput.line = hints[source.value].line; line.value = evidenceInput.line; } showInputs(); };
    showInputs(); entry.append(source, line, endLine, reference);
    const note = element('textarea'); note.id = 'triage-evidence-note'; note.placeholder = 'What does this establish, and why does it support or refute the claim?'; note.setAttribute('aria-label', 'Evidence explanation'); note.value = evidenceInput.note || '';
    note.oninput = () => { evidenceInput.note = note.value; markDirty(); }; entry.append(note);
    const add = button(pendingEvidence.size ? 'Checking code…' : 'Add evidence', () => {
      const item = { id: `e-${crypto.randomUUID()}`, stance: stance.value, category: category.value, basis: basis.value, note: note.value.trim(),
        ...(source.value ? { source: { file: hints[source.value].file, line: Number(line.value), ...(endLine.value ? { endLine: Number(endLine.value) } : {}) } } : { reference: reference.value.trim() }) };
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
      const reason = element('textarea'); reason.setAttribute('aria-label', checkpoint.title + ' reasoning'); reason.placeholder = 'Explain what you checked and what is still missing.'; reason.value = item.note;
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
  function renderBrief(codeDetails) {
    const value = currentFinding(), ready = FlowboardReview.readiness(value);
    const hero = section('The issue'); hero.classList.add('triage-overview'); hero.dataset.readingGroup = 'issue';
    hero.append(element('h2', 'triage-report-title', value.title || 'Select a finding'));
    const result = element('div', 'triage-issue-result');
    result.append(element('span', '', `Reported severity: ${value.reportedSeverity || value.severity || library.find(item => item.id === active)?.severity || 'Not given'}`), element('span', '', `Review result: ${statusLabel(value.status)}`)); hero.append(result); drawer.append(hero);
    const start = section('Start here'); start.dataset.readingGroup = 'start';
    start.append(element('strong', 'triage-muted', 'The report says'));
    const allegation = investigation?.claims?.[0]?.text || value.summary || 'Read the original report to establish its claim.';
    if (allegation.length <= 500) start.append(element('p', 'triage-brief-claim', allegation));
    else { const text = element('details'); text.append(element('summary', '', 'Read the report statement'), element('p', 'triage-brief-claim', allegation)); start.append(text); }
    const target = readingStart();
    start.append(element('p', 'triage-reading-guide', target.message));
    const startCard = cards.get(target.cardId);
    if (startCard) start.append(element('p', 'triage-reading-target', `${target.entry ? 'Code note in' : 'Related function'}: ${startCard.data.contract ? startCard.data.contract + '::' : ''}${startCard.name}`));
    const actions = element('div', 'triage-report-actions');
    const read = button('Read code', () => readCode(), 'primary'); read.disabled = !target.cardId && !target.source;
    actions.append(read, button('Read report', () => show('report'))); start.append(actions);
    if (readyDraft(investigationDraft)) {
      const opinion = FlowboardWalkthrough.assessment(investigationDraft, sourceStale);
      start.append(element('p', 'triage-muted', `Preliminary AI assessment: ${opinion.label}. Your saved judgment is separate.`));
    }
    if (!sourceStale && investigationDraft?.phase === 'ready') {
      const draft = investigationDraft, relevant = draft.claims.find(item => item.id === activeInvestigationClaim) || draft.claims[0];
      const entries = draft.evidence.filter(item => relevant?.evidence.includes(item.id));
      const strongest = entries.find(item => item.stance === 'contradicts') || entries.find(item => item.stance === 'supports') || entries[0];
      if (strongest) {
        const fact = element('div', 'triage-brief-block'); fact.append(element('strong', '', 'What the code shows'), element('small', 'triage-muted', FlowboardReading.relation(strongest.stance, 'statement', relevant.id)));
        const why = element('details'); why.append(element('summary', '', 'Why it matters'), element('p', '', strongest.note)); rememberDisclosure(why, `brief:strongest:${relevant.id}`);
        fact.append(why, button('Read this note', () => { guidePause(); visibleInvestigation = structuredClone(draft); activeInvestigationClaim = relevant.id; send('triage:investigationFocus', { evidenceId: strongest.id, claimId: relevant.id }); })); start.append(fact);
      }
    }
    const question = investigationDraft?.claims?.find(item => item.id === activeInvestigationClaim)?.nextQuestion || investigationDraft?.claims?.[0]?.nextQuestion || value.openQuestions?.[0] || investigation?.nextQuestion || FlowboardReview.nextQuestion(value)?.question;
    const unclear = element('div', 'triage-unclear'); unclear.append(element('strong', '', 'Still unclear'), element('p', '', question || 'Check the report against the code before deciding.')); start.append(unclear); drawer.append(start);
    const details = section('Details'); details.dataset.readingGroup = 'details';
    const fold = (title, key) => { const node = element('details', 'triage-reading-detail'); node.append(element('summary', '', title)); rememberDisclosure(node, `brief:${key}`); details.append(node); return node; };
    const explanation = fold('Explanation and open questions', 'explanation');
    const expectedLabel = value.triage.ruleOrigin?.kind === 'report' || investigationDraft?.property?.basis === 'report-assumption' ? 'Expected behavior · reported, not independently checked' : 'Expected behavior';
    for (const [label, text] of [[expectedLabel, value.expectedBehavior || investigationDraft?.property?.text], ['What the code does', value.actualBehavior], ['Why', value.triage.decisionReason]]) {
      if (!text) continue;
      const block = element('div', 'triage-brief-block'); block.append(element('strong', '', label), element('p', '', text)); explanation.append(block);
    }
    for (const text of (value.openQuestions || []).slice(1)) explanation.append(element('p', '', text));
    if (ready.outdated) explanation.append(element('p', 'triage-warning', 'Code has changed. Check the older notes again.'));
    for (const note of FlowboardReview.quality(value)) explanation.append(element('p', 'triage-warning', note));
    explanation.append(button('Report statements and evidence', () => show('claims')));
    if (readyDraft(investigationDraft)) {
      const generated = fold('Automatic review', 'automatic');
      generated.append(element('p', 'triage-muted', 'A draft to check, separate from your review result.'), element('p', '', investigationDraft.conclusion.text), button('Read review and opposing evidence', () => show('claims')));
    }
    const code = fold('Related functions', 'code');
    code.append(sourceInspector(), button('Browse functions', () => show('flow')));
    if (investigation) { const prepared = fold('Other code to check', 'preparation'); renderDiscovery(prepared); }
    if (codeDetails) details.append(codeDetails);
    details.append(button('Edit review', () => show('review'))); drawer.append(details);
    const anchors = [...cards.values()].filter(card => hints[card.id]?.file).map(card => ({ file: hints[card.id].file, line: hints[card.id].line, function: card.name }));
    const related = FlowboardReview.related(library, active, anchors);
    {
      const sectionNode = section('Related issues'); sectionNode.dataset.readingGroup = 'related';
      sectionNode.append(element('p', 'triage-muted', related.length ? 'Touches the same code, but may have a different cause.' : 'No other issues touch this code.'));
      for (const issue of related) { const item = button(`${issue.displayId || issue.id} · ${issue.title}`, () => select(issue.id), 'triage-neighbor'); item.append(element('small', '', issue.shared.length ? `${issue.shared.length} identical source anchors` : `Shared file: ${issue.sharedFiles.join(', ')}`)); sectionNode.append(item); }
      drawer.append(sectionNode);
    }
  }
  function sourceInspector() {
    const card = cards.get(selectedCard);
    const inspect = section(card ? 'Selected function' : 'Choose a function'); inspect.id = 'triage-inspector';
    if (!card) {
      inspect.append(element('p', 'triage-muted', 'Choose a function to read its conditions and related code.'));
      const first = cards.values().next().value;
      if (first) inspect.append(button('Read first function', () => inspectCard(first)));
      else inspect.append(button('Read report', () => show('report')));
    } else {
      const info = hints[card.id] || {}, nav = element('div', 'triage-report-actions triage-inspector-navigation');
      const back = button('Back', () => moveHistory(-1)), forward = button('Forward', () => moveHistory(1)); back.disabled = navigationIndex <= 0; forward.disabled = navigationIndex >= navigation.length - 1;
      nav.append(back, forward, button(spotlight ? 'Show all cards' : 'Focus neighborhood', () => { spotlight = !spotlight; renderDrawer(); redrawEdges(); }));
      inspect.append(nav, element('h3', '', `${card.data.contract || ''}::${card.name}`), element('p', 'triage-muted', info.range || 'Code details'),
        element('p', '', info.description || 'This function has no explanation yet. Read the code and check its role in the report.'));
      if (info.mapping) inspect.append(element('p', 'triage-muted', `Mapped by ${mappingLabel(info.mapping.method)}; relevance still needs review.`));
      const actions = element('div', 'triage-report-actions');
      const open = button('Open in editor', () => send('triage:openReference', { file: info.file, line: info.line })); open.disabled = !info.file;
      const evidence = button('Add code note', () => addFromCard(card)); evidence.disabled = readOnly || !info.file;
      const ask = button('Copy function prompt', () => send('triage:prompt', { cardId: card.id })); ask.disabled = readOnly || !info.file;
      actions.append(open, evidence, ask); inspect.append(actions);
      if (info.modifiers?.length) inspect.append(element('p', '', `Modifiers: ${info.modifiers.join(', ')}`));
      if (info.guards?.length) { const guards = element('details'); guards.append(element('summary', '', 'Conditions found in this function')); for (const guard of info.guards) guards.append(element('pre', 'triage-inline-code', guard)); inspect.append(guards); }
      const prepared = investigation?.contexts.find(item => card.id.endsWith(':' + item.cardId));
      if (prepared) {
        const calls = element('details', 'triage-prepared-calls'); calls.append(element('summary', '', `Calls and possible implementations (${prepared.calls.length})`));
        calls.append(element('p', 'triage-muted', 'Listed as written, not as a proven route. Check branches, reverts and later transactions separately.'));
        for (const site of prepared.calls) {
          const row = element('div', 'triage-prepared-call');
          row.append(button(`${site.expression} · L${site.source.line}`, () => { focusSourceLine(card, site.source.line); send('triage:openReference', { file: site.source.file, line: site.source.line }); }));
          if (!site.targets.length) row.append(element('p', 'triage-warning', 'The called implementation is not known yet.'));
          else {
            row.append(element('small', '', site.resolution === 'direct-internal' ? 'Internal call found in code; check its conditions' : site.targetCount > 1 ? `${site.targetCount} alternatives; no target selected` : 'Possible implementation; check which one is used'));
            for (const target of site.targets) row.append(sourceCandidate(target));
          }
          calls.append(row);
        }
        if (prepared.calls.length) inspect.append(calls);
      }
      const neighbors = edges.filter(edge => edge.from === card.id || edge.to === card.id);
      inspect.append(element('p', 'triage-muted', 'Adjacent diagram relationships — not an execution order.'));
      for (const edge of neighbors) {
        const other = cards.get(edge.from === card.id ? edge.to : edge.from); if (!other) continue;
        const meta = connections.find(item => item.from === edge.from && item.to === edge.to);
        const link = button(`${edge.from === card.id ? '→' : '←'} ${other.name} · ${connectionLabel(meta?.kind)}`, () => inspectCard(other), 'triage-neighbor');
        link.append(element('small', '', meta?.reason || 'Possible relationship. Check the linked code.')); inspect.append(link);
      }
      if (!neighbors.length) inspect.append(element('p', 'triage-muted', 'No adjacent relationships drawn. Check modifiers and external implementations in source when relevant.'));
    }
    return inspect;
  }
  function sourceCandidate(source) {
    const item = button(`${source.name} · ${source.file}:${source.line}`, () => {
      const existing = [...cards.values()].find(card => hints[card.id]?.file === source.file && hints[card.id].line <= source.line && hints[card.id].endLine >= source.line);
      if (existing) { inspectCard(existing); focusSourceLine(existing, source.line); }
      else send('triage:addContext', { source });
    }, 'triage-source-candidate');
    item.disabled = sourceStale; item.title = 'Read related code; this does not establish a call'; return item;
  }
  function renderDiscovery(parent) {
    const ready = section('Other code to check'); ready.id = 'triage-preparation';
    ready.append(element('strong', '', investigation.nextQuestion), element('p', 'triage-muted', 'These code matches help you look. They do not support the report by themselves.'));
    const anchors = element('details', 'triage-prepared-anchors');
    anchors.append(element('summary', '', `${investigation.contexts.length} mapped locations · compare the actual statements`));
    for (const context of investigation.contexts) {
      const card = [...cards.values()].find(card => card.id.endsWith(':' + context.cardId));
      const item = element('div', 'triage-prepared-anchor');
      item.append(button(`${context.source.name} · L${context.source.line}`, () => { if (card) { inspectCard(card); focusSourceLine(card, context.source.line); } }));
      item.append(element('small', '', `${context.source.file} · ${context.citation ? 'report location; meaning unchecked' : 'navigation context; relevance unchecked'}`), element('pre', 'triage-inline-code', context.excerpt)); anchors.append(item);
    }
    ready.append(anchors);
    if (investigation.candidates.length) {
      const alternatives = element('details', 'triage-prepared-alternatives'); alternatives.append(element('summary', '', `${investigation.candidates.length} other related functions`));
      alternatives.append(element('p', 'triage-muted', 'Searched even when report citations mapped. Relevance matches are not supporting evidence.'));
      for (const candidate of investigation.candidates) { alternatives.append(sourceCandidate(candidate.source), element('small', 'triage-muted', candidate.reason)); }
      ready.append(alternatives);
    }
    if (investigation.missing.length) { const gaps = element('details'); gaps.append(element('summary', '', 'Still unclear')); for (const text of investigation.missing) gaps.append(element('p', 'triage-muted', text)); ready.append(gaps); }
    const method = element('details'); method.append(element('summary', '', 'How this was prepared'), element('p', 'triage-muted', investigation.notice)); ready.append(method);
    parent.append(ready);
  }
  function decorateCards() {
    const neighborhood = new Set([selectedCard]);
    const claimCards = claimCardIds();
    if (spotlight && cards.has(selectedCard)) for (const edge of edges) { if (edge.from === selectedCard) neighborhood.add(edge.to); if (edge.to === selectedCard) neighborhood.add(edge.from); }
    for (const card of cards.values()) {
      if (sourceStale) for (const action of card.el.querySelectorAll('.card-actions .hdr-btn')) { action.disabled = true; action.title = 'Code changed. Refresh before requesting an explanation.'; }
      card.el.classList.toggle('triage-selected-source', card.id === selectedCard);
      card.el.classList.toggle('triage-dimmed', claimFocus && claimCards.size ? !claimCards.has(card.id) : spotlight && cards.has(selectedCard) && !neighborhood.has(card.id));
      const info = hints[card.id];
      if (!info) continue;
      if (info.identity?.signature) card.el.querySelector('.card-title').textContent = `${card.data.contract ? card.data.contract + '::' : ''}${info.identity.signature}`;
      decorateInline(card, info);
      const claimLines = claimSources().filter(link => FlowboardInline.forSource([link.entry], info).length).flatMap(link => Array.from({ length: (link.entry.source.endLine || link.entry.source.line) - link.entry.source.line + 1 }, (_, offset) => link.entry.source.line + offset));
      card.codeEl.querySelectorAll('.code-line').forEach(row => {
        const line = Number(row.dataset.sourceLine);
        const checked = !sourceStale && checkedLocation?.file === info.file && checkedLocation.sourceHash === info.sourceHash && line >= checkedLocation.line && line <= (checkedLocation.endLine || checkedLocation.line);
        row.classList.toggle('triage-claim-line', checked || claimLines.includes(line));
      });
      let row = card.el.querySelector('.triage-card-info');
      if (!row) {
        row = element('div', 'triage-card-info');
        const menu = element('details', 'triage-function-menu'); menu.append(element('summary', '', 'More'));
        const controls = element('div', 'triage-function-actions');
        const add = button('Add code note', () => addFromCard(card), 'triage-card-add-evidence'); add.disabled = readOnly;
        controls.append(button('Related functions', () => inspectCard(card)), add);
        const nativeActions = card.el.querySelector('.card-actions'); if (nativeActions) controls.append(nativeActions);
        const traits = card.el.querySelector('.hdr-badges');
        if (traits) { for (const trait of traits.children) trait.textContent = trait.title; controls.append(traits); }
        menu.append(controls); row.append(button('Explore function', () => readCode({ cardId: card.id }), 'triage-card-inspect'), menu);
        card.el.querySelector('.card-header').append(row);
        row.addEventListener('mousedown', event => event.stopPropagation());
      }
      row.querySelector('.triage-card-add-evidence').disabled = readOnly;
      if (card.annotateBtn && !card.annotateBtn.disabled) { card.annotateBtn.textContent = 'AI explanation'; card.annotateBtn.title = 'Optional AI explanation. Not checked.'; }
      const meta = card.el.querySelector('.card-meta');
      if (meta) { meta.textContent = info.range || `${info.file}:${info.line}–${info.endLine}`; meta.tabIndex = 0; meta.setAttribute('role', 'button'); meta.title = 'Open in editor'; meta.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); meta.click(); } }; }
      const modifiers = card.el.querySelector('.card-modifiers');
      if (modifiers) {
        card.el.querySelector('.card-header').append(modifiers);
        for (const chip of modifiers.querySelectorAll('.chip-link')) { chip.tabIndex = 0; chip.setAttribute('role', 'button'); chip.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chip.click(); } }; }
      }
      if (info.context) card.el.querySelector('.card-title').textContent = 'Code details';
    }
    highlightCallOccurrence();
  }
  function categorySelect(value, label) {
    const select = element('select'); select.setAttribute('aria-label', label);
    for (const [id, name] of Object.entries(FlowboardInline.categories)) { const option = element('option', '', name); option.value = id; select.append(option); }
    select.value = value; return select;
  }
  function decorateInline(card, info) {
    const key = `${token}:${editVersion}:${dirtyReview}:${inlineVisible}:${hintVersions.get(card.id) || 0}:${activeClaim}:${visibleInvestigation?.revision}:${activeInvestigationClaim}:${info.sourceHash}`;
    if (card._triageInlineKey === key) return;
    card._triageInlineKey = key;
    card.el.querySelectorAll('.triage-explanations,.triage-line-number,.triage-note-marker').forEach(node => node.remove());
    // Native AI commentary is also commentary, never a Solidity code line.
    card.codeEl.querySelectorAll('.ai-comment').forEach(node => node.remove());
    if (card.summaryEl) card.summaryEl.style.display = 'none';
    const rows = [...card.codeEl.querySelectorAll('.code-line')];
    rows.forEach(row => { row.classList.remove('triage-explained-line'); delete row.dataset.sourceLine; });
    const numbers = card._triageOriginal ? card.data.code.replace(/\r\n/g, '\n').split('\n').map((_, index) => info.line + index) : FlowboardInline.lineMap(card.data.code, info.line, card.clean);
    const generated = sourceStale || visibleInvestigation?.phase !== 'ready' ? [] : (visibleInvestigation?.evidence || []).filter(item => !activeInvestigationClaim || item.claimId === activeInvestigationClaim);
    const entries = FlowboardInline.forSource([...profile().evidence, ...generated], info), byLine = new Map();
    const mapped = numbers && rows.length === numbers.length;
    for (const [index, row] of (mapped ? rows : []).entries()) {
      const line = numbers[index]; row.dataset.sourceLine = line; byLine.set(line, row);
      const gutter = button(String(line), event => { addFromCard(card, line); }, 'triage-line-number');
      gutter.title = `Add a note at ${info.file}:${line}`; gutter.setAttribute('aria-label', `Add a note at line ${line} in ${card.name}`); gutter.disabled = readOnly;
      row.prepend(gutter);
    }
    if (!inlineVisible) return;
    const area = element('section', 'triage-explanations'); area.setAttribute('aria-label', `Explanations for ${card.name}`);
    const nativeCommentary = card.data.showAnnotations && (card.data.summary || card.data.annotations?.length);
    const explanation = element('details', 'triage-explanation-body'); explanation.append(element('summary', '', `${entries.length ? 'Explanations' : 'Code notes'} · ${entries.length} ${entries.length === 1 ? 'note' : 'notes'}${nativeCommentary ? ' · AI draft' : ''}`));
    rememberDisclosure(explanation, `${card.id}:explanations`);
    const links = element('nav', 'triage-note-links'); links.setAttribute('aria-label', `Code notes for ${card.name}`);
    const openNote = (item, note) => {
      navigateNote(item, card);
      explanation.open = true; note.open = true;
      // The same original card remains in place. A code note is an explicit
      // detour, never a silent change of the current numbered step's anchor.
      if (guideMode === 'detour') guideReveal(item.source.line);
      else note.querySelector('summary').focus({ preventScroll: true });
    };
    if (!mapped) explanation.append(element('p', 'triage-inline-unplaced', 'These lines cannot be shown here. Open the exact location in the editor.'));
    const generatedNotes = entries.filter(item => item.origin === 'model-interpretation');
    if (generatedNotes.length) explanation.append(element('p', 'triage-muted', generatedNotes.every(item => ['kept', 'repaired', 'added'].includes(item.explanationReview?.result)) ?
      'AI explanation checked against the linked code. This is not an executed test or your final judgment.' : 'Unchecked AI draft. A matching code quotation does not check its explanation.'));
    for (const item of entries) {
      const kind = FlowboardInline.category(item), note = element('details', `triage-inline-note ${kind}`);
      note.dataset.evidenceId = item.id;
      const through = item.source.endLine || item.source.line;
      const automated = item.origin === 'model-interpretation';
      const location = `L${item.source.line}${through !== item.source.line ? '–' + through : ''}`;
      const caption = element('summary', '', `${location} · ${FlowboardInline.categories[kind]}`);
      note.append(caption, element('p', '', item.note));
      if (item.explanationReview) { const check = element('details'); check.append(element('summary', '', item.explanationReview.result === 'repaired' ? 'Why this explanation changed' : 'Why this explanation was kept'), element('p', '', item.explanationReview.reason), element('small', 'triage-muted', 'AI check against code, not independent proof.')); note.append(check); }
      if (item.basis) note.append(element('small', 'triage-muted', FlowboardReview.bases[item.basis] || FlowboardReading.label(item.basis)));
      const relations = FlowboardReading.relationships(item, issueIdentifier(), automated ? visibleInvestigation.claims : profile().claims);
      for (const relation of relations) {
        const context = element('div', `triage-note-relation ${relation.stance}`);
        if (relation.claimId) {
          const statement = element('details'); statement.append(element('summary', '', relation.label), element('p', '', relation.text));
          if (relation.reason) statement.append(element('p', '', relation.reason)); context.append(statement);
        } else context.append(element('strong', '', relation.label));
        note.append(context);
      }
      const actions = element('div', 'triage-inline-actions');
      actions.append(button('Read code', () => { openNote(item, note); focusSourceLine(card, item.source.line); }), element('span', 'triage-note-file', `${item.source.file}:${item.source.line}${through !== item.source.line ? '–' + through : ''}`));
      if (automated) actions.append(button('Open in editor', () => send('triage:investigationFocus', { evidenceId: item.id, editor: true })), button('Read statement', () => { guidePause(); activeInvestigationClaim = item.claimId; show('claims'); }));
      else actions.append(button('Open in editor', () => inspectEvidence(item)), button('Edit note', () => { navigateNote(item, card); editingEvidence = item.id; evidenceFilter = 'all'; show('review'); renderGuide(); drawer.querySelector('[aria-label="Edit evidence explanation"]')?.focus({ preventScroll: true }); })); note.append(actions);
      const row = byLine.get(item.source.line);
      if (row) {
        const marker = button('Note', () => openNote(item, note), 'triage-note-marker'); marker.setAttribute('aria-label', `Read note at ${info.file}:${item.source.line}`); row.append(marker);
      } else note.append(element('p', 'triage-inline-unplaced', 'This line is hidden in the code view. Open it in the editor.'));
      links.append(button(location, () => openNote(item, note))); explanation.append(note);
      rememberDisclosure(note, `${card.id}:evidence:${item.id}`);
    }
    if (info.description) explanation.append(element('p', 'triage-muted', info.description));
    if (!entries.length) explanation.append(element('p', 'triage-muted', 'No code notes yet. Related code alone does not confirm the report.'));
    if (nativeCommentary) {
      const native = element('details', 'triage-native-commentary'); native.append(element('summary', '', 'AI explanation · not checked'), element('p', '', card.data.summary || ''));
      for (const comment of card.data.annotations || []) {
        const line = mapped ? numbers[comment.line - 1] : null;
        if (line) native.append(button(`${info.file}:${line}`, () => focusSourceLine(card, line)));
        native.append(element('p', '', comment.comment));
      }
      explanation.append(native);
    }
    area.append(explanation, links); card.el.append(area);
  }
  // Native re-renders for tracing, annotations and Undo keep their own code and
  // call listeners. Our text-only notes are applied afterwards, independently.
  const nativeRenderCode = renderCodeBody;
  renderCodeBody = function(card) {
    const original = !!guide && guideMode !== 'closed' && selectedCard === card.id && !card.data.notFound;
    card._triageOriginal = original;
    if (original) {
      const clean = card.clean, highlight = highlightSolidity;
      const lines = FlowboardWalkthrough.originalLines(card.data.code); let index = 0;
      card.clean = card.data.code.replace(/\r\n/g, '\n');
      highlightSolidity = (_line, model) => (lines[index++] || []).map(piece => piece.comment ? `<span class="tok-comment">${esc(piece.text)}</span>` : highlight(piece.text, model)).join('');
      try { nativeRenderCode(card); } finally { card.clean = clean; highlightSolidity = highlight; }
    } else nativeRenderCode(card);
    card.codeEl.tabIndex = 0; card.codeEl.setAttribute('aria-label', `${card.data.contract || ''} ${card.name} Solidity code`);
    card._triageInlineKey = null;
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
    for (const card of cards.values()) {
      const original = !!guide && guideMode !== 'closed' && selectedCard === card.id && !card.data.notFound;
      if (!!card._triageOriginal !== original) renderCodeBody(card);
    }
    decorateCards(); nativeRedraw();
    const claimCards = claimCardIds();
    const visibleEdges = edges.filter(edge => (cards.has(edge.from) || notes.has(edge.from)) && (cards.has(edge.to) || notes.has(edge.to)));
    const paths = svg.querySelectorAll('.edge-line');
    paths.forEach((node, index) => {
      const edge = visibleEdges[index];
      const meta = connections.find(x => x.from === edge?.from && x.to === edge?.to);
      const kind = meta?.kind || 'hypothesis';
      node.classList.add(kind === 'call' ? 'triage-call' : kind === 'state-dependency' ? 'triage-state' : 'triage-hypothesis');
      const previous = guide?.steps[guideIndex - 1]?.unit, current = guide?.steps[guideIndex]?.unit;
      const a = previous && guideCard(previous), b = current && guideCard(current);
      node.classList.toggle('triage-guide-edge', guideMode === 'guided' && a && b && a !== b &&
        (edge?.from === a && edge?.to === b || edge?.from === b && edge?.to === a));
      node.classList.toggle('triage-dimmed', claimFocus && claimCards.size ? !claimCards.has(edge?.from) || !claimCards.has(edge?.to) : spotlight && cards.has(selectedCard) && edge?.from !== selectedCard && edge?.to !== selectedCard);
      const title = document.createElementNS(SVG_NS, 'title'); title.textContent = `${connectionLabel(kind)}: ${meta?.reason || 'Added while exploring. Check the code and conditions.'}`; node.append(title);
    });
  };
  const nativePersist = persistNow;
  function checkpoint() {
    rememberLocation();
    scrollPositions.set(drawerTab, drawer.scrollTop);
    const workingCopy = dirtyReview || hasEvidenceDraft() ? { version: 1, baseDraftFingerprint: draftFingerprint, baseSourceFingerprint: sourceFingerprint,
      patch: structuredClone(reviewEdits), editVersion, evidenceInput: structuredClone(evidenceInput) } : null;
    return { ...snapshot(), view: { version: 1, drawerTab, selectedCard, activeClaim, activeInvestigationClaim, claimFocus, spotlight,
      inlineVisible, navigation, navigationViews, navigationIndex, scroll: [...scrollPositions], disclosures: [...disclosureState],
      investigationCorrection: { ...investigationCorrection },
      walkthrough: guide ? { key: guide.key, index: guideIndex, mode: guideMode, opinion: guideOpinion, return: guideReturn, detour: guideDetour,
        position: guideCapture() } : null }, workingCopy, recoveries };
  }
  persistNow = function() {
    nativePersist();
    if (active) {
      const state = checkpoint(); checkpoints.set(active, { state, fingerprint: draftFingerprint, sourceFingerprint });
      if (checkpoints.size > 100) checkpoints.delete(checkpoints.keys().next().value);
      send('triage:persist', { state });
    }
  };
  // Upstream Undo posts an untagged snapshot directly. Persist its result in
  // the current finding too, including keyboard Undo; never another finding.
  const nativeUndo = undo;
  undo = function() { nativeUndo(); persistNow(); };
  undoBtn.addEventListener('click', () => { persistNow(); });
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
  function revokeGeneratedGuidance() {
    guide = null; guideMode = 'closed'; guideReturn = null; checkedLocation = null;
    if (investigationDraft?.phase === 'ready') investigationDraft = null;
    visibleInvestigation = null;
    for (const workbench of drawer.querySelectorAll('.inv-workbench')) {
      const adjustment = workbench.querySelector('.inv-correction')?.closest('details');
      if (adjustment && investigationCorrection.value) {
        // Keep the original input nodes in place, including their caret and
        // composition. Only generated content is withdrawn.
        for (const child of [...workbench.children]) if (child !== adjustment) child.remove();
        workbench.className = 'inv-retained-correction';
        workbench.prepend(element('p', 'triage-warning', 'Review withdrawn. Your correction is kept locally; check its target after preparation.'));
        adjustment.querySelectorAll('button').forEach(node => node.disabled = true);
      } else workbench.remove();
    }
    drawer.querySelectorAll('.guide-opinion,.guide-report-links').forEach(node => node.remove());
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'triage:reportPreparation') {
      reportPreparation = message.report || null;
      // Aggregate status never grants or revokes a selected finding artifact.
      // Its host-validated investigation event owns that atomic transition.
      // Update small row badges only, preserving note nodes/caret and camera.
      renderPreparation(); updatePreparationRows();
      return;
    }
    if (message?.type === 'triage:load') {
      reportPreparation = message.reportPreparation || null;
      if (active) persistNow();
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      active = message.issueId; token = message.token; finding = message.finding; library = message.library || [];
      preparing = null;
      guideIntent = 'waiting'; preparationState = message.preparation || null; guidePositions.clear();
      guideAvailability = message.guideAvailability || null;
      globalThis.__flowboardTriageSession = { issueId: active, token };
      draftFingerprint = message.draftFingerprint || message.fingerprint || '';
      sourceFingerprint = message.fingerprint || '';
      investigation = message.investigation || null; sourceStale = !!message.sourceStale; historicalAssessment = message.historicalAssessment || null; recoveries = [];
      investigationDraft = message.investigationDraft || null; visibleInvestigation = investigationDraft ? structuredClone(investigationDraft) : null; activeInvestigationClaim = null; investigationCorrection = {};
      disclosureState.clear();
      activeClaim = null; claimFocus = false; reportSelection = ''; checkedLocation = null;
      guide = null; guideMode = 'closed'; guideReturn = null; guideNavigation = null; guidePending = false; guideIndex = 0; guideDetour = null; renderGuide();
      connections = message.connections || []; hints = message.hints || {}; report = message.reportText || '';
      warnings = message.warnings || []; unresolved = message.unresolved || []; git = message.git || {}; diagnostics = message.diagnostics || {};
      retrieval = message.retrieval || null; validation = message.validation || {}; rawReport = false;
      readOnly = !!message.readOnly;
      dirtyReview = false; reviewEdits = {}; editVersion = 0;
      evidenceInput = {}; evidencePreview = null; pendingEvidence.clear(); editingEvidence = null;
      selectedCard = null; spotlight = false; navigation = []; navigationViews = []; navigationIndex = -1; flowFilter = ''; evidenceFilter = 'all'; scrollPositions.clear(); renderedTab = null;
      const local = checkpoints.get(active);
      const localMatches = !!draftFingerprint && local?.fingerprint === draftFingerprint && local.sourceFingerprint === sourceFingerprint;
      const saved = localMatches ? local.state : message.state;
      recoveries = (local?.state.recoveries || saved.recoveries || message.recoveryState?.recoveries || []).filter(copy => FlowboardReview.workingCopy(copy, '', '')).slice(-5);
      const unfinished = FlowboardReview.workingCopy(local?.state.workingCopy || saved.workingCopy || message.recoveryState?.workingCopy, draftFingerprint, sourceFingerprint);
      if (unfinished?.matches && !readOnly) {
        reviewEdits = unfinished.patch; dirtyReview = Object.keys(reviewEdits).length > 0;
        editVersion = Number.isSafeInteger(unfinished.editVersion) ? unfinished.editVersion : 0;
        evidenceInput = unfinished.evidenceInput || {};
      } else if (unfinished && !recoveries.some(copy => JSON.stringify(copy.patch) === JSON.stringify(unfinished.patch) && JSON.stringify(copy.evidenceInput) === JSON.stringify(unfinished.evidenceInput))) recoveries = [...recoveries, unfinished].slice(-5);
      const view = saved.view?.version === 1 ? saved.view : null;
      drawerTab = view?.drawerTab || 'brief';
      if (view) {
        investigationCorrection = view.investigationCorrection || {};
        activeClaim = view.activeClaim; claimFocus = !!view.claimFocus; selectedCard = view.selectedCard; spotlight = !!view.spotlight;
        activeInvestigationClaim = view.activeInvestigationClaim || null;
        inlineVisible = view.inlineVisible !== false;
        navigation = Array.isArray(view.navigation) ? view.navigation.slice(-60) : []; navigationIndex = Math.min(navigation.length - 1, view.navigationIndex ?? -1);
        navigationViews = view.navigationViews || [];
        for (const [key, value] of view.scroll || []) scrollPositions.set(key, value);
        for (const [key, value] of view.disclosures || []) disclosureState.set(key, value);
      }
      undoStack.length = 0; lastSnapshotJson = null; lastContentKey = null;
      currentFlowRootId = null; flowPending.clear();
      // A reload can arrive before the preceding autosave reaches the host.
      // Keep recent layout/sticky notes only for this exact draft + source map;
      // code, targets and relationships still come from the checked host load.
      const canvas = structuredClone(message.state);
      if (localMatches) {
        const positions = new Map(saved.cards.map(card => [card.id, card]));
        canvas.cards = canvas.cards.map(card => {
          const previous = positions.get(card.id);
          return previous && Number.isFinite(previous.x) && Number.isFinite(previous.y) ? { ...card, x: previous.x, y: previous.y } : card;
        });
        canvas.notes = saved.notes; canvas.camera = saved.camera; canvas.ui = saved.ui;
      }
      loadSnapshot(canvas);
      const preparedGuide = FlowboardWalkthrough.build(investigationDraft, report), savedGuide = view?.walkthrough;
      if (!sourceStale && preparedGuide && savedGuide?.key === preparedGuide.key && savedGuide.index < preparedGuide.steps.length) {
        guide = preparedGuide; guideIndex = savedGuide.index; guideMode = savedGuide.mode; guideOpinion = savedGuide.opinion;
        guideReturn = savedGuide.return;
        guideIntent = savedGuide.mode === 'guided' ? 'guided' : 'explore'; guideWrap = savedGuide.position?.wrap !== false;
        guideDetour = guide.draft.evidence.some(item => item.id === savedGuide.detour) || profile().evidence.some(item => item.id === savedGuide.detour) || savedGuide.detour === 'new-note' && evidenceInput.cardId || savedGuide.detour?.startsWith('input:') ? savedGuide.detour : null;
        // Restore only a reference still contained by this exact saved review.
        const position = savedGuide.position, source = position?.checkedLocation;
        if (source && [...guide.draft.evidence, ...profile().evidence].some(entry => JSON.stringify(entry.source) === JSON.stringify(source))) checkedLocation = source;
        else if (source && guideDetour === 'new-note' && source.file === hints[evidenceInput.cardId]?.file && source.sourceHash === hints[evidenceInput.cardId]?.sourceHash && source.line === evidenceInput.line) checkedLocation = source;
        else if (source && guideDetour?.startsWith('input:') && JSON.stringify(detourStep()?.evidence?.source) === JSON.stringify(source)) checkedLocation = source;
        if (position && cards.has(position.selectedCard)) selectedCard = position.selectedCard;
      }
      if (!guide && cards.has(selectedCard) && navigation.length && drawerTab === 'brief') guideIntent = 'explore';
      renderGuide();
      renderBar(); renderDrawer(); redrawEdges();
      if (guide && savedGuide?.position) guideAside.scrollTop = savedGuide.position.guideScroll || 0;
      drawer.classList.add('visible'); document.body.classList.add('triage-drawer-open');
      if (guide && guideMode === 'guided') { drawer.classList.remove('visible'); document.body.classList.remove('triage-drawer-open'); }
      syncReadingLayout();
      if (!view && cards.size) {
        const start = readingStart(), first = cards.get(start.cardId) || cards.values().next().value;
        if (start.entry) { selectedCard = first.id; checkedLocation = { ...start.entry.source }; redrawEdges(); focusSourceLine(first, start.entry.source.line); }
        else focusReadable(first);
      }
      else if (view && localMatches && saved.camera) { ({ scale, panX, panY } = saved.camera); applyTransform(); }
      persistNow(); send('triage:rendered');
      if (!guide && preparedGuide && guideIntent === 'waiting' && guideAvailability?.ready !== false) guideStart();
      else if (guide && guideMode === 'guided') {
        renderGuide(); redrawEdges();
        if (cards.has(selectedCard)) cards.get(selectedCard).codeEl.parentElement.scrollTop = savedGuide?.position?.codeScroll || 0;
      }
    } else if (message?.type === 'triage:library') {
      library = message.library || []; renderBar(); show('findings');
    } else if (message?.type === 'triage:requestRefresh' && message.token === token) {
      if (!(dirtyReview || hasEvidenceDraft()) || window.confirm('Refresh the source map? Your unfinished review will be preserved for comparison.')) { persistNow(); send('triage:refresh'); }
    } else if (message?.type === 'triage:limit' && message.token === token) { currentFlowRootId = null; flowPending.clear(); }
    else if (message?.type === 'triage:cancelExpansion' && message.token === token) { flowPending.delete(message.id); if (!flowPending.size) currentFlowRootId = null; }
    else if (message?.type === 'triage:sourceStale' && message.issueId === active && message.token === token) {
      sourceStale = true; historicalAssessment = { status: reviewEdits.status || finding.status || 'unreviewed' }; readOnly = true; pendingEvidence.clear();
      const next = profile(); FlowboardClaims.invalidate(next); reviewEdits.triage = next;
      for (const check of next.checks) check.state = 'unchecked';
      // Changed code invalidates code checks, not the researcher's own verdict
      // or confidence. Display it as historical rather than editing it for them.
      dirtyReview = true; editVersion++;
      // Leave the camera and cards exactly where the researcher was reading.
      guideNavigation = null; revokeGeneratedGuidance(); renderGuide(); renderPreparation(); renderBar();
      if (!drawer.querySelector('input:focus,textarea:focus,select:focus')) renderDrawer();
      else {
        // Other manual review forms also retain their text. Stale controls must
        // not bind evidence or commit an assessment against changed code.
        for (const action of drawer.querySelectorAll('button')) action.disabled = true;
      }
      redrawEdges(); persistNow();
    }
    else if (message?.type === 'triage:contextAdded' && message.issueId === active && message.token === token) {
      const card = cards.get(message.id); if (card) inspectCard(card);
    }
    else if (message?.type === 'triage:investigation' && message.issueId === active && message.token === token && message.draft?.findingId === active) {
      if (sourceStale || message.draft.revision < (investigationDraft?.revision || 0)) return;
      investigationDraft = message.draft;
      guideAvailability = message.guideAvailability || null;
      if (!readyDraft(investigationDraft) && guide) { revokeGeneratedGuidance(); renderGuide(); redrawEdges(); }
      preparationState = null; renderPreparation();
      // Never replace source cards/camera or insert new inline notes while the
      // researcher is reading. The next explicit source/claim selection adopts
      // the new annotation snapshot. Preserve in-progress text fields as well.
      if (!drawer.querySelector('input:focus,textarea:focus,select:focus') && ['claims', 'brief'].includes(drawerTab)) renderDrawer();
      if (!guide && guideIntent === 'waiting' && guideAvailability?.ready !== false && FlowboardWalkthrough.build(investigationDraft, report)) guideStart();
      else if (guide && guide.key !== FlowboardWalkthrough.build(investigationDraft, report)?.key) renderGuide();
    }
    else if (message?.type === 'triage:investigationFocus' && message.issueId === active && message.token === token && !sourceStale) {
      if (preparing || guideNavigation && message.navigationId !== guideNavigation || message.navigationId && message.navigationId !== guideNavigation) return;
      const card = cards.get(message.cardId); if (!card) return;
      if (message.guideAvailability) guideAvailability = message.guideAvailability;
      if (message.navigationId && guide) {
        guidePending = false; guideRequest = null; guideError = null;
        if (guideMode === 'detour' && !guideDetour?.startsWith('input:')) guideDetour = message.evidenceId;
        const sameFunction = selectedCard === card.id;
        selectedCard = card.id;
        const inputAnchor = guideMode === 'detour' && guideDetour?.startsWith('input:') ? detourStep() : null;
        checkedLocation = inputAnchor?.unit?.source?.file === message.source.file && inputAnchor?.unit?.source?.sourceHash === message.source.sourceHash ? inputAnchor.evidence.source : message.source;
        activeInvestigationClaim = message.claimId;
        visibleInvestigation = structuredClone(guide.draft); activeClaim = null; claimFocus = false; spotlight = false;
        redrawEdges(); renderGuide();
        if (document.body.classList.contains('guide-reading')) { if (!sameFunction) focusReadable(card); guideReveal(checkedLocation.line); }
        else if (!sameFunction) focusSourceLine(card, message.source.line);
        else {
          const row = card.codeEl.querySelector(`[data-source-line="${message.source.line}"]`), bounds = row?.getBoundingClientRect(), viewport = flowboard.getBoundingClientRect();
          if (bounds && (bounds.top < viewport.top + 50 || bounds.bottom > viewport.bottom - 24)) { panY += viewport.top + 100 - bounds.top; applyTransform(); }
        }
        schedulePersist(); return;
      }
      rememberLocation(); guidePause(); selectedCard = card.id; activeClaim = null; claimFocus = false; spotlight = false;
      activeInvestigationClaim = message.claimId || activeInvestigationClaim; visibleInvestigation = structuredClone(investigationDraft);
      checkedLocation = message.source; show('claims'); focusSourceLine(card, message.source.line); redrawEdges(); pushLocation('investigation:' + (activeInvestigationClaim || card.id));
    }
    else if (message?.type === 'triage:investigationLinks' && message.issueId === active && message.token === token && !sourceStale) {
      for (const edge of message.connections || []) {
        if (!cards.has(edge.from) || !cards.has(edge.to)) continue;
        if (!connections.some(item => item.from === edge.from && item.to === edge.to)) connections.push(edge);
        addEdge(edge.from, edge.to);
      }
      redrawEdges(); schedulePersist();
    }
    else if (['triage:hint', 'triage:hints'].includes(message?.type) && (!message.token || message.token === token)) {
      for (const [id, hint] of Object.entries(message.type === 'triage:hints' ? message.hints : { [message.id]: message.hint })) {
        hints[id] = hint; hintVersions.set(id, (hintVersions.get(id) || 0) + 1);
      }
      redrawEdges();
      if (['flow', 'brief'].includes(drawerTab) && !drawer.querySelector('input:focus,textarea:focus,select:focus')) renderDrawer();
    }
    else if (message?.type === 'triage:evidenceBound' && message.issueId === active && message.token === token && pendingEvidence.has(message.evidence.id)) {
      const before = pendingEvidence.get(message.evidence.id); pendingEvidence.delete(message.evidence.id);
      if (before === JSON.stringify(evidenceInput)) evidenceInput = {};
      editProfile(value => { if (!value.evidence.some(item => item.id === message.evidence.id)) value.evidence.push(message.evidence); }, true);
    }
    else if (message?.type === 'triage:evidenceInspected' && message.issueId === active && message.token === token && !sourceStale && message.navigationId && message.navigationId === guideNavigation && profile().evidence.some(item => item.id === message.evidence.id)) {
      guideNavigation = null; guidePending = false; guideRequest = null; guideError = null;
      const current = profile().evidence.find(item => item.id === message.evidence.id);
      if (current.needsReview || JSON.stringify(current.source) !== JSON.stringify(message.evidence.source) || current.quote !== message.evidence.quote) return;
      evidencePreview = { ...message, evidence:current };
      for (const card of cards.values()) card.el.classList.remove('triage-evidence-focus');
      const source = message.evidence.source;
      const card = source && [...cards.values()].find(card => hints[card.id]?.file === source.file && hints[card.id]?.sourceHash === source.sourceHash && source.line >= hints[card.id].line && (source.endLine || source.line) <= hints[card.id].endLine);
      if (card) { navigateNote(current, card); card.el.classList.add('triage-evidence-focus'); focusSourceLine(card, source.line); redrawEdges(); }
      if (drawerTab === 'review' && !drawer.querySelector('input:focus,textarea:focus,select:focus')) renderDrawer();
    }
    else if (message?.type === 'triage:navigationFailed' && message.issueId === active && message.token === token && message.navigationId === guideNavigation) {
      guideNavigation = null; guidePending = false; guideError = message.reason || 'The checked code could not be opened.';
      if (message.guideAvailability) guideAvailability = message.guideAvailability;
      renderGuide();
    }
    else if (message?.type === 'triage:reviewSaved' && message.issueId === active && message.token === token) {
      finding = message.finding; library = message.library;
      draftFingerprint = message.draftFingerprint || draftFingerprint;
      // Keep edits typed while the preceding save was in flight.
      if (message.editVersion === editVersion) { dirtyReview = false; reviewEdits = {}; }
      renderBar(); renderDrawer(); redrawEdges(); persistNow();
    }
    else if (message?.type === 'triage:notice') {
      if (message.token && message.token !== token || message.issueId && message.issueId !== active) return;
      if (message.error && preparing) { preparing = null; renderBar(); }
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
    if (typing || window.getSelection()?.toString()) return;
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && ['ArrowLeft', 'ArrowRight'].includes(event.key) && guide && guideMode === 'guided') {
      event.preventDefault(); event.stopImmediatePropagation(); guideGo(guideIndex + (event.key === 'ArrowLeft' ? -1 : 1)); return;
    }
    if (event.key === 'Escape' && drawer.classList.contains('visible')) {
      event.preventDefault(); drawer.classList.remove('visible'); document.body.classList.remove('triage-drawer-open'); renderGuide(); redrawEdges(); bar.querySelector('button')?.focus();
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && ['1', '2', '3', '4', '5', '6', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key.startsWith('Arrow')) moveHistory(event.key === 'ArrowLeft' ? -1 : 1);
      else show(['findings', 'brief', 'flow', 'review', 'report', 'claims'][Number(event.key) - 1]);
    }
  }, true);
  window.addEventListener('beforeunload', () => { if (active) persistNow(); });
  renderBar(); send('triage:ready');
})();
