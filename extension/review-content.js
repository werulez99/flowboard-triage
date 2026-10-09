'use strict';
// Semantic text is not a display preview. These bounds reject, never shorten.
const crypto=require('node:crypto');
const MAX_TEXT=16384;
const string={type:'string',maxLength:MAX_TEXT};
function text(value,maximum=MAX_TEXT) {
  if(typeof value!=='string'||Array.from(value).length>maximum)throw Object.assign(new Error(`Review text exceeds its supported ${maximum}-character bound or is not text. The unchanged answer is retained; no text was truncated.`),{code:'REVIEW_CONTENT_BOUND'});
  return value;
}
function list(value,maximum=12) {
  if(!Array.isArray(value)||value.length>maximum)throw Object.assign(new Error(`Review list exceeds its supported ${maximum}-item bound or is not an array. No items were removed.`),{code:'REVIEW_CONTENT_BOUND'});
  return value.map(item=>text(item));
}
const pick=(value,keys)=>Object.fromEntries(keys.map(k=>[k,value?.[k]]).filter(([,v])=>v!==undefined));
function project(value) {
  const causal=structuredClone(value.causal||null);if(causal)delete causal.checks;
  // Legacy wire objects omitted documentation; absence means the empty list,
  // not an omitted qualification. This is the only neutral property default.
  return {property:{...pick(value.property,['text','basis','evidence','derivation']),documentation:value.property.documentation||[]},
    claims:value.claims.map(c=>pick(c,['id','allegation','actor','entry','implementation','conditions','requiredFacts','supportsIf','contradictsIf','status','reason','evidence','unknowns','nextQuestion','kind','severityFactors'])),
    evidence:value.evidence.map(e=>({...pick(e,['id','claimId','sourceId','quote','stance']),line:e.source?.line??e.line,endLine:e.source?.endLine??e.endLine,explanation:e.note??e.explanation})),
    transitions:(value.transitions||[]).map(t=>pick(t,['id','claimId','label','before','after','timing','conditions','evidence'])),
    questions:(value.questions||[]).map(q=>pick(q,['id','claimId','text','action','target','why'])),causal,
    conclusion:{status:value.conclusion.scopedStatus||value.conclusion.status,text:value.conclusion.text,limitations:value.conclusion.limitations||[]},
    walkthrough:value.walkthrough?{...(!causal?{steps:value.walkthrough.steps||[]}:{}),assessment:pick(value.walkthrough.assessment,['result','why','supportingEvidence','opposingEvidence'])}:null};
}
function bounds(value,path='semantic') {
  if(typeof value==='string') {try{text(value);}catch(error){error.message=`${path}: ${error.message}`;throw error;}}
  else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))bounds(item,`${path}.${key}`);
}
function stable(value) {return Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;}
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function equal(expected,actual) {
  const before=project(expected),after=project(actual),paths=[];
  const compare=(a,b,path)=>{if(hash(a??null)===hash(b??null)||paths.length>=6)return;if(a&&b&&typeof a==='object'&&typeof b==='object')for(const key of new Set([...Object.keys(a),...Object.keys(b)]))compare(a[key],b[key],`${path}/${key}`);else paths.push(path);};
  if(hash(before)!==hash(after)){compare(before,after,'');throw Object.assign(new Error(`The publishable semantic content differs from the checked representation (${paths.join(', ')}). Preserve the answer and repair the host mapping; no approval was transferred.`),{code:'REVIEW_CONTENT_MISMATCH',paths});}
}
function fromWire(value,units) {
  const copy=structuredClone(value);
  // The established quotation equivalence is exact source lines, with only
  // permitted outer whitespace canonicalized before binding compilation.
  for(const e of copy.evidence){const u=units.find(u=>u.id===e.sourceId);if(!u)throw new Error('Missing candidate source.');const exact=u.code.split('\n').slice(e.line-u.source.line,e.endLine-u.source.line+1).join('\n');if(exact.trim()!==e.quote.trim())throw new Error('Candidate source quotation changed.');e.quote=exact;}
  return copy.bindingFormat?require('./source-bindings').compile(copy,units):copy;
}
function mismatch(draft) {
  try {
    if(draft.checkedContentHash&&draft.checkedContentHash!==hash(project(draft)))return 'Stored explanation differs from its checked semantic content.';
    const state=draft.candidateHistory?.at(-1);
    if(state?.verification?.result==='kept')equal(fromWire(state.candidate,draft.sources),draft);
    return null;
  }catch(error){return error.message;}
}
module.exports={MAX_TEXT,string,text,list,project,hash,equal,fromWire,mismatch,bounds};
