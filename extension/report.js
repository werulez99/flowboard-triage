'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./protocol');
const store = require('./store');
const { SourceCatalog } = require('./source');
const { search } = require('./source-search');
const { preparedReview, reportClaims } = require('./investigation');
const { content, fieldNames, normalize, mentions } = require('./report-content');
function parseReport(text, options = {}) {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Report limit: 4 MiB.');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headings = [], sections = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(`{3,}|~{3,})/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const clean = lines[i].trim().replace(/^#{1,6}\s+/, '').replace(/^\*\*(.*?)\*\*$/, '$1');
    const heading = lines[i].match(/^#{1,4}\s+(.+)$/);
    if (heading) sections.push({ line: i + 1, level: lines[i].match(/^#+/)[0].length, title: heading[1], classification: 'context', reason: 'Report heading or structured finding field.' });
    let match = clean.match(/^\[?([HMLICG]-?\d+)\]?[\s:.)-]+(.+)$/i);
    if (!match) match = clean.match(/^(?:Issue|Finding)\s*(?:[:#]\s*)?(\d+)[\s:.)-]+(.+)$/i)?.map((x, n) => n === 1 ? `F-${x}` : x);
    if (match) { headings.push({ line: i, level: heading ? lines[i].match(/^#+/)[0].length : 4, id: match[1], title: match[2] });
      if (!heading) sections.push({ line: i + 1, level: 4, title: clean, classification: 'finding', reason: 'Explicit finding identifier.' }); continue; }
    const generic = lines[i].match(/^#{2,4}\s+(.+)$/);
    if (generic && !fieldNames.has(normalize(generic[1])) && !/^(findings?|high|medium|low|informational|summary|overview|recommendations?|table of contents)$/i.test(generic[1].trim())) {
      // A parent section must not borrow Severity from a child finding and
      // become a fabricated finding of its own (for example a phase group).
      const following = lines.slice(i + 1, i + 8).join('\n').split(/^#{1,6}\s/m)[0];
      if (/\*\*(?:Severity|Locations?)\*\*\s*:/i.test(following)) headings.push({ line: i, level: lines[i].match(/^#+/)[0].length, id: `F-${headings.length + 1}`, title: generic[1].trim() });
    }
  }
  if (!headings.length) throw new Error('No findings found. Use [H-01] Title, Issue 1: Title, or Markdown headings followed by Severity/Location fields.');
  if (headings.length > 1000) throw new Error('This report has more than 1,000 findings. Split it into smaller reports.');
  const seen = new Map();
  const parsed = headings.map((heading, i) => {
    const count = (seen.get(heading.id) || 0) + 1; seen.set(heading.id, count);
    const id = count === 1 ? heading.id : `${heading.id}-${count}`;
    const boundary = sections.find(section => section.line > heading.line + 1 && section.level <= heading.level && !fieldNames.has(normalize(section.title)));
    const endLine = Math.min(headings[i + 1]?.line ?? lines.length, boundary ? boundary.line - 1 : lines.length);
    const body = lines.slice(heading.line + 1, endLine).join('\n').trim();
    const parsed = content(body), fields = parsed.fields;
    const locations = [];
    const locationText = parsed.current;
    for (const location of locationText.matchAll(/(?:[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.sol(?::L?|#L)(\d+)(?:-L?\d+)?(?:,\d+(?:-\d+)?)*/g)) {
      const split = location[0].search(/\.sol(?::|#L)/) + 4;
      const file = location[0].slice(0, split).replace(/\\/g, '/');
      for (const part of location[0].slice(split).replace(/^[:#L]+/, '').split(',')) {
        const line = Number(part.split('-')[0]);
        if (Number.isSafeInteger(line) && line > 0) locations.push({ file, line });
      }
    }
    const symbols = mentions(heading.title + '\n' + parsed.current), names = [...new Set(symbols.map(item => item.name))];
    return { id, displayId: heading.id, title: heading.title, body, fields, locations, names, symbols,
      reportSpan: { line: heading.line + 1, endLine },
      warnings: count > 1 ? [`Duplicate report ID ${heading.id}; this occurrence has a separate draft.`] : [] };
  });
  for (const section of sections) {
    section.endLine = (sections.find(value => value.line > section.line)?.line || lines.length + 1) - 1;
    const issue = parsed.find(value => value.reportSpan.line === section.line);
    if (issue) { section.classification = 'finding'; section.findingId = issue.id; section.reason = 'Explicit finding identifier or a direct Severity/Location field.'; }
    else if (!fieldNames.has(normalize(section.title)) && !/^(?:security audit report|findings?|(?:finding|executive) summary|high|medium|low|informational|summary|overview|recommendations?|table of contents|found by \d+ phases?)(?:\b|$)/i.test(section.title.replace(/^[*]+|[*]+$/g, ''))) {
      // Unknown top-level sections are accounted for, not silently discarded.
      const next = sections.find(value => value.line > section.line);
      const prose = lines.slice(section.line, (next?.line || lines.length + 1) - 1).join('\n').trim();
      if (prose && !parsed.some(value => section.line > value.reportSpan.line && section.line <= value.reportSpan.endLine)) {
        section.classification = 'ambiguous'; section.reason = 'A report section has no clear finding identifier or direct finding fields. Check its classification before publication.';
      }
    }
  }
  const manifest = { version: 1, sections, ambiguities: sections.filter(value => value.classification === 'ambiguous'),
    reportLines: lines.length, findingCount: parsed.length };
  return options.manifest ? { issues: parsed, manifest } : parsed;
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
  if (matches.length === 1) return path.relative(root, matches[0]).split(path.sep).join('/');
  // Only a unique complete project-relative path may repair capitalization.
  // A basename/suffix match is not enough on a case-sensitive filesystem.
  const caseMatches = files.filter(file => path.relative(root, file).split(path.sep).join('/').toLowerCase() === clean.toLowerCase());
  return caseMatches.length === 1 ? path.relative(root, caseMatches[0]).split(path.sep).join('/') : null;
}
function draftIssue(issue, root, runner, result, sourceRevision, catalog = new SourceCatalog(root, runner, result)) {
  const cards = [], unresolved = [], functions = [], warnings = [...(issue.warnings || [])];
  const seen = new Set(), citedFiles = new Set();
  const files = [...new Set(catalog.functions.map(fn => fn.file))];
  const applicability = require('./report-targets').inspect(catalog, issue.title, issue.body);
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
    if (!fn || !catalog.anatomy(fn)) add(catalog.resolveCard({ file, line: location.line, kind: 'context' }), file, location.line, 'The report points here, but not to a single function. Read this code as context, not a step in a call.');
    else add(fn, file, location.line, 'The report points here. Check that this is the right function and code version.');
  }
  const ambiguous = new Set();
  for (const mention of issue.symbols || (issue.names || []).map(name => ({ name }))) {
    if (mention.callExpression) continue;
    const name = mention.name, named = catalog.mentioned(mention, citedFiles);
    if (named.length === 1) add(named[0], catalog.relative(named[0].file), named[0].startLine, 'The report names this function. Its role in the issue still needs checking.', 'symbol');
    else if (named.length > 1) { ambiguous.add(name); warnings.push(`Ambiguous function mention ${mention.text || name + '()'}: ${named.length} possible definitions; not auto-selected.`); }
    else if (mention.contract || mention.signature) { ambiguous.add(name); warnings.push(`No exact definition for ${mention.text || name} was found. Check the report's implementation and code version.`); }
  }
  let retrieval = null;
  if (!applicability.blockers.length && !cards.some(card => card.kind !== 'context')) {
    // File mentions without line numbers can scope description-based retrieval.
    for (const match of content(issue.body).current.matchAll(/(?:[\w.@-]+[\\/])*[\w.@-]+\.sol\b/g)) {
      const file = mapFile(root, match[0].replace(/\\/g, '/'), files);
      if (file) citedFiles.add(catalog.document(file).uri.fsPath);
    }
    const production = new Set(files.filter(file => !/(?:^|\/)(?:test|tests|script|scripts|mocks|lib|node_modules)\//.test(catalog.relative(file))));
    const engine = search(catalog), ranked = engine.rank(issue, citedFiles.size ? citedFiles : production);
    retrieval = { ...ranked, candidates: ranked.candidates.map(({ fn, ...candidate }) => ({ ...candidate, function: fn.name, contract: fn.contract })) };
    // Do not undo an exact-name ambiguity by picking the highest keyword score.
    // If every explicit function is unresolved, nearby lexical matches must
    // not reintroduce a different overload through their callers/callees.
    const unresolvedNamesOnly = ambiguous.size && issue.names?.length && issue.names.every(name => ambiguous.has(name));
    const anchors = unresolvedNamesOnly ? [] : ranked.candidates.filter(candidate => !ambiguous.has(candidate.fn.name)).slice(0, 3);
    for (const candidate of anchors) add(candidate.fn, candidate.file, candidate.line, candidate.reason, candidate.method);
    if (anchors.length) warnings.push('Description-based anchors are relevance candidates, not established claim-to-code matches. Confirm them during review.');
    else warnings.push('No sufficiently specific source match was found. Add a contract/function identifier or ask your assistant to inspect the claim; no call steps were invented.');
    if (ranked.ambiguous) warnings.push('Several source functions have similar relevance scores. The tool shows candidates without selecting a definitive starting point.');
    for (const neighbor of engine.neighbors(anchors.map(candidate => candidate.fn), 6)) add(neighbor.fn, catalog.relative(neighbor.fn.file), neighbor.fn.startLine, neighbor.reason, 'source-neighbor');
  } else if (!applicability.blockers.length) {
    const anchors = functions.filter(fn => fn.kind !== 'context');
    for (const neighbor of search(catalog).neighbors(anchors, 6)) add(neighbor.fn, catalog.relative(neighbor.fn.file), neighbor.fn.startLine, neighbor.reason, 'source-neighbor');
  }
  if (issue.locations.length > 500) warnings.push('Citation limit reached (500); remaining citations were not expanded.');
  if (cards.length === 40) warnings.push('Diagram limit reached (40 cards); refine the scope during review.');
  if (applicability.blockers.length) { cards.length = 0; functions.length = 0; warnings.push(...applicability.blockers); }
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
      ...(f.preconditions || f.conditions ? { preconditions: [(f.preconditions || f.conditions).slice(0, 4000)] } : {}),
      ...(f.impact ? { impact: f.impact.slice(0, 4000) } : {}),
      ...(f.mitigation || f.recommendation ? { remediation: (f.mitigation || f.recommendation).slice(0, 4000) } : {}),
      openQuestions: ['Does the report describe this version of the code?', 'Do these functions, permissions and conditions cause the reported problem?'] },
    cards, connections
  } : null;
  if (request) {
    request.finding.triage = preparedReview(request.finding);
    if (f.rootcause && !request.finding.summary.includes(f.rootcause)) request.finding.triage.claims.push(...reportClaims({ summary: f.rootcause }).map(claim => ({ ...claim, id: 'cause-' + claim.id })));
    if (f.expectedbehavior) request.finding.triage.ruleOrigin = { kind: 'report', reference: 'Imported report: Expected behavior (not independently checked)' };
    // A report's "actual behavior" is still an assertion, not an inspected
    // source observation. Preserve it in the original report and as a claim.
    if (f.actualbehavior && f.actualbehavior.length <= 2000 && !request.finding.triage.claims.some(claim => claim.text === f.actualbehavior)) {
      request.finding.triage.claims.push({ id: 'reported-actual-behavior', text: f.actualbehavior, state: 'unreviewed', evidence: [], questions: [] });
    }
    p.validate(request);
  }
  return { id: issue.id, displayId: issue.displayId || issue.id, title: issue.title, severity: f.severity || 'Unspecified', reportText: issue.body, reportSpan: issue.reportSpan,
    status: 'unreviewed', unresolved, warnings, retrieval, applicability: { blockers: applicability.blockers, named: applicability.named,
      definitions: applicability.selected.map(fn => ({ file: catalog.relative(fn.file), line: fn.startLine, name: fn.name, contract: fn.contract })) }, request, citationCount: issue.locations.length };
}
async function importReport(reportPath, root, extensionPath, options = {}) {
  const stat = fs.statSync(reportPath);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Report must be a file of at most 4 MiB.');
  const text = fs.readFileSync(reportPath, 'utf8');
  const { issues, manifest } = parseReport(text, { manifest: true });
  const reportHash = crypto.createHash('sha256').update(text).digest('hex');
  let previous = null;
  try { previous = p.readWorkspaceJson(root, '.flowboard/report.json', 12 * 1024 * 1024); } catch { /* first import */ }
  const namespace = previous && previous.reportHash !== reportHash ? `r-${reportHash.slice(0, 8)}-` : previous?.reportNamespace || '';
  if (previous?.reportHash && previous.reportHash !== reportHash) p.atomicJson(root, `.flowboard/reports/${previous.reportHash}.json`, previous);
  const git = p.gitState(root);
  // The editor imports the report first. Mapping every issue before showing
  // the library can monopolize the extension host for minutes on large trees.
  // An unprepared issue is not an unsuccessful source search or a review.
  let catalog;
  if (!options.deferMapping) {
    const { analyze } = require('./runner-adapter');
    const { runner, result } = await analyze(extensionPath, fs.realpathSync(root), { mode: 'source' });
    catalog = new SourceCatalog(root, runner, result);
  }
  const bundle = { version: 1, importedAt: new Date().toISOString(), sourceRevision: git.head,
    reportRevision: options.reportRevision || null, reportNamespace: namespace,
    reportName: path.basename(reportPath), reportHash, originalReport: text, reconciliation: manifest,
    issues: issues.map(issue => catalog ? draftIssue({ ...issue, id: namespace + issue.id }, root, catalog.runner, catalog.result, git.head, catalog) : {
      id: namespace + issue.id, displayId: issue.displayId, title: issue.title, severity: issue.fields.severity || 'Unspecified',
      reportText: issue.body, reportSpan: issue.reportSpan, status: 'unreviewed', mappingPending: true, request: null,
      unresolved: [], warnings: [...issue.warnings], citationCount: issue.locations.length
    }) };
  catalog?.assertFresh();
  for (const issue of bundle.issues) {
    if (issue.request && options.reportRevision) issue.request.finding.reportRevision = options.reportRevision;
    const relative = store.draftPath(issue.id);
    if (fs.existsSync(path.join(root, relative))) {
      issue.draftPreserved = true;
      try { issue.request = store.readDraft(root, issue.id); issue.status = issue.request.finding.status; issue.mappingPending = false; }
      catch (error) { issue.request = null; issue.warnings.push(`Existing draft preserved but invalid: ${error.message}`); }
    } else if (issue.request) store.writeDraft(root, issue.id, issue.request);
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
  const parsed = parseReport(`### [I-01] ${title.replace(/[\r\n]+/g, ' ')}\n${text}`)[0];
  Object.assign(parsed, { id, displayId: original?.displayId || id, title });
  let catalog = options.catalog;
  if (!catalog) {
    const { analyze } = require('./runner-adapter');
    const { runner, result } = await analyze(extensionPath, fs.realpathSync(root), { mode: 'source' });
    catalog = new SourceCatalog(root, runner, result);
  }
  if (catalog.root !== fs.realpathSync(root)) throw new Error('The source index belongs to a different project.');
  catalog.assertFresh();
  const git = p.gitState(root);
  const regenerated = { ...draftIssue(parsed, root, catalog.runner, catalog.result, git.head || undefined, catalog), mappingPending: false };
  if (regenerated.request && bundle?.reportRevision) regenerated.request.finding.reportRevision = bundle.reportRevision;
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
      Object.assign(bundle.issues.find(issue => issue.id === id), { mappingPending: false, retrieval: regenerated.retrieval, unresolved: regenerated.unresolved, warnings: regenerated.warnings });
      p.atomicJson(root, '.flowboard/report.json', bundle);
    }
    return { ...regenerated, warnings: [...regenerated.warnings, 'No sufficient new map was found. Any previous saved draft was preserved.'] };
  }
  let sourceChanged = false, bindingsChanged = false;
  if (current) {
    try { p.checkRevision(current, git); p.sources(root, current); } catch { sourceChanged = true; }
    // The saved board may contain inspected implementations expanded beyond
    // the draft's initial cards. Its fingerprint covers the whole source index;
    // do not carry a definitive review across a changed dependency merely
    // because the original anchor file and Git HEAD stayed unchanged.
    if (!sourceChanged) {
      try {
        const cached = store.readBoard(root, id);
        if (cached) {
          const fns = current.cards.map(card => catalog.resolveCard(card));
          const edges = [...(current.connections || []), ...current.cards.filter(card => card.parentId).map(card => ({
            from: card.parentId, to: card.id, kind: card.edgeKind || 'hypothesis', reason: card.reason || ''
          }))].filter((edge, index, all) => all.findIndex(other => other.from === edge.from && other.to === edge.to) === index);
          const checked = catalog.validateConnections(fns, current.cards, edges);
          const fingerprint = crypto.createHash('sha256').update(catalog.fingerprint(current.cards) + JSON.stringify(checked.connections)).digest('hex');
          if ((cached.reviewSourceFingerprint || cached.fingerprint) !== fingerprint) {
            sourceChanged = true;
            regenerated.warnings.push('The previous source index or inspected context changed outside the original anchors. Prior review evidence needs re-review.');
          }
        }
      } catch (error) {
        sourceChanged = true;
        regenerated.warnings.push(`The previous source context could not be verified (${error.message}). Prior review evidence needs re-review.`);
      }
    }
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
        require('./webview/claim-model').invalidate(regenerated.request.finding.triage);
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
