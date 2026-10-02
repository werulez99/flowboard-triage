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
function readReport(root) {
  const bundle = p.readWorkspaceJson(root, '.flowboard/report.json', 12 * 1024 * 1024);
  if (!Array.isArray(bundle.issues) || bundle.issues.length > 300) throw new Error('Invalid report index.');
  for (const issue of bundle.issues) {
    p.identifier(issue?.id, 'report finding ID');
    try { issue.request = readDraft(root, issue.id); issue.status = issue.request.finding.status; }
    catch (error) {
      issue.request = null;
      issue.draftError = error.message;
    }
  }
  return bundle;
}
function library(root) {
  try { return readReport(root).issues.map(issue => {
    const finding = issue.request?.finding, ready = finding?.triage ? review.readiness(finding) : null;
    const anchors = (issue.request?.cards || []).map(card => ({ file: card.file, line: card.line, function: card.function || '' }));
    return { id: issue.id, displayId: issue.displayId, title: issue.title, severity: issue.severity,
      status: issue.status || 'unreviewed', mapped: !!issue.request, unresolved: issue.unresolved?.length || 0,
      reviewGaps: ready?.gaps.length || 0, staleEvidence: ready?.outdated || 0,
      files: [...new Set(anchors.map(card => card.file))], anchors };
  }); }
  catch { return []; }
}
function readBoard(root, id) {
  p.identifier(id, 'board finding ID');
  try {
    const value = p.readWorkspaceJson(root, `.flowboard/boards/${id}.json`, 8 * 1024 * 1024);
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
  for (const card of state.cards) for (const key of ['name', 'code', 'fsPath']) if (card[key] !== undefined && typeof card[key] !== 'string') throw new Error('Invalid source card text.');
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
function writeBoard(root, id, state, fingerprint) {
  p.identifier(id, 'board finding ID');
  validateBoard(root, state);
  const value = { version: 1, fingerprint, updatedAt: new Date().toISOString(), state };
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
  return `Use $solidity-flowboard-triage to review ${id} in .flowboard/findings/${id}.json. Read the skill, original report and relevant source. Identify the intended rule before assessing the reported deviation; record its provenance in finding.triage.ruleOrigin, distinguishing report assertions from independently checked specifications/tests/implementation. Split the report into focused statements in finding.triage.claims, preserving its meaning. For each claim, record observed behavior, permissions/state, consequence/uncertainty, decision reason and remaining questions. Link actual ledger evidence IDs with a claim-specific supports/contradicts/context stance and an explanation of relevance. Claim states are unreviewed/supported/contradicted/mixed/unresolved; they do not set the finding verdict. Inspect version, permissions/state, actual reads/writes and call targets; actively look for guards/specification/implementations that contradict the claim. If no usable citations exist, check description-search candidates against source; search scores are not bug confidence. Add explained supports/contradicts/context entries to finding.triage.evidence with real relative source lines/hashes or specification/test references, checkpoint reasoning and a decisionReason. For inline explanations, use short notes at the exact original statement line with category behavior, claim, impact, guard or question; distinguish report assertions from source observations. Do not guess a source line from summary prose. Fill expectedBehavior, actualBehavior and openQuestions for the finding-level Review story. Annotate each relevant source card/connection so the reviewer can navigate the argument. Keep unchecked areas and deployment/specification uncertainty explicit. This is source review, not exploit execution or speculative attack-chain generation. Save the draft first, then submit a fresh delivery and report actual rendering. Distinguish confirmed, invalid, design-decision, insufficient-evidence and already-fixed; a graph or checkmark is not proof. Unsaved UI edits are not included; read the saved draft and respect concurrent edits.`;
}
module.exports = { findingKey, draftPath, readDraft, writeDraft, archiveDraft, sameDraft, readReport, library, readBoard, writeBoard, archiveBoard, archiveBoardFile, saveReview, reviewPrompt, editable };
