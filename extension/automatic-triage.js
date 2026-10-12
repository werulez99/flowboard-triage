'use strict';
// Process-local completion over a canonically revalidated investigation. The
// journal's projections are useful reading data, never authority to finish a
// new review. Reopen rebuilds these seals at the existing reconciliation gate.
const technical=require('./technical-assessment');
const seals=new WeakMap(),results=new Set(['supported','refuted','insufficient-evidence']);
function current(draft,evaluated){
  const projection=evaluated?.assessment;
  if(!draft||!projection||!results.has(projection.technical?.result)||!projection.technical.identity||projection.artifact?.retained||
      draft.reviewCandidate||draft.rejectedProposal||draft.pendingResponse||draft.recoveryRequired||
      technical.pendingObservations(draft).length||draft.claims?.some(c=>c.needsReassessment))return false;
  const legacy=!draft.technicalReview&&evaluated.checked&&projection.technical.legacy;
  if(!legacy&&!technical.current(draft))return false;
  // A still-owed review of this revision is material work even when a safe
  // unaffected statement or accepted predecessor remains available to read.
  if(!evaluated.checked&&draft.checkpoint?.stage!=='complete')return false;
  const operation=require('./next-review-operation').decide(draft,evaluated.publication);
  return !['verify','reassess'].includes(operation.kind);
}
function bind(job,draft,evaluated){
  if(!current(draft,evaluated)){clear(job);return false;}
  seals.set(job,{findingId:draft.findingId,findingHash:job.findingHash,sourceSnapshot:draft.snapshot,
    identity:evaluated.assessment.technical.identity,result:evaluated.assessment.technical.result,revision:draft.revision});
  return true;
}
function complete(job){
  const seal=seals.get(job);
  return !!seal&&seal.findingId===job.id&&seal.findingHash===job.findingHash&&!job.correctionHold&&!job.dirtyPaused&&
    !job.hasPrivateCandidate&&!['running','waiting-for-provider-capacity'].includes(job.state);
}
function clear(job){seals.delete(job);}
function record(job){return complete(job)?seals.get(job):null;}
module.exports={current,bind,complete,clear,record};
