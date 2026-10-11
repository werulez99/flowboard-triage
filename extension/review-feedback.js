'use strict';
// Attributed review guidance, not an accepted explanation or a new check.
const hash = value => require('./review-candidate').hash(value);
const VERSION = 'candidate-feedback-v1';
function current(state) {
  const v=state?.verification;
  if(!v||v.result!=='repair')return null;
  if(v.candidateHash!==state.candidateHash||v.revisionHash!==hash(state.revisions)||!v.response||
    v.response.result!=='repair'||hash(v.problems)!==hash(v.response.problems))
    throw Object.assign(new Error('Verifier feedback does not identify this exact candidate and revision.'),{code:'CANDIDATE_STALE'});
  return {version:VERSION,requestId:v.requestId,candidateHash:v.candidateHash,revisionHash:v.revisionHash,
    responseHash:hash(v.response),response:structuredClone(v.response),
    ...(v.sourceReferences?.responseHash===hash(v.response)&&v.sourceReferences.requestId===v.requestId?
      {referenceDiagnostics:structuredClone(v.sourceReferences.references.filter(r=>r.status!=='supplied'))}:{})};
}
function entries(feedback) {
  if(!feedback||feedback.version!==VERSION)return [];
  if(hash(feedback.response)!==feedback.responseHash)throw new Error('Retained verifier feedback changed.');
  const v=feedback.response;
  return [
    ...(v.problems||[]).map((reason,i)=>({id:`problem:${i}`,target:'/reviewCandidate',reason,evidence:[],feedbackRole:'correction'})),
    ...(v.explanationReviews||[]).map((r,i)=>({id:`note:${i}`,target:`/evidence/${r.evidenceId}`,reason:r.reason,evidence:[r.evidenceId],checkedSourceIds:r.checkedSourceIds,result:r.result})),
    ...(v.inputReviews||[]).map((r,i)=>({id:`premise:${i}`,target:`/inputs/${r.id}`,reason:r.reason,evidence:r.evidence||[],status:r.status})),
    ...(v.checks||[]).map((r,i)=>({id:`check:${i}`,target:r.target,reason:r.reason,evidence:r.evidence||[]})),
    ...(v.reportReview?[{id:'report',target:'/reportCoverage',reason:JSON.stringify(v.reportReview),evidence:[]}]:[])
  ];
}
function diagnostics(draft) {
  const f=current(draft.reviewCandidate);if(!f)return [];
  const models=[draft.reviewCandidate.candidate,draft.reviewCandidate.referenceBase||draft.reviewCandidate.acceptedBase];
  const records=entries(f).map(item=>{
    const notes=item.evidence.flatMap(id=>models.flatMap(m=>(m?.evidence||[]).filter(e=>e.id===id)));
    const locations=notes.map(n=>{const unit=draft.sources.find(u=>u.id===n.sourceId);return unit&&{...unit.source,line:n.source?.line??n.line,endLine:n.source?.endLine??n.endLine};}).filter(Boolean);
    const unique=[...new Map(locations.map(s=>[JSON.stringify(s),s])).values()];
    // Never infer a location from review prose, or arbitrarily choose one of
    // several reviewed sources. Note-specific rows retain exact inspectability.
    const correction=item.feedbackRole==='correction';
    return {id:hash([f.requestId,f.responseHash,item.id]),code:correction?'CANDIDATE_VERIFICATION_REPAIR':'CANDIDATE_REVIEW_REASONING',target:item.target,
      feedbackId:item.id,feedbackRole:correction?'correction':'reasoning',result:item.result,status:item.status,message:item.reason,kind:'interpretation',group:correction?'Current corrections':'Review reasoning (not approval)',sources:unique,
      ...(unique.length===1?{source:unique[0]}:{}),
      ...(correction?{action:'Reconcile the affected argument in a private revision; fresh verification is required.'}:{})};
  });
  const refs=draft.reviewCandidate.verification.sourceReferences;
  if(refs?.requestId===f.requestId&&refs.responseHash===f.responseHash)for(const ref of refs.references.filter(r=>r.status!=='supplied'))records.push({
    id:hash([f.requestId,f.responseHash,'reference',ref.sourceId]),code:'FEEDBACK_SOURCE_REFERENCE',feedbackRole:'correction',
    target:'/reviewCandidate/verification',message:`${ref.sourceId}: ${ref.reason}`,kind:ref.status==='unbound'?'interpretation':'local-reading',
    group:ref.status==='unbound'?'Unbound feedback references':'Local source needed',sources:ref.source?[ref.source]:[],...(ref.source?{source:ref.source}:{}),
    action:ref.status==='unbound'?'Correct or explicitly resolve the unbound reference; it is not a canonical acquisition requirement.':'Supply this exact material source in the next review; the past response did not receive its complete extent.'});
  return records;
}
function responseSchema(feedback) {
  const ids=entries(feedback).map(e=>e.id);
  return {type:'array',maxItems:ids.length,items:{type:'object',additionalProperties:false,
    properties:{feedbackIds:{type:'array',minItems:1,maxItems:ids.length,items:{type:'string',enum:ids}},
      // Use the pinned wire subset, keeping the same nonblank host rule below.
      // Feedback dispositions remain authoring accountability, never checks.
      disposition:{enum:['changed','retained','unresolved']},reason:{type:'string',pattern:'\\S',maxLength:2400},
      targets:{type:'array',maxItems:80,items:{type:'string'}}},required:['feedbackIds','disposition','reason','targets']}};
}
function validate(value,input,edits,full) {
  const f=input.hostReview;if(f?.version!==VERSION)return null;
  const records=value.feedbackResponses,expected=new Set(entries(f).map(e=>e.id)),seen=new Set(),problems=[];
  if(!require('./challenge-format').valid(records,responseSchema(f)))throw new Error('Private repair must account for the complete attributed verifier feedback.');
  const known=new Set(require('./authoring-contract').catalog(input,full).targets.flatMap(t=>t.paths));
  for(const r of records){
    for(const id of r.feedbackIds){if(seen.has(id))problems.push(`Repeated feedback ${id}`);seen.add(id);}
    for(const target of r.targets)if(!known.has(target)&&!edits.some(e=>e.path===target))problems.push(`Unknown feedback target ${target}`);
    if(r.disposition==='changed'&&(!r.targets.length||r.targets.some(t=>!edits.some(e=>e.path===t||e.path.startsWith(t+'/')||t.startsWith(e.path+'/')))))problems.push('Changed feedback must identify actual edits.');
    if(!r.reason.trim())problems.push('Feedback disposition needs a concrete reason.');
  }
  for(const id of expected)if(!seen.has(id))problems.push(`Unaddressed feedback ${id}`);
  if(problems.length)throw new Error(problems.join('; '));
  return {feedbackHash:f.responseHash,requestId:f.requestId,responses:structuredClone(records)};
}
module.exports={VERSION,current,entries,diagnostics,responseSchema,validate};
