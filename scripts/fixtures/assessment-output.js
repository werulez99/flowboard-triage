'use strict';
// Fictional DeadlineWindow contract mechanics, never real-analysis replay.
const capacity=require('../../extension/review-capacity');
function response(input,{blocked=false,refuted=false}={}){
 const base=require('./teaching-output').response(input,'time');
 if(input.checkOnly){const value=input.earlierDraft,notes=value.evidence,changes=input.candidateRevisions?.changes||[];
  return{result:'kept',problems:[],inputReviews:(input.semanticInput?.premises||[]).map(p=>({id:p.id,status:'applied',reason:'The explicit fictional scenario restriction is applied to the exact guard.',claimIds:['c1'],eventIds:value.causal.events.map(e=>e.id),evidence:notes.map(e=>e.id)})),
   explanationReviews:notes.map(e=>({evidenceId:e.id,result:changes.some(c=>c.path==='/evidence/'+e.id)?'repaired':'kept',reason:e.explanation,checkedSourceIds:[e.sourceId]})),
   checks:[...capacity.targets(value.causal).map(t=>t.key),...(input.candidateRevisionTargets||[])].map(target=>({target,reason:'Deterministic fixture review of the exact source guard, scope, preserved explanations and revision.',evidence:notes.map(n=>n.id),documentation:[]}))};}
 const value=base.claims?structuredClone(base):require('./teaching-output').response({...input,phase:'generate',candidateOnly:false,repairOnly:false},'time');
 const unit=input.sources.find(s=>s.name==='DeadlineWindow::schedule'),row=unit.code.split('\n').find(s=>s.includes('require(startedAt > 0'));
 const at=row.indexOf(' | '),line=Number(row.slice(0,at));
 value.evidence.push({id:'entry-limit',claimId:'c1',sourceId:unit.id,line,endLine:line,quote:row.slice(at+3),stance:'contradicts',explanation:'The starting clock is bounded and must be positive. The reported behavior cannot be generalized to zero-start invocations, which revert at this guard.'});
 value.claims[0].evidence.push('entry-limit');value.claims[0].kind='defect';
 value.claims[0].severityFactors={consequence:'minor-deviation',party:'Clock consumer',asset:'Readiness value',scale:'Bounded clock interval',duration:'Until the expected deadline',repeatability:'Each separate configuration',caps:'Source input guards',permissions:'Public caller',economics:'No monetary consequence asserted',recovery:'A later configuration changes the threshold',conditions:[],unknowns:[],evidence:['write','read','rule'],reason:'The checked fictional effect is a bounded readiness deviation.'};
 if(blocked)value.causal.order=[];
 if(refuted){
  const why='Under the researcher-selected startedAt = 0 premise, the first require reverts before the deadline write; no later readiness effect follows from that invocation.';
  Object.assign(value.claims[0],{conditions:['startedAt is 0'],status:'contradicted',reason:why,severityFactors:null});
  value.causal.outcome='refuted';value.causal.summary=why;
  value.causal.events=[{...value.causal.events[0],id:'zero-guard',evidenceId:'entry-limit',title:'Zero start is rejected',conditions:['startedAt is 0'],what:why,why,changes:[],effect:'rolled-back'}];
  value.causal.relationships=[];value.causal.order=['zero-guard'];
  for(const o of value.causal.obligations)Object.assign(o,{reason:why,evidence:['entry-limit'],state:o.kind==='impact'?'refuted':'established'});
  value.walkthrough.assessment={result:'invalid',why,supportingEvidence:'',opposingEvidence:'entry-limit'};
  value.conclusion={status:'contradicted-in-scope',text:why,limitations:[]};
 }
 return require('./authoring-output').encode(value,input);
}
module.exports={response};
