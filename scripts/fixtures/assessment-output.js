'use strict';
// Fictional DeadlineWindow contract mechanics, never real-analysis replay.
const capacity=require('../../extension/review-capacity');
function response(input,{blocked=false,refuted=false,scenarios=false,shared=false,inspection=false}={}){
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
 if(inspection){
  const rows=unit.code.split('\n').map(row=>({line:Number(row.slice(0,row.indexOf(' | '))),text:row.slice(row.indexOf(' | ')+3)})),comment=rows.find(r=>r.text.includes('Checked citation:'));
  const note={id:'comment-rule',claimId:'c1',sourceId:unit.id,line:comment.line,endLine:comment.line,quote:comment.text,stance:'supports',explanation:'This source comment states the fictional expected deadline. It is displayed verbatim as reviewed specification context, not as proof that the implementation satisfies it.'};
  value.evidence.unshift(note);value.claims[0].evidence=[note.id,...value.claims[0].evidence];
  const guard=value.evidence.find(e=>e.id==='entry-limit');guard.line=line-3;guard.quote=rows.filter(r=>r.line>=guard.line&&r.line<=line).map(r=>r.text).join('\n');
 }
 value.claims[0].severityFactors={consequence:'minor-deviation',party:'Clock consumer',asset:'Readiness value',scale:'Bounded clock interval',duration:'Until the expected deadline',repeatability:'Each separate configuration',caps:'Source input guards',permissions:'Public caller',economics:'No monetary consequence asserted',recovery:'A later configuration changes the threshold',conditions:[],unknowns:[],evidence:['write','read','rule'],reason:'The checked fictional effect is a bounded readiness deviation.'};
 if(scenarios){
  const id='separate',note={...value.evidence.at(-1),id:'separate-guard',claimId:id},why='A separate zero-start invocation reverts at its entry guard; it neither writes nor participates in the positive-start scenario.';
  value.evidence.push(note);value.claims.push({...structuredClone(value.claims[0]),id,allegation:'A zero-start call can change the deadline.',conditions:['startedAt is 0'],status:'contradicted',reason:why,evidence:[note.id],severityFactors:null});
  value.causal.obligations.push(...capacity.kinds.map(kind=>({id:kind+'-separate',claimId:id,kind,question:'Check the separate zero-start claim.',state:kind==='impact'?'refuted':'established',reason:why,evidence:[note.id],documentation:[]})));
  value.causal.events.push({...structuredClone(value.causal.events[0]),id:'separate-entry',invocationId:'separate-call',transaction:'separate-tx',claimId:id,evidenceId:note.id,title:'Independent zero-start scenario',conditions:['startedAt is 0'],what:why,why,changes:[],effect:'rolled-back'});
  value.causal.relationships.push({...structuredClone(value.causal.relationships[0]),from:'read',to:'separate-entry',kind:'context',explanation:'Independent scenario reading transition only; no execution or state flows between these invocations.',binding:'Separate root invocations and transactions.',evidence:[note.id]});
  value.causal.order.push('separate-entry');
  if(shared){const common={...structuredClone(value.evidence.find(e=>e.id==='rule')),id:'shared-rule',claimId:'',stance:'context'};value.evidence.push(common);
    for(const c of value.claims)c.evidence=[...c.evidence,common.id];
    for(const o of value.causal.obligations.filter(o=>o.kind==='conditions'))o.evidence=[...o.evidence,common.id];}
 }
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
