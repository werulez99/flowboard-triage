'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),diagnostics=require('../extension/tutorial-diagnostics'),policy=require('../extension/guide-policy'),technical=require('../extension/technical-assessment');
// Exact fictional source views. The same production staged validator runs at
// assembly, both V boundaries and publication; no semantic discovery is tested.
function fixture({other=false,shadow=false,transition=false,alias=false,missing=false}={}){
 const version='a'.repeat(64),source=(file,line,endLine=line)=>({file,sourceHash:version,line,endLine});
 const make=(id,contract,code,line=3)=>({id,name:contract+'::read',contract,complete:true,source:source(`src/${contract}.sol`,line,line+code.split('\n').length-1),code});
 const first=make('manager','Manager','function read() external {\n    require(!paused);\n    paused = true;\n    require(paused);\n}');
 const second=other?make('oracle','Oracle','function read() external {\n    require(paused);\n}'):
   shadow?make('shadow','Manager','function read(bool paused) external {\n    require(paused);\n}',10):first;
 const state=contract=>({id:contract+'-state',name:contract+'::paused (state)',contract,contextKind:'state',complete:true,source:source(`src/${contract}.sol`,2),code:'bool paused;'});
 const note=(id,u,line)=>({id,claimId:'c',sourceId:u.id,source:{...u.source,line,endLine:line},quote:u.code.split('\n')[line-u.source.line],stance:'contradicts',note:'Controlled source guard review.',explanationReview:{result:'kept'}});
 const notes=[note('a',first,4),note('b',second,second===first?6:second.source.line+1),note('write',first,5)];
 const event=(id,e,u,value,invocation)=>({id,claimId:'c',evidenceId:e,invocationId:invocation,transaction:'tx',title:id,role:'Guard',what:'The exact guard is inspected.',why:'The guard determines this scoped result.',actor:'Caller',caller:'msg.sender',receiver:u.contract,conditions:[`paused == ${value}`],inputs:[],changes:[],effect:'condition'});
 const from=event('before','a',first,'false','m'),to=event('after','b',second,'true',second===first&&!alias?'m':'o');
 if(transition)from.changes=[{name:'paused',before:'false',operation:'assign true',after:'true',units:'boolean',evidence:['write']}];
 const obligations=require('../extension/review-capacity').kinds.map(kind=>({id:kind,claimId:'c',kind,question:kind,state:'established',reason:'Controlled review of the stated guard condition.',evidence:['a','b'],documentation:[]}));
 const draft={findingId:'fictional',phase:'ready',revision:1,snapshot:{sourceDigest:'source',reportHash:'report'},sources:[first,...(second!==first?[second]:[]),...(!missing?[state('Manager'),...(other?[state('Oracle')]:[])]:[])],evidence:notes,claims:[{id:'c',status:'contradicted',reason:'The stated final guard rules out normal completion.',evidence:['a','b'],unknowns:[]}],property:{text:'Reported normal completion',basis:'report-assumption',evidence:[]},conclusion:{limitations:[]},actions:[],
 walkthrough:{assessment:{result:'invalid',why:'The scoped guard prevents completion.',supportingEvidence:'',opposingEvidence:'b'}},
 causal:{scope:'The supplied fictional guard scenario',summary:'Separate source facts retain their actual identity.',outcome:'refuted',obligations,events:[from,to],relationships:[{from:'before',to:'after',kind:'data',explanation:'Compare the stated source-level facts; no call target is inferred.',evidence:['a','b']}],order:['before','after'],checks:[]},runs:[{requestId:'fixed',phase:'challenge',outcome:'completed',resultAccepted:true}]};
 draft.causal.checks=require('../extension/review-capacity').targets(draft.causal).map(t=>({target:t.key,reason:'Controlled review of this exact target and source.',evidence:notes.map(n=>n.id),documentation:[]}));
 technical.seal(draft,{requestId:'fixed'});draft.publication=policy.gate(draft);draft.publication.digest=policy.digest(draft);return draft;
}
test('distinct exact declarations and a shadowed parameter do not become a same-name contradiction',()=>{
 for(const options of [{other:true},{shadow:true}]){
  const d=fixture(options);assert.doesNotThrow(()=>diagnostics.assertVerification(d));
  assert.equal(policy.gate(d).ready,true,JSON.stringify(policy.gate(d).details));assert.equal(policy.expose(d).assessmentProjection.technical.result,'refuted');
 }
});
test('same-state contradiction stops V; only the matching exact source write reconciles it',()=>{
 const d=fixture();let reservations=0;
 assert.throws(()=>{diagnostics.assertVerification(d);reservations++;},e=>e.validationProblems.some(p=>p.code==='SCENARIO_CONTRADICTION'));assert.equal(reservations,0);
 assert.equal(policy.expose(d).assessmentProjection.technical.result,'not-assessed');assert.equal(policy.gate(d).ready,false);
 const changed=fixture({transition:true});assert.doesNotThrow(()=>diagnostics.assertVerification(changed));assert.equal(policy.gate(changed).ready,true,JSON.stringify(policy.gate(changed).details));
 const wrong=fixture({transition:true});wrong.evidence.find(n=>n.id==='write').source.file='src/Other.sol';
 assert.throws(()=>diagnostics.assertVerification(wrong),/representation defects/);
});
test('unproved declaration, alias and delegate storage are unknown, not contradictions or proof',()=>{
 for(const options of [{missing:true},{alias:true}]){const d=fixture(options),result=diagnostics.assertVerification(d);
  assert.ok(result.details.some(p=>p.code==='SCENARIO_STATE_IDENTITY'));assert.ok(!result.details.some(p=>p.code==='SCENARIO_CONTRADICTION'));
  assert.equal(policy.gate(d).ready,false);assert.equal(policy.expose(d).assessmentProjection.technical.result,'insufficient-evidence');
 }
});
