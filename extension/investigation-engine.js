'use strict';
// One persisted, source-bound defensive review. Model output is an interpretation,
// never an executed observation or a researcher verdict. Work is finite and read-only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./protocol');
const { search, terms } = require('./source-search');
const { loadCompiler } = require('./compiler-context');
const { runProvider, schema: reviewSchema } = require('./semantic-provider');
const challengeFormat = require('./challenge-format');
const { relatedCode } = require('./reading-context');
const { content } = require('./report-content');
const { escaped, lexicalCode } = require('./solidity-text');
const walkthrough = require('./webview/walkthrough-model');
const documentation = require('./local-documentation');
const guidePolicy = require('./guide-policy');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const MAX_BYTES = 3 * 1024 * 1024;
const isTest = file => /(?:^|\/)(?:test|tests)\//.test(file) || /\.t\.sol$/.test(file);
const now = () => new Date().toISOString();
const fileFor = id => `.flowboard/investigations/${p.identifier(id, 'finding ID') || id}.json`;
function snapshot(catalog, request, issue) {
  catalog.assertFresh();
  const sources = [...catalog.sourceStamps.keys()].sort().map(file => [catalog.relative(file), hash(fs.readFileSync(file, 'utf8'))]);
  return { version: 1, policy: guidePolicy.POLICY, project: hash(fs.realpathSync(catalog.root)), sourceDigest: hash(sources), sourceCount: sources.length,
    configuration: catalog.projectConfigurationStamp,
    reportHash: hash([request.finding.title, request.finding.summary, request.finding.expectedBehavior, request.finding.preconditions, issue?.reportText || '']),
    revision: p.gitState(catalog.root).head || null,
    documentation: documentation.inspect(catalog.root, request.finding.title).digest };
}
function sameSnapshot(a, b) { return !!a && a.policy === b.policy && a.project === b.project && a.sourceDigest === b.sourceDigest && a.configuration === b.configuration && a.reportHash === b.reportHash && a.revision === b.revision && (a.documentation || null) === (b.documentation || null); }
function write(root, draft) {
  let existing;
  try { existing = p.readWorkspaceJson(root, fileFor(draft.findingId), MAX_BYTES); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (draft.storageRevision == null || existing.revision !== draft.storageRevision) || !existing && draft.storageRevision != null) throw new Error('Investigation changed in another view. Reopen it before updating; the other draft was preserved.');
  draft.updatedAt = now();
  draft.storageRevision = draft.revision;
  if (Buffer.byteLength(JSON.stringify(draft)) > MAX_BYTES) throw new Error('Investigation draft exceeded its bounded storage size. Previous draft is preserved.');
  p.atomicJson(root, fileFor(draft.findingId), draft);
}
function read(root, id) {
  try {
    const value = p.readWorkspaceJson(root, fileFor(id), MAX_BYTES);
    if (value.version !== 1 || value.engine !== 'source-review-v1' || value.findingId !== id || !Array.isArray(value.claims) || !Array.isArray(value.sources) || !Array.isArray(value.evidence) || !Array.isArray(value.corrections) || !Array.isArray(value.actions) || !Array.isArray(value.runs)) throw new Error('Invalid or mismatched investigation draft.');
    for (const [key, maximum] of Object.entries({ claims: 8, evidence: 24, transitions: 12, questions: 8, sources: 40, actions: 50, experiments: 10, corrections: 30, runs: 16 })) {
      if (!Array.isArray(value[key]) || value[key].length > maximum || value[key].some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error(`Invalid investigation ${key}.`);
    }
    if (!value.snapshot || !/^[a-f0-9]{64}$/.test(value.snapshot.sourceDigest) || !/^[a-f0-9]{64}$/.test(value.snapshot.reportHash) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.phase !== 'string' || typeof value.property?.text !== 'string' || typeof value.property?.basis !== 'string' || typeof value.conclusion?.text !== 'string') throw new Error('Invalid investigation identity, rule or conclusion.');
    const refs = new Map();
    for (const unit of value.sources) {
      const source = unit.source;
      if (typeof unit.id !== 'string' || refs.has(unit.id) || typeof unit.name !== 'string' || typeof unit.code !== 'string' || unit.code.length > 32000 || !source || typeof source.file !== 'string' || !/^[a-f0-9]{64}$/.test(source.sourceHash) || !Number.isSafeInteger(source.line) || !Number.isSafeInteger(source.endLine) || source.line < 1 || source.endLine < source.line || source.endLine - source.line > 799 || unit.code.split('\n').length !== source.endLine - source.line + 1) throw new Error('Invalid saved source excerpt.');
      refs.set(unit.id, unit);
    }
    for (const claim of value.claims) {
      for (const key of ['id', 'allegation', 'actor', 'implementation', 'reason', 'status']) if (typeof claim[key] !== 'string') throw new Error('Invalid saved claim.');
      for (const key of ['conditions', 'requiredFacts', 'unknowns', 'evidence']) if (!Array.isArray(claim[key]) || claim[key].some(item => typeof item !== 'string')) throw new Error('Invalid saved claim links.');
      if (claim.entry && !refs.has(claim.entry)) throw new Error('Saved claim has no matching source context.');
    }
    for (const evidence of value.evidence) {
      const unit = refs.get(evidence.sourceId), source = evidence.source;
      if (!unit || !source || source.file !== unit.source.file || source.sourceHash !== unit.source.sourceHash || !Number.isSafeInteger(source.line) || !Number.isSafeInteger(source.endLine) || source.line < unit.source.line || source.endLine > unit.source.endLine || source.endLine < source.line || typeof evidence.note !== 'string' || typeof evidence.quote !== 'string' || evidence.quote !== unit.code.split('\n').slice(source.line - unit.source.line, source.endLine - unit.source.line + 1).join('\n')) throw new Error('Invalid saved source evidence.');
      evidence.origin = 'model-interpretation'; evidence.interpretationVerified = false;
    }
    const claims = new Set(value.claims.map(claim => claim.id)), evidenceIds = new Set(value.evidence.map(item => item.id));
    if (value.documentation && (!Array.isArray(value.documentation.excerpts) || value.documentation.excerpts.length > 6 ||
      value.documentation.excerpts.some(item => typeof item?.id !== 'string' || typeof item.text !== 'string' || item.text.length > 18000 ||
        !item.source || typeof item.source.file !== 'string' || !/^[a-f0-9]{64}$/.test(item.source.sourceHash) ||
        !Number.isSafeInteger(item.source.line) || !Number.isSafeInteger(item.source.endLine) || item.source.line < 1 || item.source.endLine < item.source.line))) throw new Error('Invalid saved documentation references.');
    if (value.property.documentation !== undefined && (!Array.isArray(value.property.documentation) || value.property.documentation.length > 6 ||
      value.property.documentation.some(id => typeof id !== 'string' || !value.documentation?.excerpts.some(item => item.id === id)))) throw new Error('Invalid expected-rule documentation links.');
    if (claims.size !== value.claims.length || evidenceIds.size !== value.evidence.length || value.evidence.some(item => typeof item.id !== 'string' || !['supports', 'contradicts', 'context'].includes(item.stance) || item.claimId && !claims.has(item.claimId))) throw new Error('Invalid saved evidence identity or scope.');
    const strings = items => Array.isArray(items) && items.every(item => typeof item === 'string');
    if (value.readingLimits !== undefined && (!strings(value.readingLimits) || value.readingLimits.length > 40 || value.readingLimits.some(item => item.length > 2000))) throw new Error('Invalid saved code-reading limits.');
    for (const claim of value.claims) if (claim.evidence.some(id => !evidenceIds.has(id))) throw new Error('Saved claim references missing evidence.');
    for (const transition of value.transitions) {
      if (!claims.has(transition.claimId) || !['id', 'label', 'before', 'after', 'timing'].every(key => typeof transition[key] === 'string') || !strings(transition.conditions) || !strings(transition.evidence) || transition.evidence.some(id => !evidenceIds.has(id))) throw new Error('Invalid saved state transition.');
      transition.origin = 'source-prediction'; transition.observed = false;
    }
    for (const question of value.questions) if (!claims.has(question.claimId) || !['id', 'text', 'action', 'target', 'why'].every(key => typeof question[key] === 'string')) throw new Error('Invalid saved investigation question.');
    for (const action of value.actions) if (!['id', 'kind', 'outcome', 'result'].every(key => typeof action[key] === 'string') || !strings(action.sourceIds)) throw new Error('Invalid saved investigation action.');
    for (const experiment of value.experiments) if (!['id', 'sourceId', 'outcome', 'interpretation'].every(key => typeof experiment[key] === 'string') || !Array.isArray(experiment.tests) || experiment.tests.some(item => !item || typeof item.name !== 'string' || typeof item.status !== 'string') || !strings(experiment.command) || !strings(experiment.limits) || !experiment.source) throw new Error('Invalid saved experiment.');
    for (const correction of value.corrections) if (!['id', 'field', 'value', 'at'].every(key => typeof correction[key] === 'string')) throw new Error('Invalid saved researcher correction.');
    // Local JSON is editable, not a signed attestation. Never restore a model
    // draft as a human-reviewed finding just because those flags were changed.
    value.conclusion.humanReviewed = false; value.conclusion.status = 'insufficient-evidence';
    if (value.walkthrough && (!Array.isArray(value.walkthrough.steps) || value.walkthrough.steps.length > 16 ||
      value.walkthrough.steps.some(step => !step || !['evidenceId', 'title', 'paragraphId', 'phrase'].every(key => typeof step[key] === 'string') || !evidenceIds.has(step.evidenceId)) ||
      !value.walkthrough.assessment || !['valid', 'invalid', 'unclear'].includes(value.walkthrough.assessment.result) ||
      !['why', 'supportingEvidence', 'opposingEvidence'].every(key => typeof value.walkthrough.assessment[key] === 'string'))) throw new Error('Invalid saved walkthrough references.');
    value.storageRevision = value.revision;
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function archive(root, draft) {
  p.atomicJson(root, `.flowboard/recovery/investigation-${p.identifier(draft.findingId, 'finding ID') || draft.findingId}-${crypto.randomUUID()}.json`, draft);
}
function validateCurrent(catalog, draft) {
  if ((draft.snapshot.documentation || null) !== documentation.inspect(catalog.root, draft.title).digest) throw new Error('Local documentation changed. Refresh the expected-rule review.');
  for (const unit of draft.sources) {
    p.sources(catalog.root, { cards: [unit.source] });
    const doc = catalog.document(unit.source.file);
    if (doc.lines.slice(unit.source.line - 1, unit.source.endLine).join('\n') !== unit.code) throw new Error('Saved investigation source text does not match its bound source. It was not placed on the current board.');
    if (unit.contextKind) catalog.resolveUnit(unit);
  }
}
function text(value, max = 2000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function list(value, max = 12) { return Array.isArray(value) ? value.slice(0, max).map(item => text(item)).filter(Boolean) : []; }
function modelSources(units) {
  const position = source => source ? `${source.file}:${source.line}-${source.endLine}` : null;
  const unitAt = (file, line) => units.find(unit => unit.source.file === file && unit.source.line === line)?.id;
  return units.map(unit => ({ id: unit.id, name: unit.name, signature: unit.signature, kind: unit.kind,
    contextKind: unit.contextKind || null,
    file: unit.source.file, line: unit.source.line, endLine: unit.source.endLine, complete: unit.complete, reason: unit.reason,
    // Code already supplies the full expression. Repeating its text, receiver
    // spelling and deep dependency paths at every call consumed most of the
    // model packet. Preserve resolution meaning and use exact supplied IDs.
    relatedCalls: (unit.relatedCalls || []).map(call => ({ line: call.line, receiverTypes: call.receiverTypes,
      relationship: call.relationship, resolution: call.resolution,
      targets: call.targets.map(target => unitAt(target.file, target.line) || { file: target.file, line: target.line, contract: target.contract, signature: target.signature }) })),
    // Number every original line so the model need not reconstruct offsets.
    code: unit.code.split('\n').map((line, index) => `${unit.source.line + index} | ${line}`).join('\n'),
    structure: unit.structure ? { visibility: unit.structure.visibility, virtual: unit.structure.virtual,
      calls: unit.structure.calls.slice(0, 18).map(item => ({ at: item.source.line, target: position(item.target), name: item.target.name, relationship: item.relationship,
        conditions: (item.conditions || []).map(condition => ({ branch: condition.branch, expression: condition.expression })) })),
      guards: unit.structure.guards.slice(0, 12).map(item => ({ at: position(item.source), kind: item.kind })),
      assignments: unit.structure.writes.slice(0, 12).map(item => ({ at: item.source.line, kind: item.kind })),
      modifiers: unit.structure.modifiers.map(item => ({ at: position(item.source), target: position(item.target) })),
      note: 'Declaration references and syntactic assignments are not runtime dispatch, persistent state, or payment proof.' } : null }));
}
function makeContext(catalog, request, issue) {
  const compiler = loadCompiler(catalog.root), engine = search(catalog);
  const units = [], functions = new Map(); let budget = 110000, sourceLimit = 28;
  const unread = new Set();
  const add = (fn, reason) => {
    if (!fn) return null;
    const file = catalog.relative(fn.file), key = catalog.key(fn), id = `s-${hash(key).slice(0, 12)}`;
    const retainedIdentity = units.find(unit => functions.has(unit.id) && catalog.key(functions.get(unit.id)) === key);
    if (retainedIdentity) return retainedIdentity.id;
    if (functions.has(id)) return id;
    if (units.length >= sourceLimit) { unread.add(`${fn.contract || ''}::${fn.name} at ${file}:${fn.startLine}`); return null; }
    const doc = catalog.document(file), lines = doc.lines.slice(fn.startLine - 1, Math.min(fn.endLine, fn.startLine + 799));
    while (lines.join('\n').length > Math.min(budget, 32000)) lines.pop();
    if (!lines.length) { unread.add(`${fn.contract || ''}::${fn.name} at ${file}:${fn.startLine}`); return null; }
    const code = lines.join('\n'); budget -= code.length;
    const unit = { id, name: `${fn.contract ? fn.contract + '::' : ''}${fn.name}`, contract: fn.contract || null,
      ...(fn.kind === 'context' ? { contextKind: fn.contextKind || (fn.symbol ? 'state' : 'excerpt') } : {}),
      signature: catalog.hints(fn).identity.signature, kind: isTest(file) ? 'test-source' : 'production-source',
      source: { file, line: fn.startLine, endLine: fn.startLine + lines.length - 1, sourceHash: hash(doc.text) },
      declarationEndLine: fn.endLine, complete: lines.length === fn.endLine - fn.startLine + 1, reason, code,
      relatedCalls: fn.kind === 'context' ? [] : catalog.callLinks(fn).slice(0, 25).map(site => ({ line: site.line, expression: site.expression, receiverTypes: site.receiverTypes,
        relationship: site.relationship, resolution: site.resolution, targets: site.candidates.slice(0, 8).map(target => ({ file: catalog.relative(target.file), line: target.startLine, signature: catalog.hints(target).identity.signature, contract: target.contract })) })),
      structure: compiler.available ? compiler.facts(file, fn.startLine, fn.name) : null };
    units.push(unit); functions.set(id, fn); unread.delete(`${fn.contract || ''}::${fn.name} at ${file}:${fn.startLine}`); return id;
  };
  const targets = require('./report-targets').inspect(catalog, request.finding.title, issue?.reportText || request.finding.summary);
  if (targets.blockers.length) throw Object.assign(new Error(targets.blockers.join('\n')), { code: 'REPORT_APPLICABILITY' });
  for (const fn of targets.selected) add(fn, 'Explicit report definition. Examine its code and complete relevant dependencies.');
  for (const card of request.cards) if (!targets.selected.length || card.mapping?.method === 'citation' || card.mapping?.method === 'symbol') add(catalog.resolveCard(card), 'Original report/map location. Verify relevance and revision; location is not evidence of the allegation.');
  const query = { title: request.finding.title, fields: { summary: request.finding.summary }, body: issue?.reportText || '' };
  const production = new Set(catalog.functions.filter(fn => !isTest(catalog.relative(fn.file)) && !/(?:^|\/)(script|scripts|mocks|lib|node_modules)\//.test(catalog.relative(fn.file))).map(fn => fn.file));
  const ranked = targets.selected.length ? [] : engine.rank(query, production).candidates;
  if (!targets.selected.length) for (const candidate of ranked.slice(0, 3)) add(candidate.fn, candidate.reason);
  const anchors = targets.selected.length ? targets.selected : [...new Map([...request.cards.filter(card => card.kind !== 'context').map(card => catalog.resolveCard(card)), ...ranked.slice(0, 3).map(candidate => candidate.fn)].map(fn => [catalog.key(fn), fn])).values()];
  const related = relatedCode(catalog, anchors), omitted = [];
  const queryWords = terms(content(issue?.reportText || request.finding.summary).current);
  const relevanceOf = item => [...terms(item.fn.name)].filter(word => queryWords.has(word)).length;
  const order = { report: 0, guard: 1, call: 2, hypothesis: 3, 'state-dependency': 4 };
  for (const item of related.items.sort((a, b) => order[a.relationship] - order[b.relationship] || relevanceOf(b) - relevanceOf(a)).filter(item => item.relationship !== 'state-dependency').slice(0, 12)) if (!add(item.fn, item.reason)) omitted.push(`${item.source.name} at ${item.source.file}:${item.source.line}`);
  const tests = new Set(catalog.functions.filter(fn => isTest(catalog.relative(fn.file))).map(fn => fn.file));
  // Explicit report identifiers in test documentation are especially useful for
  // finding existing regressions; they still do not establish execution results.
  const displayId = issue?.displayId || request.finding.displayId || request.findingId;
  if (displayId && /^[A-Za-z]+-\d+$/.test(displayId)) {
    for (const file of [...tests].sort()) {
      const doc = catalog.document(catalog.relative(file));
      if (!doc.text.includes(displayId)) continue;
      // IDs are local to a report. A different audit's M-01 test is not this
      // allegation's regression. Require a code-level reference to its named
      // contract as well; tests remain context, never deployed execution.
      const contracts = [...new Set(anchors.map(fn => fn.contract).filter(Boolean))];
      if (contracts.length && !contracts.some(contract => new RegExp(`\\b${escaped(contract)}\\b`).test(lexicalCode(doc.text)))) continue;
      const nearby = catalog.functions.filter(fn => fn.file === file && /^test/.test(fn.name) &&
        doc.lines.slice(Math.max(0, fn.startLine - 161), fn.startLine).join('\n').includes(displayId)).slice(0, 3);
      const local = nearby.length ? nearby : engine.rank(query, new Set([file])).candidates.map(candidate => candidate.fn).filter(fn => /^test/.test(fn.name)).slice(0, 2);
      for (const fn of local) add(fn, `Existing test source near ${displayId}. Inspect assertions and setup; it has not run.`);
      if (units.filter(unit => unit.kind === 'test-source').length >= 6) break;
    }
  }
  // Generic test name matches are not deployed paths. Only explicitly linked
  // regression sources above enter initial preparation.
  // One hop of compiler-identified declarations. External targets remain declared
  // interfaces unless the source/configuration independently resolves deployment.
  const queryTerms = terms([query.title, query.fields.summary, query.body].join(' '));
  const relevance = call => [...terms(call.target.name)].filter(term => queryTerms.has(term)).length;
  for (const unit of [...units].filter(unit => unit.kind === 'production-source')) {
    for (const call of [...(unit.structure?.calls || [])].sort((a, b) => relevance(b) - relevance(a)).slice(0, 1)) {
      try { add(catalog.resolveCard({ file: call.target.file, line: call.target.line, function: call.target.name }), call.caveat); } catch { /* unresolved declaration */ }
    }
  }
  // Reserve room for the generated questions instead of filling every slot
  // with discovery candidates before the model can request decisive context.
  sourceLimit = 40;
  const gaps = [...related.gaps, ...(omitted.length ? [`The initial reading limit left some additional candidates for follow-up. Do not assume their behavior is absent.`] : [])];
  const declarationsFor = (fn, wanted) => {
    if (!fn?.contract) return [];
    const code = catalog.anatomy(fn)?.declaration || '';
    const declarations = [], visited = new Set();
    const read = (contract, file) => {
      if (visited.has(contract)) return; visited.add(contract);
      declarations.push(...catalog.stateDeclarations(catalog.relative(file), contract));
      for (const base of catalog.result.contractBases.get(contract) || []) {
        const definitions = catalog.relevantDefinitions([...new Map(catalog.functions.filter(item => item.contract === base).map(item => [item.file, item])).values()], file);
        if (definitions.length === 1) read(base, definitions[0].file);
      }
    };
    read(fn.contract, fn.file);
    return declarations.filter(item => wanted ? item.symbol === wanted : new RegExp(`\\b${escaped(item.symbol)}\\b`).test(code));
  };
  const complete = draft => {
    const before = new Set(units.map(unit => unit.id)), visited = new Set();
    // Finish the explicitly requested functions before following any helper's
    // helpers. Depth-first library expansion used to consume all forty slots
    // on bit getters before reaching settlement or the other claimed route.
    const queue = [...new Set([...(draft.actions || []).filter(action => ['inspect', 'symbol', 'callers', 'references'].includes(action.kind)).flatMap(action => action.sourceIds), ...draft.claims.map(claim => claim.entry), ...draft.evidence.map(item => item.sourceId)])]
      .map(id => ({ fn: functions.get(id), depth: 0 }));
    const limit = sourceLimit; sourceLimit = Math.max(units.length, 32); // leave eight slots for explicit challenge questions
    let remaining = 24;
    while (queue.length && remaining > 0) {
      const { fn, depth } = queue.shift();
      if (!fn || fn.kind === 'context' || visited.has(catalog.key(fn))) continue;
      remaining--;
      visited.add(catalog.key(fn));
      for (const modifier of catalog.modifiersFor(fn)) if (modifier.file) {
        const guard = catalog.modifierAt(catalog.relative(modifier.file), modifier.startLine, modifier.name);
        if (guard && add(guard, `${fn.contract}::${fn.name} applies ${guard.name}. Read this guard and its helpers before judging reachability.`)) queue.push({ fn: guard, depth: depth + 1 });
      }
      for (const declaration of declarationsFor(fn)) {
        if (!add(declaration, `${fn.contract}::${fn.name} uses ${declaration.symbol}. Read its declared type and storage alongside the operation; this is not a call.`)) gaps.push(`The code limit left ${declaration.contract}::${declaration.symbol} unread.`);
      }
      if (depth >= 3) continue;
      for (const site of catalog.callLinks(fn)) if (site.candidates.length === 1) {
        const target = site.candidates[0];
        const library = target.contract && new RegExp(`\\blibrary\\s+${escaped(target.contract)}\\b`).test(lexicalCode(catalog.document(catalog.relative(target.file)).text));
        if (site.relationship !== 'call' && !library) continue;
        // A reached library is read in full. Further library details are
        // available by explicit question rather than recursively filling the
        // packet with every arithmetic/bit-manipulation helper.
        if (library && depth > 1) continue;
        if (add(target, `${fn.contract}::${fn.name} references ${target.name} at ${catalog.relative(fn.file)}:${site.line}. Read this ${library ? 'library definition (check argument binding)' : 'internal helper'} before judging the statement.`)) queue.push({ fn: target, depth: depth + 1 });
        else gaps.push(`The code limit left ${target.contract}::${target.name} unread.`);
      }
    }
    sourceLimit = limit;
    const added = units.filter(unit => !before.has(unit.id)).map(unit => unit.id);
    return { id: `complete-${crypto.randomUUID()}`, kind: 'code-completion', outcome: added.length ? 'source-returned' : unread.size ? 'reading-limit' : 'context-already-available', performedAt: now(), sourceIds: added,
      result: added.length ? `Read ${added.length} additional declarations or internal helpers used by the selected statements. Their exact code is available to the second pass; no statement result was assumed.` : unread.size ? 'Some local code remains unread because the review reached its reading limit. This does not mean the code is missing.' : 'Relevant declarations and internal helpers within this check were already available. This does not establish that all implementations or recovery paths were inspected.' };
  };
  const act = (question, claim) => {
    const before = new Set(units.map(unit => unit.id));
    let target = functions.get(question.target);
    // Follow an explicitly requested definition across files. A receiver such
    // as manager.take is not a contract name and remains a candidate, not dispatch.
    const qualified = question.target.match(/^([A-Z][\w$]*)(?:::|\.)([\w$]+)$/);
    if (!target && qualified) {
      const entry = functions.get(claim?.entry);
      let candidates = catalog.relevantDefinitions(catalog.mentioned({ contract: qualified[1], name: qualified[2] }), entry?.file);
      if (!candidates.length && entry) candidates = catalog.modifierDefinitions(qualified[1], qualified[2], entry.file);
      if (!candidates.length) candidates = catalog.functionDeclarations(qualified[1], qualified[2], entry?.file);
      if (candidates.length === 1) target = candidates[0];
    }
    const location = question.target.match(/^(.+\.sol):(\d+)$/);
    if (!target && location) {
      try {
        const line = Number(location[2]), doc = catalog.document(location[1]);
        target = catalog.functionAt(location[1], line);
        if (!target && line >= 1 && line <= doc.lineCount) target = { name: 'Code details', kind: 'context', file: doc.uri.fsPath,
          startLine: line, endLine: Math.min(line + 7, doc.lineCount), contract: null, calls: [], memberCalls: [], modifiers: [] };
      } catch { /* exact local target unavailable */ }
    }
    const entry = functions.get(claim?.entry), scope = entry && catalog.relative(entry.file);
    const matched = new Set();
    const omittedLocal = [];
    const include = (fn, reason) => { const id = add(fn, reason); if (id) matched.add(id); else if (fn) omittedLocal.push(`${fn.contract || ''}::${fn.name} at ${catalog.relative(fn.file)}:${fn.startLine}`); return id; };
    const declarationContext = fn => {
      for (const item of declarationsFor(fn)) include(item, `${fn.contract}::${fn.name} uses ${item.symbol}. Its declaration answers type/storage questions, not deployment or specification questions.`);
    };
    const qTerms = terms(question.text + ' ' + question.why);
    const nameScore = name => [...terms(name)].filter(term => qTerms.has(term)).length;
    if (['inspect', 'symbol', 'missing-context'].includes(question.action) && target) {
      include(target, 'Code requested by the selected statement.'); declarationContext(target);
      for (const link of [...catalog.callLinks(target)].sort((a, b) => nameScore(b.expression) - nameScore(a.expression)).slice(0, 4)) if (link.candidates.length === 1) include(link.candidates[0], `Possible callee for ${link.expression}; check dispatch and branch conditions.`);
    } else if (question.action === 'callers' && target) {
      let count = 0;
      for (const fn of catalog.functions) {
        if (isTest(catalog.relative(fn.file)) || !catalog.code(fn).includes(target.name)) continue;
        if (catalog.callLinks(fn).some(site => site.candidates.some(candidate => catalog.key(candidate) === catalog.key(target)) || site.expression.replace(/\(.*$/, '').split('.').pop() === target.name)) {
          include(fn, `Caller/name candidate referencing ${target.name}. Interface dispatch, actual branch and permissions remain unresolved.`); if (++count >= 4) break;
        }
      }
    } else if (['symbol', 'references'].includes(question.action) && /^[A-Za-z_$][\w$]{0,79}$/.test(question.target)) {
      const expression = new RegExp(`\\b${question.target.replace(/\$/g, '\\$')}\\b`);
      for (const item of declarationsFor(entry, question.target)) include(item, `The selected statement asks about ${question.target}. This is its same-contract declaration; check any local shadowing in the function.`);
      let count = 0;
      const questionText = `${question.text} ${question.why}`;
      const role = fn => (fn.contract && new RegExp(`\\b${escaped(fn.contract)}\\b`).test(questionText) ? 8 : 0) +
        (catalog.relative(fn.file) === scope ? 4 : 0) + (isTest(catalog.relative(fn.file)) || /(?:^|\/)(?:script|scripts)\//.test(catalog.relative(fn.file)) ? -4 : 0);
      const candidates = [...catalog.functions].sort((a, b) => role(b) - role(a) ||
        (question.action === 'symbol' ? Number(b.name === question.target) - Number(a.name === question.target) : nameScore(b.name) - nameScore(a.name)));
      for (const fn of candidates) {
        if (isTest(catalog.relative(fn.file))) continue;
        // A bare, repeated method name cannot select an unrelated overload.
        if (question.action === 'symbol' && fn.name === question.target && catalog.functions.filter(candidate => candidate.name === fn.name && !isTest(catalog.relative(candidate.file))).length > 1 && entry && (fn.file !== entry.file || fn.contract !== entry.contract)) continue;
        const namesContract = fn.contract === question.target && question.action === 'references';
        if (question.action === 'symbol' ? fn.name === question.target : namesContract || expression.test(catalog.anatomy(fn)?.declaration || '')) {
          include(fn, question.action === 'symbol' ? 'Exact symbol candidate; overload and deployment remain to review.' : 'Identifier occurrence in the selected contract; check the actual reads and writes.');
          if (++count >= 4) break;
        }
      }
    } else if (question.action === 'missing-context' && entry) {
      // Mixed questions can request both local declarations and unavailable
      // deployment/specification. Supply only the local portion, without a loop.
      declarationContext(entry);
    }
    // Follow a small amount of compiler declaration context around the explicit
    // question. These excerpts are NOT a generated route or execution sequence.
    const primary = units.filter(unit => !before.has(unit.id));
    for (const unit of primary.slice(0, 2)) for (const call of [...(unit.structure?.calls || [])].sort((a, b) => nameScore(b.target.name) - nameScore(a.target.name)).slice(0, 2)) {
      try { add(catalog.resolveCard({ file: call.target.file, line: call.target.line, function: call.target.name }), 'Compiler-declared context for this inspection question; no runtime ordering inferred.'); } catch { /* keep unresolved */ }
    }
    const added = units.filter(unit => !before.has(unit.id)).map(unit => unit.id);
    return { id: `action-${crypto.randomUUID()}`, questionId: question.id, claimId: question.claimId, kind: question.action,
      target: question.target, questionText: question.text, why: question.why, performedAt: now(), sourceIds: [...new Set([...added, ...matched])],
      outcome: omittedLocal.length ? 'reading-limit' : added.length ? 'source-returned' : matched.size ? 'context-already-available' : question.action === 'missing-context' ? 'blocked' : 'no-additional-context',
      result: omittedLocal.length ? `Available locally but not read within this review's limit: ${omittedLocal.join('; ')}. ${added.length} additional excerpts were read.` : added.length ? `${added.length} additional code excerpts obtained for the second pass.` : matched.size ? 'Matching local code is already available at these links. Missing deployment or specification facts are not answered by this match.' : 'This check found no additional code. It does not establish that no other route exists.',
      bounded: { sourceLimit: 40, currentSources: units.length, remainingCodeCharacters: budget } };
  };
  const restore = (saved, draft) => {
    const relevantTests = new Set(units.filter(unit => unit.kind === 'test-source').map(unit => unit.id));
    const required = new Set([...(draft?.evidence || []).map(entry => entry.sourceId), ...(draft?.claims || []).map(claim => claim.entry),
      ...(draft?.actions || []).filter(action => ['inspect','callers','symbol','references'].includes(action.kind)).flatMap(action => action.sourceIds)]);
    units.length = 0; functions.clear(); unread.clear(); budget = 110000; sourceLimit = 40;
    const restoredIds = new Set();
    for (const unit of saved) {
      if (unit.kind === 'test-source' && !relevantTests.has(unit.id) && !required.has(unit.id)) continue;
      const fn = catalog.resolveUnit(unit), id = add(fn, unit.reason);
      let restored = units.find(value => value.id === id);
      if (!restored || restored.code !== unit.code || restored.source.sourceHash !== unit.source.sourceHash) throw new Error('A saved review stage no longer matches the current code. It must be prepared again.');
      // Older context cards used a different display name in catalog.key().
      // Their saved IDs are referenced by the accepted claims. Preserve that
      // identity only AFTER the exact original content has been revalidated.
      if (restoredIds.has(id) && id !== unit.id) { restored = { ...restored }; units.push(restored); }
      else functions.delete(id);
      restored.id = unit.id; restored.name = unit.name; functions.set(unit.id, fn); restoredIds.add(unit.id);
    }
  };
  const prioritize = draft => {
    // Only unbound discovery candidates can leave the working packet. Never
    // evict a cited function, an inspected premise or an explicit report root
    // to manufacture room. Deferred code stays available in the local index.
    const pinned = new Set([...(draft.claims || []).map(item => item.entry), ...(draft.evidence || []).map(item => item.sourceId),
      ...(draft.explanationReviews || []).flatMap(item => item.checkedSourceIds || []), ...(draft.questions || []).map(item => item.target)]);
    const roots = new Set(targets.selected.map(fn => catalog.key(fn))), deferred = [];
    for (let i = units.length - 1; i >= 0 && units.length > 32; i--) {
      const unit = units[i], fn = functions.get(unit.id);
      if (pinned.has(unit.id) || fn && roots.has(catalog.key(fn))) continue;
      deferred.push(`${unit.name} at ${unit.source.file}:${unit.source.line}`);
      budget += unit.code.length; units.splice(i, 1); functions.delete(unit.id);
    }
    return deferred;
  };
  return { compiler, units, add, act, complete, restore, prioritize, gaps, unread,
    documentation: documentation.inspect(catalog.root, [request.finding.title, content(issue?.reportText || request.finding.summary).current].join('\n')) };
}
function accept(output, draft, units) {
  if (!output || !Array.isArray(output.claims) || !output.claims.length || output.claims.length > 8 || !Array.isArray(output.evidence) || !output.property || !output.conclusion) throw new Error('Model returned no usable claim/evidence structure.');
  const known = new Map(units.map(unit => [unit.id, unit])), ids = new Set();
  const claims = output.claims.map(claim => {
    const id = text(claim.id, 100);
    if (!/^[\w-]+$/.test(id) || ids.has(id)) throw new Error('Model claim IDs are invalid or repeated.'); ids.add(id);
    return { id, allegation: text(claim.allegation), actor: text(claim.actor), entry: known.has(claim.entry) ? claim.entry : '',
      implementation: text(claim.implementation), conditions: list(claim.conditions), requiredFacts: list(claim.requiredFacts),
      supportsIf: text(claim.supportsIf), contradictsIf: text(claim.contradictsIf), status: ['supported', 'contradicted', 'narrowed'].includes(claim.status) ? claim.status : 'unresolved',
      reason: text(claim.reason), evidence: list(claim.evidence, 24), unknowns: list(claim.unknowns), nextQuestion: text(claim.nextQuestion),
      origin: 'model-interpretation', reviewed: false, correctionRevision: draft.corrections.length,
      premiseIds: draft.corrections.filter(item => !item.claimId || item.claimId === id).map(item => item.id) };
  });
  for (const correction of draft.corrections) if (correction.claimId && draft.claims.some(claim => claim.id === correction.claimId) && !ids.has(correction.claimId)) throw new Error('Model omitted a researcher-corrected claim scope. The corrected draft was preserved rather than silently discarding that premise.');
  for (const experiment of draft.experiments) if (experiment.claimId && draft.claims.some(claim => claim.id === experiment.claimId) && !ids.has(experiment.claimId)) throw new Error('Model omitted a scope linked to an executed check. The preceding draft and observation were preserved.');
  const evidenceIds = new Set();
  const evidence = output.evidence.slice(0, 24).map(item => {
    const id = text(item.id, 100), unit = known.get(item.sourceId);
    if (!/^[\w-]+$/.test(id) || evidenceIds.has(id) || !unit || item.claimId && !ids.has(item.claimId)) throw new Error('Model evidence has an unknown/duplicate identity or source.');
    evidenceIds.add(id);
    if (!Number.isSafeInteger(item.line) || !Number.isSafeInteger(item.endLine) || item.line < unit.source.line || item.endLine < item.line || item.endLine > unit.source.endLine || item.endLine - item.line > 80) throw new Error('Model evidence span is outside its supplied source.');
    const exact = unit.code.split('\n').slice(item.line - unit.source.line, item.endLine - unit.source.line + 1).join('\n');
    if (typeof item.quote !== 'string' || exact.trim() !== item.quote.trim()) throw new Error(`Evidence ${id} does not quote its complete source span exactly. It was not accepted.`);
    if (!text(item.explanation)) throw new Error('Evidence must explain how the source bears on the claim.');
    if (!item.claimId && ['supports', 'contradicts'].includes(item.stance)) throw new Error('A supporting or challenging note must name its report statement. Shared code context is not a statement result.');
    return { id, findingId: draft.findingId, claimId: item.claimId || '', sourceId: unit.id, function: unit.contextKind ? null : { name: unit.name, signature: unit.signature || '', line: unit.source.line, endLine: unit.declarationEndLine || unit.source.endLine }, source: { ...unit.source, line: item.line, endLine: item.endLine },
      quote: exact, note: text(item.explanation, 4000), stance: ['supports', 'contradicts'].includes(item.stance) ? item.stance : 'context',
      origin: 'model-interpretation', quoteVerified: true, interpretationVerified: false,
      basis: unit.kind === 'test-source' ? 'test-reference' : 'inference' };
  });
  for (const claim of claims) {
    claim.evidence = claim.evidence.filter(id => evidence.some(item => item.id === id && (!item.claimId || item.claimId === claim.id)));
    const entries = evidence.filter(item => claim.evidence.includes(item.id));
    if (claim.status !== 'unresolved' && (!entries.length || !claim.reason || !claim.implementation || !claim.conditions.length)) {
      claim.status = 'unresolved'; claim.unknowns.push('The proposed assessment lacked scoped conditions, explanation, or claim-linked source evidence.');
    }
    if (claim.status === 'contradicted' && !entries.some(item => item.stance === 'contradicts') || claim.status === 'supported' && !entries.some(item => item.stance === 'supports')) {
      claim.status = 'unresolved'; claim.unknowns.push('The proposed assessment had no evidence with the required stance.');
    }
  }
  const refs = value => list(value, 24).filter(id => evidenceIds.has(id));
  const property = { text: text(output.property.text), basis: ['source-contract', 'test-expectation', 'local-documentation'].includes(output.property.basis) ? output.property.basis : 'report-assumption', evidence: refs(output.property.evidence),
    documentation: list(output.property.documentation, 6).filter(id => draft.documentation?.excerpts.some(item => item.id === id)) };
  if (!property.evidence.length && !property.documentation.length) property.basis = 'report-assumption';
  const transitions = (output.transitions || []).slice(0, 12).filter(item => ids.has(item.claimId)).map(item => ({ id: text(item.id, 100), claimId: item.claimId,
    label: text(item.label), before: text(item.before), after: text(item.after), timing: ['within-transaction', 'transaction-outcome', 'later-action'].includes(item.timing) ? item.timing : 'unknown',
    conditions: list(item.conditions), evidence: refs(item.evidence).filter(id => evidence.some(entry => entry.id === id && (!entry.claimId || entry.claimId === item.claimId))), origin: 'source-prediction', observed: false }));
  const questions = (output.questions || []).slice(0, 8).filter(item => ids.has(item.claimId)).map(item => ({
    id: text(item.id, 100), claimId: item.claimId, text: text(item.text), action: ['inspect', 'callers', 'symbol', 'references'].includes(item.action) ? item.action : 'missing-context', target: text(item.target, 1000), why: text(item.why) }));
  const presentation = output.walkthrough;
  const prepared = presentation ? { steps: (Array.isArray(presentation.steps) ? presentation.steps : []).slice(0, 16).filter(step => evidenceIds.has(step.evidenceId)).map(step => ({
    evidenceId: step.evidenceId, title: text(step.title, 180), paragraphId: text(step.paragraphId, 100), phrase: text(step.phrase, 2000)
  })), assessment: {
    result: ['valid', 'invalid'].includes(presentation.assessment?.result) ? presentation.assessment.result : 'unclear',
    why: text(presentation.assessment?.why, 2000),
    supportingEvidence: evidence.find(item => item.id === presentation.assessment?.supportingEvidence && item.stance === 'supports')?.id || '',
    opposingEvidence: evidence.find(item => item.id === presentation.assessment?.opposingEvidence && item.stance === 'contradicts')?.id || ''
  } } : null;
  return { property, claims, evidence, transitions, questions, causal: output.causal ? structuredClone(output.causal) : null, walkthrough: prepared, conclusion: { status: 'insufficient-evidence',
    scopedStatus: claims.some(claim => claim.status === 'unresolved') ? 'partial' : text(output.conclusion.status, 100),
    text: text(output.conclusion.text, 4000), limitations: list(output.conclusion.limitations), origin: 'model-draft', humanReviewed: false } };
}
function correct(draft, change) {
  if (!['property', 'actor', 'entry', 'implementation', 'conditions'].includes(change.field) || !text(change.value)) throw new Error('Choose an investigation field and a nonempty correction.');
  if (change.claimId && !draft.claims.some(claim => claim.id === change.claimId)) throw new Error('The selected claim is not in this investigation.');
  const correction = { id: crypto.randomUUID(), claimId: change.claimId || null, field: change.field, value: text(change.value), reason: text(change.reason), origin: 'researcher', independentlySupported: false, at: now() };
  draft.corrections.push(correction); draft.corrections = draft.corrections.slice(-30);
  for (const claim of draft.claims) if (!correction.claimId || claim.id === correction.claimId) {
    claim.previousAssessment = { status: claim.status, reason: claim.reason };
    claim.status = 'unresolved'; claim.reason = 'Researcher correction changed a premise. Reassess this scoped claim against the correction; existing quotes are not renewed proof.';
    claim.needsReassessment = true;
  }
  for (const transition of draft.transitions) if (!correction.claimId || transition.claimId === correction.claimId) transition.needsReassessment = true;
  draft.conclusion = { status: 'insufficient-evidence', text: 'A researcher correction changed the investigation premises. Dependent conclusions are unresolved until reassessed.', humanReviewed: false, origin: 'correction-invalidation' };
  draft.phase = 'corrected'; draft.revision++;
  return correction;
}
function checkExplanations(output, previous, next, units) {
  // This checks the challenge's coverage/identity, NOT the truth of its prose.
  // A real quote cannot by itself certify a model's interpretation.
  const sourceIds = new Set(units.map(unit => unit.id)), reviewed = new Set();
  const inspected = (ids, target) => {
    const expected = units.find(unit => unit.id === target);
    return ids.some(id => id === target || expected && units.some(unit => unit.id === id && unit.code === expected.code &&
      unit.source.file === expected.source.file && unit.source.line === expected.source.line && unit.source.endLine === expected.source.endLine && unit.source.sourceHash === expected.source.sourceHash));
  };
  const checks = output.explanationReviews || [];
  for (const claim of previous.claims) if (!next.claims.some(item => item.id === claim.id)) throw new Error(`The second pass omitted statement ${claim.id}. Its unresolved path was preserved; the result was not applied.`);
  if (!Array.isArray(checks) || checks.length > 48) throw new Error('The second pass returned invalid explanation checks.');
  const accepted = [];
  for (const check of checks) {
    const old = previous.evidence.find(item => item.id === check.evidenceId), item = next.evidence.find(item => item.id === check.evidenceId);
    if (reviewed.has(check.evidenceId) || !old && !item || !['kept', 'repaired', 'removed', 'added'].includes(check.result) || !text(check.reason) || !Array.isArray(check.checkedSourceIds) || !check.checkedSourceIds.length || check.checkedSourceIds.some(id => !sourceIds.has(id))) throw new Error('Each explanation check needs its own note, a concrete reason and available code references.');
    if (old && !inspected(check.checkedSourceIds, old.sourceId) || item && !inspected(check.checkedSourceIds, item.sourceId)) throw new Error(`The explanation check for ${check.evidenceId} did not inspect its referenced function (${old?.sourceId || item?.sourceId}).`);
    if (check.result === 'removed' ? !old || !!item : !item || (check.result === 'added' ? !!old : !old)) throw new Error('The explanation check does not match the retained or removed note.');
    if (check.result === 'kept' && (['note', 'quote', 'stance', 'claimId', 'sourceId'].some(key => old[key] !== item[key]) || JSON.stringify(old.source) !== JSON.stringify(item.source))) throw new Error('A changed explanation must be marked repaired, not kept.');
    if (old && item && old.claimId !== item.claimId) throw new Error('A repaired note cannot silently change its report statement. Remove it and add a separately scoped note.');
    const record = { evidenceId: check.evidenceId, result: check.result, reason: text(check.reason), checkedSourceIds: [...new Set(check.checkedSourceIds)], origin: 'model-challenge', independentlyVerified: false };
    if (item) item.explanationReview = record;
    reviewed.add(check.evidenceId); accepted.push(record);
  }
  for (const item of [...previous.evidence, ...next.evidence]) if (!reviewed.has(item.id)) throw new Error(`The second pass did not check explanation ${item.id}. Earlier work remains a draft, not a checked explanation.`);
  next.explanationReviews = accepted;
  return next;
}
async function advance({ root, catalog, request, issue, findingId, draft, provider = 'none', executable, budget, signal, current, publish, persist = true, invoke = runProvider, onProgress, beforeRequest }) {
  const ensure = () => { if (signal?.aborted || !current()) throw Object.assign(new Error('Investigation superseded; partial work is preserved.'), { code: 'INVESTIGATION_SUPERSEDED' }); catalog.assertFresh(); };
  const save = async () => {
    ensure(); if (!sameSnapshot(draft.snapshot, snapshot(catalog, request, issue))) throw new Error('Source or report changed during review. Results were withheld.');
    draft.actions = draft.actions.slice(-40); draft.runs = draft.runs.slice(-12);
    draft.revision++; if (persist) write(root, draft); await publish(draft);
  };
  try {
    ensure(); const context = makeContext(catalog, request, issue);
    const lastAccepted = [...draft.runs].reverse().find(run => run.resultAccepted);
    const resumeQuestions = draft.checkpoint?.stage === 'complete' && draft.failureKind === 'material-evidence' && draft.questions.length;
    const resumeChallenge = sameSnapshot(draft.snapshot, snapshot(catalog, request, issue)) && draft.claims.length && draft.evidence.length &&
      !draft.claims.some(claim => claim.needsReassessment) && (draft.checkpoint?.stage === 'challenge' ||
        resumeQuestions ||
        draft.failureKind === 'provider' && draft.runs.at(-1)?.phase === 'challenge' && lastAccepted?.phase === 'generate');
    if (resumeChallenge) { validateCurrent(catalog, draft); context.restore(draft.sources, draft); }
    if (resumeChallenge) context.gaps.push(...(draft.codeGaps || []));
    draft.codeGaps = [...new Set(context.gaps)];
    for (const unit of context.units) if (!unit.complete) draft.codeGaps.push(`${unit.name} is only available through ${unit.source.file}:${unit.source.endLine} in this review. Its remaining code has not been checked.`);
    // Keep the previous argument reopenable while a new generation is pending
    // or fails. Its evidence may refer to challenge-only excerpts not present
    // in this pass's initial discovery. Replace it only after accepting a new
    // coherent set of claims, evidence and sources together.
    const retained = new Map(draft.sources.map(unit => [unit.id, unit]));
    for (const unit of context.units) if (retained.size < 40 || retained.has(unit.id)) retained.set(unit.id, unit);
    draft.sources = [...retained.values()];
    draft.compiler = context.compiler.available ? { available: true, version: context.compiler.version, file: context.compiler.file, digest: context.compiler.digest, inputCount: context.compiler.inputCount,
      configurationVerified: false, limitation: 'All compilation input texts match. Active build profile/settings and deployed bytecode are not certified by source matching.' } : { available: false, reason: context.compiler.reason };
    draft.actions.push({ id: `prepare-${crypto.randomUUID()}`, kind: 'source-preparation', outcome: 'source-returned', performedAt: now(), sourceIds: context.units.map(unit => unit.id), result: 'Report references, separate production/test candidates and bounded compiler declaration context prepared. No execution route is assumed.' });
    draft.phase = ['claude', 'codex'].includes(provider) ? resumeChallenge ? 'challenging' : 'generating' : 'provider-required';
    delete draft.error; delete draft.failureKind;
    if (resumeChallenge) draft.actions.push({ id: `resume-${crypto.randomUUID()}`, kind: 'checkpoint-resume', outcome: 'source-returned',
      sourceIds: draft.sources.map(unit => unit.id), result: 'Resuming the saved explanation check. The accepted generation is reused after checking its report and code.', performedAt: now() });
    await save();
    if (!['claude', 'codex'].includes(provider)) return draft;
    draft.documentation = context.documentation;
    // Supply the original text once, with exact paragraph IDs. Previously the
    // same long report appeared as raw text, sections AND paragraphs in every
    // pass, crowding out the relevant code without adding evidence.
    const input = phase => ({ phase, finding: { id: findingId, title: request.finding.title,
      reportSections: content(issue?.reportText || request.finding.summary).sections.map(({ field, proposed }) => ({ field, proposed })),
      reportParagraphs: walkthrough.paragraphs(issue?.reportText || request.finding.summary),
      expectedBehavior: request.finding.expectedBehavior || '' },
      snapshot: draft.snapshot, corrections: draft.corrections, previousScopes: draft.claims.map(({ id, allegation, implementation, conditions }) => ({ id, allegation, implementation, conditions })), sources: modelSources(context.units),
      compiler: draft.compiler, experiments: draft.experiments, codeGaps: context.gaps, documentation: context.documentation,
      ...(phase === 'challenge' ? { earlierDraft: challengeFormat.earlier(draft, reviewSchema), actions: draft.actions.slice(-5) } : {}) });
    let repairUsed = resumeChallenge && !!draft.checkpoint?.repairUsed;
    let followups = resumeChallenge && !resumeQuestions ? draft.checkpoint?.followups || 0 : 0;
    const readQuestions = result => {
      let progress = false; const alreadyRead = new Set(context.units.map(unit => unit.id));
      const deferred = context.prioritize(result);
      if (deferred.length) draft.actions.push({ id: `prioritize-${crypto.randomUUID()}`, kind: 'context-priority', outcome: 'candidates-deferred', sourceIds: [], performedAt: now(),
        result: `Reserved follow-up room by deferring unreferenced discovery candidates, not evidence: ${deferred.join('; ')}. These definitions remain in the local index.` });
      for (const question of result.questions.slice(0, 4)) {
        const action = context.act(question, result.claims.find(claim => claim.id === question.claimId));
        draft.actions.push(action);
        if (['source-returned', 'reading-limit'].includes(action.outcome) && action.sourceIds.some(id => !alreadyRead.has(id))) progress = true;
      }
      return progress;
    };
    const obtain = async (phase, previous = null, feedback = null) => {
      const data = input(phase);
      if (feedback) data.hostReview = feedback;
      if (phase === 'challenge' && !feedback && !repairUsed) data.checkOnly = true;
      else if (phase === 'challenge') data.repairOnly = true;
      const call = async input => { await beforeRequest?.({ phase, inputBytes: Buffer.byteLength(JSON.stringify(input)) });
        return invoke(input, { provider, executable, budget, signal, onProgress }); };
      let response = await call(data); ensure();
      draft.runs.push({ ...response.audit, resultAccepted: false, ...(feedback ? { repair: true } : {}) });
      const validate = value => {
        if (data.checkOnly && value?.result) value = challengeFormat.checked(value, data.earlierDraft, reviewSchema);
        if (value?.mode === challengeFormat.PATCH) value = challengeFormat.apply(value, data.earlierDraft, reviewSchema);
        else if (phase === 'challenge' && value?.mode) value = challengeFormat.expand(value, data.earlierDraft, reviewSchema);
        const accepted = accept(value, draft, context.units);
        return previous ? checkExplanations(value, previous, accepted, context.units) : accepted;
      };
      let accepted;
      try { accepted = validate(response.value); }
      catch (error) {
        if (repairUsed) {
          draft.lastRejected = { phase, inputHash: response.audit?.inputHash, at: now(), error: error.message, output: response.value };
          draft.checkpoint ||= { stage: phase, snapshot: hash(draft.snapshot) };
          draft.checkpoint.feedback = { problems: [error.message], rejectedOutput: response.value };
          throw error;
        }
        repairUsed = true;
        const repairFeedback = { problems: error.reviewProblems || [error.message], rejectedOutput: response.value };
        draft.checkpoint = { stage: phase, snapshot: hash(draft.snapshot), repairUsed: true, followups, feedback: repairFeedback, at: now() }; await save();
        // One bounded repair with the exact rejected response and host error.
        // Never guess new line spans, silently fix meaning, or publish it.
        response = await call({ ...data, checkOnly: false, repairOnly: phase === 'challenge', hostReview: repairFeedback }); ensure();
        draft.runs.push({ ...response.audit, resultAccepted: false, repair: true });
        accepted = validate(response.value);
      }
      draft.runs.at(-1).resultAccepted = true; return accepted;
    };
    if (!resumeChallenge) {
    const parsed = await obtain('generate');
    if (parsed.walkthrough) parsed.walkthrough.reportText = issue?.reportText || request.finding.summary || '';
    Object.assign(draft, parsed); draft.sources = context.units; draft.phase = 'checking-source'; await save();
    for (const question of draft.questions.slice(0, 4)) {
      ensure(); draft.actions.push(context.act(question, draft.claims.find(claim => claim.id === question.claimId)));
    }
    ensure(); draft.actions.push(context.complete(draft));
    draft.readingLimits = [...context.unread].slice(0, 40);
    if (draft.readingLimits.length) context.gaps.push(`Available locally but not read within this review's limit: ${draft.readingLimits.join('; ')}. Do not describe these as missing implementations.`);
    draft.sources = context.units; draft.phase = 'challenging';
    }
    let savedFeedback = resumeChallenge ? draft.checkpoint?.feedback : null;
    if (resumeQuestions) {
      // A stopped material question can resume from its checked draft when
      // local retrieval yields new evidence. Retrying an unavailable external
      // fact must not regenerate the same explanation or spend another call.
      if (followups >= 2 || !readQuestions(draft)) {
        draft.phase = 'blocked'; draft.failureKind = 'material-evidence';
        draft.publication = guidePolicy.gate(draft); draft.error = draft.publication.problems[0] || 'No new local evidence resolves the remaining question.';
        draft.sources = context.units; await save(); return draft;
      }
      followups++;
      savedFeedback = { problems: guidePolicy.gate(draft).problems, newLocalCode: true,
        instruction: 'Recheck the unresolved statements using the newly supplied local code. Preserve scope and genuine external unknowns.' };
    }
    draft.sources = context.units;
    draft.checkpoint = { stage: 'challenge', snapshot: hash(draft.snapshot), repairUsed, followups, ...(savedFeedback ? { feedback: savedFeedback } : {}), at: now() }; await save();
    let next = await obtain('challenge', draft, savedFeedback);
    if (next.walkthrough) next.walkthrough.reportText = issue?.reportText || request.finding.summary || '';
    let firstGate = guidePolicy.gate({ ...draft, ...next });
    while (!firstGate.ready) {
      const progress = followups < 2 && readQuestions(next);
      // Stop if the missing fact cannot be obtained. A closed explanation with
      // invalid references/order gets one repair; open speculation does not.
      const structural = next.causal?.outcome !== 'blocked' && next.claims.every(claim => claim.status !== 'unresolved' && !claim.unknowns.length) && !next.conclusion.limitations.length;
      if (progress || structural && !repairUsed) {
        if (progress) followups++; else repairUsed = true;
        const feedback = { problems: firstGate.problems, newLocalCode: progress,
          instruction: 'Check these exact failures against supplied evidence. Do not weaken the scope or erase material unknowns merely to satisfy the publication gate.' };
        draft.checkpoint = { stage: 'challenge', snapshot: hash(draft.snapshot), repairUsed, followups, feedback, at: now() };
        Object.assign(draft, next); draft.sources = context.units; draft.phase = 'challenging'; await save();
        next = await obtain('challenge', draft, feedback);
        if (next.walkthrough) next.walkthrough.reportText = issue?.reportText || request.finding.summary || '';
        firstGate = guidePolicy.gate({ ...draft, ...next });
      } else break;
    }
    const changes = next.claims.map(claim => {
      const previous = draft.claims.find(old => old.id === claim.id);
      return { claimId: claim.id, before: previous?.status || 'not-separated', after: claim.status, reason: claim.reason };
    });
    Object.assign(draft, next); draft.challengeChanges = changes;
    draft.publication = guidePolicy.gate(draft);
    if (draft.publication.ready) draft.publication.digest = guidePolicy.digest(draft);
    draft.phase = draft.publication.ready ? 'ready' : 'blocked';
    draft.checkpoint = { stage: 'complete', snapshot: hash(draft.snapshot), followups, repairUsed, at: now() };
    if (!draft.publication.ready) { draft.failureKind = 'material-evidence'; draft.error = draft.publication.problems[0]; }
    draft.actions = draft.actions.slice(-40); draft.runs = draft.runs.slice(-12);
    await save(); return draft;
  } catch (error) {
    if (error.code === 'INVESTIGATION_SUPERSEDED' || signal?.aborted || !current()) return draft;
    draft.phase = 'blocked'; draft.failureKind = error.code === 'REPORT_PAUSED' ? 'paused' : error.code === 'REPORT_BUDGET' ? 'budget' : error.code === 'REPORT_APPLICABILITY' ? 'applicability' : error.audit ? 'provider' : 'validation'; draft.error = text(error.message, 1000);
    if (error.audit) draft.runs.push(error.audit);
    // A failed provider/schema/challenge must not erase a usable earlier draft.
    try { await save(); } catch { /* never overwrite a changed source context */ }
    return draft;
  }
}
function create({ findingId, request, issue, catalog }) {
  return { version: 1, engine: 'source-review-v1', findingId, title: request.finding.title, snapshot: snapshot(catalog, request, issue),
    createdAt: now(), revision: 0, phase: 'preparing', property: { text: request.finding.expectedBehavior || 'Expected property needs a stated basis.', basis: 'report-assumption', evidence: [] },
    claims: [], evidence: [], transitions: [], questions: [], sources: [], actions: [], experiments: [], corrections: [], runs: [],
    conclusion: { status: 'insufficient-evidence', text: 'Preparation has not yet established source-based conclusions.', humanReviewed: false, origin: 'preparation' } };
}
module.exports = { snapshot, sameSnapshot, write, read, archive, create, makeContext, accept, checkExplanations, correct, advance, validateCurrent, modelSources, hash, isTest };
