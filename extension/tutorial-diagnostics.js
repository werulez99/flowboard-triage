'use strict';
// Pure representation/capability inspection. This never supplies semantic
// attestations, mutates a candidate, acquires code, or advances a lifecycle.
const crypto=require('node:crypto'),bindings=require('./call-bindings'),capacity=require('./review-capacity');
const {lexicalCode}=require('./solidity-text');
const VERSION='tutorial-diagnostics-v1';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actions={structural:'Correct these exact explanation fields and their dependent checks in a private revision; do not retry an unchanged verification.',
  capability:'Inspect the linked supplied code. This operation is outside the supported local analysis; more copies of that code will not resolve it.',
  'material-evidence':'Establish the named scenario or specification premise, or retain an explicit incomplete disposition. Do not infer it from source availability.',
  'local-reading':'Supply the exact missing current source view, then recheck locally without a model request.',
  operational:'Resolve the local recovery/storage problem while preserving received work and consumed requests.'};
const groups={structural:'Explanation correction',capability:'Unsupported analysis','material-evidence':'Missing specification or premise','local-reading':'Local source needed',operational:'Operational issue'};
function detail(draft,reason,kind='structural',target=null,meta={}) {
  const events=draft.causal?.events||[],links=draft.causal?.relationships||[];
  const link=links.find(l=>capacity.target('relationship',l)===target);
  const event=events.find(e=>capacity.target('event',e)===target||e.id===target)||(link&&events.find(e=>e.id===link.from));
  const obligation=(draft.causal?.obligations||[]).find(o=>capacity.target('obligation',o)===target||o.id===target);
  const note=(draft.evidence||[]).find(n=>n.id===(event?.evidenceId||meta.missingEvidence?.[0]||obligation?.evidence?.[0])),source=meta.source||event?.anchor?.source||note?.source;
  const sourceUnit=source&&(draft.sources||[]).filter(u=>u.source.file===source.file&&u.source.sourceHash===source.sourceHash&&u.source.line<=source.line&&u.source.endLine>=source.endLine).sort((a,b)=>(a.source.endLine-a.source.line)-(b.source.endLine-b.source.line))[0];
  const code=meta.code||({structural:'REPRESENTATION_INVALID',capability:'ANALYSIS_UNSUPPORTED','material-evidence':'MATERIAL_PREMISE_OPEN','local-reading':'SOURCE_VIEW_REQUIRED'}[kind]||'LOCAL_OPERATION_FAILED');
  return {kind,code,target,reason,action:actions[kind],group:groups[kind],...meta,
    ...(source?{source,sourceId:meta.sourceId||sourceUnit?.id||note?.sourceId,file:source.file,line:source.line,endLine:source.endLine}:{}),
    id:hash([code,target,source,reason]).slice(0,20)};
}
function inspect(draft) {
  const model=draft.causal,details=[];
  const fail=(reason,kind='structural',target=null,meta={})=>details.push(detail(draft,reason,kind,target,meta));
  const identity=hash({version:VERSION,model,sources:draft.sources,evidence:draft.evidence,claims:draft.claims,
    premises:draft.semanticInput,corrections:draft.corrections,sourceSnapshot:draft.snapshot,bindingPlan:draft.bindingPlan});
  if(!model)return {version:VERSION,identity,details,admissible:true};
  const resolved=require('./event-source').resolver(draft),{units,evidence}=resolved;
  // Source-valid references, NOT fresh explanation approvals. The final gate
  // independently requires all original/current/revision attestations.
  const refs=ids=>Array.isArray(ids)&&ids.length>0&&ids.every(id=>{
    const n=evidence.get(id),u=units.get(n?.sourceId);return !!u&&require('./event-source').covers(n,u,n.source);
  });
  const events=model.events||[],links=model.relationships||[],frames=new Map(),transactions=new Map(),participants=new Map();
  for(const event of events){
    const target=capacity.target('event',event),unit=resolved.event(event);
    if(event.callSiteId){const site=bindings.exactSite(unit,event.callSiteId),anchor=(event.anchor||evidence.get(event.evidenceId))?.source;
      if(event.anchor&&(!draft.bindingPlan||event.anchor.sourceId!==unit?.id||event.anchor.source.sourceHash!==unit?.source.sourceHash))fail(`${event.title}: the derived visual anchor has no current binding identity.`,'structural',target,{code:'CALL_ANCHOR_IDENTITY'});
      if(!site||anchor?.line!==site.span.line||anchor?.endLine!==site.span.endLine)fail(`${event.title}: the highlighted call occurrence does not match this event's exact checked lines.`,'structural',target,{code:'CALL_ANCHOR_RANGE'});
    }
    if(transactions.has(event.invocationId)&&transactions.get(event.invocationId)!==event.transaction)fail(`${event.title}: one invocation cannot belong to different transactions.`,'structural',target,{code:'INVOCATION_TRANSACTION'});
    transactions.set(event.invocationId,event.transaction);
    if(unit&&!unit.contextKind&&/^\s*(?:function|constructor|receive|fallback)\b/.test(lexicalCode(unit.code))){
      const frame=frames.get(event.invocationId);
      if(frame&&frame.id!==unit.id)fail(`${event.title}: invocation ${event.invocationId} was anchored to ${frame.name}, but this step points to ${unit.name}. Anchor a return/outcome to the correct function, or use the actual helper invocation with an explained context relationship.`,'structural',target,{code:'INVOCATION_FRAME'});
      else frames.set(event.invocationId,unit);
      const current={caller:String(event.caller||'').trim(),receiver:String(event.receiver||'').trim()},previous=participants.get(event.invocationId);
      if(previous&&['caller','receiver'].some(k=>previous[k]!==current[k]))fail(`${event.title}: invocation ${event.invocationId} changes its caller or receiver. Reuse the same frame labels; explain return or transfer recipients in the relationship, not as a different execution receiver.`,'structural',target,{code:'INVOCATION_PARTICIPANTS'});
      else participants.set(event.invocationId,current);
    }
    if(unit?.contextKind&&event.effect!=='read')fail(`${event.title}: a declaration is context, not evidence of an executed operation or committed change. Anchor the operation in its function and keep the declaration as a read step.`,'structural',target,{code:'CONTEXT_NOT_EXECUTION'});
    if(unit&&!unit.contextKind&&event.effect==='committed'){
      const note=event.anchor||evidence.get(event.evidenceId),lines=unit.code.split('\n'),start=lines.slice(0,note?.source.line-unit.source.line).join('\n').length+(note?.source.line>unit.source.line?1:0);
      const path=bindings.sourcePath(unit,start+Math.max(0,lexicalCode(unit.code.slice(start)).search(/\S/)),new Map(),units);
      if(path.commitment==='reverts')fail(`${event.title}: the body operation can be reached, but the modifier postlude reverts; it cannot commit.`,'structural',target,{code:'MODIFIER_COMMITMENT',source:path.modifier.source});
      else if(path.modifier&&path.commitment==='unknown')fail(`${event.title}: modifier postlude completion is unresolved; reaching the body does not establish commitment.`,'capability',target,{code:'MODIFIER_POSTLUDE_UNKNOWN',source:path.modifier.source});
    }
    for(const change of event.changes||[]){const problem=require('./checked-calculation').problem(change);if(problem)fail(`${event.title}: ${problem}`,'structural',target,{code:'VALUE_CALCULATION'});}
  }
  const ids=new Set(events.map(e=>e.id));
  for(const link of links){
    const target=capacity.target('relationship',link),from=events.find(e=>e.id===link.from),to=events.find(e=>e.id===link.to);
    if(!from||!to){fail('An explanation handoff points outside this scenario.','structural',target,{code:'HANDOFF_TARGET'});continue;}
    if(['call','callback','return','branch'].includes(link.kind)&&from.transaction!==to.transaction)fail('A call or return was incorrectly joined across transactions.','structural',target,{code:'CROSS_TRANSACTION_CALL'});
    if(['call','callback','return'].includes(link.kind)){
      if(!link.binding?.trim())fail(`${from.title}: the ${link.kind} handoff has no checked value binding or reason it needs none.`,'structural',target,{code:'HANDOFF_BINDING'});
      bindings.validateTransition({draft,link,from,to,source:resolved.event(from),destination:resolved.event(to),units,evidence,refs,events,links,
        fail:(reason,kind='structural',meta={})=>fail(reason,kind,target,meta)});
    }
  }
  bindings.validateInvocations({events,links,units,evidence,fail,resolved});
  if(!events.length||!Array.isArray(model.order)||model.order.length!==events.length||new Set(model.order).size!==events.length||model.order.some(id=>!ids.has(id)))fail('The tutorial has no complete, unique reading order.','structural','causal/order',{code:'READING_ORDER'});
  for(let i=1;i<(model.order||[]).length;i++)if(!links.some(l=>l.from===model.order[i-1]&&l.to===model.order[i]))fail('A move to the next step has no explained handoff or context detour.','structural',`causal/order/${i}`,{code:'MISSING_HANDOFF'});
  return {version:VERSION,identity,details:[...new Map(details.map(d=>[d.id,d])).values()],admissible:!details.some(d=>d.kind==='structural')};
}
function assertVerification(draft){const result=inspect(draft);if(!result.admissible)throw Object.assign(new Error('The saved explanation has deterministic representation defects. Correct the listed fields before paid verification; the exact candidate is preserved.'),{
  code:'TUTORIAL_REPRESENTATION',diagnostics:result,validationProblems:result.details.map(d=>({...d,message:d.reason}))});return result;}
function subject(reference,units,draft={}){
  const value=require('./review-content').fromWire(reference,units);
  return {...draft,...value,sources:units,evidence:value.evidence.map(e=>({...e,note:e.explanation??e.note,
    source:e.source||{...units.find(u=>u.id===e.sourceId).source,line:e.line,endLine:e.endLine}}))};
}
const instruction='tutorialDiagnostics are deterministic host observations bound to the supplied explanation/source/premises, not semantic approvals. Correct all structural representation defects together, retaining material scope. Distinguish unsupported analysis from missing source and unresolved specification/scenario premises. Do not invent facts to silence a diagnostic. Fresh verification still covers every required target; an honest incomplete disposition is allowed but cannot publish a tutorial.';
function packetSubject(input,units,draft){const data=require('./packet-context').expand(input),views=new Map(data.sources.map(s=>[s.id,s]));
  const current=units.filter(u=>views.has(u.id)).map(u=>({...u,modelRanges:require('./source-coverage').ranges(views.get(u.id))}));
  return subject(data.earlierDraft,current,draft);
}
module.exports={VERSION,inspect,assertVerification,detail,groups,subject,packetSubject,instruction};
