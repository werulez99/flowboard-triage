'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const engine=require('../extension/investigation-engine'),provider=require('../extension/semantic-provider');
const native=process.env.FLOWBOARD_EXTENSION_PATH;
async function fixture(t, extraDefinitions = 0) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'saved-challenge-preparation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'src'));
  fs.writeFileSync(path.join(root,'src/Vault.sol'),'pragma solidity ^0.8.20;\ncontract Vault {\n function credit() external payable {}\n receive() external payable {}\n'+Array.from({length:extraDefinitions},(_,i)=>` function helper${i}() internal {}\n`).join('')+'}\ncontract Other { receive() external payable {} }\n');
  const indexed=await require('../extension/runner-adapter').analyze(native,root),catalog=new(require('../extension/source').SourceCatalog)(root,indexed.runner,indexed.result);
  const request={findingId:'I-1',finding:{title:'Vault.credit accounting',summary:'Check the local receiving rule.'},cards:[{file:'src/Vault.sol',line:3,function:'credit'}]},findingId=request.findingId;
  const draft=engine.create({findingId,request,catalog}),context=engine.makeContext(catalog,request),entry=context.units.find(u=>u.name==='Vault::credit');
  const q={id:'q1',claimId:'c1',text:'Supply receive or fallback code.',target:'Vault receiving behavior',why:'Receiving code and deployed identity are separate.',action:'missing-context'};
  const value={property:{text:'The reported expectation remains attributed.',basis:'report-assumption',evidence:[]},claims:[{id:'c1',allegation:'Review the receiving behavior.',actor:'Caller',entry:entry.id,implementation:'Vault',conditions:[],requiredFacts:['Receiving definition'],supportsIf:'Supported source',contradictsIf:'Opposing source',status:'unresolved',reason:'Read the local definition.',evidence:[],unknowns:['Receiving behavior'],nextQuestion:q.text}],evidence:[],questions:[q],transitions:[],conclusion:{status:'insufficient-evidence',text:'Receiving behavior needs review.',limitations:['Receiving behavior']}};
  Object.assign(draft,engine.accept(value,draft,context.units));draft.sources=context.units;draft.runs=[{phase:'generate',resultAccepted:true,requestId:'old-paid'}];
  for(const fn of catalog.functions.filter(fn=>/^helper/.test(fn.name)))context.add(fn,'Synthetic discovery candidate');
  for(const u of draft.sources)u.readThrough=u.source.endLine;
  draft.actions.push({id:'old-negative',kind:q.action,outcome:'blocked',sourceIds:[],result:'Older resolver found no additional code.',acquisitionKey:engine.hash([q,entry.id,draft.snapshot.reportHash,draft.snapshot.sourceDigest,draft.snapshot.configuration])});
  return {root,catalog,request,draft,findingId,current:()=>true,publish:async()=>{},persist:false,provider:'codex'};
}
for(const stage of ['challenge','complete'])test(`ordinary ${stage} resume refreshes old negative acquisition without generation or read attestation`,{skip:!native},async t=>{
  const f=await fixture(t);f.draft.checkpoint={stage,followups:1,repairUsed:true};f.draft.failureKind='material-evidence';
  const original=structuredClone(f.draft),earlier=require('../extension/challenge-format').earlier(f.draft,provider.schema);let captured,captureBoundaries=0;
  await engine.advance({...f,beforeRequest:()=>{captureBoundaries++;},invoke:async input=>{captured=input;throw Object.assign(Error('Offline capture'),{code:'LOCAL_READING_LIMIT'});}});
  assert.equal(captured.phase,'challenge');assert.deepEqual(captured.earlierDraft,earlier);
  const receiving=captured.sources.find(s=>s.name==='Vault::receive');assert.ok(receiving);assert.match(receiving.code,/receive\(\)/);
  assert.ok(!captured.sources.some(s=>s.name==='Other::receive'));
  const unit=f.draft.sources.find(u=>u.id===receiving.id);assert.equal(unit.readThrough,unit.source.line-1);
  assert.equal(f.draft.checkpoint.followups,stage==='complete'?2:1);assert.equal(f.draft.checkpoint.repairUsed,true);
  assert.deepEqual(f.draft.runs,original.runs);assert.deepEqual(f.draft.claims,original.claims);
  // The nontransport interception is the capture boundary. It performs no
  // coordinator reservation, slot/health operation or provider process.
  assert.equal(captureBoundaries,1);assert.ok(!fs.existsSync(path.join(f.root,'.flowboard/investigations')));
  const before=f.draft.actions.filter(a=>a.questionId==='q1').length;
  await engine.advance({...f,invoke:async()=>{throw Object.assign(Error('capture'),{code:'LOCAL_READING_LIMIT'});}});
  assert.equal(f.draft.checkpoint.followups,stage==='complete'?2:1,'No automatic allowance renewal.');
  assert.ok(f.draft.actions.filter(a=>a.questionId==='q1').length<=before+1);
});
test('saved resume retains completed dependency leaves beyond the discovery budget',{skip:!native},async t=>{
  const f=await fixture(t,34),leaf=f.draft.sources.find(u=>u.name==='Vault::helper0');
  f.draft.actions.push({id:'retained-completion',kind:'code-completion',sourceIds:[leaf.id],outcome:'source-returned'});
  f.draft.checkpoint={stage:'challenge',followups:0};let packet;
  await engine.advance({...f,invoke:async input=>{packet=input;throw Object.assign(Error('Offline capture'),{code:'LOCAL_READING_LIMIT'});}});
  assert.ok(packet.sources.some(s=>s.id===leaf.id));
  assert.equal(f.draft.runs.length,1);assert.equal(f.draft.runs[0].requestId,'old-paid');
  assert.ok(packet.sources.length<36,'Unbound discovery candidates can still be deferred.');
});
test('serialized Unicode/draft growth is rejected before actual transport admission or dispatch',{skip:!native},async t=>{
  const f=await fixture(t);f.draft.checkpoint={stage:'challenge',followups:0};
  f.draft.claims[0].reason='\u6587'.repeat(100000);
  let admitted=0,dispatched=0;
  const invoke=async()=>{dispatched++;throw Error('Must not dispatch');};invoke.isProviderTransport=true;
  await engine.advance({...f,invoke,beforeRequest:()=>{admitted++;}});
  assert.equal(admitted,0);assert.equal(dispatched,0);
  assert.match(f.draft.error,/262144|packet|bytes/i);assert.equal(f.draft.phase,'blocked');
  assert.equal(f.draft.runs.length,1);assert.equal(f.draft.runs[0].requestId,'old-paid');
});
test('completed external unknown with exhausted followups remains finite and does not reset counters',{skip:!native},async t=>{
  const f=await fixture(t);f.draft.questions[0].target='External observed identity';f.draft.questions[0].text='Supply authenticated deployed identity.';
  f.draft.checkpoint={stage:'complete',followups:2,repairUsed:true};f.draft.failureKind='material-evidence';let calls=0;
  await engine.advance({...f,invoke:async()=>{calls++;throw Error('No call permitted');}});
  assert.equal(calls,0);assert.equal(f.draft.checkpoint.followups,2);assert.equal(f.draft.phase,'blocked');
});
test('negative receipt reuse is suppressed only with unchanged resolver and input',{skip:!native},async t=>{
  const f=await fixture(t),q=f.draft.questions[0];q.target='External identity';q.text='Supply authenticated deployment.';
  f.draft.checkpoint={stage:'challenge',followups:0};const key=engine.hash([engine.ACQUISITION_VERSION,q,f.draft.claims[0].entry,f.draft.snapshot.reportHash,f.draft.snapshot.sourceDigest,f.draft.snapshot.configuration]);
  f.draft.actions.push({id:'current-negative',kind:q.action,outcome:'blocked',sourceIds:[],result:'External observation unavailable.',acquisitionKey:key});
  await engine.advance({...f,invoke:async()=>{throw Object.assign(Error('Offline capture'),{code:'LOCAL_READING_LIMIT'});}});
  assert.equal(f.draft.actions.filter(a=>a.acquisitionKey===key).length,1);
});
