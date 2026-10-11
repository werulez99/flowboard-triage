'use strict';
// One local decision over the existing lifecycle; never an approval or budget.
const candidates=require('./review-candidate');
const coverageCodes=new Set(['OBLIGATION_CHECK_COVERAGE','EVENT_CHECK_COVERAGE','RELATIONSHIP_CHECK_COVERAGE','REVIEW_REQUIREMENTS']);
function decide(draft,gate){
  if(!draft)return{kind:'generate',phases:2,reason:'Initial source-grounded authoring and full challenge are required.'};
  if(draft.pendingResponse)return{kind:'recover',phases:0,reason:'Recover the exact owned response locally before any new request.'};
  if(draft.reviewCandidate)return{kind:draft.reviewCandidate.state==='terminal'?'revision':'candidate',phases:['awaiting-verification'].includes(draft.reviewCandidate.state)?1:2,reason:'Follow the retained private candidate lifecycle.'};
  if(draft.phase==='corrected'||draft.claims?.some(c=>c.needsReassessment))return{kind:'reassess',phases:2,reason:'Material inputs changed; existing reassessment and revision obligations apply.'};
  if(require('./technical-assessment').pendingObservations(draft).length)return{kind:'continue',phase:'challenge',phases:1,reason:'Interpret the new associated observation through the ordinary challenge; no generation is needed.'};
  const retained=draft.reviewOperation;
  if(retained?.kind==='verify'){
    if(retained.context!==candidates.identity(draft)||retained.material!==candidates.hash(require('./review-content').project(draft)))return{kind:'reassess',phases:2,reason:'Retained verification input changed; previous operation identity cannot authorize reuse.'};
    return retained;
  }
  if(draft.checkpoint?.stage!=='complete')return{kind:'continue',phases:1,reason:'Continue the existing checkpoint.'};
  if(!draft.technicalReview&&!draft.candidateVerification&&!draft.runs?.some(r=>r.phase==='challenge'&&r.resultAccepted))
    return{kind:'continue',phase:'challenge',phases:1,reason:'The old complete acquisition checkpoint is not a completed substantive review. Continue its bounded source/question challenge.'};
  const details=gate?.details||draft.publication?.details||[];
  const missing=details.filter(d=>coverageCodes.has(d.code));
  const material=candidates.hash(require('./review-content').project(draft));
  const reviewId=draft.technicalReview?.requestId||draft.runs?.findLast(r=>r.phase==='challenge')?.requestId;
  const identity=candidates.hash([candidates.identity(draft),material,reviewId]);
  if(missing.length)return{kind:'verify',phases:1,identity,reviewId,material,deficiencies:missing,
    reason:'Review response received; required checking is incomplete. Revalidate the unchanged argument locally, then obtain complete fresh verification. No generation is needed.'};
  if(details.some(d=>d.kind==='capability'||d.kind==='local-reading'))return{kind:'revalidate',phases:0,identity,reason:'Revalidate the retained argument locally after the named source/capability changes. Do not regenerate it.'};
  return{kind:'evidence',phases:0,identity,reason:gate?.ready?'The current tutorial is already available.':'The completed review needs the named material evidence or an explicit substantive revision; unchanged generation cannot resolve it.'};
}
module.exports={decide,coverageCodes};
