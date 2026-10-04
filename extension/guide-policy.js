'use strict';
// A publication gate, not a truth oracle. Locations and closed references are
// host checked. Interpretations also need an evidence-grounded challenge.
const POLICY = 'checked-explanation-v3';
const crypto = require('node:crypto');
const { lexicalCode } = require('./solidity-text');
function digest(draft) {
  return crypto.createHash('sha256').update(JSON.stringify({ findingId: draft.findingId, snapshot: draft.snapshot,
    property: draft.property, claims: draft.claims, evidence: draft.evidence, sources: draft.sources,
    causal: draft.causal, walkthrough: draft.walkthrough, conclusion: draft.conclusion })).digest('hex');
}
const str = { type: 'string' }, strings = { type: 'array', items: str };
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const schema = object({
  scope: str, summary: str, outcome: { enum: ['supported', 'refuted', 'blocked'] },
  obligations: { type: 'array', maxItems: 40, items: object({ id: str, claimId: str,
    kind: { enum: ['applicability', 'entry', 'conditions', 'behavior', 'settlement', 'rule', 'impact', 'counterevidence'] },
    question: str, state: { enum: ['established', 'refuted', 'not-applicable', 'open'] }, reason: str,
    evidence: strings, documentation: strings }) },
  events: { type: 'array', maxItems: 18, items: object({ id: str, invocationId: str, transaction: str, phase: str,
    claimId: str, evidenceId: str, title: str, role: str, actor: str, caller: str, receiver: str,
    conditions: strings, what: str, why: str,
    inputs: { type: 'array', maxItems: 8, items: object({ name: str, expression: str, type: str, units: str, origin: str, evidence: strings }) },
    changes: { type: 'array', maxItems: 6, items: object({ name: str, before: str, operation: str, after: str, units: str, evidence: strings }) },
    effect: { enum: ['read', 'condition', 'intermediate', 'committed', 'rolled-back', 'return'] },
    paragraphId: str, phrase: str }) },
  relationships: { type: 'array', maxItems: 30, items: object({ from: str, to: str,
    kind: { enum: ['call', 'callback', 'return', 'branch', 'data', 'later-transaction', 'context'] },
    explanation: str, binding: str, evidence: strings }) },
  order: strings,
  checks: { type: 'array', maxItems: 60, items: object({ target: str, reason: str, evidence: strings, documentation: strings }) }
});
function gate(draft) {
  const problems = [], model = draft.causal;
  const fail = reason => problems.push(reason);
  if (!model || typeof model !== 'object') return { ready: false, problems: ['The saved analysis has no checked explanation model. Prepare it with the current review policy.'] };
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
  for (const claim of draft.claims) if (claim.status === 'unresolved' || claim.needsReassessment || claim.unknowns?.length) fail(`${claim.id}: ${claim.unknowns?.[0] || claim.nextQuestion || 'A material statement is unresolved.'}`);
  if (draft.conclusion?.limitations?.length) fail(draft.conclusion.limitations[0]);
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
  if (obligations.length > 40 || events.length > 18 || links.length > 30 || checks.length > 60) fail('The explanation exceeds its checked presentation bounds.');
  const check = (id, ids) => checks.some(item => item.target === id && nonempty(item.reason) && refs(item.evidence, item.documentation) && ids.every(value => item.evidence.includes(value)));
  for (const claim of draft.claims) for (const kind of ['applicability', 'entry', 'conditions', 'behavior', 'settlement', 'rule', 'impact', 'counterevidence']) {
    const obligationsForKind = obligations.filter(item => item.claimId === claim.id && item.kind === kind);
    if (!obligationsForKind.length) fail(`${claim.id}: ${kind} has not been checked.`);
  }
  const identities = new Set();
  for (const item of obligations) {
    if (!nonempty(item.id) || identities.has(item.id) || !claims.has(item.claimId) || !nonempty(item.question) || !nonempty(item.reason) ||
      !['established', 'refuted', 'not-applicable'].includes(item.state) || !refs(item.evidence, item.documentation) || !check(item.id, item.evidence)) fail(`${item.claimId || 'Report'}: ${item.question || 'An evidence requirement'} remains open or unchecked.`);
    identities.add(item.id);
    if (model.outcome === 'supported' && ['rule', 'impact', 'behavior'].includes(item.kind) && item.state !== 'established') fail(`A supported violation requires an established ${item.kind}.`);
  }
  if (model.outcome === 'supported' && (draft.property.basis === 'report-assumption' || !(draft.property.evidence?.length || draft.property.documentation?.length))) fail('The expected rule has no independent checked basis.');
  if (model.outcome === 'refuted' && !draft.evidence.some(item => item.stance === 'contradicts')) fail('No decisive counterevidence refutes the allegation.');
  const eventIds = new Set(), frames = new Map(), transactions = new Map();
  for (const event of events) {
    if (eventIds.has(event.id) || !['id', 'invocationId', 'transaction', 'title', 'role', 'what', 'why'].every(key => nonempty(event[key])) || !claims.has(event.claimId) || evidence.get(event.evidenceId)?.claimId !== event.claimId || !refs([event.evidenceId]) || !check(event.id, [event.evidenceId]) || !['read', 'condition', 'intermediate', 'committed', 'rolled-back', 'return'].includes(event.effect)) fail(`The step ${event.title || event.id || '(unnamed)'} is incomplete or lacks checked code.`);
    eventIds.add(event.id);
    const eventUnit = units.get(evidence.get(event.evidenceId)?.sourceId);
    if (transactions.has(event.invocationId) && transactions.get(event.invocationId) !== event.transaction) fail(`${event.title}: one invocation cannot belong to different transactions.`);
    transactions.set(event.invocationId, event.transaction);
    // Modifiers execute within their enclosing function invocation. Context
    // reads may visit declarations. Neither is a different function frame.
    if (event.effect !== 'read' && eventUnit && !eventUnit.contextKind && /^\s*(?:function|constructor|receive|fallback)\b/.test(lexicalCode(eventUnit.code))) {
      const frame = frames.get(event.invocationId);
      if (frame && frame.id !== eventUnit.id) fail(`${event.title}: invocation ${event.invocationId} was anchored to ${frame.name}, but this step points to ${eventUnit.name}. Anchor a return/outcome to the correct function, or use the actual helper invocation with an explained context relationship.`);
      else frames.set(event.invocationId, eventUnit);
    }
    if (eventUnit?.contextKind && event.effect !== 'read') fail(`${event.title}: a declaration is context, not evidence of an executed operation or committed change. Anchor the operation in its function and keep the declaration as a read step.`);
    if (event.effect !== 'read' && (!nonempty(event.actor) || !nonempty(event.caller) || !nonempty(event.receiver))) fail(`${event.title}: the relevant caller and receiver are missing.`);
    for (const input of list(event.inputs)) if (!['name', 'expression', 'type', 'units', 'origin'].every(key => nonempty(input[key])) || !refs(input.evidence)) fail(`${event.title}: an input has no checked origin or units.`);
    for (const change of list(event.changes)) if (!['name', 'before', 'operation', 'after', 'units'].every(key => nonempty(change[key])) || !refs(change.evidence)) fail(`${event.title}: a displayed value change lacks evidence.`);
  }
  for (const link of links) {
    if (!eventIds.has(link.from) || !eventIds.has(link.to) || !nonempty(link.explanation) || !refs(link.evidence) || !check(`${link.from}->${link.to}`, link.evidence) || !['call', 'callback', 'return', 'branch', 'data', 'later-transaction', 'context'].includes(link.kind)) fail('An explanation handoff is missing, unchecked or points outside this scenario.');
    const from = events.find(event => event.id === link.from), to = events.find(event => event.id === link.to);
    if (from && to && ['call', 'callback', 'return', 'branch'].includes(link.kind) && from.transaction !== to.transaction) fail('A call or return was incorrectly joined across transactions.');
  }
  if (!events.length || !Array.isArray(model.order) || model.order.length !== events.length || new Set(model.order).size !== events.length || model.order.some(id => !eventIds.has(id))) fail('The tutorial has no complete, unique reading order.');
  for (let i = 1; i < list(model.order).length; i++) if (!links.some(link => link.from === model.order[i - 1] && link.to === model.order[i])) fail('A move to the next step has no explained handoff or context detour.');
  return { ready: !problems.length, policy: POLICY, problems: [...new Set(problems)].slice(0, 12) };
}
function expose(draft, report = null) {
  if (!draft) return null;
  const checked = draft.phase === 'ready' && draft.publication?.policy === POLICY && draft.publication.digest === digest(draft) && gate(draft).ready;
  if (checked && (!report || report.published)) return structuredClone(draft);
  // Partial model prose never crosses the host boundary. It stays in the
  // private draft for diagnostics/retry, separate from researcher decisions.
  const copy = structuredClone(draft);
  for (const field of ['causal', 'walkthrough', 'explanationReviews', 'challengeChanges', 'documentation', 'checkpoint', 'lastRejected']) delete copy[field];
  Object.assign(copy, { claims: [], evidence: [], sources: [], transitions: [], questions: [], property: { text: '', basis: 'report-assumption', evidence: [] }, conclusion: { text: '', limitations: [] } });
  copy.preparation = { state: draft.phase === 'blocked' ? (draft.failureKind === 'provider' ? 'failed' : 'blocked') : draft.phase === 'provider-required' ? 'not-started' : ['challenging', 'checking-source'].includes(draft.phase) ? 'checking' : 'preparing',
    reason: draft.error || draft.publication?.problems?.[0] || (draft.phase === 'provider-required' ? 'Choose an authenticated provider to prepare the explanation.' : ''),
    problems: draft.publication?.problems || [], attempted: draft.actions.slice(-5).map(action => action.result) };
  if (report && !report.published) copy.preparation = { state: report.mode === 'running' ? 'preparing' : 'blocked',
    reason: report.reason || 'Generated guides are private until every finding in this report passes its checks.', report,
    attempted: report.stopped.map(job => `${job.id}: ${job.reason || job.state}`) };
  if (copy.phase === 'ready') copy.phase = 'preparing';
  return copy;
}
module.exports = { POLICY, schema, gate, expose, digest };
