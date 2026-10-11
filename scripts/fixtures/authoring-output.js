'use strict';
// Translate deterministic fixture authoring, never retained/model answers.
// Fixtures still pass through the exact new enforced schema and engine path.
function encode(value, input) {
  const contract=require('../../extension/authoring-contract');
  if(input.reportCoverageContract&&(value?.claims?.length||input.earlierDraft?.reportCoverage)){
    value=structuredClone(value);const plain=require('../../extension/packet-context').expand(input),coverage=require('../../extension/report-coverage');
    const map=value.reportCoverage||plain.earlierDraft?.reportCoverage||{version:coverage.VERSION,reportHash:plain.semanticInput.originalReport.sha256,
      dispositions:plain.finding.reportParagraphs.map((p,i)=>({id:'fixture-scope-'+i,paragraphId:p.id,start:0,end:p.text.length,kind:'claim',claimIds:[value.claims[0].id],duplicateOf:'',reason:'Fictional fixture assertion is represented by this claim.'}))};
    const original=plain.candidateRevisions?.changes.find(c=>c.path==='/reportCoverage')?.before??plain.earlierDraft?.reportCoverage;
    const review=input.phase==='generate'?null:{reportHash:map.reportHash,reviewedIds:[...new Set([...(original?.dispositions||[]),...map.dispositions].map(d=>d.id))],changes:coverage.changes(original,map).map(c=>({...c,reason:'Fixture reviewed the exact scope change.'})),reason:'Deterministic fixture reviewed original wording and all scope dispositions.'};
    if(value.claims){value.reportCoverage=map;value.reportReview=review;}
    else if(!input.candidateOnly)value.reportReview=review;
  }
  // Deterministic old fixtures decline new dimensions explicitly. This is
  // never used for paid replay or production normalization.
  if(input.assessmentContract&&value?.claims){value=structuredClone(value);value.property.derivation??=null;for(const claim of value.claims){claim.kind??=null;claim.severityFactors??=null;}}
  if(input.authoringFormat!==contract.VERSION)return value;
  if(value?.claims&&value?.causal){const full=structuredClone(value);if(full.walkthrough)delete full.walkthrough.steps;
    value={mode:input.candidateOnly?'candidate-patch-v1':'review-patch-v1',updates:Object.entries(full).filter(([key])=>!['inputReviews','explanationReviews','reportReview','bindingFormat'].includes(key)).map(([key,item])=>({path:'/'+key,valueJSON:JSON.stringify(item)})),
      ...(input.reportCoverageContract&&!input.candidateOnly?{reportReview:full.reportReview}:{}),
      inputReviews:full.inputReviews||[],explanationReviews:full.explanationReviews||[],checks:full.causal.checks||[]};
    if(input.candidateOnly){delete value.inputReviews;delete value.explanationReviews;delete value.checks;}
  }
  if(!['candidate-patch-v1','review-patch-v1'].includes(value?.mode))return value;
  const plain=require('../../extension/packet-context').expand(input),format=require('../../extension/challenge-format'),provider=require('../../extension/semantic-provider');
  const canonical=structuredClone(plain.bindingFormat?require('../../extension/source-bindings').schema(provider.schema):provider.schema),full=provider.fullSchema(plain);
  if(plain.reportCoverageContract)canonical.required.push('reportCoverage','reportReview');else{delete canonical.properties.reportCoverage;delete canonical.properties.reportReview;}
  const after=value.mode===format.CANDIDATE?format.candidate(value,plain.earlierDraft,canonical):format.assemblePatch(value,plain.earlierDraft,canonical);
  if(input.assessmentContract){after.property.derivation??=null;for(const claim of after.claims){claim.kind??=null;claim.severityFactors??=null;}}
  const lookup=(root,path)=>path.split('/').slice(1).reduce((v,key)=>Array.isArray(v)?v.find(i=>i.id===key):v?.[key],root);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),edits=[];
  const note=value=>{const{sourceId,line,endLine,quote,...rest}=value;const source=plain.sources.find(s=>s.id===sourceId);
    const exact=source.code.split('\n').filter(row=>{const n=Number(row.split(' | ')[0]);return n>=line&&n<=endLine;}).map(row=>row.slice(row.indexOf(' | ')+3)).join('\n');
    require('node:assert/strict').equal(quote.trim(),exact.trim(),'Fixture conversion must not conceal a legacy quote conflict.');
    return{...rest,selection:{sourceId,sourceHash:source.sourceHash,line,endLine}};};
  for(const group of contract.catalog(plain,full).targets){
    if(group.op==='replace')for(const target of group.paths){const before=lookup(plain.earlierDraft,target),next=lookup(after,target);if(next&&!same(before,next))edits.push({op:'replace',target,value:target.startsWith('/evidence/')?note(next):next});}
    else if(group.op==='add'){const target=group.paths[0],before=lookup(plain.earlierDraft,target),next=lookup(after,target);for(const item of next)if(!before.some(i=>i.id===item.id))edits.push({op:'add',target,value:target==='/evidence'?note(item):item});}
    else for(const target of group.paths)if(lookup(after,target)!==undefined&&!edits.some(e=>target.startsWith(e.target+'/'))&&!same(lookup(plain.earlierDraft,target),lookup(after,target)))edits.push({op:'set',target,value:lookup(after,target)});
  }
  for(const target of contract.catalog(plain,full).removals)if(!lookup(after,target))edits.push({op:'remove',target});
  const result={mode:plain.candidateOnly?contract.CANDIDATE:contract.REPAIR,edits,...(!plain.candidateOnly?{...(plain.reportCoverageContract?{reportReview:value.reportReview}:{}),inputReviews:value.inputReviews||[],explanationReviews:value.explanationReviews,checks:value.checks}:{})};
  if(plain.hostReview?.version===require('../../extension/review-feedback').VERSION)result.feedbackResponses=[{
    feedbackIds:require('../../extension/review-feedback').entries(plain.hostReview).map(e=>e.id),disposition:'unresolved',
    reason:'Scripted fixture retains the exact review questions for the subsequent independent fixture check; this is not a semantic attestation.',targets:[]}];
  require('node:assert/strict').equal(format.valid(result,provider.responseSchema(input)),true,'Fixture must use the actual provider-enforced edit schema.');
  return result;
}
function invoke(fn){if(!fn)return fn;const wrapped=async(input,...args)=>{const result=await fn(input,...args);return result?.value?{...result,value:encode(result.value,input)}:result;};Object.assign(wrapped,fn);return wrapped;}
function options(value){return new Proxy(value,{get(target,key){return key==='invoke'?invoke(target[key]):target[key];}});}
module.exports={encode,invoke,options};
