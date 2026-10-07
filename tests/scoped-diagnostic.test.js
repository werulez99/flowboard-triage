'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const provider=require('../extension/semantic-provider'),notes=require('../extension/provisional-work-note'),{hash}=require('../extension/investigation-engine');
const input={phase:'challenge',repairOnly:true,finding:{id:'fictional'},snapshot:{project:'current'},semanticInput:{premises:[]},sources:[{id:'s',code:'1 | function f() {}'}],earlierDraft:{claims:[]}};
const scope={question:'Explain the stated guard and its counterevidence, not another claim.',claimIds:['c'],questionIds:['q'],checkTargets:['obligation:o'],evidenceIds:['e'],premiseIds:[],allowedPaths:['/evidence/e/**'],newIdPrefix:'proposal-'};
test('scoped task keeps every semantic byte and strict schema; ordinary task remains unchanged',async()=>{
  const before=provider.requestMetrics(input),copy=JSON.stringify(input),m=provider.scopedReviewDiagnosticPacket(input,scope);
  assert.equal(m.payload,before.payload);assert.equal(m.inputHash,before.inputHash);assert.equal(m.sourcePacketHash,before.sourcePacketHash);
  assert.equal(m.encodedSchema,before.encodedSchema);assert.notEqual(m.instructionHash,before.instructionHash);assert.match(m.system,/Override all earlier whole-finding/);
  assert.equal(JSON.stringify(input),copy);assert.deepEqual(provider.requestMetrics(input),before);
  assert.throws(()=>provider.scopedReviewDiagnosticPacket({...input,phase:'generate'},scope));
  const proposal={mode:'review-patch-v1',updates:[],inputReviews:[],explanationReviews:[],checks:[]};
  const events=[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(proposal)}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}];
  const result=await provider.runScopedReviewDiagnostic(input,scope,{timeoutMs:5000,spawn:(_exe,args,settings)=>{
    assert.ok(args.includes('--output-schema'));assert.ok(args.includes('model_reasoning_effort="medium"'));
    return require('node:child_process').spawn(process.execPath,['-e',`process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(events.map(JSON.stringify).join('\n'))}));`],settings);
  }});
  assert.deepEqual(result.proposal,proposal);assert.equal(result.value,undefined);
  assert.equal(require('../extension/challenge-format').valid(result,provider.responseSchema(input)),false);
});
test('one untrusted note is pre-hash input, tied to report/source/premise/base, never accepted evidence',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provisional-note-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const note={version:1,status:notes.STATUS,requestId:'diagnostic-only',responseHash:'a'.repeat(64),fingerprints:notes.fingerprints(input),targetIds:['obligation:o'],proposal:{claim:'Incorrect fixture: a false condition passes'}};
  const attached=notes.attach(input,note);assert.equal(input.provisionalWorkNotes,undefined);
  const original=provider.requestMetrics(input),m=provider.requestMetrics(attached);
  assert.notEqual(m.inputHash,original.inputHash);assert.notEqual(m.instructionHash,original.instructionHash);assert.equal(m.schemaHash,original.schemaHash);assert.equal(m.sourcePacketHash,original.sourcePacketHash);
  assert.match(m.system,/Inherit no approval/);assert.equal(attached.earlierDraft,input.earlierDraft);
  for(const delta of [{snapshot:{project:'changed'}},{finding:{id:'other'}},{semanticInput:{premises:['changed']}},{sources:[{id:'s',code:'different'}]},{earlierDraft:{claims:['changed']}}])assert.throws(()=>notes.attach({...input,...delta},note),/different current inputs/);
  const notePath=path.join(root,'note.json'),packetPath=path.join(root,'packet.json');fs.writeFileSync(notePath,JSON.stringify(note));fs.writeFileSync(packetPath,JSON.stringify(attached));
  const c={findingId:'fictional',phases:['challenge'],timeoutMs:1000,snapshotHash:hash(input.snapshot),firstPacket:require('../scripts/evaluation-plan-guard').packetIdentity(attached),firstPacketPath:packetPath,provisionalNotePath:notePath,provisionalNoteHash:hash(note)};
  const manifest={root,maximumRequests:1,cases:[c]},guard=new(require('../scripts/evaluation-plan-guard').EvaluationPlanGuard)({manifest,root,approval:{authorized:true,manifestHash:hash(manifest),maximumRequests:1},ledger:{used:0,receipts:[]}});
  guard.check=packet=>assert.deepEqual(packet,attached);assert.deepEqual(guard.preparedInput(input),attached);
  fs.writeFileSync(notePath,JSON.stringify({...note,proposal:{claim:'changed'}}));assert.throws(()=>guard.preparedInput(input),/note changed/);
});
