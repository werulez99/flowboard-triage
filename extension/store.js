'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const p = require('./protocol');
const review = require('./webview/review-model');
const editable = ['status', 'confidence', 'summary', 'expectedBehavior', 'actualBehavior', 'preconditions', 'impact', 'evidence', 'openQuestions', 'remediation', 'triage'];
function sameDraft(a, b) {
  const shape = request => ({ findingId: findingKey(request), finding: request.finding,
    cards: request.cards.map(({ sourceHash, ...card }) => card), connections: request.connections || [] });
  return isDeepStrictEqual(shape(a), shape(b));
}
function findingKey(request) { return request.findingId || `finding-${crypto.createHash('sha256').update(request.finding.title).digest('hex').slice(0, 20)}`; }
function draftPath(id) { p.identifier(id, 'finding ID'); return `.flowboard/findings/${id}.json`; }
function readDraft(root, id) { return p.validate(p.readWorkspaceJson(root, draftPath(id))); }
function selectedDraft(request, id) {
  p.identifier(id, 'selected finding ID');
  if (request.findingId && request.findingId !== id) throw new Error('The selected draft declares a different finding ID. Correct the ID before opening; no other finding was loaded.');
  // Legacy files may have no findingId. Their filename/library key is identity,
  // not the title-derived fallback used for a brand-new standalone submission.
  return { ...structuredClone(request), findingId: id };
}
function writeDraft(root, id, request, preserve = false) {
  const relative = draftPath(id);
  if (preserve && fs.existsSync(path.join(root, relative))) return readDraft(root, id);
  p.evidenceSources(root, request.finding?.triage, true);
  p.atomicJson(root, relative, p.validate(request));
  return request;
}
function archiveDraft(root, id, request) {
  p.identifier(id, 'finding ID');
  const hash = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const relative = `.flowboard/draft-history/${id}/${hash}.json`;
  if (!fs.existsSync(path.join(root, relative))) p.atomicJson(root, relative, request);
  return relative;
}
function readReportIndex(root) {
  const bundle = p.readWorkspaceJson(root, '.flowboard/report.json', 12 * 1024 * 1024);
  if (!Array.isArray(bundle.issues) || bundle.issues.length > 1000) throw new Error('Invalid report index: expected at most 1,000 findings.');
  for (const issue of bundle.issues) p.identifier(issue?.id, 'report finding ID');
  return bundle;
}
function readIssue(root, id) {
  p.identifier(id, 'report finding ID');
  return readReportIndex(root).issues.find(issue => issue.id === id);
}
function readReport(root) {
  const bundle = readReportIndex(root);
  for (const issue of bundle.issues) {
    p.identifier(issue?.id, 'report finding ID');
    try { issue.request = readDraft(root, issue.id); issue.status = issue.request.finding.status; issue.mappingPending = false; }
    catch (error) {
      issue.request = null;
      if (!(issue.mappingPending && error.code === 'ENOENT')) issue.draftError = error.message;
    }
  }
  return bundle;
}
const summaries = new Map();
function library(root, currentIndex = null) {
  // List display does not need hydrated sibling requests. Validate exact current
  // bytes (not mtime/watchers/TTL); reuse only their derived small summaries.
  // Selected analysis separately reads and validates its complete draft.
  try { return (currentIndex || readReportIndex(root)).issues.map(issue => {
    let data = null, error = null;
    try {
      const raw = p.readWorkspaceText(root, draftPath(issue.id)), key = `${fs.realpathSync(root)}:${issue.id}`;
      const digest = crypto.createHash('sha256').update(raw).digest('hex'), cached = summaries.get(key);
      if (cached?.digest === digest) data = cached.data;
      else {
        const request = p.validate(JSON.parse(raw)), finding = request.finding, ready = finding.triage ? review.readiness(finding) : null;
        data = { status: finding.status, reviewGaps: ready?.gaps.length || 0, staleEvidence: ready?.outdated || 0,
          anchors: request.cards.map(card => ({ file: card.file, line: card.line, function: card.function || '' })) };
        if (summaries.size >= 2000) summaries.delete(summaries.keys().next().value);
        summaries.set(key, { digest, data });
      }
    } catch (caught) { error = caught; }
    const anchors = data?.anchors || [];
    return { id: issue.id, displayId: issue.displayId, title: issue.title, severity: issue.severity,
      status: data?.status || issue.status || 'unreviewed', mapped: !!data, mappingPending: !!issue.mappingPending && error?.code === 'ENOENT', unresolved: issue.unresolved?.length || 0,
      reviewGaps: data?.reviewGaps || 0, staleEvidence: data?.staleEvidence || 0,
      files: [...new Set(anchors.map(card => card.file))], anchors: structuredClone(anchors) };
  }); }
  catch { return []; }
}
function readBoard(root, id) {
  p.identifier(id, 'board finding ID');
  try {
    const value = p.readWorkspaceJson(root, `.flowboard/boards/${id}.json`, 8 * 1024 * 1024);
    if (value.reviewSourceFingerprint !== undefined && (typeof value.reviewSourceFingerprint !== 'string' || !value.reviewSourceFingerprint || value.reviewSourceFingerprint.length > 128)) throw new Error('Invalid saved review source fingerprint.');
    validateBoard(root, value.state); return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validateBoard(root, state) {
  if (!state || !Array.isArray(state.cards) || state.cards.length > 200 || !Array.isArray(state.edges) || state.edges.length > 500 ||
    state.notes !== undefined && (!Array.isArray(state.notes) || state.notes.length > 100)) throw new Error('Invalid or oversized board snapshot.');
  for (const item of [...state.cards, ...(state.notes || [])]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid board card/note.');
    for (const key of ['x', 'y', 'w', 'h']) if (item[key] !== undefined && (!Number.isFinite(item[key]) || Math.abs(item[key]) > 10000000)) throw new Error('Invalid board coordinates.');
  }
  for (const edge of state.edges) if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') throw new Error('Invalid board connection.');
  if (state.camera) for (const key of ['scale', 'panX', 'panY']) if (state.camera[key] !== undefined && !Number.isFinite(state.camera[key])) throw new Error('Invalid board camera.');
  if (state.view !== undefined) {
    const view = state.view, tabs = ['findings', 'brief', 'flow', 'review', 'report', 'claims', 'help'];
    const id = value => typeof value === 'string' && value.length <= 400;
    const failView = () => { throw new Error('Invalid investigation view checkpoint.'); };
    if (!view || typeof view !== 'object' || Array.isArray(view) || view.version !== 1 || JSON.stringify(view).length > 100000) failView();
    if (view.drawerTab !== undefined && !tabs.includes(view.drawerTab)) failView();
    if (view.investigationCorrection !== undefined) {
      const correction = view.investigationCorrection;
      if (!correction || typeof correction !== 'object' || Array.isArray(correction) || Object.keys(correction).some(key => !['field','value'].includes(key)) ||
        correction.field !== undefined && !['property','actor','entry','implementation','conditions'].includes(correction.field) ||
        correction.value !== undefined && (typeof correction.value !== 'string' || correction.value.length > 4000)) failView();
    }
    for (const key of ['selectedCard', 'activeClaim', 'activeInvestigationClaim']) if (view[key] !== undefined && view[key] !== null && !id(view[key])) failView();
    for (const key of ['claimFocus', 'spotlight', 'inlineVisible']) if (view[key] !== undefined && typeof view[key] !== 'boolean') failView();
    if (view.navigation !== undefined && (!Array.isArray(view.navigation) || view.navigation.length > 60 || !view.navigation.every(id))) failView();
    if (view.navigationIndex !== undefined && (!Number.isSafeInteger(view.navigationIndex) || view.navigationIndex < -1 || view.navigationIndex >= (view.navigation?.length || 0))) failView();
    if (view.navigationViews !== undefined && (!Array.isArray(view.navigationViews) || view.navigationViews.length > 60 || view.navigationViews.some(value => !value ||
      !tabs.includes(value.drawerTab) || !Number.isFinite(value.scrollTop) || value.scrollTop < 0 || value.scrollTop > 10000000 ||
      ['selectedCard', 'activeClaim'].some(key => value[key] !== null && !id(value[key])) ||
      ['claimFocus', 'spotlight'].some(key => typeof value[key] !== 'boolean') ||
      !value.camera || ['scale', 'panX', 'panY'].some(key => !Number.isFinite(value.camera[key]) || Math.abs(value.camera[key]) > 10000000)))) failView();
    if (view.walkthrough != null) {
      const guide = view.walkthrough;
      if (!id(guide.key) || !Number.isSafeInteger(guide.index) || guide.index < 0 || guide.index > 40 ||
        !['closed', 'guided', 'explore', 'detour'].includes(guide.mode) || typeof guide.opinion !== 'boolean') failView();
      if (guide.detour != null && !id(guide.detour)) failView();
      for (const position of [guide.return, guide.position].filter(item => item != null)) {
        if (!id(position.selectedCard || '') || !tabs.includes(position.drawerTab) || !Number.isSafeInteger(position.guideIndex) || position.guideIndex < 0 || position.guideIndex > 40 ||
          typeof position.drawerOpen !== 'boolean' || !position.camera ||
          ['scale', 'panX', 'panY'].some(key => !Number.isFinite(position.camera[key]) || Math.abs(position.camera[key]) > 10000000) ||
          ['scrollTop', 'scrollLeft', 'scrollTopCode'].some(key => !Number.isFinite(position[key]) || position[key] < 0 || position[key] > 10000000)) failView();
        const source = position.checkedLocation;
        if (position.guideScroll !== undefined && (!Number.isFinite(position.guideScroll) || position.guideScroll < 0 || position.guideScroll > 10000000)) failView();
        if (position.codeScroll !== undefined && (!Number.isFinite(position.codeScroll) || position.codeScroll < 0 || position.codeScroll > 10000000)) failView();
        if (position.wrap !== undefined && typeof position.wrap !== 'boolean') failView();
        if (source && (typeof source.file !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceHash) || !Number.isSafeInteger(source.line) || !Number.isSafeInteger(source.endLine) || source.line < 1 || source.endLine < source.line)) failView();
      }
    }
    for (const key of ['scroll', 'disclosures']) if (view[key] !== undefined) {
      const entries = view[key];
      if (!Array.isArray(entries) || entries.length > (key === 'scroll' ? tabs.length : 1000) || entries.some(entry =>
        !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || entry[0].length > 1000 ||
        (key === 'scroll' ? !tabs.includes(entry[0]) || !Number.isFinite(entry[1]) || entry[1] < 0 || entry[1] > 10000000 : typeof entry[1] !== 'boolean'))) failView();
    }
  }
  if (state.workingCopy !== undefined && state.workingCopy !== null && !review.workingCopy(state.workingCopy, '')) throw new Error('Invalid review working copy.');
  if (state.recoveries !== undefined && (!Array.isArray(state.recoveries) || state.recoveries.length > 5 || state.recoveries.some(copy => !review.workingCopy(copy, '')))) throw new Error('Invalid earlier working copies.');
  for (const card of state.cards) for (const key of ['name', 'code', 'fsPath']) if (card[key] !== undefined && typeof card[key] !== 'string') throw new Error('Invalid source card text.');
  for (const card of state.cards) {
    // These are optional, unverified native model comments, not source-bound
    // evidence. A hand-edited/corrupt cache must not crash annotations.map in
    // the pinned renderer before the investigation can acknowledge loading.
    if (card.summary !== undefined && card.summary !== null && (typeof card.summary !== 'string' || card.summary.length > 64000) ||
        card.showAnnotations !== undefined && typeof card.showAnnotations !== 'boolean' ||
        card.annotations !== undefined && card.annotations !== null && (!Array.isArray(card.annotations) || card.annotations.length > 2000 ||
          card.annotations.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
            !Number.isSafeInteger(item.line) || item.line < 1 || item.line > 1000000 || typeof item.comment !== 'string' || item.comment.length > 16000))) {
      throw new Error('Invalid cached native annotations.');
    }
  }
  // Reject any source card pointing outside this workspace, including restored cards.
  for (const card of state.cards) if (card.fsPath) {
    const absolute = fs.realpathSync(card.fsPath);
    if (!p.contained(fs.realpathSync(root), absolute)) throw new Error('Board source escapes the workspace.');
  }
}
function archiveBoard(root, id, value) {
  p.identifier(id, 'board finding ID');
  const hash = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const relative = `.flowboard/board-history/${id}/${hash}.json`;
  if (!fs.existsSync(path.join(root, relative))) p.atomicJson(root, relative, value);
  return relative;
}
function archiveBoardFile(root, id) {
  p.identifier(id, 'board finding ID');
  const original = fs.realpathSync(path.join(root, `.flowboard/boards/${id}.json`));
  if (!p.contained(fs.realpathSync(root), original)) throw new Error('Saved canvas file is outside the workspace.');
  const stat = fs.statSync(original);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Saved canvas exceeds the archive limit.');
  const bytes = fs.readFileSync(original);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const relative = `.flowboard/board-history/${id}/${hash}.json`;
  const directory = p.writableDirectory(root, path.dirname(relative));
  const target = path.join(directory, path.basename(relative));
  // Keep the exact previous bytes, even if they were not valid JSON. Existing
  // archives are immutable; a corrupt snapshot must not silently lose notes.
  if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  return relative;
}
function writeBoard(root, id, state, fingerprint, reviewSourceFingerprint = fingerprint) {
  p.identifier(id, 'board finding ID');
  validateBoard(root, state);
  const value = { version: 1, fingerprint, reviewSourceFingerprint, updatedAt: new Date().toISOString(), state };
  if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error('Board snapshot is larger than 8 MiB.');
  p.atomicJson(root, `.flowboard/boards/${id}.json`, value);
}
function saveReview(root, id, patch, expectedFingerprint) {
  const request = readDraft(root, id);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
  if (expectedFingerprint && expectedFingerprint !== fingerprint) throw new Error('The finding was edited elsewhere. Reload the review before saving; nothing was overwritten.');
  const next = structuredClone(request);
  for (const key of editable) if (Object.hasOwn(patch, key)) {
    if (patch[key] === '' || patch[key] === null) delete next.finding[key];
    else next.finding[key] = structuredClone(patch[key]);
  }
  p.evidenceSources(root, next.finding.triage, true);
  p.validate(next);
  p.sources(root, next); p.checkRevision(next, p.gitState(root));
  const historyPath = `.flowboard/history/${id}.json`;
  let history = [];
  if (fs.existsSync(path.join(root, historyPath))) history = p.readWorkspaceJson(root, historyPath, 4 * 1024 * 1024).entries || [];
  history.push({ at: new Date().toISOString(), actor: 'reviewer', previous: request.finding, current: next.finding });
  history = history.slice(-100);
  while (history.length > 1 && Buffer.byteLength(JSON.stringify({ version: 1, entries: history })) > 4 * 1024 * 1024) history.shift();
  p.atomicJson(root, historyPath, { version: 1, entries: history });
  writeDraft(root, id, next);
  return next;
}
function reviewPrompt(id) {
  p.identifier(id, 'finding ID');
  return `Use $solidity-flowboard-triage to review ${id} in .flowboard/findings/${id}.json. Read the skill, original report and relevant source. Identify the intended rule before assessing the reported deviation; record its provenance in finding.triage.ruleOrigin, distinguishing report assertions from independently checked specifications/tests/implementation. Split the report into focused statements in finding.triage.claims, preserving its meaning. For each claim, record observed behavior, permissions/state, consequence/uncertainty, decision reason and remaining questions. Link actual ledger evidence IDs with a claim-specific supports/contradicts/context stance and an explanation of relevance. Claim states are unreviewed/supported/contradicted/mixed/unresolved; they do not set the finding verdict. Inspect version, permissions/state, actual reads/writes and call targets; actively look for guards/specification/implementations that contradict the claim. If no usable citations exist, check description-search candidates against source; search scores are not bug confidence. Add explained supports/contradicts/context entries to finding.triage.evidence with real relative source lines/hashes or specification/test references, checkpoint reasoning and a decisionReason. Write visible explanations in simple English using short sentences: what this code does, why it matters to the report, and what is still unknown. Avoid internal labels such as provenance, ledger, source binding or semantic verification in displayed text. Keep quotations, code, names, paths, IDs and enum values unchanged. Explanations appear below continuous code. For code explanations, use short notes at the exact original statement line with category behavior, claim, impact, guard or question; distinguish report assertions from source observations. Do not guess a source line from summary prose. Fill expectedBehavior, actualBehavior and openQuestions for the finding-level Review story. Annotate each relevant source card/connection so the reviewer can navigate the argument. Keep unchecked areas and deployment/specification uncertainty explicit. This is source review, not exploit execution or speculative attack-chain generation. Save the draft first, then submit a fresh delivery and report actual rendering. Distinguish confirmed, invalid, design-decision, insufficient-evidence and already-fixed; a graph or checkmark is not proof. Unsaved UI edits are not included; read the saved draft and respect concurrent edits.`;
}
module.exports = { findingKey, selectedDraft, draftPath, readDraft, writeDraft, archiveDraft, sameDraft, readReportIndex, readIssue, readReport, library, readBoard, writeBoard, archiveBoard, archiveBoardFile, saveReview, reviewPrompt, editable };
