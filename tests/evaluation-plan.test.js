'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EvaluationPlanGuard,packetIdentity}=require('../scripts/evaluation-plan-guard'),{hash}=require('../extension/investigation-engine');
test('private final-answer retention preserves malformed JSON without collecting reasoning',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'evaluation-answer-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'answer.jsonl'),capture=require('../scripts/run-evaluation-plan').retainAnswers;
  const events=[null,42,{type:'item.completed',item:{type:'reasoning',text:'DO_NOT_RETAIN'}},{type:'item.completed',item:{type:'agent_message',text:'{broken café'}},{type:'turn.completed',usage:{}}];
  const child=capture(file)(process.execPath,['-e',`process.stdout.write(${JSON.stringify(events.map(JSON.stringify).join('\n'))})`],{stdio:['pipe','pipe','pipe']});
  await new Promise(resolve=>child.once('close',resolve));const raw=fs.readFileSync(file,'utf8');assert.ok(!raw.includes('DO_NOT_RETAIN'));assert.equal(JSON.parse(raw).text,'{broken café');
});
test('answer capture reports disk failure without throwing from a listener or replacing a valid transport result',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'evaluation-disk-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const provider=require('../extension/semantic-provider'),capture=require('../scripts/run-evaluation-plan').retainAnswers;
  const events=[{type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}];
  const retained=capture(path.join(root,'answer.jsonl'),(_exe,_args,settings)=>require('node:child_process').spawn(process.execPath,
    ['-e',`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(events.map(JSON.stringify).join('\n'))}));`],settings),
    {...fs,writeSync(){throw Object.assign(Error('PRIVATE disk path'),{code:'ENOSPC'});}});
  const result=await provider.runCodex({phase:'generate',sources:[]},{spawn:retained,timeoutMs:5000});
  assert.deepEqual(result.value,{ok:true});assert.equal(result.audit.outcome,'completed');assert.equal(result.audit.teardown.confirmed,true);
  assert.equal(retained.status.state,'failed');assert.equal(retained.status.errors[0].code,'ENOSPC');assert.equal(retained.status.stored,0);
  assert.equal(retained.answers[0].text,'{"ok":true}','Exact decoded answer remains recoverable, never rewritten.');
  assert.ok(!JSON.stringify(retained.status).includes('PRIVATE'));assert.equal(retained.status.rawByteExact,false);
});
test('answer capture does not claim exact text after malformed UTF-8',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'evaluation-utf8-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const capture=require('../scripts/run-evaluation-plan').retainAnswers(path.join(root,'answer.jsonl'));
  const child=capture(process.execPath,['-e','process.stdout.write(Buffer.from([0xc3,0x28]))'],{stdio:['pipe','pipe','pipe']});
  await new Promise(resolve=>child.once('close',resolve));assert.equal(capture.status.state,'failed');assert.equal(capture.status.errors[0].kind,'decoding');assert.equal(capture.answers.length,0);
});
test('prepared exact input survives only acquisition-history/source-order changes without relaxing packet hashes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'evaluation-prepared-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const input={phase:'generate',finding:{id:'A'},snapshot:{project:'controlled'},sources:[{id:'a',code:'complete A'},{id:'b',code:'complete B'}],actions:[{kind:'code-completion',result:'Source acquired'}]};
  const firstPacketPath=path.join(root,'input.json');fs.writeFileSync(firstPacketPath,JSON.stringify(input));
  const manifest={root,referenceHash:'outside-packet',maximumRequests:1,cases:[{findingId:'A',phases:['generate'],timeoutMs:600000,snapshotHash:hash(input.snapshot),firstPacket:packetIdentity(input),firstPacketPath}]};
  const ledger={manifestHash:hash(manifest),used:0,receipts:[]},approval={authorized:true,manifestHash:hash(manifest),maximumRequests:1};
  const guard=new EvaluationPlanGuard({manifest,ledger,approval,root,save:()=>assert.fail('Preparation cannot reserve')});
  const reordered={...input,sources:[...input.sources].reverse(),actions:[{kind:'code-completion',result:'Already acquired'}]};
  assert.deepEqual(guard.preparedInput(reordered),input);assert.equal(ledger.used,0);
  assert.deepEqual(guard.preparedInput({...reordered,actions:[...(reordered.actions||[]),{kind:'checkpoint-resume',sourceIds:['a'],result:'Saved stage resumed.'}]}),input);
  for(const delta of [{sources:[{id:'a',code:'changed'}]}, {finding:{id:'A',premise:'new'}},{earlierDraft:{changed:true}},{questions:['new']},{actions:[{kind:'experiment'}]}])assert.throws(()=>guard.preparedInput({...reordered,...delta}));
  fs.writeFileSync(firstPacketPath,JSON.stringify({...input,actions:[]}));assert.throws(()=>guard.preparedInput(reordered),/Frozen approved packet changed/);
});
test('five-call manifest keeps per-case phases nontransferable and packet/source/schema drift fails before reservation',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'evaluation-plan-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const input={phase:'generate',finding:{id:'A'},snapshot:{project:'controlled'},sources:[]};
  const manifest={root,referenceHash:'outside-packet',maximumRequests:5,cases:['A','B','C'].map(id=>({findingId:id,phases:id==='C'?['generate']:['generate','challenge'],timeoutMs:600000,snapshotHash:hash(input.snapshot),firstPacket:packetIdentity({...input,finding:{id}})}))};
  const ledger={manifestHash:hash(manifest),used:0,receipts:[]},approval={authorized:true,manifestHash:hash(manifest),maximumRequests:5};let saves=0;
  const guard=new EvaluationPlanGuard({manifest,ledger,approval,root,save:()=>saves++});
  for(const changed of [{...input,phase:'challenge'},{...input,finding:{id:'sibling'}},{...input,sources:[{code:'different'}]},
    {...input,bindingFormat:'source-bindings-v1'},{...input,snapshot:{project:'other'}}])assert.throws(()=>guard.authorize(changed));
  assert.equal(saves,0);assert.equal(ledger.used,0);
  const receipt=guard.authorize({...input,finding:{id:'C'}});assert.equal(receipt.timeoutMs,600000);
  assert.throws(()=>guard.authorize({...input,finding:{id:'C'}}),/exhausted/);
  assert.throws(()=>guard.authorize({...input,phase:'challenge',finding:{id:'C'},earlierDraft:{}}),/exhausted/);
  assert.equal(ledger.used,1,'Four unused units cannot transfer to the generation-only case.');
  ledger.receipts.push(...Array.from({length:4},(_,i)=>({findingId:i<2?'A':'B',outcome:'failed'})));ledger.used=5;
  const restored=new EvaluationPlanGuard({manifest,ledger:JSON.parse(JSON.stringify(ledger)),approval,root,save:()=>assert.fail('No refund')});
  assert.throws(()=>restored.authorize(input),/Aggregate/);
});
test('inactive execution command needs exact separate approval, not the presence of a manifest',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'evaluation-inactive-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'manifest.json'),approval=path.join(root,'approval.json');
  fs.writeFileSync(file,JSON.stringify({root,maximumRequests:1,cases:[]}));fs.writeFileSync(approval,JSON.stringify({authorized:false}));
  const before=fs.readdirSync(root).sort();
  assert.throws(()=>require('node:child_process').execFileSync(process.execPath,[require.resolve('../scripts/run-evaluation-plan'),file,'--execute',approval],{stdio:'pipe'}),/No approval/);
  assert.deepEqual(fs.readdirSync(root).sort(),before,'No coordinator, lock, reservation, checkpoint or provider is created.');
});
