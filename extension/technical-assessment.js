'use strict';
// One read model over the existing argument. No alternate verdict store,
// generated narrative, request, source acquisition, or human-decision mutation.
const crypto=require('node:crypto'),content=require('./review-content');
const VERSION='technical-review-v1';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const presentationCodes=new Set(['READING_ORDER']);
const presentation=detail=>presentationCodes.has(detail.code);
function identity(draft){return hash([VERSION,draft.snapshot,draft.semanticInput,draft.corrections,draft.sources,
  content.project(draft),draft.inputReviews,draft.explanationReviews,draft.causal?.checks,draft.bindingPlan,draft.candidateVerification]);}
function seal(draft,review){draft.technicalReview={...review,version:VERSION,identity:identity(draft)};}
function current(draft){return draft.technicalReview?.version===VERSION&&draft.technicalReview.identity===identity(draft)&&
  (draft.runs||[]).some(r=>r.requestId===draft.technicalReview.requestId&&r.phase==='challenge'&&r.outcome==='completed'&&r.resultAccepted);}
function aggregate(draft,withheld=new Set()){
  const obligations=draft.causal?.obligations||[],evidence=draft.evidence||[];
  const basis=['source-contract','test-expectation','local-documentation','derived-security-invariant'].includes(draft.property?.basis)&&
    !!(draft.property?.evidence?.length||draft.property?.documentation?.length);
  const material=(draft.claims||[]).filter(c=>c.kind!=='context');
  const claims=material.map(c=>{
    const own=obligations.filter(o=>o.claimId===c.id),unknown=withheld.has(c.id)||c.needsReassessment||c.unknowns?.length||own.some(o=>o.state==='open');
    const linked=e=>e.claimId===c.id&&(!Array.isArray(c.evidence)||c.evidence.includes(e.id));
    const supports=evidence.some(e=>linked(e)&&e.stance==='supports');
    const contradicts=evidence.some(e=>linked(e)&&e.stance==='contradicts');
    const established=kind=>own.some(o=>o.kind===kind&&o.state==='established');
    const defeatedPrerequisite=own.some(o=>['applicability','entry','conditions','settlement'].includes(o.kind)&&o.state==='refuted');
    const defect=!unknown&&!defeatedPrerequisite&&c.kind!=='impact-qualification'&&['supported','narrowed'].includes(c.status)&&basis&&supports&&['rule','behavior','impact'].every(established);
    const refuted=!unknown&&contradicts&&(c.status==='contradicted'||c.status==='narrowed'&&own.some(o=>o.kind==='impact'&&o.state==='refuted'));
    return{id:c.id,result:defect?'supported':refuted?'refuted':'insufficient-evidence',reason:c.reason,evidence:c.evidence||[],unknowns:c.unknowns||[]};
  });
  const supported=claims.filter(c=>c.result==='supported'),unknown=claims.filter(c=>c.result==='insufficient-evidence');
  const result=supported.length?'supported':claims.length&&!unknown.length?'refuted':'insufficient-evidence';
  const complete=claims.length>0&&!unknown.length&&!(draft.conclusion?.limitations?.length);
  return{result,coverage:complete?'complete':'partial',claims,supported:supported.map(c=>c.id),unresolved:unknown.map(c=>c.id),
    label:result==='supported'?(complete?'Defect established in the assessed scope':'Defect established · additional alleged scope unresolved'):
      result==='refuted'?'Refuted in the assessed scope':'Insufficient evidence for the complete allegation'};
}
function consistency(draft){
  const a=aggregate(draft),outcome=draft.causal?.outcome,assessment=draft.walkthrough?.assessment?.result,problems=[];
  if(a.result==='supported'&&(outcome==='refuted'||assessment==='invalid'))problems.push({code:'ASSESSMENT_AGGREGATION',target:'causal/outcome',kind:'structural',
    reason:'A source-backed supported defect cannot have an aggregate refuted/invalid assessment. Preserve the surviving defect and qualify any unresolved or refuted scope.',claimIds:a.supported});
  if(outcome==='refuted'&&a.result==='insufficient-evidence')problems.push({code:'REFUTATION_SCOPE',target:'causal/outcome',kind:'structural',
    reason:'Refutation requires decisive counterevidence for every material allegation in scope. Missing support, an unresolved premise or a resource failure is not refutation.',claimIds:a.unresolved});
  if(outcome==='supported'&&a.result!=='supported')problems.push({code:'SUPPORT_SCOPE',target:'causal/outcome',kind:'structural',
    reason:'An aggregate supported defect needs an established property, violation and consequence in the same claim without a refuted necessary prerequisite. A narrowed label or true context alone is insufficient.',claimIds:a.unresolved});
  return problems;
}
function execution(draft){const last=draft.runs?.at(-1);if(['generating','challenging'].includes(draft.phase))return{state:'running',substantive:false};return !last?{state:'not-started',substantive:false}:
  {state:last.outcome==='completed'?'completed':last.outcome==='cancelled'?'interrupted':'failed',
    transportCompleted:last.outcome==='completed',substantive:!!(last.resultAccepted&&last.phase==='challenge'),requestId:last.requestId};}
function project(draft,publication){
  const base={version:VERSION,execution:execution(draft),technical:{result:'not-assessed',coverage:'not-assessed',label:'Not assessed',why:'No current completed substantive assessment is available.',remaining:[]},
    tutorial:{state:publication.ready?'ready':draft.phase==='corrected'?'stale':['preparing','generating','challenging','candidate-awaiting-verification'].includes(draft.phase)?'preparing':'blocked',problems:publication.problems||[]}};
  if(draft.reviewCandidate||draft.rejectedProposal||draft.pendingResponse||content.mismatch(draft))return base;
  const fresh=current(draft),legacyReady=!draft.technicalReview&&draft.phase==='ready'&&publication.ready&&draft.publication?.digest===require('./guide-policy').digest(draft);
  if(!fresh&&!legacyReady){if(base.execution.substantive)base.technical.why='The completed historical review did not authorize the independent technical-assessment contract. Its original result and blockers remain available.';return base;}
  const details=publication.details||[],hard=details.filter(d=>d.kind==='structural'&&!presentation(d));
  if(hard.length){base.technical.why='The completed review needs recheck: '+hard.map(d=>d.reason).join(' ');return base;}
  const withheld=new Set();
  for(const detail of details.filter(d=>['capability','local-reading','material-evidence'].includes(d.kind))){
    if(presentation(detail))continue;
    if(detail.claimIds?.length){for(const id of detail.claimIds)withheld.add(id);continue;}
    const event=draft.causal?.events.find(e=>'event:'+e.id===detail.target),link=draft.causal?.relationships.find(l=>`relationship:${l.from}->${l.to}:${l.kind}`===detail.target);
    const obligation=draft.causal?.obligations.find(o=>o.id===detail.target||'obligation:'+o.id===detail.target);
    if(event)withheld.add(event.claimId);else if(link)for(const e of draft.causal.events.filter(e=>[link.from,link.to].includes(e.id)))withheld.add(e.claimId);
    else if(obligation)withheld.add(obligation.claimId);
    else if(draft.claims.some(c=>c.id===detail.target))withheld.add(detail.target);
    else if(detail.code==='PREMISE_UNRESOLVED')for(const c of draft.claims)withheld.add(c.id);
    else if(detail.target?.startsWith('conclusion/limitations/')){
      const dependent=draft.claims.filter(c=>c.unknowns?.includes(detail.reason));
      for(const c of dependent.length?dependent:draft.claims)withheld.add(c.id);
    }
    else if(detail.kind!=='material-evidence')for(const c of draft.claims)withheld.add(c.id);
  }
  const a=aggregate(draft,withheld),decisive=a.claims.filter(c=>a.result==='supported'?c.result==='supported':a.result==='refuted'?c.result==='refuted':true);
  base.technical={...a,why:decisive.map(c=>c.reason).filter(Boolean).join(' '),remaining:[...new Set([
    ...a.claims.flatMap(c=>c.unknowns),...(draft.conclusion?.limitations||[]),...details.filter(d=>!presentation(d)&&d.kind!=='structural').map(d=>d.reason)])],
    evidence:decisive.flatMap(c=>c.evidence).filter((id,i,ids)=>ids.indexOf(id)===i).map(id=>draft.evidence.find(e=>e.id===id)).filter(Boolean).map(e=>({id:e.id,stance:e.stance,note:e.note,source:e.source,sourceId:e.sourceId})),
    identity:fresh?draft.technicalReview.identity:publication.digest,legacy:!fresh};
  return base;
}
const instruction=`TECHNICAL REVIEW CONTRACT technical-review-v1. Review the SAME complete immutable argument, every original/current/removed explanation, premise, causal and revision target. A missing pedagogical reading order alone does not erase a reviewable technical argument: inspect its actual events/relationships and return kept only if its exact scoped argument may stand unchanged, preserving a blocked tutorial. Do not inherit any approval from preflight. Dispatch, state, branches, settlement and material premises are not presentation defects. Establish a surviving defect only when its property, behavior, conditions and consequence hold together; preserve unresolved independent alleged scope beside it. Refute only the bounded material allegations actually defeated by evidence, not the whole codebase. True contextual facts are not surviving defects. Reconstruct the decisive argument and examine the strongest credible counterinterpretation, including failure, recovery and final settlement. Agreement is not independent ground truth. Missing PoC/specification, low impact, actor permissions, an analyzer limit, timeout or engagement exclusion are not automatic refutations.`;
module.exports={VERSION,presentation,identity,seal,current,aggregate,consistency,execution,project,instruction};
