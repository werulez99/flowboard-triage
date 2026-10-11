'use strict';
// Fictional source and scripted review records: production contract and path
// controls, not model accuracy or executed Solidity observations.
const test=require('node:test'),assert=require('node:assert/strict');
const bindings=require('../extension/call-bindings'),binding=require('../extension/source-bindings'),state=require('../extension/state-predicates');
const policy=require('../extension/guide-policy'),diagnostics=require('../extension/tutorial-diagnostics'),engine=require('../extension/investigation-engine');
const format=require('../extension/challenge-format'),provider=require('../extension/semantic-provider'),requirements=require('../extension/review-requirements');
function fixture({shadow=false,parameterType='uint256',inherited=false,helperModifier=false,prefix='lock = LOCKED;',postlude='after();',body=''}={}){
  const sources=[],hash='a'.repeat(64);
  const add=(id,name,code,line,contextKind,owner='Base')=>{const u={id,name:owner+'::'+name,contract:owner,complete:true,code,contextKind,
    source:{file:owner==='Child'?'src/Child.sol':'src/Base.sol',sourceHash:hash,line,endLine:line+code.split('\n').length-1}};u.readThrough=u.source.endLine;sources.push(u);return u;};
  const declaration=add('decl','lock','uint256 private lock;',2,'state');
  add('locked','LOCKED','uint256 private constant LOCKED = 2;',3,'state');add('free','FREE','uint256 private constant FREE = 1;',4,'state');
  const guard=add('guard','guard',`modifier guard() {\n before();\n _;\n ${postlude}\n}`,6);
  add('before','before',`function before() private ${helperModifier?'denied ':''}{\n ${helperModifier?'':'if (lock == LOCKED) revert Busy();'}\n ${helperModifier?'':prefix}\n}`,13);
  add('after','after','function after() private { lock = FREE; }',19);
  if(helperModifier)add('denied','denied','modifier denied() { require(false); _; }',20);
  const caller=add('entry','enter',`function enter(${shadow?parameterType+' lock':''}) external guard {\n${body} finish(false);\n}`,23,undefined,inherited?'Child':'Base');
  const callee=add('finish','finish','function finish(bool accepted) internal {\n require(accepted, "rejected");\n}',30,undefined,inherited?'Child':'Base');
  const scopes=[{contract:'Base',file:'src/Base.sol',sourceHash:hash},...(inherited?[{contract:'Child',file:'src/Child.sol',sourceHash:hash}]:[])];
  for(const s of sources)s.initialization={complete:true,scopes};
  const call=bindings.unitSites(caller).find(s=>s.name==='finish');
  caller.relatedCalls=[{...call,receiver:'internal',relationship:'call',targets:[{file:callee.source.file,line:callee.source.line,contract:callee.contract,signature:'finish(bool)'}]}];
  const evidence=[];
  const note=(id,u,line,endLine=line)=>{const n={id,claimId:'c',sourceId:u.id,source:{...u.source,line,endLine},quote:u.code.split('\n').slice(line-u.source.line,endLine-u.source.line+1).join('\n'),stance:id==='finish-note'?'contradicts':'context',note:'Scripted exact-source review of this bounded conditional invocation.',explanationReview:{result:'kept'}};evidence.push(n);return n;};
  note('decl-note',declaration,2);note('guard-note',guard,6,10);note('call-note',caller,call.span.line,call.span.endLine);note('finish-note',callee,31);
  const common={claimId:'c',transaction:'tx',phase:'entry',actor:'Caller',caller:'Caller',receiver:inherited?'Child instance':'Base instance',changes:[],conditions:[],paragraphId:'',phrase:'',role:'Check the bounded invocation',what:'Follow the exact code under the attributed entry assumption.',why:'A rejected operation cannot commit.',effect:'intermediate',inputs:[]};
  const first={...common,id:'entry-event',invocationId:'root',evidenceId:'call-note',callSiteId:call.id,title:'Enter guarded function',
    statePredicates:[{id:'entry-lock',sourceId:declaration.id,sourceHash:hash,owner:'Base',variable:'lock',receiver:common.receiver,invocationId:'root',transaction:'tx',at:'entry',operator:'!=',value:'2',origin:'scenario-assumption',reason:'Conditional source scenario: entry is not already locked; not a deployed observation.',evidence:['decl-note','guard-note']}],
    inputs:shadow?[{name:'lock',expression:'1',type:'uint256',units:'count',origin:'Explicit conditional input',evidence:['call-note']}]:[]};
  const second={...common,id:'finish-event',invocationId:'child',evidenceId:'finish-note',callSiteId:'',title:'Reject false',effect:'rolled-back',inputs:[{name:'accepted',expression:'false',type:'bool',units:'boolean',origin:'Exact call argument',evidence:['call-note','finish-note']}]};
  const ids=evidence.map(n=>n.id),obligations=require('../extension/review-capacity').kinds.map(kind=>({id:kind,claimId:'c',kind,question:'Examine '+kind,state:kind==='impact'?'not-applicable':'established',reason:'Only this conditional invocation is assessed; false is rejected.',evidence:ids,documentation:[]}));
  const draft={findingId:'fictional-state-path',phase:'ready',revision:1,snapshot:{policy:policy.POLICY},corrections:[],experiments:[],sources,evidence,
    property:{text:'A rejected invocation cannot commit its changes.',basis:'report-assumption',evidence:[],documentation:[]},claims:[{id:'c',allegation:'The false argument commits changes.',actor:'Caller',entry:caller.id,implementation:caller.name,conditions:['Only the explicitly attributed entry predicates and exact false argument.'],requiredFacts:[],supportsIf:'Committed rejected invocation',contradictsIf:'Exact rejection',status:'contradicted',reason:'The final false guard rejects this invocation.',evidence:ids,unknowns:[],nextQuestion:''}],
    transitions:[],questions:[],actions:[],conclusion:{status:'contradicted-in-scope',text:'Only the stated source scenario is rejected.',limitations:[]},inputReviews:[],
    walkthrough:{assessment:{result:'invalid',why:'False is rejected.',supportingEvidence:'',opposingEvidence:'finish-note'}},
    causal:{scope:'Fictional conditional source route only.',summary:'Inspect guard state, then the false argument.',outcome:'refuted',obligations,events:[first,second],
      relationships:[{from:first.id,to:second.id,kind:'call',callSiteId:call.id,binding:'false to accepted',explanation:'The internal call keeps the execution receiver.',evidence:ids,dispatch:{kind:'internal',receiver:'internal',implementation:callee.id,evidence:ids,context:'same',failure:'propagates'}}],order:[first.id,second.id],checks:[]}};
  draft.causal.checks=requirements.targets(draft).map(r=>({...r,reason:'Scripted review: the entry predicate is a conditional assumption, and the false branch rejects.'}));
  return draft;
}
function compiled(draft){
  const first=draft.causal.events[0],second=draft.causal.events[1],link=draft.causal.relationships[0],source=draft.sources.find(u=>u.id==='entry');
  const plan={entries:[{id:'enter-finish',callerEventId:first.id,calleeEventId:second.id,sourceId:source.id,sourceHash:source.source.sourceHash,callSiteId:link.callSiteId,implementationSourceId:'finish',kind:'internal',context:'same',failure:'propagates',evidence:link.evidence}],links:[{key:`${first.id}->${second.id}:call`,entryBindingId:'enter-finish'}],inputs:[]};
  const wire=binding.wire(format.earlier(draft,provider.schema),plan);wire.explanationReviews=draft.evidence.map(n=>({evidenceId:n.id,result:'kept',reason:'Scripted fixture only; exact source and conditional reasoning checked.',checkedSourceIds:[n.sourceId]}));
  assert.equal(format.valid(wire,binding.schema(provider.schema)),true);
  const accepted=engine.accept(wire,draft,draft.sources),checked=engine.checkExplanations(wire,accepted,engine.accept(wire,draft,draft.sources),draft.sources);
  const result={...draft,...checked};result.publication=policy.gate(result);result.publication.digest=policy.digest(result);return result;
}
test('private helper modifiers cannot be discarded by an ordinary handoff',()=>{
  const draft=fixture({helperModifier:true});delete draft.causal.events[0].statePredicates;
  const outcome=compiled(draft);assert.equal(outcome.publication.ready,false);
  assert.ok(outcome.publication.details.some(d=>d.code==='MODIFIER_HELPER_MODIFIERS_UNSUPPORTED'));
  assert.equal(policy.expose(outcome).causal,undefined);
});
test('typed entry state survives compilation/review/reopen and reaches the normal conditional path',()=>{
  for(const inherited of [false,true]){
    const result=compiled(fixture({inherited}));assert.equal(result.publication.ready,true,JSON.stringify(result.publication.details));
    const copy=JSON.parse(JSON.stringify(result));assert.equal(policy.gate(copy).ready,true);
    assert.deepEqual(policy.expose(copy).causal.events[0].statePredicates,result.causal.events[0].statePredicates);
    assert.equal(result.causal.events[0].statePredicates[0].origin,'scenario-assumption');
  }
});
test('prefix storage writes reach the body without overwriting a same-named parameter',()=>{
  const bad=compiled(fixture({body:' require(lock == 1);\n'}));assert.equal(bad.publication.ready,false);assert.ok(bad.publication.details.some(d=>d.code==='PATH_TERMINATED'));
  const good=compiled(fixture({shadow:true,body:' require(lock == 1);\n'}));assert.equal(good.publication.ready,true,JSON.stringify(good.publication.details));
  const changed=compiled(fixture({body:' require(lock == 2);\n'}));assert.equal(changed.publication.ready,true,JSON.stringify(changed.publication.details));
});
test('scalar scenario inputs are bound to the actual source parameter type and uint256 range',()=>{
  const maximum=(2n**256n-1n).toString();
  for(const value of ['0','1',maximum]){
    const d=fixture({shadow:true});d.causal.events[0].inputs[0].expression=value;
    const result=compiled(d);assert.equal(result.publication.ready,true,JSON.stringify(result.publication.details));
    assert.equal(policy.gate(JSON.parse(JSON.stringify(result))).ready,true);
  }
  const alias=fixture({shadow:true,parameterType:'uint'});
  assert.equal(compiled(alias).publication.ready,true,'uint and uint256 denote the same source type');
  for(const value of ['-1',(2n**256n).toString()]){
    const d=fixture({shadow:true});d.causal.events[0].inputs[0].expression=value;
    assert.throws(()=>compiled(d),error=>error.code==='BINDING_PARAMETER'&&error.validationProblems.some(p=>p.code==='PARAMETER_VALUE_RANGE'));
    assert.ok(policy.gate(d).details.some(p=>p.code==='PARAMETER_VALUE_RANGE'),'Legacy content still encounters the same publication check');
  }
  const mismatch=fixture({shadow:true,parameterType:'uint8',body:' require(lock != 0);\n'}),unit=mismatch.sources.find(u=>u.id==='entry'),event=mismatch.causal.events[0];
  event.inputs[0].expression='300';
  assert.throws(()=>compiled(mismatch),error=>error.code==='BINDING_PARAMETER'&&error.validationProblems.some(p=>p.code==='PARAMETER_DECLARATION_TYPE'));
  assert.ok(policy.gate(mismatch).details.some(p=>p.code==='PARAMETER_DECLARATION_TYPE'));
  const units=new Map(mismatch.sources.map(u=>[u.id,u])),notes=new Map(mismatch.evidence.map(n=>[n.id,n]));
  const values=bindings.callerConstraints(event,unit,units,notes);
  assert.equal(values.has('lock'),false,'A uint256 label cannot import a scalar into a uint8 parameter');
  assert.notEqual(bindings.sourcePath(unit,unit.code.indexOf('finish'),values,units).reachable,true);
  event.inputs[0].type='uint8';event.inputs[0].expression='1';
  assert.equal(bindings.callerConstraints(event,unit,units,notes).has('lock'),false,'Other numeric widths remain outside this scalar subset');
  const arrayLabel=fixture({shadow:true});arrayLabel.causal.events[0].inputs[0].type='uint256[]';
  assert.throws(()=>compiled(arrayLabel),{code:'BINDING_PARAMETER'});
});
test('stale, wrong receiver, conflicting and unreviewed scalar assumptions cannot borrow approval',()=>{
  for(const mutate of [f=>f.sourceHash='b'.repeat(64),f=>f.receiver='Other instance',f=>f.invocationId='other',f=>f.transaction='later',f=>f.owner='Other']){
    const d=fixture();mutate(d.causal.events[0].statePredicates[0]);assert.throws(()=>compiled(d),{code:'STATE_PREDICATE_BINDING'});
  }
  const conflict=fixture(),first=conflict.causal.events[0];first.statePredicates.push({...first.statePredicates[0],id:'contrary',operator:'=='});assert.throws(()=>compiled(conflict),{code:'STATE_PREDICATE_BINDING'});
  const missing=fixture();missing.causal.checks.find(c=>c.target==='event:entry-event').evidence=['call-note'];assert.equal(compiled(missing).publication.ready,false);
  for(const origin of ['source-derived','runtime-observation']){const d=fixture();d.causal.events[0].statePredicates[0].origin=origin;const result=compiled(d);assert.equal(result.publication.ready,false);assert.ok(result.publication.details.some(p=>p.code.includes(origin==='source-derived'?'DERIVATION':'OBSERVATION')));}
});
test('locked entry is rejected, and a late postlude revert cannot commit a reached body',()=>{
  const locked=fixture();locked.causal.events[0].statePredicates[0].operator='==';assert.ok(compiled(locked).publication.details.some(p=>p.code==='MODIFIER_PREFIX_REJECTS'));
  const late=fixture({postlude:'after(); require(false);'});late.causal.events[0].effect='committed';assert.ok(compiled(late).publication.details.some(p=>p.code==='MODIFIER_COMMITMENT'));
  const normal=fixture(),u=normal.sources.find(u=>u.id==='entry'),units=new Map(normal.sources.map(u=>[u.id,u])),notes=new Map(normal.evidence.map(n=>[n.id,n]));
  const values=bindings.callerConstraints(normal.causal.events[0],u,units,notes),path=bindings.sourcePath(u,u.code.indexOf('finish'),values,units);
  assert.equal(path.reachable,true);assert.equal([...state.stored(path.values).values()][0].scalar,'2');
  assert.equal(path.commitment,'postlude-passes');
});
test('entry predicates conflict across events; compound storage writes cannot resurrect an old scalar',()=>{
  const d=fixture(),first=d.causal.events[0];d.causal.events.push({...structuredClone(first),id:'another-event',statePredicates:[{...first.statePredicates[0],operator:'=='}]});
  assert.throws(()=>compiled(d),{code:'STATE_PREDICATE_BINDING'});
  const compound=fixture({body:' lock += 1;\n'});compound.causal.events[0].conditions=['These illustrative values do not overflow.'];
  assert.ok(compiled(compound).publication.details.some(p=>p.code==='STATE_WRITE_UNSUPPORTED'));
});
test('modifier and private helper guards cannot read another frame\'s same-named parameter',()=>{
  for(const helper of [false,true]){
    const d=fixture({helperModifier:true}),entry=d.sources.find(u=>u.id==='entry'),guard=d.sources.find(u=>u.id==='guard'),before=d.sources.find(u=>u.id==='before');
    delete d.causal.events[0].statePredicates;
    entry.code=entry.code.replace('enter()','enter(bool allowed)');
    d.causal.events[0].inputs=[{name:'allowed',expression:'true',type:'bool',units:'boolean',origin:'Explicit caller parameter, not storage.',evidence:['call-note']}];
    if(helper){guard.code='modifier guard(bool allowed) { before(); _; }';entry.code=entry.code.replace('external guard','external guard(true)');before.code='function before() private { require(allowed); }';}
    else{guard.code='modifier guard() { require(allowed); _; }';before.code='function before() private {}';}
    // This production path test intentionally stops at sourcePath: changing
    // function bytes is not borrowed as an already-reviewed fixture response.
    const units=new Map(d.sources.map(u=>[u.id,u])),notes=new Map(d.evidence.map(n=>[n.id,n]));
    const p=bindings.sourcePath(entry,entry.code.indexOf('finish'),bindings.callerConstraints(d.causal.events[0],entry,units,notes),units);
    assert.notEqual(p.reachable,true,helper?'Helper cannot borrow modifier parameter':'Modifier cannot borrow function parameter');
  }
});
test('the actual post-prefix storage value reaches an internal callee parameter',()=>{
  const d=fixture(),u=d.sources.find(u=>u.id==='entry'),callee=d.sources.find(u=>u.id==='finish'),first=d.causal.events[0],second=d.causal.events[1];
  u.code=u.code.replace('finish(false)','finish(lock)');callee.code='function finish(uint256 value) internal {\n require(value == 2);\n require(false);\n}';callee.source.endLine=33;callee.readThrough=33;
  const site=bindings.unitSites(u)[0];u.relatedCalls=[{...site,receiver:'internal',relationship:'call',targets:[{file:callee.source.file,line:callee.source.line,contract:callee.contract,signature:'finish(uint256)'}]}];
  first.callSiteId=site.id;d.evidence.find(n=>n.id==='call-note').quote=' finish(lock);';
  const note=d.evidence.find(n=>n.id==='finish-note');note.source.line=32;note.source.endLine=32;note.quote=' require(false);';
  second.inputs=[{name:'value',expression:'lock',type:'uint256',units:'guard state code',origin:'The actual storage value after the modifier prefix.',evidence:['call-note','decl-note']}];
  const link=d.causal.relationships[0];link.callSiteId=site.id;link.binding='lock to value after the guarded prefix';
  const result=compiled(d);assert.equal(result.publication.ready,true,JSON.stringify(result.publication.details));
});
test('provider alternatives preserve old missing predicates without optional strict-schema properties',()=>{
  const strict=state.wireSchema(binding.schema(provider.fullSchema({})));
  assert.doesNotThrow(()=>require('../extension/provider-settings').validateSchema?.(strict));
  const event=strict.properties.causal.properties.events.items;
  assert.equal(event.anyOf.length,2);assert.ok(event.anyOf.every(s=>s.required.length===Object.keys(s.properties).length));
  const d=fixture(),before=require('../extension/review-content').hash(require('../extension/review-content').project(d));
  d.causal.events[0].statePredicates[0].operator='==';assert.notEqual(require('../extension/review-content').hash(require('../extension/review-content').project(d)),before,'Predicate changes are semantic content, never inherited approval.');
});
test('SourceCatalog acquisition feeds inherited scalar declarations through the ordinary compiled contract',{skip:!process.env.FLOWBOARD_EXTENSION_PATH},async t=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowboard-state-predicates-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'src'));
  const d=fixture({inherited:true}),byFile=new Map();
  for(const u of d.sources){const lines=byFile.get(u.source.file)||[];u.code.split('\n').forEach((line,i)=>lines[u.source.line-1+i]=line);byFile.set(u.source.file,lines);}
  for(const [file,lines]of byFile){if(file==='src/Base.sol'){lines[0]='contract Base {';lines[20]='}';}else{lines[0]='import "./Base.sol";';lines[1]='contract Child is Base {';lines[33]='}';}fs.writeFileSync(path.join(root,file),Array.from(lines,line=>line||'').join('\n'));}
  const parsed=await require('../extension/runner-adapter').analyze(process.env.FLOWBOARD_EXTENSION_PATH,root,{mode:'source'});
  const catalog=new(require('../extension/source').SourceCatalog)(root,parsed.runner,parsed.result);
  const request={findingId:d.findingId,finding:{title:'Fictional guarded false call',summary:'Inspect Child.enter and the Base.guard entry predicate.'},cards:[{id:'entry',file:'src/Child.sol',line:23,function:'enter'}]};
  const context=engine.makeContext(catalog,request);
  const replacement=new Map();
  for(const old of d.sources){
    const name=old.name.split('::').at(-1),fn=old.contextKind==='state'?catalog.stateDeclarations(old.source.file,old.contract).find(s=>s.symbol===name):catalog.named(name).find(f=>f.contract===old.contract)||catalog.modifierAt(old.source.file,old.source.line,name);
    assert.ok(fn,'Native declaration '+old.name);
    const id=context.add(fn,'Exact fictional material source for the conditional-state regression.');
    assert.ok(id);const current=context.units.find(u=>u.id===id);current.readThrough=current.source.endLine;replacement.set(old.id,current);
  }
  d.sources=[...replacement.values()];
  for(const n of d.evidence){const u=replacement.get(n.sourceId);n.sourceId=u.id;n.source.sourceHash=u.source.sourceHash;}
  d.claims[0].entry=replacement.get('entry').id;
  const first=d.causal.events[0],decl=replacement.get('decl'),u=replacement.get('entry'),call=bindings.unitSites(u).find(s=>s.name==='finish');
  Object.assign(first.statePredicates[0],{sourceId:decl.id,sourceHash:decl.source.sourceHash});first.callSiteId=call.id;
  Object.assign(d.causal.relationships[0],{callSiteId:call.id});d.causal.relationships[0].dispatch.implementation=replacement.get('finish').id;
  const plan={entries:[{id:'native-call',callerEventId:first.id,calleeEventId:'finish-event',sourceId:u.id,sourceHash:u.source.sourceHash,callSiteId:call.id,implementationSourceId:replacement.get('finish').id,kind:'internal',context:'same',failure:'propagates',evidence:d.evidence.map(e=>e.id)}],links:[{key:'entry-event->finish-event:call',entryBindingId:'native-call'}],inputs:[]};
  const wire=binding.wire(format.earlier(d,provider.schema),plan);wire.explanationReviews=d.evidence.map(n=>({evidenceId:n.id,result:'kept',reason:'Scripted source-only state boundary review, not observed execution.',checkedSourceIds:[n.sourceId]}));
  const accepted=engine.accept(wire,d,d.sources),checked=engine.checkExplanations(wire,accepted,engine.accept(wire,d,d.sources),d.sources);
  const complete={...d,...checked};assert.equal(policy.gate(complete).ready,true,JSON.stringify(policy.gate(complete).details));
  assert.equal(policy.gate(JSON.parse(JSON.stringify(complete))).ready,true);
});
