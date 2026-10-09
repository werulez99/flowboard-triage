'use strict';
// A publication gate, not a truth oracle. Locations and closed references are
// host checked. Interpretations also need an evidence-grounded challenge.
const capacity = require('./review-capacity'), { limits, kinds, POLICY } = capacity;
const crypto = require('node:crypto');
const diagnostics = require('./tutorial-diagnostics');
function digest(draft) {
  return crypto.createHash('sha256').update(JSON.stringify({ findingId: draft.findingId, snapshot: draft.snapshot,
    property: draft.property, claims: draft.claims, evidence: draft.evidence, sources: draft.sources,
    causal: draft.causal, walkthrough: draft.walkthrough, conclusion: draft.conclusion, dependencies: draft.dependencies,
    semanticInput: draft.semanticInput, inputReviews: draft.inputReviews, ...(draft.bindingPlan ? { bindingPlan: draft.bindingPlan } : {}),
    ...(require('./technical-assessment').observations(draft).length?{observations:require('./technical-assessment').observations(draft)}:{}),
    ...(draft.candidateVerification ? { candidateVerification: draft.candidateVerification } : {}) })).digest('hex');
}
const str = require('./review-content').string, strings = { type: 'array', items: str };
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
  if(draft.recoveryRequired)return {ready:false,policy:POLICY,problems:[draft.recoveryRequired.reason],details:[]};
  const fidelity=require('./review-content').mismatch(draft);
  if(fidelity)return {ready:false,policy:POLICY,problems:[fidelity],details:[{kind:'structural',reason:fidelity,action:'Inspect the retained checked representation and recover locally; do not regenerate or transfer approval.'}]};
  if (draft.reviewCandidate) return { ready: false, policy: POLICY, problems: ['A private candidate is saved; complete fresh verification is still required.'], details: [] };
  if (draft.rejectedProposal) return {ready:false,policy:POLICY,problems:['Received analysis remains an unaccepted proposal. Repair and full fresh verification are required.'],details:[]};
  const problems = [], details = [], model = draft.causal;
  const fail = (reason, kind = 'structural', target = null, meta = {}) => { problems.push(reason); details.push(diagnostics.detail(draft,reason,kind,target,meta)); };
  if (draft.candidateHistory?.length) {
    const lifecycle = require('./review-candidate'), state = draft.candidateHistory.at(-1), receipt = draft.candidateVerification;
    if (!receipt || state.verification?.result !== 'kept' || receipt.candidateHash !== state.candidateHash ||
        receipt.revisionHash !== lifecycle.hash(state.revisions) || lifecycle.hash(receipt.targets) !== lifecycle.hash(lifecycle.revisionTargets(state.revisions)) ||
        lifecycle.hash(receipt.checks ?? null) !== lifecycle.hash(state.verification.revisionChecks ?? null))
      fail('The candidate revision verification receipt is missing or changed.');
  }
  if (!model || typeof model !== 'object') return { ready: false, problems: ['The saved analysis has no checked explanation model. Prepare it with the current review policy.'] };
  if(!draft.property||!Array.isArray(draft.claims)||!Array.isArray(draft.evidence)||!Array.isArray(draft.sources))
    return {ready:false,policy:POLICY,problems:['The saved analysis is missing its canonical argument fields. No checked assessment or layout remedy is available.'],details:[{kind:'structural',code:'ARGUMENT_INCOMPLETE',reason:'Canonical property, claims, evidence and source collections are required.'}]};
  const technical=require('./technical-assessment'),optionalDetails=[];
  if(technical.pendingObservations(draft).length&&!technical.current(draft))fail('Execution observations have changed since the retained substantive review. Interpret their assertions and setup before publishing a current walkthrough.','material-evidence','experiments',{code:'OBSERVATION_REVIEW_REQUIRED'});
  const resolved = require('./event-source').resolver(draft);
  for (const problem of require('./semantic-input').problems(draft, false, resolved)) fail(problem, 'structural',null,{code:'PREMISE_REVIEW_INVALID'});
  for(const review of draft.inputReviews||[])if(review.status==='unresolved'){
    const premise=draft.semanticInput?.premises.find(p=>p.id===review.id);
    if(premise)fail(`The saved ${premise.field} is still unresolved: ${premise.text}\n${review.reason}`,'material-evidence','premise:'+review.id,{code:'PREMISE_UNRESOLVED',eventIds:review.eventIds,claimIds:review.claimIds});
  }
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
  for (const claim of draft.claims) if (claim.status === 'unresolved' || claim.needsReassessment || claim.unknowns?.length) for(const unknown of claim.unknowns?.length ? claim.unknowns : [claim.nextQuestion || 'A material statement is unresolved.']) fail(`${claim.id}: ${unknown}`, 'material-evidence', claim.id);
  for (const [index, limitation] of (draft.conclusion?.limitations || []).entries()) fail(limitation, 'material-evidence', `conclusion/limitations/${index}`);
  const required = new Set([...draft.evidence.map(item => item.sourceId), ...draft.claims.map(item => item.entry)]);
  for (const unit of units.values()) if (required.has(unit.id) && Number.isInteger(unit.readThrough) && unit.readThrough < unit.source.endLine) {
    const contextNotes=unit.contextKind==='excerpt'&&unit.modelRanges&&!draft.claims.some(c=>c.entry===unit.id)&&
      draft.evidence.filter(e=>e.sourceId===unit.id).every(e=>require('./source-coverage').read(unit,e.source.line,e.source.endLine));
    if(!contextNotes)fail(`Local code remains unread: ${unit.source.file}:${unit.readThrough + 1}-${unit.source.endLine}. The complete function is available locally.`, 'local-reading', unit.id);
  }
  if (!nonempty(model.scope) || !nonempty(model.summary) || !['supported', 'refuted','blocked'].includes(model.outcome)) fail('The material explanation or its scoped conclusion is incomplete.');
  else if(model.outcome==='blocked') fail('The checked explanation retains a material blocker.','material-evidence');
  const assessment = draft.walkthrough?.assessment;
  if (!assessment || assessment.result !== ({ supported: 'valid', refuted: 'invalid',blocked:'unclear' })[model.outcome] || !nonempty(assessment.why)) fail('The preliminary assessment does not match the checked explanation.');
  else if(model.outcome!=='blocked') {
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
  for(const claim of draft.claims){
    const factors=claim.severityFactors;
    if(factors&&(!refs(factors.evidence)||factors.evidence.some(id=>evidence.get(id)?.claimId!==claim.id&&evidence.get(id)?.claimId!=='')||!obligations.some(o=>o.claimId===claim.id&&o.kind==='impact'&&check(capacity.target('obligation',o),factors.evidence))))
      optionalDetails.push({kind:'optional',target:`claim:${claim.id}/severityFactors`,code:'SEVERITY_REVIEW_MISSING',claimIds:[claim.id],reason:'Optional severity is unavailable: its factors have no complete source-grounded impact review. The independently checked core is assessed separately.'});
    if(draft.property.derivation&&!obligations.some(o=>o.claimId===claim.id&&o.kind==='rule'&&check(capacity.target('obligation',o),draft.property.derivation.evidence)))
      fail('The invariant derivation lacks its source-grounded rule check.','structural',`claim:${claim.id}/rule`,{code:'DERIVATION_REVIEW_MISSING',claimIds:[claim.id]});
  }
  for (const claim of draft.claims) for (const kind of kinds) {
    const obligationsForKind = obligations.filter(item => item.claimId === claim.id && item.kind === kind);
    if (!obligationsForKind.length) fail(`${claim.id}: ${kind} has not been checked.`);
  }
  const identities = new Set();
  for (const item of obligations) {
    if (!nonempty(item.id) || identities.has(item.id) || !claims.has(item.claimId) || !nonempty(item.question) || !nonempty(item.reason) ||
      !['established', 'refuted', 'not-applicable','open'].includes(item.state) || !refs(item.evidence, item.documentation) || !check(capacity.target('obligation', item), item.evidence)) {
      const reviewed=normalized.find(c=>c.target===capacity.target('obligation',item)),missing=(item.evidence||[]).filter(id=>!reviewed?.evidence?.includes(id));
      fail(`${item.claimId || 'Report'}: ${item.question || 'An evidence requirement'} remains open or unchecked.${missing.length?' Fresh check omits evidence: '+missing.join(', ')+'.':''}`,'structural',capacity.target('obligation',item),{code:'OBLIGATION_CHECK_COVERAGE',missingEvidence:missing,
        ...(missing.length?{action:'Fresh verification must assess these evidence references under explicit eligible authority. Do not edit the received check, inherit approval, or author an unnecessary candidate revision.'}:{})});
    }
    else if(item.state==='open') fail(`${item.claimId}: ${item.question} remains materially open after checking.`,'material-evidence',item.id);
    identities.add(item.id);
    if (model.outcome === 'supported' && draft.claims.find(claim => claim.id === item.claimId)?.status === 'supported' && ['rule', 'impact', 'behavior'].includes(item.kind) && item.state !== 'established') fail(`A supported violation requires an established ${item.kind}.`);
  }
  if (model.outcome === 'supported' && !draft.claims.some(claim => ['supported', 'narrowed'].includes(claim.status) && ['rule', 'impact', 'behavior'].every(kind => obligations.some(item => item.claimId === claim.id && item.kind === kind && item.state === 'established')))) fail('A supported outcome needs at least one checked claim with established behavior, rule and impact; refuted secondary claims do not establish it.');
  if (model.outcome === 'supported' && (!['source-contract','test-expectation','local-documentation','derived-security-invariant'].includes(draft.property.basis) || !(draft.property.evidence?.length || draft.property.documentation?.length))) fail('The expected rule has no independent checked basis.');
  if(draft.property.basis==='derived-security-invariant'){
    const derivation=draft.property.derivation;
    if(!derivation||!['mechanism','reason','counterevidence'].every(k=>nonempty(derivation[k]))||!derivation.assumptions?.length||!refs(derivation.evidence))fail('The derived security invariant needs source-grounded rights/obligations, its derivation, explicit assumptions and contrary evidence.','structural','property/derivation',{code:'DERIVATION_INCOMPLETE'});
  }
  if (model.outcome === 'refuted' && !draft.evidence.some(item => item.stance === 'contradicts')) fail('No decisive counterevidence refutes the allegation.');
  const eventIds = new Set();
  for (const event of events) {
    if (eventIds.has(event.id) || !['id', 'invocationId', 'transaction', 'title', 'role', 'what', 'why'].every(key => nonempty(event[key])) || !claims.has(event.claimId) || evidence.get(event.evidenceId)?.claimId !== event.claimId || !refs([event.evidenceId]) || !check(capacity.target('event', event), [event.evidenceId]) || !['read', 'condition', 'intermediate', 'committed', 'rolled-back', 'return'].includes(event.effect)) fail(`The step ${event.title || event.id || '(unnamed)'} is incomplete or lacks checked code.`);
    eventIds.add(event.id);
    if (event.effect !== 'read' && (!nonempty(event.actor) || !nonempty(event.caller) || !nonempty(event.receiver))) fail(`${event.title}: the relevant caller and receiver are missing.`);
    for (const input of list(event.inputs)) if (!['name', 'expression', 'type', 'units', 'origin'].every(key => nonempty(input[key])) || !refs(input.evidence)) fail(`${event.title}: an input has no checked origin or units.`);
    for (const change of list(event.changes)) {
      if (!['name', 'before', 'operation', 'after', 'units'].every(key => nonempty(change[key])) || !refs(change.evidence)) fail(`${event.title}: a displayed value change lacks evidence.`);
    }
  }
  for (const link of links) {
    if (!eventIds.has(link.from) || !eventIds.has(link.to) || !nonempty(link.explanation) || !refs(link.evidence) || !check(capacity.target('relationship', link), link.evidence) || !['call', 'callback', 'return', 'branch', 'data', 'later-transaction', 'context'].includes(link.kind)) fail('An explanation handoff is missing, unchecked or points outside this scenario.');
  }
  const deterministic = diagnostics.inspect(draft);
  for(const item of deterministic.details){problems.push(item.reason);details.push(item);}
  return { ready: !problems.length, policy: POLICY, problems: [...new Set(problems)].slice(0, 12), details, optionalDetails, diagnosticsVersion: deterministic.version, diagnosticsIdentity: deterministic.identity };
}
function evaluate(draft) {
  const publication=gate(draft),identity=digest(draft);
  const checked=draft.phase==='ready'&&draft.publication?.policy===POLICY&&draft.publication.digest===identity&&publication.ready;
  const assessment=require('./technical-assessment').project(draft,publication);
  Object.assign(assessment,require('./assessment-profile').project(draft,assessment));
  return {publication,digest:identity,checked,assessment};
}
function expose(draft, report = null, evaluation=null) {
  if (!draft) return null;
  const evaluated=evaluation||evaluate(draft),checked=evaluated.checked;
  if (checked && (!report || report.findingReady === true && report.findingId === draft.findingId)) {
    const copy = structuredClone(draft); for(const key of ['reviewCandidate','candidateHistory','candidateVerification','invalidatedCandidates','invalidatedReviews','correctionHistory','rejectedProposal','rejectedProposalHistory','lastRejected','localRevalidations','localDiagnosticHistory','tutorialDiagnostics'])delete copy[key];
    delete copy.technicalReview;delete copy.technicalReviewHistory;
    // Withheld optional assertions stay in the immutable private response,
    // not in the native/copy/export semantic DTO. This grants no new checks.
    for(const claim of copy.claims)if(evaluated.publication.optionalDetails?.some(d=>d.claimIds.includes(claim.id)))claim.severityFactors=null;
    return { ...copy, assessmentProjection:evaluated.assessment, nativeSources: require('./event-source').projections(draft) };
  }
  // Partial model prose never crosses the host boundary. It stays in the
  // private draft for diagnostics/retry, separate from researcher decisions.
  const copy = structuredClone(draft);
  for(const key of ['invalidatedCandidates','invalidatedReviews','correctionHistory','rejectedProposal','rejectedProposalHistory','localRevalidations','localDiagnosticHistory','tutorialDiagnostics'])delete copy[key];
  for (const field of ['causal', 'bindingPlan', 'nativeSources', 'walkthrough', 'explanationReviews', 'inputReviews', 'challengeChanges', 'documentation', 'checkpoint', 'lastRejected', 'reviewCandidate', 'candidateHistory', 'candidateVerification']) delete copy[field];
  Object.assign(copy, { claims: [], evidence: [], sources: [], transitions: [], questions: [], property: { text: '', basis: 'report-assumption', evidence: [] }, conclusion: { text: '', limitations: [] } });
  delete copy.technicalReview;delete copy.technicalReviewHistory;
  copy.assessmentProjection=evaluated.assessment;
  copy.preparation = { state: draft.phase === 'blocked' ? (draft.failureKind === 'provider' ? 'failed' : 'blocked') : draft.phase === 'provider-required' ? 'not-started' : ['challenging', 'checking-source'].includes(draft.phase) ? 'checking' : 'preparing',
    reason: draft.error || draft.publication?.problems?.[0] || (draft.phase === 'provider-required' ? 'Choose an authenticated provider to prepare the explanation.' : ''),
    problems: draft.publication?.problems || [], attempted: draft.actions.slice(-5).map(action => action.result) };
  if (checked && report && !report.findingReady) copy.preparation = { state: 'checking',
    reason: 'Checking this saved walkthrough against the current finding and code.',
    attempted: [] };
  if (copy.phase === 'ready') copy.phase = 'preparing';
  return copy;
}
module.exports = { POLICY, schema, gate, expose, digest, evaluate };
