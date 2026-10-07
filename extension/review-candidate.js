'use strict';
// A proposed explanation is durable work, not a checked explanation. The
// original semantic base, candidate and verification have separate identities.
const crypto = require('node:crypto');
const format = require('./challenge-format');
const scope = require('./review-scope');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const VERSION = 'private-candidate-v1';
const purposes = ['candidate-completion', 'candidate-verification', 'candidate-repair', 'candidate-reverification','rejected-proposal-repair'];
function unchecked(value) {
  const result = structuredClone(value);
  result.inputReviews = []; result.explanationReviews = [];
  if (result.causal) result.causal.checks = [];
  return result;
}
function wire(draft, schema) {
  const value = format.earlier(draft, schema);
  return unchecked(draft.bindingPlan ? require('./source-bindings').wire(value, draft.bindingPlan) : value);
}
function identity(draft) { return hash([draft.snapshot, draft.corrections, draft.semanticInput]); }
function revision(original, candidate, origin) {
  const changes = [];
  const compare = (before, after, path) => {
    if (hash(before ?? null) === hash(after ?? null)) return;
    if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every(item => item?.id)) {
      for (const id of new Set([...before, ...after].map(item => item.id)))
        compare(before.find(item => item.id === id), after.find(item => item.id === id), `${path}/${id}`);
    } else if (path === '/causal') {
      for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})]))
        if (key !== 'checks') compare(before?.[key], after?.[key], `${path}/${key}`);
    } else changes.push({ path, before: before ?? null, afterHash: hash(after ?? null) });
  };
  for (const key of new Set([...Object.keys(original), ...Object.keys(candidate)]))
    if (!['inputReviews', 'explanationReviews'].includes(key)) compare(original[key], candidate[key], '/' + key);
  return { version: VERSION, ...(origin?{referenceBaseHash:hash(original),referenceOrigin:origin}:{acceptedBaseHash:hash(original)}), candidateHash: hash(candidate), changes };
}
function assertCurrent(draft, schema) {
  const state = draft.reviewCandidate;
  const rejected=state?.referenceOrigin&&require('./rejected-proposal').assertCurrent(draft,schema);
  if (!state || state.version !== VERSION || state.contextHash !== identity(draft) ||
      (rejected ? state.referenceBaseHash!==rejected.proposalHash || hash(state.referenceOrigin)!==hash(rejected.origin) || hash(state.referenceBase)!==rejected.proposalHash : state.acceptedBaseHash !== hash(wire(draft, schema))) ||
      state.candidateHash !== hash(state.candidate) ||
      hash(state.revisions) !== hash(revision(state.referenceBase||state.acceptedBase, state.candidate,state.referenceOrigin)))
    throw Object.assign(new Error('Private candidate/source/premise/base or revision identity changed. No prior checks can be reused.'), { code: 'CANDIDATE_STALE' });
  return state;
}
function save(draft, candidate, schema, provenance) {
  const prior = draft.reviewCandidate && assertCurrent(draft, schema);
  const rejected=draft.rejectedProposal&&require('./rejected-proposal').assertCurrent(draft,schema);
  const acceptedBase = rejected?rejected.proposal:prior?.acceptedBase || wire(draft, schema), proposed = unchecked(candidate);
  require('./review-content').bounds(proposed);
  const wireSchema=proposed.bindingFormat?require('./source-bindings').schema(schema):schema;
  if(!format.valid(proposed,wireSchema))throw new Error('Private candidate exceeds its supported structural contract; it was not frozen.');
  scope.assert(acceptedBase, proposed);
  for (const claim of acceptedBase.claims) if (!proposed.claims.some(item => item.id === claim.id))
    throw new Error(`Private candidate omitted material claim ${claim.id}.`);
  const revisions = revision(acceptedBase, proposed,rejected?.origin);
  draft.reviewCandidate = { version: VERSION, state: 'awaiting-verification',
    contextHash: identity(draft), ...(rejected?{referenceBase:acceptedBase,referenceBaseHash:hash(acceptedBase),referenceOrigin:rejected.origin}:{acceptedBaseHash: hash(acceptedBase), acceptedBase}),
    versionNumber: (prior?.versionNumber || 0) + 1, candidate: proposed, candidateHash: hash(proposed), revisions,
    lineage: [...(prior?.lineage || []), { ...provenance, candidateHash: hash(proposed), revisionHash: hash(revisions) }],
    history: [...(prior?.history || []), ...(prior ? [{ candidate: prior.candidate, candidateHash: prior.candidateHash, verification: prior.verification || null }] : [])],
    repairCount: prior?.repairCount || 0, verification: null };
  return draft.reviewCandidate;
}
function needsCompletion(draft) {
  if (!draft.causal) return false;
  if (draft.claims.some(item => item.needsReassessment)) return true;
  const required=new Set([...draft.evidence.map(item=>item.sourceId),...draft.claims.map(item=>item.entry)]);
  if(draft.claims.some(item=>item.status==='unresolved'||item.unknowns.length)&&draft.sources.some(unit=>required.has(unit.id)&&Number.isInteger(unit.readThrough)&&unit.readThrough<unit.source.endLine))return true;
  // A limitation is not an authoring task. First acquire the named local
  // definition; an unavailable external fact still needs review, not an empty
  // candidate patch. Only actual acquisition receipts establish local work.
  return draft.questions.some(question => {
    const action = [...draft.actions].reverse().find(item => item.questionId === question.id);
    return action && ['source-returned', 'context-already-available', 'reading-limit'].includes(action.outcome) &&
      action.sourceIds.some(id => draft.sources.some(unit => unit.id === id));
  });
}
function purpose(draft, schema) {
  if(draft.rejectedProposal&&!draft.reviewCandidate){const state=require('./rejected-proposal').assertCurrent(draft,schema);if(state.state!=='repair-pending')throw new Error('The retained proposal repair is terminal; no automatic repeat is permitted.');return 'rejected-proposal-repair';}
  if (!draft.reviewCandidate) return needsCompletion(draft) ? 'candidate-completion' : null;
  const state = assertCurrent(draft, schema);
  if (state.state === 'seeded') return 'candidate-completion';
  if (state.state === 'repair-requested') {
    if (state.repairCount >= 1) throw new Error('The candidate already used its bounded repair cycle. Retained feedback needs inspection.');
    return 'candidate-repair';
  }
  if (state.state === 'terminal') throw new Error('The candidate review ended with retained blockers; no automatic further request is permitted.');
  return state.repairCount ? 'candidate-reverification' : 'candidate-verification';
}
function packet(input, draft, schema, selectedPurpose) {
  const state = draft.reviewCandidate && assertCurrent(draft, schema);
  const rejected=draft.rejectedProposal&&require('./rejected-proposal').assertCurrent(draft,schema);
  const candidate = state?.candidate || rejected?.proposal || wire(draft, schema);
  const revisions=state?.revisions||revision(candidate,candidate,rejected?.origin);
  const result = { ...input, earlierDraft: candidate, reviewPurpose: selectedPurpose,
    candidateIdentity: { version: VERSION, contextHash: identity(draft), ...(rejected?{referenceBaseHash:rejected.proposalHash,referenceOrigin:rejected.origin}:{acceptedBaseHash: state?.acceptedBaseHash || hash(candidate)}),
      candidateHash: hash(candidate), revisionHash: hash(revisions), versionNumber: state?.versionNumber || 0 },
    candidateRevisions: revisions,
    ...(rejected?{referenceOrigin:rejected.origin,previousScopes:rejected.proposal.claims.map(({id,allegation,implementation,conditions})=>({id,allegation,implementation,conditions})),evidenceScopes:scope.manifest(rejected.proposal)}:{}) };
  delete result.checkOnly; delete result.repairOnly; delete result.provisionalWorkNotes;
  // This explicit repair names the immutable proposal once in earlierDraft.
  // Old replay feedback can contain a second complete rejectedOutput and
  // obsolete host errors. Current typed diagnostics are candidateProblems.
  if(rejected)delete result.hostReview;
  if (selectedPurpose.endsWith('verification')) { result.checkOnly = true; result.candidateRevisionTargets = revisionTargets(result.candidateRevisions); }
  else { result.candidateOnly = true; if (selectedPurpose === 'candidate-repair') result.candidateProblems = state.verification.problems;
    if(selectedPurpose==='rejected-proposal-repair')result.candidateProblems=rejected.validationProblems; }
  return result;
}
function revisionTargets(revisions) {
  // Note revisions already have explicit kept/repaired/added/removed coverage.
  // Reuse the existing check shape for other material old-to-candidate changes,
  // including a removed operation/question; current targets cannot cover an
  // omitted old target by themselves. No independent attestation framework.
  const targets=revisions.changes.filter(item=>!item.path.startsWith('/evidence/')).map(item=>'revision:'+item.path);
  require('./review-capacity').assertLength(targets,require('./review-capacity').limits.revisionChecks,'material revision checks');
  return targets;
}
function checkRevisions(value, input, draft) {
  const targets=revisionTargets(input.candidateRevisions), checks=value.checks.filter(item=>item.target.startsWith('revision:'));
  const evidence=new Set([...(draft.rejectedProposal?.proposal.evidence||draft.evidence),...input.earlierDraft.evidence].map(item=>item.id));
  const docs=new Set((draft.documentation?.excerpts||[]).map(item=>item.id));
  if(checks.length!==targets.length || new Set(checks.map(item=>item.target)).size!==targets.length || checks.some(item=>
    !targets.includes(item.target) || !item.reason.trim() || !(item.evidence.length+item.documentation.length) ||
    item.evidence.some(id=>!evidence.has(id)) || item.documentation.some(id=>!docs.has(id))))
    throw new Error('Every material original-to-candidate revision needs its own fresh, source-linked check, including removals.');
  return checks;
}
const instruction = `PRIVATE CANDIDATE LIFECYCLE. earlierDraft is the exact UNCHECKED candidate, not an accepted review. candidateRevisions spans the immutable original reference to this candidate; its before fields are exact old content, afterHash identifies content in earlierDraft. When referenceOrigin.kind=received-rejected, the original was NEVER accepted; it supplies material scope and revision lineage, not evidence of correctness or approvals. rejected-proposal-repair must resolve the typed candidateProblems and all material local questions/dependencies across the entire original claim scope, retaining genuine blockers. Review scope never disappears when a note is removed. No diagnostic or candidate checks confer approval.
For a checkOnly request: overall kept means the CANDIDATE remains EXACTLY unchanged. Fresh explanationReviews classify each note relative to the ORIGINAL reference (accepted base, or explicitly unaccepted received proposal): unchanged=kept, changed=repaired, new=added, absent=removed. Review every current note AND every old changed/removed note in candidateRevisions, with their original and current sources. Check the reasons and dependent reference changes, all original claim groups, every current causal target and all premises. No approvals are inherited. If any edit is needed return repair with concrete affected IDs; do not rewrite the candidate. An indispensable missing fact stays a finite blocker, not a forced verdict.
In that same checks array, additionally check EVERY exact target in candidateRevisionTargets. Explain why its exact original-to-candidate change/removal is justified (or reject it), using old/current evidence IDs or supplied documentation. These checks do not replace any current causal target or explanation review. Revision targets are separate from runtime events and never become tutorial steps.
For candidateOnly: normal instructions demanding fresh inputReviews, explanationReviews and causal checks do NOT apply to this authoring request. Complete the WHOLE explanation across all material claim groups, rule basis, conditions, consequences and counterevidence, or retain exact indispensable blockers. Return only candidate-patch-v1 updates; it supplies no attestations. Keep unaffected content and stable IDs. A candidate-repair request may change only the stated problems and their necessary dependencies. Do not invent facts or remove material scope to fit. The complete candidate will receive a separate fresh check.`;
module.exports = { VERSION, purposes, unchecked, wire, identity, revision, revisionTargets, checkRevisions, hash, assertCurrent, save, needsCompletion, purpose, packet, instruction };
