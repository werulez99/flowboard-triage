'use strict';
// Identity constraints are shared by every response form. This manifest is
// mechanical context, not evidence or approval of the model's interpretation.
function manifest(previous) {
  return { evidence: (previous.evidence || []).map(({ id, claimId }) => ({ id, claimId })),
    claims: (previous.claims || []).map(({ id }) => id) };
}
function dependents(value, id) {
  const result = [];
  const visit = (item, at) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach((entry, index) => visit(entry, `${at}/${entry?.id || index}`)); return; }
    for (const [key, child] of Object.entries(item)) {
      const location = `${at}/${key}`;
      if (child === id && ['evidenceId', 'supportingEvidence', 'opposingEvidence'].includes(key) ||
          key === 'evidence' && Array.isArray(child) && child.includes(id)) result.push(location);
      if (Array.isArray(child)) child.forEach((entry, index) => visit(entry, `${location}/${entry?.id || index}`));
      else if (child && typeof child === 'object') visit(child, location);
    }
  };
  for (const key of ['property', 'claims', 'causal', 'walkthrough', 'inputReviews', 'transitions', 'questions'])
    visit(value[key], '/' + key);
  return [...new Set(result)].sort();
}
function problems(previous, next) {
  const old = new Map((previous.evidence || []).map(item => [item.id, item]));
  return (next.evidence || []).flatMap(item => {
    const prior = old.get(item.id);
    if (!prior || prior.claimId === item.claimId) return [];
    return [{ code: 'EVIDENCE_SCOPE_CHANGED', evidenceId: item.id, oldClaimId: prior.claimId, proposedClaimId: item.claimId,
      dependentTargets: { previous: dependents(previous, item.id), proposed: dependents(next, item.id) },
      permittedOperation: 'Keep the original scope, or explicitly remove this note and add a fresh ID in the new scope. Review both IDs and all affected references; retain the old note if still justified. Do not drop its material claim.',
      message: `Evidence ${item.id} cannot change claim ${JSON.stringify(prior.claimId)} to ${JSON.stringify(item.claimId)}. Remove it and add a separately scoped note with a fresh ID; freshly review both scopes and dependent targets.` }];
  });
}
function failure(items) {
  return Object.assign(new Error(items.map(item => item.message).join('\n')), { code: items[0].code,
    validationProblems: items, reviewProblems: items.map(item => item.message) });
}
function assert(previous, next) { const items = problems(previous, next); if (items.length) throw failure(items); }
const instruction = `evidenceScopes is a host-derived immutable identity manifest from earlierDraft. Every existing evidence.id -> claimId binding is FIXED, including claimId="" (shared context). This applies to field edits, whole-item replacement and whole-array replacement. One source supporting two claims needs separate notes with distinct IDs. To correct a wrongly scoped old note, explicitly remove it and add a NEW ID; explain what removal changes for the old material claim and update every dependent reference. Retain the old note if it remains justified. Never rename or drop a material claim to avoid coverage. Supply fresh removed/added/repaired/kept reviews for all old and new notes, and fresh source-grounded checks for every retained causal target. Kept cannot mask any change of meaning, source or scope.`;
module.exports = { manifest, problems, failure, assert, instruction };
