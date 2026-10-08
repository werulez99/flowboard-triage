'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const contract=require('../extension/authoring-contract'),format=require('../extension/challenge-format'),provider=require('../extension/semantic-provider');
function fixture(candidateOnly=true){
  const make=s=>s.enum?s.enum[0]:s.type==='array'?[]:s.type==='object'?Object.fromEntries(Object.entries(s.properties).map(([k,v])=>[k,make(v)])):s.type==='integer'?1:'';
  const earlierDraft=make(provider.schema),sourceHash='a'.repeat(64),code='function act() external {\n    // caf\u00e9\n    require(allowed);\n    return;\n}';
  earlierDraft.claims=[{...make(provider.schema.properties.claims.items),id:'claim-local',evidence:['note-local']}];
  earlierDraft.evidence=[{id:'note-local',claimId:'claim-local',sourceId:'source-local',line:3,endLine:3,quote:'    require(allowed);',stance:'context',explanation:'The guard checks allowed.'}];
  earlierDraft.causal.events=[{...make(provider.schema.properties.causal.properties.events.items),id:'event-local'}];
  const units=[{id:'source-local',complete:true,source:{file:'Local.sol',sourceHash,line:1,endLine:5},code}];
  return{units,input:{phase:'challenge',authoringFormat:contract.VERSION,candidateOnly,...(!candidateOnly?{repairOnly:true}:{}),earlierDraft,sources:[{id:'source-local',file:'Local.sol',sourceHash,line:1,endLine:5,code:code.split('\n').map((l,i)=>`${i+1} | ${l}`).join('\n')}]}};
}
const response=(input,edits)=>({mode:input.candidateOnly?contract.CANDIDATE:contract.REPAIR,edits,...(!input.candidateOnly?{inputReviews:[],explanationReviews:[],checks:[]}:{})});
test('production candidate and repair schema constrain targets and typed values using one syntax contract',()=>{
  for(const candidateOnly of [true,false]){
    const{input,units}=fixture(candidateOnly),schema=provider.responseSchema(input),m=provider.measureRequest(input);
    assert.match(m.system,/AUTHORING SYNTAX source-edits-v2/);assert.match(m.system,/ID-less array as a WHOLE/);
    assert.deepEqual(JSON.parse(m.encodedSchema),schema);
    for(const target of ['/causal/events/event-local/changes/1/evidence','/causal/relationships/a->b:call','/claims/0','/causal/checks','/evidence/not-here'])
      assert.equal(format.valid(response(input,[{op:'set',target,value:[]}]),schema),false,target);
    const updated={...input.earlierDraft.causal.events[0],changes:[{name:'x',before:'x0',operation:'+ y',after:'x0+y',units:'counter',evidence:['note-local']}]};
    const value=response(input,[{op:'replace',target:'/causal/events/event-local',value:updated},{op:'set',target:'/causal/relationships',value:[]}]);
    assert.equal(format.valid(value,schema),true);const compiled=contract.compile(value,input,provider.schema,units);
    assert.deepEqual(compiled.output.causal.events[0],updated);assert.deepEqual(compiled.output.evidence,input.earlierDraft.evidence);
    const wholeArray=response(input,[{op:'set',target:'/causal/events/event-local/changes',value:updated.changes}]);
    assert.equal(format.valid(wholeArray,schema),true);assert.deepEqual(contract.compile(wholeArray,input,provider.schema,units).output.causal.events[0],updated);
    if(candidateOnly)assert.equal(format.valid({...value,checks:[]},schema),false,'Authors cannot attest checks.');
  }
});
test('explicit selections copy exact Unicode lines and reject stale, sparse, ambiguous and conflicting selections atomically',()=>{
  const{input,units}=fixture(),note={id:'note-new',claimId:'claim-local',stance:'context',explanation:'Comment and guard, still unreviewed.',selection:{sourceId:'source-local',sourceHash:'a'.repeat(64),line:2,endLine:3}};
  const value=response(input,[{op:'add',target:'/evidence',value:note}]),before=structuredClone(input);
  const result=contract.compile(value,input,provider.schema,units);
  assert.equal(result.output.evidence.at(-1).quote,'    // caf\u00e9\n    require(allowed);');assert.equal(result.mapping.selections.length,1);assert.deepEqual(input,before);
  for(const change of [n=>n.selection.sourceHash='b'.repeat(64),n=>n.selection.endLine=6,n=>n.selection.line=4,n=>n.selection.sourceId='unknown',n=>n.quote='conflicting legacy quote']){
    const bad=structuredClone(value);change(bad.edits[0].value);assert.throws(()=>contract.compile(bad,input,provider.schema,units),e=>e.code==='AUTHORING_REJECTED');
  }
  const sparse=structuredClone(input);sparse.sources[0].providedRanges=[{line:1,endLine:2},{line:4,endLine:5}];sparse.sources[0].code=sparse.sources[0].code.split('\n').filter(l=>!l.startsWith('3 |')).join('\n');
  assert.throws(()=>contract.compile(value,sparse,provider.schema,units),/complete selected interval/);
  assert.throws(()=>contract.compile(value,{...input,sources:[...input.sources,input.sources[0]]},provider.schema,units),/one exact current/);
  assert.throws(()=>contract.compile({...value,edits:[...value.edits,...value.edits]},input,provider.schema,units),e=>e.validationProblems.some(p=>p.code==='EDIT_CONFLICT'));
  assert.deepEqual(input,before);
});
test('legacy diagnosis collects illegal addressing and independent quote mismatch without assembling a partial candidate',()=>{
  const{input,units}=fixture(),legacy={mode:format.CANDIDATE,updates:[{path:'/causal/events/event-local/changes/1/evidence',valueJSON:'[]'},
    {path:'/causal/relationships/from->to:call',valueJSON:'{}'},
    {path:'/evidence/wrong',valueJSON:JSON.stringify({...input.earlierDraft.evidence[0],id:'wrong',quote:'return;'})}]};
  const copy=structuredClone(legacy),problems=contract.legacyProblems(legacy,input,provider.schema,units);
  assert.equal(problems.filter(p=>p.code==='EDIT_TARGET_OR_VALUE').length,2);assert.equal(problems.filter(p=>p.code==='EVIDENCE_QUOTE').length,1);
  assert.deepEqual(legacy,copy);assert.throws(()=>format.candidate(legacy,input.earlierDraft,provider.schema));
  const guidance=contract.guidance(legacy);for(const [i,update]of guidance.updates.entries()){
    assert.equal(update.path,legacy.updates[i].path);assert.deepEqual(update.value,JSON.parse(legacy.updates[i].valueJSON));
  }
  assert.deepEqual(legacy,copy,'Guidance never repairs a received answer or quote.');
});
test('shared enforced schema references cannot be dangling or cyclic',()=>{
  assert.equal(format.valid('x',{$ref:'#/$defs/nope',$defs:{}}),false);
  assert.equal(format.valid('x',{$ref:'#/$defs/a',$defs:{a:{$ref:'#/$defs/a'}}}),false);
  const {input}=fixture();
  assert.throws(()=>provider.measureRequest({...input,authoringFormat:'source-edits-unknown'}),e=>e.code==='AUTHORING_CONTRACT');
  assert.throws(()=>provider.measureRequest({...input,checkOnly:true}),e=>e.code==='AUTHORING_CONTRACT');
});
test('typed complete objects preserve canonical supported text beyond the legacy JSON-string edit bound',()=>{
  const {input,units}=fixture(),claim=structuredClone(input.earlierDraft.claims[0]);
  for(const key of ['allegation','actor','reason','supportsIf','contradictsIf','nextQuestion'])claim[key]='x'.repeat(12000);
  const value=response(input,[{op:'replace',target:'/claims/claim-local',value:claim}]);
  assert.equal(format.valid(value,provider.responseSchema(input)),true);
  assert.deepEqual(contract.compile(value,input,provider.schema,units).output.claims[0],claim);
  assert.throws(()=>format.candidate({mode:format.CANDIDATE,updates:[{path:'/claims/claim-local',valueJSON:JSON.stringify(claim)}]},input.earlierDraft,provider.schema),/unsafe/,'Legacy replay limits stay unchanged.');
});
test('a legacy reference without a causal model is readable but an empty typed repair cannot invent its completeness',()=>{
  const {input,units}=fixture(false);input.earlierDraft.causal=null;
  const value=response(input,[]),before=structuredClone(input);
  assert.equal(format.valid(value,provider.responseSchema(input)),true,'Empty edits are syntactically valid, not a semantic approval.');
  assert.throws(()=>contract.compile(value,input,provider.schema,units),e=>e.validationProblems[0].code==='EDIT_ASSEMBLY'&&/incomplete explanation/.test(e.message));
  assert.deepEqual(input,before);
});
