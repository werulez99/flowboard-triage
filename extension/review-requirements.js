'use strict';
// A non-attesting inventory, derived from the exact argument. The checker
// supplies its own reasons and may disagree. Never repair a received check.
const capacity=require('./review-capacity');
const unique=values=>[...new Set(values||[])];
const VERSION='review-requirements-v2';
function targets(argument) {
  const model=argument.causal||{};
  return [
    ...(model.obligations||[]).map(o=>({target:capacity.target('obligation',o),evidence:unique([...(o.evidence||[]),...(o.kind==='conditions'?(model.events||[]).filter(e=>e.claimId===o.claimId).flatMap(e=>(e.statePredicates||[]).flatMap(f=>f.evidence)):[])]),documentation:unique(o.documentation)})),
    ...(model.events||[]).map(e=>({target:capacity.target('event',e),evidence:unique([e.evidenceId,...(e.statePredicates||[]).flatMap(f=>f.evidence)]),documentation:[]})),
    ...(model.relationships||[]).map(r=>({target:capacity.target('relationship',r),evidence:unique(r.evidence),documentation:[]}))
  ];
}
function noteShape(n){return {claimId:n.claimId,sourceId:n.sourceId,line:n.line??n.source?.line,endLine:n.endLine??n.source?.endLine,
  quote:n.quote,explanation:n.explanation??n.note,stance:n.stance};}
function derive(input) {
  const current=input.earlierDraft;if(!input.checkOnly||!current)return null;
  // Historical partial/full-response drafts predate causal review targets.
  // Their existing decoder remains usable; the final gate still withholds
  // incomplete content. Do not retrofit an exact-check contract onto them.
  if(!current.causal)return null;
  const version=input.reviewRequirements?.version||VERSION;
  if(!['review-requirements-v1',VERSION].includes(version))throw Error('Unknown saved review requirements contract.');
  const old=new Map((current.evidence||[]).map(n=>[n.id,n]));
  for(const change of input.candidateRevisions?.changes||[])if(change.path.startsWith('/evidence/')){
    const id=change.path.slice('/evidence/'.length);if(change.before)old.set(id,change.before);else old.delete(id);
  }
  const notes=new Map((current.evidence||[]).map(n=>[n.id,n]));
  const reviews=unique([...old.keys(),...notes.keys()]).map(id=>{
    const a=old.get(id),b=notes.get(id);
    return {evidenceId:id,result:!a?'added':!b?'removed':JSON.stringify(noteShape(a))===JSON.stringify(noteShape(b))?'kept':'repaired',
      sourceIds:unique([a?.sourceId,b?.sourceId].filter(Boolean))};
  });
  const required=targets(current);
  for(const target of input.candidateRevisionTargets||[])required.push({target,evidence:[],documentation:[],sourceLinked:true});
  capacity.assertLength(reviews,capacity.limits.explanationReviews,'Required explanation reviews');
  capacity.assertLength(required,capacity.limits.checks+capacity.limits.revisionChecks,'Required current/revision checks');
  const coverage=require('./report-coverage'),reference=coverage.reference(input);
  return {version,checks:required,notes:reviews,
    premises:(input.semanticInput?.premises||[]).map(p=>p.id),
    report:current.reportCoverage?{paragraphs:(input.finding?.reportParagraphs||[]).map(p=>p.id),dispositions:current.reportCoverage.dispositions?.map(d=>d.id)||[],
      ...(version===VERSION?{reviewedIds:unique([...(reference.reportCoverage?.dispositions||[]),...current.reportCoverage.dispositions].map(d=>d.id)),changes:coverage.changes(reference.reportCoverage,current.reportCoverage)}:{})}:null,
    additional:(current.claims||[]).flatMap(c=>[
      ...(current.property?.derivation?[{claimId:c.id,kind:'rule',evidence:current.property.derivation.evidence,required:true}]:[]),
      ...(c.severityFactors?[{claimId:c.id,kind:'impact',evidence:c.severityFactors.evidence,required:false}]:[])])};
}
function missing(check, requirement) {
  return {evidence:requirement.evidence.filter(id=>!check?.evidence?.includes(id)),documentation:requirement.documentation.filter(id=>!check?.documentation?.includes(id))};
}
function validate(value,input) {
  if(!input.reviewRequirements)return;
  const expected=derive(input);
  if(require('./review-content').hash(expected)!==require('./review-content').hash(input.reviewRequirements))throw Error('The review requirements do not identify this exact argument/revision.');
  const failures=[],known=new Set(expected.checks.map(c=>c.target)),seen=new Set();
  for(const c of value.checks||[]){
    if(!known.has(c.target)||seen.has(c.target))failures.push({target:c.target,message:'Duplicate or unknown current/revision check target.'});seen.add(c.target);
    for(const key of ['evidence','documentation'])if(unique(c[key]).length!==(c[key]||[]).length)
      failures.push({target:c.target,message:`Duplicate ${key} reference in ${c.target}.`});
  }
  // Disagreement must not assert the evidence disputed by the checker. Its
  // exact negative feedback is retained by the ordinary private repair path.
  if(value.result==='kept'){
    for(const r of expected.checks){const c=value.checks.find(c=>c.target===r.target),m=missing(c,r);
      if(!c?.reason?.trim()||m.evidence.length||m.documentation.length||r.sourceLinked&&!((c?.evidence?.length||0)+(c?.documentation?.length||0)))
        failures.push({target:r.target,missingEvidence:m.evidence,missingDocumentation:m.documentation,message:`Fresh check incomplete for ${r.target}; missing evidence: ${m.evidence.join(', ')||'none'}; missing documentation: ${m.documentation.join(', ')||'none'}.`});}
    const reviews=value.explanationReviews||[];
    for(const n of expected.notes)if(reviews.filter(r=>r.evidenceId===n.evidenceId&&r.result===n.result).length!==1)
      failures.push({target:`evidence:${n.evidenceId}`,message:`Review ${n.evidenceId} exactly once as ${n.result} relative to the original reference.`});
    if(reviews.length!==expected.notes.length)failures.push({target:'/explanationReviews',message:'The original/current note inventory is not exact.'});
  }
  if(failures.length)throw Object.assign(Error(failures.map(f=>f.message).join('\n')),{code:'REVIEW_REQUIREMENTS',validationProblems:failures.map(f=>({code:'REVIEW_REQUIREMENTS',...f}))});
}
const instruction=`reviewRequirements is a HOST-DERIVED CHECKLIST, never an attestation or required verdict. Review every current target and original-to-current revision against supplied source. For kept, each check must cite ALL listed evidence AND documentation IDs and explain their relevance; extra relevant references remain allowed. Supply every note review with its listed original-to-current result (overall kept does not mean every note is kept), all material premise reviews and full report-scope review. Additional required rule/invariant evidence needs a rule check for each named claim; optional severity factors cannot replace core impact. Reject a disputed link or argument with result=repair and precise problems rather than certifying it. Honest unresolved semantic facts may remain in an unchanged kept argument. Missing required attestations are not a semantic verdict. Never copy this checklist as reasoning.`;
module.exports={VERSION,targets,derive,missing,validate,instruction};
