'use strict';
// A publication gate, not a truth oracle. Locations and closed references are
// host checked. Interpretations also need an evidence-grounded challenge.
const capacity = require('./review-capacity'), { limits, kinds, POLICY } = capacity;
const crypto = require('node:crypto');
const { lexicalCode } = require('./solidity-text');
const bindings = require('./call-bindings');
function digest(draft) {
  return crypto.createHash('sha256').update(JSON.stringify({ findingId: draft.findingId, snapshot: draft.snapshot,
    property: draft.property, claims: draft.claims, evidence: draft.evidence, sources: draft.sources,
    causal: draft.causal, walkthrough: draft.walkthrough, conclusion: draft.conclusion, dependencies: draft.dependencies,
    semanticInput: draft.semanticInput, inputReviews: draft.inputReviews, ...(draft.bindingPlan ? { bindingPlan: draft.bindingPlan } : {}) })).digest('hex');
}
const str = { type: 'string' }, strings = { type: 'array', items: str };
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const dispatchSchema = object({ kind: { enum: ['internal', 'internal-library', 'self', 'constructor', 'local-instance', 'observed-external', 'unresolved', 'not-applicable'] },
  receiver: str, implementation: str, evidence: strings,
  context: { enum: ['same', 'call', 'delegatecall', 'staticcall', 'creation', 'none'] },
  failure: { enum: ['propagates', 'caught', 'caught-return', 'returns-status', 'not-applicable'] } });
const schema = object({
  scope: str, summary: str, outcome: { enum: ['supported', 'refuted', 'blocked'] },
  obligations: { type: 'array', maxItems: limits.obligations, items: object({ id: str, claimId: str,
    kind: { enum: kinds },
    question: str, state: { enum: ['established', 'refuted', 'not-applicable', 'open'] }, reason: str,
    evidence: strings, documentation: strings }) },
  events: { type: 'array', maxItems: limits.events, items: object({ id: str, invocationId: str, transaction: str, phase: str,
    claimId: str, evidenceId: str, callSiteId: str, title: str, role: str, actor: str, caller: str, receiver: str,
    conditions: strings, what: str, why: str,
    inputs: { type: 'array', maxItems: 8, items: object({ name: str, expression: str, type: str, units: str, origin: str, evidence: strings }) },
    changes: { type: 'array', maxItems: 6, items: object({ name: str, before: str, operation: str, after: str, units: str, evidence: strings }) },
    effect: { enum: ['read', 'condition', 'intermediate', 'committed', 'rolled-back', 'return'] },
    paragraphId: str, phrase: str }) },
  relationships: { type: 'array', maxItems: limits.relationships, items: object({ from: str, to: str,
    kind: { enum: ['call', 'callback', 'return', 'branch', 'data', 'later-transaction', 'context'] },
    explanation: str, binding: str, evidence: strings, callSiteId: str, dispatch: dispatchSchema }) },
  order: strings,
  checks: { type: 'array', maxItems: limits.checks, items: object({ target: str, reason: str, evidence: strings, documentation: strings }) }
});
function gate(draft) {
  const problems = [], details = [], model = draft.causal;
  const fail = (reason, kind = 'structural', target = null) => { problems.push(reason); details.push({ kind, target, reason,
    action: kind === 'capability' ? 'This material route needs a supported analysis capability or independently verified versioned input; unchanged retries cannot establish it.' : kind === 'material-evidence' ? 'Obtain the named evidence; do not regenerate unchanged claims.' : kind === 'local-reading' ? 'Read the remaining local segments and challenge the affected claim.' : 'Repair the affected references or coverage, retaining accepted source and claims.' }); };
  if (!model || typeof model !== 'object') return { ready: false, problems: ['The saved analysis has no checked explanation model. Prepare it with the current review policy.'] };
  const resolved = require('./event-source').resolver(draft);
  for (const problem of require('./semantic-input').problems(draft, true, resolved)) fail(problem, 'structural');
  for (const problem of require('./source-bindings').integrity(draft)) fail(problem, 'structural');
  const nonempty = value => typeof value === 'string' && !!value.trim();
  const list = value => Array.isArray(value) ? value : [];
  const units = new Map(list(draft.sources).map(unit => [unit.id, unit])), evidence = new Map(list(draft.evidence).map(entry => [entry.id, entry]));
  const docs = new Set(draft.documentation?.excerpts.map(item => item.id) || []), claims = new Set(draft.claims.map(item => item.id));
  const refs = (ids, documentation = []) => Array.isArray(ids) && Array.isArray(documentation) && !!(ids.length + documentation.length) &&
    ids.every(id => {
      const item = evidence.get(id), unit = item && units.get(item.sourceId), s = item?.source;
      return unit && unit.complete && item.explanationReview && ['kept', 'repaired', 'added'].includes(item.explanationReview.result) && s && s.line >= unit.source.line && s.endLine <= unit.source.endLine && s.endLine >= s.line && s.sourceHash === unit.source.sourceHash && s.file === unit.source.file &&
        item.quote === unit.code.split('\n').slice(s.line - unit.source.line, s.endLine - unit.source.line + 1).join('\n');
    }) && documentation.every(id => docs.has(id));
  // Lead with the concrete missing fact, not a generic schema/readiness label.
  for (const claim of draft.claims) if (claim.status === 'unresolved' || claim.needsReassessment || claim.unknowns?.length) fail(`${claim.id}: ${claim.unknowns?.[0] || claim.nextQuestion || 'A material statement is unresolved.'}`, 'material-evidence', claim.id);
  if (draft.conclusion?.limitations?.length) fail(draft.conclusion.limitations[0], 'material-evidence');
  const required = new Set([...draft.evidence.map(item => item.sourceId), ...draft.claims.map(item => item.entry)]);
  for (const unit of units.values()) if (required.has(unit.id) && Number.isInteger(unit.readThrough) && unit.readThrough < unit.source.endLine) fail(`Local code remains unread: ${unit.source.file}:${unit.readThrough + 1}-${unit.source.endLine}. The complete function is available locally.`, 'local-reading', unit.id);
  if (!nonempty(model.scope) || !nonempty(model.summary) || !['supported', 'refuted'].includes(model.outcome)) fail('The material explanation or its scoped conclusion is incomplete.');
  const assessment = draft.walkthrough?.assessment;
  if (!assessment || assessment.result !== ({ supported: 'valid', refuted: 'invalid' })[model.outcome] || !nonempty(assessment.why)) fail('The preliminary assessment does not match the checked explanation.');
  else {
    const stance = model.outcome === 'supported' ? 'supports' : 'contradicts';
    const id = assessment[stance === 'supports' ? 'supportingEvidence' : 'opposingEvidence'];
    if (!refs([id]) || evidence.get(id)?.stance !== stance) fail('The preliminary assessment has no exact decisive code link.');
  }
  if (!draft.claims.length) fail('No report statement has been examined.');
  const obligations = list(model.obligations), events = list(model.events), links = list(model.relationships), checks = list(model.checks);
  if (draft.claims.length > limits.claims || obligations.length > limits.obligations || events.length > limits.events || links.length > limits.relationships || checks.length > limits.checks) fail('The explanation exceeds its supported analytical capacity. No material claims may be dropped to fit.');
  const normalized = capacity.normalizeChecks(model), targetKeys = capacity.targets(model).map(item => item.key);
  if (new Set(targetKeys).size !== targetKeys.length || new Set(normalized.map(item => item.target)).size !== normalized.length || normalized.some(item => !targetKeys.includes(item.target))) fail('Challenge targets are duplicate, ambiguous or unknown. Use typed obligation, event and relationship identities.');
  const check = (id, ids) => normalized.some(item => item.target === id && nonempty(item.reason) && refs(item.evidence, item.documentation) && ids.every(value => item.evidence.includes(value)));
  for (const claim of draft.claims) for (const kind of kinds) {
    const obligationsForKind = obligations.filter(item => item.claimId === claim.id && item.kind === kind);
    if (!obligationsForKind.length) fail(`${claim.id}: ${kind} has not been checked.`);
  }
  const identities = new Set();
  for (const item of obligations) {
    if (!nonempty(item.id) || identities.has(item.id) || !claims.has(item.claimId) || !nonempty(item.question) || !nonempty(item.reason) ||
      !['established', 'refuted', 'not-applicable'].includes(item.state) || !refs(item.evidence, item.documentation) || !check(capacity.target('obligation', item), item.evidence)) fail(`${item.claimId || 'Report'}: ${item.question || 'An evidence requirement'} remains open or unchecked.`);
    identities.add(item.id);
    if (model.outcome === 'supported' && draft.claims.find(claim => claim.id === item.claimId)?.status === 'supported' && ['rule', 'impact', 'behavior'].includes(item.kind) && item.state !== 'established') fail(`A supported violation requires an established ${item.kind}.`);
  }
  if (model.outcome === 'supported' && !draft.claims.some(claim => ['supported', 'narrowed'].includes(claim.status) && ['rule', 'impact', 'behavior'].every(kind => obligations.some(item => item.claimId === claim.id && item.kind === kind && item.state === 'established')))) fail('A supported outcome needs at least one checked claim with established behavior, rule and impact; refuted secondary claims do not establish it.');
  if (model.outcome === 'supported' && (draft.property.basis === 'report-assumption' || !(draft.property.evidence?.length || draft.property.documentation?.length))) fail('The expected rule has no independent checked basis.');
  if (model.outcome === 'refuted' && !draft.evidence.some(item => item.stance === 'contradicts')) fail('No decisive counterevidence refutes the allegation.');
  const eventIds = new Set(), frames = new Map(), transactions = new Map(), participants = new Map();
  for (const event of events) {
    if (eventIds.has(event.id) || !['id', 'invocationId', 'transaction', 'title', 'role', 'what', 'why'].every(key => nonempty(event[key])) || !claims.has(event.claimId) || evidence.get(event.evidenceId)?.claimId !== event.claimId || !refs([event.evidenceId]) || !check(capacity.target('event', event), [event.evidenceId]) || !['read', 'condition', 'intermediate', 'committed', 'rolled-back', 'return'].includes(event.effect)) fail(`The step ${event.title || event.id || '(unnamed)'} is incomplete or lacks checked code.`);
    eventIds.add(event.id);
    const eventUnit = resolved.event(event);
    if (event.callSiteId) {
      const site = bindings.exactSite(eventUnit, event.callSiteId), anchor = (event.anchor || evidence.get(event.evidenceId))?.source;
      if (event.anchor && (!draft.bindingPlan || event.anchor.sourceId !== eventUnit?.id || event.anchor.source.sourceHash !== eventUnit?.source.sourceHash)) fail(`${event.title}: the derived visual anchor has no current binding identity.`);
      if (!site || anchor?.line !== site.span.line || anchor?.endLine !== site.span.endLine) fail(`${event.title}: the highlighted call occurrence does not match this event's exact checked lines.`, 'structural', capacity.target('event', event));
    }
    if (transactions.has(event.invocationId) && transactions.get(event.invocationId) !== event.transaction) fail(`${event.title}: one invocation cannot belong to different transactions.`);
    transactions.set(event.invocationId, event.transaction);
    // Modifiers execute within their enclosing function invocation. Context
    // reads may visit declarations. Neither is a different function frame.
    if (eventUnit && !eventUnit.contextKind && /^\s*(?:function|constructor|receive|fallback)\b/.test(lexicalCode(eventUnit.code))) {
      const frame = frames.get(event.invocationId);
      if (frame && frame.id !== eventUnit.id) fail(`${event.title}: invocation ${event.invocationId} was anchored to ${frame.name}, but this step points to ${eventUnit.name}. Anchor a return/outcome to the correct function, or use the actual helper invocation with an explained context relationship.`);
      else frames.set(event.invocationId, eventUnit);
      // The receiver is the function's execution context, not the recipient
      // of a later return or transfer. A read of a call site still belongs to
      // that frame. Reuse stable labels instead of silently changing actors.
      const current = { caller: String(event.caller || '').trim(), receiver: String(event.receiver || '').trim() };
      const previous = participants.get(event.invocationId);
      if (previous && ['caller', 'receiver'].some(key => previous[key] !== current[key])) fail(`${event.title}: invocation ${event.invocationId} changes its caller or receiver. Reuse the same frame labels; explain return or transfer recipients in the relationship, not as a different execution receiver.`, 'structural', capacity.target('event', event));
      else participants.set(event.invocationId, current);
    }
    if (eventUnit?.contextKind && event.effect !== 'read') fail(`${event.title}: a declaration is context, not evidence of an executed operation or committed change. Anchor the operation in its function and keep the declaration as a read step.`);
    if (event.effect !== 'read' && (!nonempty(event.actor) || !nonempty(event.caller) || !nonempty(event.receiver))) fail(`${event.title}: the relevant caller and receiver are missing.`);
    for (const input of list(event.inputs)) if (!['name', 'expression', 'type', 'units', 'origin'].every(key => nonempty(input[key])) || !refs(input.evidence)) fail(`${event.title}: an input has no checked origin or units.`);
    for (const change of list(event.changes)) if (!['name', 'before', 'operation', 'after', 'units'].every(key => nonempty(change[key])) || !refs(change.evidence)) fail(`${event.title}: a displayed value change lacks evidence.`);
  }
  for (const link of links) {
    if (!eventIds.has(link.from) || !eventIds.has(link.to) || !nonempty(link.explanation) || !refs(link.evidence) || !check(capacity.target('relationship', link), link.evidence) || !['call', 'callback', 'return', 'branch', 'data', 'later-transaction', 'context'].includes(link.kind)) fail('An explanation handoff is missing, unchecked or points outside this scenario.');
    const from = events.find(event => event.id === link.from), to = events.find(event => event.id === link.to);
    if (from && to && ['call', 'callback', 'return', 'branch'].includes(link.kind) && from.transaction !== to.transaction) fail('A call or return was incorrectly joined across transactions.');
    if (from && to && ['call', 'callback', 'return'].includes(link.kind)) {
      const source = resolved.event(from), destination = resolved.event(to);
      if (!nonempty(link.binding)) fail(`${from.title}: the ${link.kind} handoff has no checked value binding or reason it needs none.`, 'structural', capacity.target('relationship', link));
      bindings.validateTransition({ draft, link, from, to, source, destination, units: resolved.units, evidence: resolved.evidence, refs, events, links,
        fail: (reason, kind = 'structural') => fail(reason, kind, capacity.target('relationship', link)) });
    }
  }
  bindings.validateInvocations({ events, links, units: resolved.units, evidence: resolved.evidence, fail, resolved });
  if (!events.length || !Array.isArray(model.order) || model.order.length !== events.length || new Set(model.order).size !== events.length || model.order.some(id => !eventIds.has(id))) fail('The tutorial has no complete, unique reading order.');
  for (let i = 1; i < list(model.order).length; i++) if (!links.some(link => link.from === model.order[i - 1] && link.to === model.order[i])) fail('A move to the next step has no explained handoff or context detour.');
  return { ready: !problems.length, policy: POLICY, problems: [...new Set(problems)].slice(0, 12), details };
}
function expose(draft, report = null) {
  if (!draft) return null;
  const checked = draft.phase === 'ready' && draft.publication?.policy === POLICY && draft.publication.digest === digest(draft) && gate(draft).ready;
  if (checked && (!report || report.findingReady === true && report.findingId === draft.findingId)) return { ...structuredClone(draft), nativeSources: require('./event-source').projections(draft) };
  // Partial model prose never crosses the host boundary. It stays in the
  // private draft for diagnostics/retry, separate from researcher decisions.
  const copy = structuredClone(draft);
  for (const field of ['causal', 'bindingPlan', 'nativeSources', 'walkthrough', 'explanationReviews', 'inputReviews', 'challengeChanges', 'documentation', 'checkpoint', 'lastRejected']) delete copy[field];
  Object.assign(copy, { claims: [], evidence: [], sources: [], transitions: [], questions: [], property: { text: '', basis: 'report-assumption', evidence: [] }, conclusion: { text: '', limitations: [] } });
  copy.preparation = { state: draft.phase === 'blocked' ? (draft.failureKind === 'provider' ? 'failed' : 'blocked') : draft.phase === 'provider-required' ? 'not-started' : ['challenging', 'checking-source'].includes(draft.phase) ? 'checking' : 'preparing',
    reason: draft.error || draft.publication?.problems?.[0] || (draft.phase === 'provider-required' ? 'Choose an authenticated provider to prepare the explanation.' : ''),
    problems: draft.publication?.problems || [], attempted: draft.actions.slice(-5).map(action => action.result) };
  if (checked && report && !report.findingReady) copy.preparation = { state: 'checking',
    reason: 'Checking this saved walkthrough against the current finding and code.',
    attempted: [] };
  if (copy.phase === 'ready') copy.phase = 'preparing';
  return copy;
}
module.exports = { POLICY, schema, gate, expose, digest };
