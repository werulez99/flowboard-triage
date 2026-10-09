'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const bindings=require('../extension/call-bindings'),diagnostics=require('../extension/tutorial-diagnostics');
function unit(name,code,line=1){return {id:name,name:'Local::'+name,contract:'Local',complete:true,code,readThrough:line+code.split('\n').length-1,source:{file:'src/Local.sol',sourceHash:'a'.repeat(64),line,endLine:line+code.split('\n').length-1}};}
function modifier(body,condition='guard()',values=new Map()){
  const source=unit('enter',`function enter() internal ${condition} {\n bool reached = true;\n}`),guard=unit('guard',`modifier guard() {\n ${body}\n}`,10);
  return {source,guard,units:new Map([[source.id,source],[guard.id,guard]]),values};
}
function path(f,complete=false){return bindings.sourcePath(f.source,complete?Infinity:f.source.code.indexOf('bool reached'),f.values,f.units,{complete});}
test('exact modifier prefix/body/postlude are separate; unsupported effects and missing source stay distinct',()=>{
  assert.equal(path(modifier('_;')).reachable,true);
  assert.equal(path(modifier('require(false); _;')).reachable,false);
  const post=modifier('_; require(false);');assert.equal(path(post).reachable,true);assert.equal(path(post).commitment,'reverts');
  assert.equal(path(post,true).outcome,'failure');assert.equal(path(post,true).bodyReached,true);
  assert.equal(path(modifier('state = true; _;')).code,'MODIFIER_EFFECT_UNSUPPORTED');
  const missing=modifier('_;');missing.units.delete('guard');assert.equal(path(missing).kind,'local-reading');
  assert.equal(path(modifier('require(allowed); _;')).code,'MODIFIER_GUARD_PREMISE');
  assert.equal(path(modifier('_;','guard() other()')).code,'MODIFIER_COMPOSITION_UNSUPPORTED');
  const argumentsCase=modifier('require(allowed); _;','guard(false)');argumentsCase.guard.code=argumentsCase.guard.code.replace('guard()','guard(bool allowed)');assert.equal(path(argumentsCase).reachable,false);
  for(const expression of ['sideEffect()','++state']){
    const ignored=modifier('_;',`guard(${expression})`);ignored.guard.code=ignored.guard.code.replace('guard()','guard(bool unused)');
    assert.equal(path(ignored).code,'MODIFIER_ARGUMENT_EFFECT_UNSUPPORTED');
  }
  assert.equal(path(modifier('require(true, buildMessage()); _;')).code,'MODIFIER_EFFECT_UNSUPPORTED');
  assert.equal(path(modifier('if (check()) revert Denied(); _;')).code,'MODIFIER_EFFECT_UNSUPPORTED');
  assert.equal(path(modifier('require(true, "allowed"); _;')).reachable,true);
  const caller=modifier('if (msg.sender != address(manager)) revert Unauthorized(); _;','guard()',new Map([['msg.sender==address(manager)',true]]));assert.equal(path(caller).reachable,true);
  const stale=modifier('_;');stale.guard.source.sourceHash='b'.repeat(64);assert.equal(path(stale).code,'MODIFIER_OWNER_UNRESOLVED');
  const sparse=modifier('_;');sparse.guard.modelRanges=[{line:10,endLine:10}];assert.equal(path(sparse).code,'MODIFIER_VIEW_MISSING');
  const bodyGap=modifier('_;');bodyGap.source.modelRanges=[{line:1,endLine:1}];assert.equal(path(bodyGap).code,'FUNCTION_VIEW_MISSING');
});
function subject(){
  const source=unit('enter','function enter(uint256 amount) external {\n require(amount > 0);\n}');
  const note={id:'n',claimId:'c',sourceId:source.id,source:{...source.source,line:2,endLine:2},quote:' require(amount > 0);'};
  const event={id:'one',invocationId:'inv',transaction:'tx',claimId:'c',evidenceId:'n',title:'Check amount',caller:'caller',receiver:'Local',effect:'condition',inputs:[{name:'amount',expression:'amount',type:'uint256',units:'token A raw units',origin:'caller',evidence:['n']}],changes:[]};
  return {sources:[source],evidence:[note],claims:[{id:'c'}],causal:{events:[event],relationships:[],order:['one'],checks:[]},semanticInput:{premises:[]}};
}
test('pure staged diagnostics catch frame/type/order defects without semantic approvals; unit labels are not physical proof',()=>{
  const draft=subject(),before=structuredClone(draft);assert.equal(diagnostics.assertVerification(draft).admissible,true);assert.deepEqual(draft,before);
  const next={...structuredClone(draft.causal.events[0]),id:'two'};draft.causal.events.push(next);draft.causal.order.push('two');draft.causal.relationships.push({from:'one',to:'two',kind:'data'});
  next.inputs[0].units='token B cents';const units=diagnostics.inspect(draft);assert.equal(units.details.find(d=>d.code==='UNIT_IDENTITY_UNESTABLISHED').kind,'material-evidence');
  next.inputs[0].type='uint128';assert.throws(()=>diagnostics.assertVerification(draft),{code:'TUTORIAL_REPRESENTATION'});
  next.inputs[0].type='uint256';next.inputs[0].units='token A raw units';next.inputs[0].expression='amount * 100';assert.equal(diagnostics.inspect(draft).admissible,false,'Same label cannot bless changed scale/expression.');
  next.inputs=[];const second=unit('finish','function finish() internal {\n require(true);\n}',10);draft.sources.push(second);draft.evidence.push({id:'other',sourceId:second.id,source:{...second.source,line:11,endLine:11},quote:' require(true);'});next.evidenceId='other';
  assert.ok(diagnostics.inspect(draft).details.some(d=>d.code==='INVOCATION_FRAME'));assert.equal(draft.causal.checks.length,0);
});
test('all mixed current blockers survive coordinator and visible group projection without model-authored questions',()=>{
  const draft=subject();Object.assign(draft,{questions:[],actions:[],publication:{ready:false,details:[
    diagnostics.detail(draft,'Independent rule not supplied','material-evidence','c'),
    diagnostics.detail(draft,'Modifier effect is supplied but unsupported','capability','event:one',{code:'MODIFIER_EFFECT_UNSUPPORTED'}),
    diagnostics.detail(draft,'A required definition is absent','local-reading','event:one'),
    diagnostics.detail(draft,'A frame conflicts','structural','event:one')]}});
  const runner=new(require('../extension/report-preparation').ReportPreparation)('/unused',{configuration:()=>({provider:'none'})}),job={id:'case'};
  runner.recoveryStatus(job,draft);assert.equal(job.validationProblems.length,4);assert.equal(job.missingInputs.length,0);assert.equal(job.repairAvailable,false);
  const rendered=require('./helpers/preparation-renderer')({jobs:[job],ready:0,total:1,requests:4,requestLimit:4,reportName:'Generic',mode:'incomplete'},'case');
  for(const text of ['Missing specification or premise','Unsupported analysis','Local source needed','Explanation correction'])assert.ok(rendered.text.includes(text),text);
  assert.ok(rendered.buttons.some(b=>b.text.startsWith('Inspect code')));runner.dispose();
});
