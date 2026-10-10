'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const contract=require('../extension/authoring-contract'),format=require('../extension/challenge-format'),provider=require('../extension/semantic-provider');
function fixture(candidateOnly=true){
  const make=s=>s.anyOf?make(s.anyOf[0]):s.type==='null'?null:s.enum?s.enum[0]:s.type==='array'?[]:s.type==='object'?Object.fromEntries(Object.entries(s.properties).map(([k,v])=>[k,make(v)])):s.type==='integer'?1:'';
  const earlierDraft=make(provider.schema),sourceHash='a'.repeat(64),code='function act() external {\n    // caf\u00e9\n    require(allowed);\n    return;\n}';
  delete earlierDraft.reportCoverage;delete earlierDraft.reportReview; // legacy authoring reference has no new scope attestations
  earlierDraft.claims=[{...make(provider.schema.properties.claims.items),id:'claim-local',evidence:['note-local']}];
  earlierDraft.evidence=[{id:'note-local',claimId:'claim-local',sourceId:'source-local',line:3,endLine:3,quote:'    require(allowed);',stance:'context',explanation:'The guard checks allowed.'}];
  earlierDraft.causal.events=[{...make(provider.schema.properties.causal.properties.events.items),id:'event-local'}];
  const units=[{id:'source-local',complete:true,source:{file:'Local.sol',sourceHash,line:1,endLine:5},code}];
  return{units,input:{phase:'challenge',assessmentContract:require('../extension/technical-assessment').VERSION,authoringFormat:contract.VERSION,candidateOnly,...(!candidateOnly?{repairOnly:true}:{}),earlierDraft,sources:[{id:'source-local',file:'Local.sol',sourceHash,line:1,endLine:5,code:code.split('\n').map((l,i)=>`${i+1} | ${l}`).join('\n')}]}};
}
const response=(input,edits)=>({mode:input.candidateOnly?contract.CANDIDATE:contract.REPAIR,edits,...(!input.candidateOnly?{inputReviews:[],explanationReviews:[],checks:[]}:{})});
test('rejected typed edits retain independently valid scoped questions without applying edits or erasing originals',()=>{
  const {input,units}=fixture(),q={id:'local-question',claimId:'claim-local',text:'Which guard controls the callback?',action:'symbol',target:'Receiver::callback',why:'The return depends on this guard.'};
  input.earlierDraft.questions=[{...q,id:'original-question',target:'Original::settle'}];
  const edit={op:'add',target:'/questions',value:q},bad={op:'add',target:'/evidence',value:{id:'new-note',claimId:'claim-local',stance:'context',explanation:'Untrusted.',selection:{sourceId:'source-local',sourceHash:'b'.repeat(64),line:3,endLine:3}}};
  const value=response(input,[edit,bad]),original=structuredClone(input);
  assert.equal(format.valid(value,provider.responseSchema(input)),true);
  assert.throws(()=>contract.compile(value,input,provider.schema,units),e=>e.validationProblems.some(p=>p.code==='SOURCE_SELECTION_VERSION'));
  assert.deepEqual(contract.questions(value,provider.schema,input.earlierDraft),[q]);
  const replacement={op:'replace',target:'/questions/original-question',value:{...q,id:'original-question'}};
  assert.deepEqual(contract.questions(response(input,[replacement]),provider.schema,input.earlierDraft),[replacement.value]);
  assert.equal(contract.mergeQuestions(input.earlierDraft.questions,[replacement.value]).length,2,'Unaccepted replacement cannot erase the original acquisition question.');
  for(const edits of [[edit,edit],[edit,{op:'remove',target:'/questions/local-question'}],[{...edit,value:{...q,claimId:'other-claim'}}],
    [{...replacement,target:'/questions/missing'}],[{...edit,value:{...q,id:'original-question'}}],[{...edit,value:{...q,why:undefined}}]]){
    const hints=contract.questionHints(response(input,edits),provider.schema,input.earlierDraft);
    assert.deepEqual(hints.questions,[]);assert.ok(hints.validationProblems.length);
  }
  assert.deepEqual(contract.questions(response(input,[{op:'remove',target:'/questions/original-question'}]),provider.schema,input.earlierDraft),[]);
  assert.deepEqual(contract.questions({mode:'candidate-patch-v1',updates:[{path:'/questions',valueJSON:JSON.stringify([q])}]},provider.schema,input.earlierDraft),[q]);
  assert.deepEqual(input,original);
});
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
test('valid typed additions diagnose the assembled evidence capacity without admitting a prefix',()=>{
  const {input,units}=fixture(),limit=provider.schema.properties.evidence.maxItems;
  input.earlierDraft.evidence=Array.from({length:limit},(_,i)=>({...input.earlierDraft.evidence[0],id:i?'other-'+i:'note-local'}));
  const value=response(input,[{op:'add',target:'/evidence',value:{id:'one-more',claimId:'claim-local',stance:'context',explanation:'Still unverified.',selection:{sourceId:'source-local',sourceHash:'a'.repeat(64),line:3,endLine:3}}}]);
  const before=structuredClone(input);
  assert.equal(format.valid(value,provider.responseSchema(input)),true,'Syntax validity alone does not establish assembled capacity.');
  assert.throws(()=>contract.compile(value,input,provider.schema,units),e=>e.validationProblems.some(p=>p.code==='EDIT_CAPACITY'&&p.target==='/evidence'&&p.actual===limit+1&&p.maximum===limit));
  assert.deepEqual(input,before);
});
test('aggregate collection capacity reaches measured candidate and repair instructions from the exact reference',()=>{
  for(const candidateOnly of [true,false]){
    const {input,units}=fixture(candidateOnly),policy=require('../extension/review-capacity');
    assert.equal(policy.limits.evidence,64);assert.equal(policy.limits.explanationReviews,128);assert.equal(policy.POLICY,'checked-explanation-v9');
    const full=provider.fullSchema(input),bounds=contract.collectionBounds(input.earlierDraft,full),text=contract.aggregateInstruction(input,full),measured=provider.measureRequest(input);
    assert.deepEqual(bounds.find(b=>b.path==='/evidence'),{path:'/evidence',current:1,maximum:64});
    assert.ok(bounds.some(b=>b.path==='/causal/events/{new}/changes'));
    assert.ok(measured.system.includes(text));assert.match(text,/Replace preserves count/);
    input.earlierDraft.evidence=Array.from({length:64},(_,i)=>({...input.earlierDraft.evidence[0],id:i?'note-'+i:'note-local'}));
    assert.equal(contract.compile(response(input,[]),input,provider.schema,units).output.evidence.length,64);
    const extra={op:'add',target:'/evidence',value:{id:'over-capacity',claimId:'claim-local',stance:'context',explanation:'Unverified additional observation.',selection:{sourceId:'source-local',sourceHash:'a'.repeat(64),line:3,endLine:3}}};
    assert.throws(()=>contract.compile(response(input,[extra]),input,provider.schema,units),e=>e.validationProblems.some(p=>p.current===64&&p.final===65&&p.maximum===64));
    {const nested=structuredClone(input.earlierDraft);nested.claims[0].conditions=Array(13).fill('condition');
      assert.ok(contract.collectionBounds(nested,provider.schema).some(b=>b.path==='/claims/claim-local/conditions'&&b.current===13&&b.maximum===12));}
  }
});
