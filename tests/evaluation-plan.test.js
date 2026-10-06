'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EvaluationPlanGuard,packetIdentity}=require('../scripts/evaluation-plan-guard'),{hash}=require('../extension/investigation-engine');
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
