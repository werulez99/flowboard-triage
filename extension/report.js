'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./protocol');
const store = require('./store');
const { SourceCatalog } = require('./source');
const { search } = require('./source-search');
const fieldNames = new Set(['severity', 'location', 'locations', 'summary', 'summarydescription', 'description', 'rootcause', 'preconditions', 'impact', 'mitigation', 'recommendation', 'attackpath', 'expectedbehavior', 'actualbehavior']);
const normalize = text => text.toLowerCase().replace(/[^a-z]/g, '');
function parseReport(text) {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Report limit: 4 MiB.');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headings = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(`{3,}|~{3,})/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const clean = lines[i].trim().replace(/^#{1,6}\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1');
    let match = clean.match(/^\[?([HMLICG]-?\d+)\]?[\s:.)-]+(.+)$/i);
    if (!match) match = clean.match(/^(?:Issue|Finding)\s*(?:[:#]\s*)?(\d+)[\s:.)-]+(.+)$/i)?.map((x, n) => n === 1 ? `F-${x}` : x);
    if (match) { headings.push({ line: i, id: match[1], title: match[2] }); continue; }
    const generic = lines[i].match(/^#{2,4}\s+(.+)$/);
    if (generic && !fieldNames.has(normalize(generic[1])) && !/^(findings?|high|medium|low|informational|summary|overview|recommendations?|table of contents)$/i.test(generic[1].trim())) {
      const following = lines.slice(i + 1, i + 8).join('\n');
      if (/\*\*(?:Severity|Locations?)\*\*\s*:/i.test(following)) headings.push({ line: i, id: `F-${headings.length + 1}`, title: generic[1].trim() });
    }
  }
  if (!headings.length) throw new Error('No findings found. Use [H-01] Title, Issue 1: Title, or Markdown headings followed by Severity/Location fields.');
  if (headings.length > 300) throw new Error('Report limit: 300 findings.');
  const seen = new Map();
  return headings.map((heading, i) => {
    const count = (seen.get(heading.id) || 0) + 1; seen.set(heading.id, count);
    const id = count === 1 ? heading.id : `${heading.id}-${count}`;
    const body = lines.slice(heading.line + 1, headings[i + 1]?.line ?? lines.length).join('\n').trim();
    const fields = {};
    let active = null, fieldLines = [];
    const flush = () => { if (active) fields[active] = fieldLines.join('\n').trim(); };
    for (const line of body.split('\n')) {
      const marker = line.match(/^\s*\*\*([^*]+)\*\*\s*:?\s*(.*)$/) || line.match(/^#{2,6}\s+(.+)$/);
      if (marker && fieldNames.has(normalize(marker[1]))) { flush(); active = normalize(marker[1]); fieldLines = [marker[2] || '']; }
      else if (active) fieldLines.push(line);
    }
    flush();
    const locations = [];
    const locationText = body;
    for (const location of locationText.matchAll(/(?:[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.sol(?::|#L)(\d+)(?:-L?\d+)?(?:,\d+(?:-\d+)?)*/g)) {
      const split = location[0].search(/\.sol(?::|#L)/) + 4;
      const file = location[0].slice(0, split).replace(/\\/g, '/');
      for (const part of location[0].slice(split).replace(/^[:#L]+/, '').split(',')) {
        const line = Number(part.split('-')[0]);
        if (Number.isSafeInteger(line) && line > 0) locations.push({ file, line });
      }
    }
    const names = [...new Set([...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(x => x[1]))]
      .filter(name => !['if', 'for', 'while', 'require', 'assert', 'function', 'returns', 'mapping'].includes(name));
    return { id, displayId: heading.id, title: heading.title, body, fields, locations, names,
      warnings: count > 1 ? [`Duplicate report ID ${heading.id}; this occurrence has a separate draft.`] : [] };
  });
}
function mapFile(root, supplied, files = []) {
  const clean = supplied.replace(/^([A-Za-z]:)?\/+/, '').replace(/\\/g, '/');
  if (clean.split('/').includes('..')) return null;
  const parts = clean.split('/');
  const candidates = [clean];
  for (let i = 1; i < parts.length - 1; i++) candidates.push(parts.slice(i).join('/'));
  for (const relative of candidates) {
    try {
      const absolute = fs.realpathSync(path.resolve(root, relative));
      if (p.contained(fs.realpathSync(root), absolute) && absolute.endsWith('.sol') && fs.statSync(absolute).isFile()) return relative;
    } catch { /* unresolved citation */ }
  }
  const matches = files.filter(file => file.endsWith('/' + clean) || path.basename(file) === clean);
  return matches.length === 1 ? path.relative(root, matches[0]).split(path.sep).join('/') : null;
}
function draftIssue(issue, root, runner, result, sourceRevision, catalog = new SourceCatalog(root, runner, result)) {
  const cards = [], unresolved = [], functions = [], warnings = [...(issue.warnings || [])];
  const seen = new Set(), citedFiles = new Set();
  const files = [...new Set(catalog.functions.map(fn => fn.file))];
  function add(fn, file, line, description, method = 'citation') {
    const key = `${fn.file}:${fn.startLine}:${fn.kind || 'function'}:${fn.name}`;
    if (seen.has(key) || cards.length === 40) return;
    seen.add(key); functions.push(fn);
    const doc = catalog.document(file);
    cards.push({ id: `source-${cards.length + 1}`, file, line, ...(fn.kind === 'context' ? { kind: 'context' } : { function: fn.name }),
      sourceHash: crypto.createHash('sha256').update(doc.text).digest('hex'), description,
      mapping: { method, confidence: ['description', 'source-neighbor'].includes(method) ? 'low' : 'medium' } });
  }
  for (const location of issue.locations.slice(0, 500)) {
    const file = mapFile(root, location.file, files);
    if (!file) { unresolved.push({ ...location, reason: 'Source file not found unambiguously in this checkout.' }); continue; }
    const doc = catalog.document(file); citedFiles.add(doc.uri.fsPath);
    if (location.line > doc.lineCount) { unresolved.push({ ...location, reason: 'Line outside current source; report may use an older revision.' }); continue; }
    const fn = catalog.functionAt(file, location.line);
    if (!fn || !catalog.anatomy(fn)) add(catalog.resolveCard({ file, line: location.line, kind: 'context' }), file, location.line, 'Report citation does not uniquely identify one executable function declaration. This is source context, not a call step.');
    else add(fn, file, location.line, 'Mapped from report line; confirm that this is the intended function in the analyzed revision.');
  }
  for (const name of issue.names || []) {
    const named = catalog.named(name, citedFiles);
    if (named.length === 1) add(named[0], catalog.relative(named[0].file), named[0].startLine, 'Explicit function mention in report; connection and claim remain unreviewed.', 'symbol');
    else if (named.length > 1) warnings.push(`Ambiguous function mention ${name}(): ${named.length} possible definitions; not auto-selected.`);
  }
  let retrieval = null;
  if (!cards.some(card => card.kind !== 'context')) {
    // File mentions without line numbers can scope description-based retrieval.
    for (const match of issue.body.matchAll(/(?:[\w.@-]+[\\/])*[\w.@-]+\.sol\b/g)) {
      const file = mapFile(root, match[0].replace(/\\/g, '/'), files);
      if (file) citedFiles.add(catalog.document(file).uri.fsPath);
    }
    const engine = search(catalog), ranked = engine.rank(issue, citedFiles);
    retrieval = { ...ranked, candidates: ranked.candidates.map(({ fn, ...candidate }) => ({ ...candidate, function: fn.name, contract: fn.contract })) };
    const anchors = ranked.candidates.slice(0, 3);
    for (const candidate of anchors) add(candidate.fn, candidate.file, candidate.line, candidate.reason, candidate.method);
    if (anchors.length) warnings.push('Description-based anchors are relevance candidates, not established claim-to-code matches. Confirm them during review.');
    else warnings.push('No sufficiently specific source match was found. Add a contract/function identifier or ask your assistant to inspect the claim; no call steps were invented.');
    if (ranked.ambiguous) warnings.push('Several source functions have similar relevance scores. The tool shows candidates without selecting a definitive starting point.');
    for (const neighbor of engine.neighbors(anchors.map(candidate => candidate.fn), 6)) add(neighbor.fn, catalog.relative(neighbor.fn.file), neighbor.fn.startLine, neighbor.reason, 'source-neighbor');
  } else if (!issue.locations.length) {
    const anchors = functions.filter(fn => fn.kind !== 'context');
    for (const neighbor of search(catalog).neighbors(anchors, 6)) add(neighbor.fn, catalog.relative(neighbor.fn.file), neighbor.fn.startLine, neighbor.reason, 'source-neighbor');
  }
  if (issue.locations.length > 500) warnings.push('Citation limit reached (500); remaining citations were not expanded.');
  if (cards.length === 40) warnings.push('Diagram limit reached (40 cards); refine the scope during review.');
  const connections = catalog.graph(functions, cards);
  for (const fn of functions.filter(value => value.kind !== 'context')) for (const link of catalog.callLinks(fn)) {
    if (link.candidates.length > 1 && warnings.length < 30) warnings.push(`${catalog.relative(fn.file)}:${link.line} — ${link.expression} has ${link.candidates.length} possible targets. No unique dispatch target was auto-selected.`);
  }
  const f = issue.fields;
  const request = cards.length ? {
    version: 1, id: `import-${crypto.randomUUID()}`, findingId: issue.id, ...(sourceRevision ? { sourceRevision } : {}),
    finding: { title: `${issue.displayId || issue.id}: ${issue.title}`.slice(0, 250), status: 'unreviewed', confidence: 'low',
      ...(f.severity ? { reportedSeverity: f.severity.slice(0, 4000) } : {}),
      summary: (f.summarydescription || f.summary || f.description || issue.body || 'Imported finding').slice(0, 4000),
      ...(f.expectedbehavior ? { expectedBehavior: f.expectedbehavior.slice(0, 4000) } : {}),
      ...(f.actualbehavior ? { actualBehavior: f.actualbehavior.slice(0, 4000) } : {}),
      ...(f.preconditions ? { preconditions: [f.preconditions.slice(0, 4000)] } : {}),
      ...(f.impact ? { impact: f.impact.slice(0, 4000) } : {}),
      ...(f.mitigation || f.recommendation ? { remediation: (f.mitigation || f.recommendation).slice(0, 4000) } : {}),
      openQuestions: ['Confirm the analyzed report revision and intended behavior. Source mappings are unreviewed.', 'Does the claimed deviation actually follow from these functions, permissions and state?'] },
    cards, connections
  } : null;
  if (request) p.validate(request);
  return { id: issue.id, displayId: issue.displayId || issue.id, title: issue.title, severity: f.severity || 'Unspecified', reportText: issue.body,
    status: 'unreviewed', unresolved, warnings, retrieval, request, citationCount: issue.locations.length };
}
async function importReport(reportPath, root, extensionPath, options = {}) {
  const stat = fs.statSync(reportPath);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Report must be a file of at most 4 MiB.');
  const text = fs.readFileSync(reportPath, 'utf8');
  const issues = parseReport(text);
  const reportHash = crypto.createHash('sha256').update(text).digest('hex');
  let previous = null;
  try { previous = p.readWorkspaceJson(root, '.flowboard/report.json', 12 * 1024 * 1024); } catch { /* first import */ }
  const namespace = previous && previous.reportHash !== reportHash ? `r-${reportHash.slice(0, 8)}-` : previous?.reportNamespace || '';
  if (previous?.reportHash && previous.reportHash !== reportHash) p.atomicJson(root, `.flowboard/reports/${previous.reportHash}.json`, previous);
  const { analyze } = require('./runner-adapter');
  const { runner, result } = await analyze(extensionPath, fs.realpathSync(root), { mode: 'source' });
  const catalog = new SourceCatalog(root, runner, result);
  const git = p.gitState(root);
  const bundle = { version: 1, importedAt: new Date().toISOString(), sourceRevision: git.head,
    reportRevision: options.reportRevision || null, reportNamespace: namespace,
    reportName: path.basename(reportPath), reportHash,
    issues: issues.map(issue => draftIssue({ ...issue, id: namespace + issue.id }, root, runner, result, git.head, catalog)) };
  catalog.assertFresh();
  for (const issue of bundle.issues) if (issue.request) {
    if (options.reportRevision) issue.request.finding.reportRevision = options.reportRevision;
    const relative = store.draftPath(issue.id);
    if (fs.existsSync(path.join(root, relative))) {
      issue.draftPreserved = true;
      try { issue.request = store.readDraft(root, issue.id); issue.status = issue.request.finding.status; }
      catch (error) { issue.request = null; issue.warnings.push(`Existing draft preserved but invalid: ${error.message}`); }
    } else store.writeDraft(root, issue.id, issue.request);
  }
  p.atomicJson(root, '.flowboard/report.json', bundle);
  return bundle;
}
async function refreshFindingMap(root, id, extensionPath, options = {}) {
  p.identifier(id, 'finding ID');
  let current = null;
  try { current = store.readDraft(root, id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const draftHash = current ? hash(current) : null;
  if (options.expectedFingerprint && options.expectedFingerprint !== draftHash) throw new Error('The finding was edited elsewhere. Reload before rebuilding its map; nothing was overwritten.');
  let bundle = null;
  try { bundle = store.readReport(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const original = bundle?.issues.find(issue => issue.id === id);
  if (!original && !current) throw new Error('No original finding or draft is available for source search.');
  const text = original?.reportText || current.finding.summary || '';
  const title = original?.title || current.finding.title;
  const originalHash = hash({ text, title, reportHash: bundle?.reportHash });
  const parsed = parseReport(`### [I-01] Source map refresh\n${text}`)[0];
  Object.assign(parsed, { id, displayId: original?.displayId || id, title });
  const { analyze } = require('./runner-adapter');
  const { runner, result } = await analyze(extensionPath, fs.realpathSync(root), { mode: 'source' });
  const catalog = new SourceCatalog(root, runner, result), git = p.gitState(root);
  const regenerated = draftIssue(parsed, root, runner, result, git.head || undefined, catalog);
  catalog.assertFresh();
  let latest = null;
  try { latest = store.readDraft(root, id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if ((latest ? hash(latest) : null) !== draftHash) throw new Error('The finding changed while its source map was being rebuilt. Reload and retry; nothing was overwritten.');
  if (bundle) {
    const latestBundle = store.readReport(root), latestIssue = latestBundle.issues.find(issue => issue.id === id);
    if (hash({ text: latestIssue?.reportText || current?.finding.summary || '', title: latestIssue?.title || current?.finding.title, reportHash: latestBundle.reportHash }) !== originalHash) throw new Error('The original report changed during source search. Reload and retry.');
    bundle = latestBundle;
  }
  if (!regenerated.request) {
    if (original && bundle) {
      Object.assign(bundle.issues.find(issue => issue.id === id), { retrieval: regenerated.retrieval, unresolved: regenerated.unresolved, warnings: regenerated.warnings });
      p.atomicJson(root, '.flowboard/report.json', bundle);
    }
    return { ...regenerated, warnings: [...regenerated.warnings, 'No sufficient new map was found. Any previous saved draft was preserved.'] };
  }
  let sourceChanged = false, bindingsChanged = false;
  if (current) {
    try { p.checkRevision(current, git); p.sources(root, current); } catch { sourceChanged = true; }
    const bindings = request => request.cards.map(card => {
      const fn = catalog.resolveCard(card);
      return `${card.kind || 'function'}:${catalog.relative(fn.file)}:${fn.startLine}:${fn.name}:${fn.paramCount ?? ''}`;
    }).sort();
    if (!sourceChanged) { try { bindingsChanged = hash(bindings(current)) !== hash(bindings(regenerated.request)); } catch { bindingsChanged = true; } }
    if ((sourceChanged || bindingsChanged) && !['unreviewed', 'insufficient-evidence'].includes(current.finding.status) && !options.allowReviewReset) {
      const error = new Error('The source or source-map bindings changed since this finding was assessed. Rebuilding requires explicitly marking that prior assessment unreviewed; the original draft will be archived.');
      error.code = 'REVIEW_RESET_REQUIRED'; throw error;
    }
    regenerated.request.finding = structuredClone(current.finding);
    if (sourceChanged || bindingsChanged) {
      regenerated.request.finding.status = 'unreviewed'; regenerated.request.finding.confidence = 'low';
      regenerated.request.finding.openQuestions = [...(regenerated.request.finding.openQuestions || []).slice(0, 39), 'Source or mapped anchors changed. Prior evidence/assessment must be re-reviewed; the old draft is archived.'];
      regenerated.warnings.push('Source or mapped anchors changed: prior review fields were retained for context, not revalidated. The assessment is now unreviewed.');
      if (regenerated.request.finding.triage) {
        for (const item of regenerated.request.finding.triage.evidence) item.needsReview = true;
        for (const check of regenerated.request.finding.triage.checks) check.state = 'unchecked';
      }
    }
    regenerated.backup = store.archiveDraft(root, id, current);
  }
  p.validate(regenerated.request); p.sources(root, regenerated.request); p.checkRevision(regenerated.request, p.gitState(root)); catalog.assertFresh();
  store.writeDraft(root, id, regenerated.request);
  regenerated.status = regenerated.request.finding.status;
  if (original && bundle) {
    Object.assign(bundle.issues.find(issue => issue.id === id), regenerated);
    p.atomicJson(root, '.flowboard/report.json', bundle);
  }
  return regenerated;
}
module.exports = { parseReport, mapFile, draftIssue, importReport, refreshFindingMap };
