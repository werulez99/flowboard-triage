'use strict';
// Declaration-bound entry assumptions for the small scalar path interpreter.
// These are reviewed scenario inputs, never discovered deployment values.
const {lexicalCode,functionParts}=require('./solidity-text');
const coverage=require('./source-coverage');
const text=require('./review-content').string;
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const schema={type:'array',maxItems:8,items:object({id:text,sourceId:text,sourceHash:{type:'string',pattern:'^[a-f0-9]{64}$'},owner:text,variable:text,
  receiver:text,invocationId:text,transaction:text,at:{enum:['entry']},operator:{enum:['==','!=']},value:{type:'string',pattern:'^(0|[1-9][0-9]{0,77})$'},
  origin:{enum:['scenario-assumption','source-derived','runtime-observation']},reason:text,evidence:{type:'array',maxItems:require('./review-capacity').limits.evidence,items:text}})};
function wireSchema(input){
  if(Array.isArray(input))return input.map(wireSchema);
  if(!input||typeof input!=='object')return input;
  const node=Object.fromEntries(Object.entries(input).map(([k,v])=>[k,wireSchema(v)]));
  if(node.type==='object'&&node.properties?.statePredicates&&!node.required.includes('statePredicates')){
    const legacy=structuredClone(node);delete legacy.properties.statePredicates;
    const current=structuredClone(node);current.required.push('statePredicates');
    return{anyOf:[legacy,current]};
  }
  return node;
}
const owner=u=>u.contract||u.name?.split('::')[0];
const scopes=u=>u.initialization?.complete?u.initialization.scopes:[{contract:owner(u),file:u.source.file,sourceHash:u.source.sourceHash}];
const inside=(u,d)=>scopes(u).some(s=>s.contract===owner(d)&&s.file===d.source.file&&s.sourceHash===d.source.sourceHash);
const declaration=u=>u?.contextKind==='state'&&/^\s*uint256\s+(?:(public|private|internal)\s+)?([A-Za-z_$][\w$]*)\s*(?:=\s*[^;]+)?;\s*$/.exec(lexicalCode(u.code));
const identity=u=>[u.source.file,u.source.sourceHash,u.source.line,u.source.endLine,owner(u),declaration(u)?.[2]].join(':');
const key=(u,event)=>'@storage:'+JSON.stringify([identity(u),event.receiver,event.transaction]);
function issue(code,reason,kind='structural',source){return{code,reason,kind,source};}
function combine(a,b){
  if(a?.scalar!==undefined&&b?.scalar!==undefined&&a.scalar!==b.scalar)return null;
  const scalar=a?.scalar??b?.scalar,notEqual=[...new Set([...(a?.notEqual||[]),...(b?.notEqual||[])])];
  if(scalar!==undefined&&notEqual.includes(scalar))return null;
  return{...(a||{}),...b,...(scalar!==undefined?{scalar}:{}),...(notEqual.length?{notEqual}:{})};
}
function entry(event,unit,units,evidence){
  const values=new Map(),problems=[],seen=new Set();
  if(event?.statePredicates!==undefined&&!require('./challenge-format').valid(event.statePredicates,schema))return{values,problems:[issue('STATE_PREDICATE_FORMAT','The storage-entry predicates do not satisfy their bounded versioned contract.')]};
  for(const fact of event?.statePredicates||[]){
    const d=units.get(fact.sourceId),parsed=declaration(d);
    const fail=(code,reason,kind='structural')=>problems.push({...issue(code,reason,kind,d?.source),predicateId:fact.id});
    if(!fact.id||seen.has(fact.id)){fail('STATE_PREDICATE_ID','State predicates require unique stable IDs within the event.');continue;}seen.add(fact.id);
    if(!d){fail('STATE_DECLARATION_IDENTITY','This state predicate names no canonical supplied declaration. Correct its source selection; do not invent a mandatory source identity.');continue;}
    if(!parsed||!d.complete){fail('STATE_DECLARATION_MISSING','Supply the exact uint256 storage declaration selected by this entry predicate.','local-reading');continue;}
    if(d.source.sourceHash!==fact.sourceHash||owner(d)!==fact.owner||parsed[2]!==fact.variable||!unit||!inside(unit,d)){
      fail('STATE_DECLARATION_IDENTITY','The state predicate does not match this function\'s exact declaration, source hash and established inheritance scope.');continue;}
    if(!coverage.read(d,d.source.line,d.source.endLine)||d.modelRanges&&!coverage.covers(d.modelRanges,d.source.line,d.source.endLine)){
      fail('STATE_DECLARATION_VIEW','Read/supply the complete selected declaration before using this state predicate.','local-reading');continue;}
    if(fact.receiver!==event.receiver||fact.invocationId!==event.invocationId||fact.transaction!==event.transaction||fact.at!=='entry'){
      fail('STATE_PREDICATE_CONTEXT','The state predicate belongs to a different receiver, invocation, transaction or program point.');continue;}
    if(!['==','!='].includes(fact.operator)||! /^(0|[1-9][0-9]{0,77})$/.test(fact.value)||BigInt(fact.value)>=2n**256n){
      fail('STATE_PREDICATE_VALUE','Only exact uint256 entry equality/inequality predicates are supported.');continue;}
    if(!fact.reason?.trim()||!fact.evidence?.length||!fact.evidence.every(id=>{
      const n=evidence.get(id),u=units.get(n?.sourceId);return n&&n.claimId===event.claimId&&u&&require('./event-source').covers(n,u,n.source);
    })||!fact.evidence.some(id=>{const n=evidence.get(id);return n&&n.source.file===d.source.file&&n.source.sourceHash===d.source.sourceHash&&n.source.line<=d.source.line&&n.source.endLine>=d.source.endLine;})){
      fail('STATE_PREDICATE_EVIDENCE','Link the exact storage declaration and claim-owned evidence explaining this attributed entry assumption.');continue;}
    if(fact.origin!=='scenario-assumption'){
      fail(fact.origin==='runtime-observation'?'STATE_OBSERVATION_UNSUPPORTED':'STATE_DERIVATION_UNSUPPORTED',fact.origin==='runtime-observation'?
        'This source-only state predicate cannot authenticate a runtime value. Supply an approved identity/time-bound observation capability or retain that fact as unresolved.':
        'The bounded state interpreter cannot derive an arbitrary entry value from this citation. A constructor value alone is not a later-state invariant; retain the derivation as unresolved or explicitly review a source-conditional scenario assumption.','capability');continue;}
    const k=key(d,event),next=combine(values.get(k),{...(fact.operator==='=='?{scalar:fact.value}:{notEqual:[fact.value]}),storage:{sourceId:d.id,declaration:identity(d),receiver:event.receiver,transaction:event.transaction}});
    if(!next){fail('STATE_PREDICATE_CONFLICT','The same entry storage declaration has incompatible predicates.');continue;}values.set(k,next);
  }
  return{values,problems};
}
const stored=values=>new Map([...values].filter(([k])=>k.startsWith('@storage:')));
function transfer(base,changed){const result=new Map(base);for(const [k,v]of stored(changed))result.set(k,v);return result;}
function frame(unit,values,units,at){
  const result=new Map(values),body=functionParts(unit.code,unit.name.split('::').at(-1));
  const parameters=require('./call-bindings').parameterNames(body?.header||'');
  for(const [k,v]of values)if(k.startsWith('@alias:')){if(!parameters.includes(k.slice(7)))result.delete(k.slice(7));result.delete(k);}
  const byName=new Map();
  for(const [k,v]of stored(values)){
    const d=units.get(v?.storage?.sourceId),parsed=declaration(d);if(!parsed||identity(d)!==v.storage.declaration||!inside(unit,d))continue;
    // A private base declaration is not lexically accessible in a child body.
    if(parsed[1]==='private'&&owner(d)!==owner(unit))continue;
    const name=parsed[2];if(parameters.includes(name)||at!==undefined&&!require('./call-bindings').bindingWrites(body,name,at).active.id.startsWith('state:'))continue;
    if(byName.has(name)){byName.set(name,null);continue;}byName.set(name,[k,v]);
  }
  for(const [name,item]of byName)if(item){result.set(name,item[1]);result.set('@alias:'+name,item[0]);}
  return result;
}
function assignment(unit,match,node,values,units){
  if(match[1]){values.delete('@alias:'+match[2]);return null;} // distinct local declaration
  const body=functionParts(unit.code,unit.name.split('::').at(-1)),name=match[2];
  const scan=require('./call-bindings').bindingWrites(body,name,node.start);
  if(scan.unsafe||!scan.active.id.startsWith('state:'))return null;
  const k=values.get('@alias:'+name);if(!k)return null;
  const value=require('./execution-slice').scalar(match[3],values);
  if(value===null)return{outcome:'unknown',code:'STATE_WRITE_UNSUPPORTED',kind:'capability',reason:'This storage assignment needs a supported exact scalar expression; its previous state fact cannot survive the unknown effect.'};
  const next={storage:values.get(k).storage,scalar:value};values.set(k,next);values.set(name,next);return{outcome:'continue'};
}
function assert(draft){
  const resolved=require('./event-source').resolver(draft),problems=[],byInvocation=new Map();
  for(const e of draft.causal?.events||[]){
    const current=entry(e,resolved.event(e),resolved.units,resolved.evidence);
    for(const p of current.problems)problems.push({...p,eventId:e.id});
    for(const [k,v]of current.values){const scoped=e.invocationId+':'+k,next=combine(byInvocation.get(scoped),v);
      if(!next)problems.push({...issue('STATE_PREDICATE_CONFLICT','Events in the same invocation describe incompatible values at the same storage-entry point.'),eventId:e.id});
      else byInvocation.set(scoped,next);
    }
  }
  return problems;
}
module.exports={VERSION:'state-predicates-v1',schema,wireSchema,entry,frame,stored,transfer,assignment,combine,identity,declaration,key,assert};
