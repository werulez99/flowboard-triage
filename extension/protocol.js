'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const review = require('./webview/review-model');

const REQUEST = '.flowboard/request.json';
const STATUS = '.flowboard/status.json';
const MAX_BYTES = 256 * 1024;
const STATUSES = ['unreviewed', 'confirmed', 'invalid', 'design-decision', 'insufficient-evidence', 'already-fixed'];
function fail(message) { throw new Error(message); }
function string(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}: expected non-empty text (max ${max}).`);
}
function identifier(value, label) {
  string(value, label, 100);
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) fail(`${label}: use letters, digits, dot, underscore or hyphen.`);
}
function validate(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('Expected a finding object.');
  if (request.version !== 1) fail('Finding version must be 1.');
  identifier(request.id, 'request.id');
  if (request.findingId !== undefined) identifier(request.findingId, 'findingId');
  const finding = request.finding;
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) fail('finding is required.');
  string(finding.title, 'finding.title', 250);
  for (const key of ['reportedSeverity', 'reportRevision', 'summary', 'expectedBehavior', 'actualBehavior', 'impact', 'remediation']) {
    if (finding[key] !== undefined) string(finding[key], `finding.${key}`);
  }
  if (!STATUSES.includes(finding.status)) fail(`finding.status must be one of ${STATUSES.join(', ')}.`);
  if (finding.confidence !== undefined && !['low', 'medium', 'high'].includes(finding.confidence)) fail('confidence must be low, medium or high.');
  for (const key of ['preconditions', 'evidence', 'openQuestions']) {
    if (finding[key] === undefined) continue;
    if (!Array.isArray(finding[key]) || finding[key].length > 40) fail(`${key}: expected an array of at most 40 strings.`);
    finding[key].forEach(value => string(value, `finding.${key}`));
  }
  if (finding.triage !== undefined) {
    review.validate(finding.triage);
    const readiness = review.readiness(finding);
    if (readiness.errors.length) fail(readiness.errors.join(' '));
  }
  if (['confirmed', 'invalid', 'design-decision', 'already-fixed'].includes(finding.status) && !finding.evidence?.length && !finding.triage?.evidence.length) {
    fail('A reviewed verdict requires evidence. The tool does not validate the verdict itself.');
  }
  if (request.sourceRevision !== undefined && !/^[0-9a-f]{7,64}$/i.test(request.sourceRevision)) fail('sourceRevision must be a Git commit hash.');
  if (!Array.isArray(request.cards) || request.cards.length < 1 || request.cards.length > 40) fail('Provide between 1 and 40 cards.');
  const ids = new Set();
  for (const card of request.cards) {
    if (!card || typeof card !== 'object') fail('Invalid card.');
    identifier(card.id, 'card.id');
    if (ids.has(card.id)) fail(`Duplicate card id: ${card.id}`);
    if (card.parentId !== undefined) {
      identifier(card.parentId, 'card.parentId');
      if (!ids.has(card.parentId)) fail('Parent cards must precede their children.');
    }
    string(card.file, 'card.file', 1000);
    if (path.posix.isAbsolute(card.file) || path.win32.isAbsolute(card.file) || card.file.includes('\\') || card.file.includes('\0')) {
      fail('Use workspace-relative source paths with forward slashes.');
    }
    if (!Number.isSafeInteger(card.line) || card.line < 1) fail('card.line must be a positive, 1-based integer.');
    if (card.function !== undefined) string(card.function, 'card.function', 200);
    if (card.kind !== undefined && !['function', 'context'].includes(card.kind)) fail('card.kind must be function or context.');
    if (card.description !== undefined) string(card.description, 'card.description');
    if (card.mapping !== undefined) {
      if (!card.mapping || !['citation', 'symbol', 'description', 'source-neighbor', 'reviewer'].includes(card.mapping.method)) fail('Unknown card mapping method.');
      if (!['low', 'medium', 'high'].includes(card.mapping.confidence)) fail('Mapping confidence must be low, medium or high.');
    }
    if (card.reason !== undefined) string(card.reason, 'card.reason');
    if (card.edgeKind !== undefined && !['hypothesis', 'call', 'state-dependency'].includes(card.edgeKind)) fail('Unknown edgeKind.');
    if (card.sourceHash !== undefined && !/^[0-9a-f]{64}$/.test(card.sourceHash)) fail('sourceHash must be SHA-256.');
    ids.add(card.id);
  }
  if (request.connections !== undefined) {
    if (!Array.isArray(request.connections) || request.connections.length > 200) fail('connections must be an array of at most 200 edges.');
    for (const edge of request.connections) {
      if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) fail('Each connection must join two existing, different cards.');
      if (!['hypothesis', 'call', 'state-dependency'].includes(edge.kind)) fail('Unknown connection kind.');
      if (edge.reason !== undefined) string(edge.reason, 'connection.reason');
    }
  }
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_BYTES) fail(`Finding request limit: ${MAX_BYTES} bytes.`);
  return request;
}
function readWorkspaceText(root, relative, maxBytes = MAX_BYTES) {
  const absolute = fs.realpathSync(path.resolve(root, relative));
  if (!contained(fs.realpathSync(root), absolute)) fail('Workspace data must resolve inside the project.');
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > maxBytes) fail(`Workspace JSON limit: ${maxBytes} bytes.`);
  return fs.readFileSync(absolute, 'utf8');
}
function readWorkspaceJson(root, relative, maxBytes = MAX_BYTES) { return JSON.parse(readWorkspaceText(root, relative, maxBytes)); }
function readJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) fail(`JSON input must be a file of at most ${MAX_BYTES} bytes.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function gitState(root) {
  try {
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 };
    return {
      head: execFileSync('git', ['rev-parse', 'HEAD'], options).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], options).trim())
    };
  } catch { return { head: null, dirty: null }; }
}
function sources(root, request) {
  evidenceSources(root, request.finding?.triage);
  const realRoot = fs.realpathSync(root);
  return request.cards.map(card => {
    const absolute = fs.realpathSync(path.resolve(realRoot, card.file));
    if (!contained(realRoot, absolute) || !absolute.endsWith('.sol') || !fs.statSync(absolute).isFile()) fail('Source must be a .sol file inside the workspace (including symlinks).');
    const source = fs.readFileSync(absolute, 'utf8');
    if (card.line > source.split(/\r?\n/).length) fail(`Line outside ${card.file}.`);
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    if (card.sourceHash && card.sourceHash !== hash) fail(`Stale source hash: ${card.file}. Re-read the source before submitting.`);
    return { absolute, hash };
  });
}
function evidenceSources(root, triage, stamp = false) {
  if (!triage) return [];
  review.validate(triage);
  const realRoot = fs.realpathSync(root);
  return triage.evidence.filter(item => item.source && !item.needsReview).map(item => {
    const absolute = fs.realpathSync(path.resolve(realRoot, item.source.file));
    if (!contained(realRoot, absolute) || !absolute.endsWith('.sol') || !fs.statSync(absolute).isFile()) fail('Evidence source escapes the workspace or is not Solidity.');
    const source = fs.readFileSync(absolute, 'utf8');
    if ((item.source.endLine || item.source.line) > source.split(/\r?\n/).length) fail(`Evidence line outside ${item.source.file}.`);
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    if (item.source.sourceHash && item.source.sourceHash !== hash) fail(`Stale evidence source: ${item.source.file}. Re-review the evidence, not just its hash.`);
    if (stamp) item.source.sourceHash = hash;
    return { id: item.id, absolute, hash, source };
  });
}
function checkRevision(request, git) {
  if (request.sourceRevision && (!git.head || !git.head.toLowerCase().startsWith(request.sourceRevision.toLowerCase()))) {
    fail('sourceRevision does not match this checkout. Use the analyzed checkout or re-triage against current code.');
  }
}
function writableDirectory(root, directory) {
  const realRoot = fs.realpathSync(root);
  const destination = path.resolve(realRoot, directory);
  if (!contained(realRoot, destination)) fail('Output directory escapes the workspace.');
  const relative = path.relative(realRoot, destination);
  let current = realRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()) fail(`Unsafe output directory: ${current}`);
    } else fs.mkdirSync(current);
  }
  return destination;
}
function atomicJson(root, relative, value) {
  const directory = writableDirectory(root, path.dirname(relative));
  const destination = path.join(directory, path.basename(relative));
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) fail('Refusing to overwrite a symbolic link.');
  const temporary = path.join(directory, `.tmp-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function noteText(request, analysis, git) {
  const f = request.finding;
  const lines = [f.title, `Assessment (not tool-verified): ${f.status}; confidence: ${f.confidence || 'unspecified'}`,
    `Reported severity: ${f.reportedSeverity || 'unspecified'}`, `Source: ${git.head || 'not a Git checkout'}${git.dirty ? ' + tracked modifications' : ''}`,
    `Navigation: ${analysis.mode}${analysis.success === false ? ' (Slither failed; source-only fallback)' : ''}`];
  if (f.reportRevision) lines.push(`Report revision: ${f.reportRevision} (may differ from checkout)`);
  for (const key of ['summary', 'expectedBehavior', 'actualBehavior', 'impact', 'preconditions', 'evidence', 'openQuestions', 'remediation']) {
    if (f[key]) lines.push(`\n${key}:\n${Array.isArray(f[key]) ? f[key].map(x => `- ${x}`).join('\n') : f[key]}`);
  }
  const connections = request.cards.filter(x => x.parentId).map(x => `${x.parentId} → ${x.id} [${x.edgeKind || 'hypothesis'}]: ${x.reason || 'No rationale supplied'}`);
  if (connections.length) lines.push('\nConnection rationale (arrows do not prove reachability):\n' + connections.join('\n'));
  lines.push('\nSource navigation can misresolve overloaded/interface/dynamic calls. Verify all targets. No exploit execution or automatic verdict.');
  return lines.join('\n');
}
module.exports = { REQUEST, STATUS, MAX_BYTES, STATUSES, validate, readJson, readWorkspaceText, readWorkspaceJson, sources, evidenceSources, gitState, checkRevision, writableDirectory, atomicJson, noteText, contained, identifier };
