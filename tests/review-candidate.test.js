'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const engine=require('../extension/investigation-engine'),provider=require('../extension/semantic-provider'),candidate=require('../extension/review-candidate');
const format=require('../extension/challenge-format'),policy=require('../extension/guide-policy'),capacity=require('../extension/review-capacity');
const native=process.env.FLOWBOARD_EXTENSION_PATH;
async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-route-'));
  fs.cpSync(path.join(__dirname,'../scripts/fixtures/route-preparation/project'),root,{recursive:true});
  await require('../extension/report').importReport(path.join(__dirname,'../scripts/fixtures/route-preparation/report.md'),root,native,{deferMapping:true});
  const indexed=await require('../extension/runner-adapter').analyze(native,root,{mode:'source'}),catalog=new(require('../extension/source').SourceCatalog)(root,indexed.runner,indexed.result);
  const report=require('../extension/store').readReport(root),issue=report.issues[0],entry=require('../extension/report').parseReport(report.originalReport,{manifest:true}).issues[0];
  const controller=new(require('../extension/report-preparation').ReportPreparation)(root,{}),request=controller.request(entry,catalog,report);controller.dispose();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,catalog,request,issue,findingId:issue.id,current:()=>true,publish:async()=>{},provider:'codex',yieldAfterStage:true};
}
const fixed=input=>require('../scripts/fixtures/route-ready-output').response(input);
async function generation(f) {
  f.draft=engine.create(f);
  await engine.advance({...f,invoke:async input=>{
    const value=fixed(input);value.questions=[{id:'local-guard',claimId:'c1',text:'Interpret the supplied approval guard.',action:'inspect',target:value.evidence.at(-1).sourceId,why:'Complete the guard explanation before review.'}];
    return {value,audit:{phase:'generate',resultAccepted:false,outcome:'completed',requestId:'paid-generation'}};
  }});
  assert.equal(f.draft.phase,'challenging');return structuredClone(f.draft);
}
function proposal(input) {
  const unit=input.sources.find(u=>u.name==='RouteBook::_preview');
  const updates=[{path:'/questions',valueJSON:'[]'},{path:'/evidence/approval-guard/explanation',valueJSON:JSON.stringify('The false approval reaches require and reverts. Its uncaught internal failure undoes the preceding writes in commit.')}];
  // Twenty distinct reached-threshold branch conditions, not duplicate notes
  // manufactured from the same statement. These are controlled source facts.
  for(const line of unit.code.split('\n').filter(line=>/if \(requestedThreshold >= (?:[2-9]|1[0-9]|2[01])\)/.test(line))) {
    const [_,n,text]=line.match(/^(\d+) \| (.*)$/),threshold=text.match(/>= (\d+)/)[1];
    updates.push({path:'/evidence/threshold-'+threshold,valueJSON:JSON.stringify({id:'threshold-'+threshold,claimId:'c1',sourceId:unit.id,line:+n,endLine:+n,quote:text,stance:'context',explanation:`Threshold ${threshold} contributes its one counter unit only when requestedThreshold reaches ${threshold}.`})});
  }
  const ids=[...input.earlierDraft.evidence.map(e=>e.id),...updates.slice(2).map(u=>u.path.split('/').at(-1))];
  updates.push({path:'/claims/c1/evidence',valueJSON:JSON.stringify(ids)});
  return {mode:format.CANDIDATE,updates};
}
function verification(input) {
  const old=new Map(input.candidateRevisions.changes.filter(c=>c.path.startsWith('/evidence/')).map(c=>[c.path.split('/').at(-1),c.before]));
  const value={result:'kept',problems:[],inputReviews:fixed({...input,checkOnly:true}).inputReviews,
    explanationReviews:input.earlierDraft.evidence.map(e=>({evidenceId:e.id,result:old.has(e.id)?old.get(e.id)?'repaired':'added':'kept',reason:e.explanation,checkedSourceIds:[e.sourceId,...(old.get(e.id)?[old.get(e.id).sourceId]:[])]})),
    checks:[...capacity.targets(input.earlierDraft.causal).map(t=>t.key),...(input.candidateRevisionTargets||[])].map(target=>({target,reason:'The uncaught false approval reverts this invocation and its intermediate writes; branch inputs remain bounded as reported.',evidence:input.earlierDraft.claims[0].evidence,documentation:[]}))};
  return value;
}
test('ordinary imported candidate persists 32 notes and references, then checks original revisions without replacing the base early',{skip:!native},async t=>{
  const f=await fixture(t),base=await generation(f);let count=0;
  await engine.advance({...f,invoke:async input=>{count++;assert.equal(input.reviewPurpose,'candidate-completion');assert.ok(input.candidateOnly);assert.ok(!provider.responseSchema(input).properties.explanationReviews);return {value:proposal(input),audit:{phase:'challenge',outcome:'completed',requestId:'C'}};}});
  assert.equal(count,1);assert.equal(f.draft.phase,'candidate-awaiting-verification',f.draft.error);
  assert.deepEqual(f.draft.claims,base.claims);assert.deepEqual(f.draft.evidence,base.evidence);
  assert.equal(f.draft.reviewCandidate.candidate.evidence.length,32);assert.equal(f.draft.reviewCandidate.candidate.claims[0].evidence.length,32);
  assert.equal(policy.gate(f.draft).ready,false);assert.ok(!JSON.stringify(policy.expose(f.draft)).includes('candidate-patch'));
  assert.equal(policy.expose(f.draft).reviewCandidate,undefined);
  f.draft=engine.read(f.root,f.findingId);
  for(const mutate of [d=>d.reviewCandidate.candidate.evidence.pop(),d=>d.corrections.push({value:'Changed premise'}),d=>d.snapshot.sourceDigest='a'.repeat(64),d=>d.reviewCandidate.revisions.changes.pop()]) {
    const changed=structuredClone(f.draft);mutate(changed);assert.throws(()=>candidate.assertCurrent(changed,provider.schema),/identity changed/);
  }
  await engine.advance({...f,invoke:async input=>{count++;assert.equal(input.reviewPurpose,'candidate-verification');assert.equal(input.checkOnly,true);assert.ok(!input.repairOnly);return {value:verification(input),audit:{phase:'challenge',outcome:'completed',requestId:'V'}};}});
  assert.equal(count,2);assert.equal(f.draft.phase,'ready',f.draft.error);
  const saved=engine.read(f.root,f.findingId);assert.equal(saved.evidence.length,32);assert.equal(saved.claims[0].evidence.length,32);assert.equal(saved.explanationReviews.length,32);
  assert.equal(saved.candidateHistory[0].acceptedBase.evidence.length,12);assert.equal(saved.candidateHistory[0].verification.result,'kept');
  const missingReceipt=structuredClone(saved);delete missingReceipt.candidateVerification;assert.equal(policy.gate(missingReceipt).ready,false);
  const changedReceipt=structuredClone(saved);changedReceipt.candidateVerification.checks.pop();assert.equal(policy.gate(changedReceipt).ready,false);
  assert.equal(policy.expose(saved).candidateHistory,undefined);
  const model=require('../extension/webview/walkthrough-model').build(saved,f.issue.reportText);assert.equal(model.steps.length,15);assert.equal(model.draft.evidence.length,32);
});
test('completed check disagreement alone unlocks repair; absent coverage and timeout do not',{skip:!native},async t=>{
  const f=await fixture(t);await generation(f);
  await engine.advance({...f,invoke:async input=>({value:proposal(input),audit:{phase:'challenge',outcome:'completed',requestId:'C'}})});
  const ready=structuredClone(f.draft);
  for(const mode of ['timeout','missing','revision']) {
    f.draft=structuredClone(ready);delete f.draft.storageRevision;
    await engine.advance({...f,persist:false,invoke:async input=>{if(mode==='timeout')throw Object.assign(Error('timeout'),{audit:{phase:'challenge',outcome:'failed'}});const value=verification(input);if(mode==='missing')value.explanationReviews.pop();else value.checks=value.checks.filter(c=>!c.target.startsWith('revision:'));return{value,audit:{phase:'challenge',outcome:'completed'}};}});
    assert.equal(f.draft.reviewCandidate.state,'awaiting-verification');assert.equal(policy.gate(f.draft).ready,false);
  }
  f.draft=ready;
  await engine.advance({...f,invoke:async input=>({value:{...verification(input),result:'repair',problems:['Clarify approval-guard explanation against its supplied require.']},audit:{phase:'challenge',outcome:'completed',requestId:'V'}})});
  assert.equal(f.draft.reviewCandidate.state,'repair-requested');
  await engine.advance({...f,invoke:async input=>{assert.equal(input.reviewPurpose,'candidate-repair');return{value:{mode:format.CANDIDATE,updates:[]},audit:{phase:'challenge',outcome:'completed',requestId:'R'}};}});
  assert.equal(f.draft.reviewCandidate.repairCount,1);
  await engine.advance({...f,invoke:async input=>{assert.equal(input.reviewPurpose,'candidate-reverification');return{value:verification(input),audit:{phase:'challenge',outcome:'completed',requestId:'V2'}};}});
  assert.equal(f.draft.phase,'ready',f.draft.error);
});
test('saved candidate response recovers locally, and a response for an older candidate cannot verify its replacement',{skip:!native},async t=>{
  const f=await fixture(t);await generation(f);
  // Save the exact completed C response, then interrupt at the durable pending
  // checkpoint before ingestion. This is a host interruption, not a retry.
  let interrupted=false,calls=0;
  await engine.advance({...f,current:()=>!interrupted,publish:async draft=>{if(draft.pendingResponse)interrupted=true;},invoke:async input=>{
    calls++;return{value:proposal(input),audit:{phase:'challenge',outcome:'completed',requestId:'C-paid'}};
  }});
  f.draft=engine.read(f.root,f.findingId);assert.ok(f.draft.pendingResponse);
  await engine.advance({...f,localOnly:true,invoke:async()=>assert.fail('Paid C recovery cannot dispatch')});
  assert.equal(f.draft.phase,'candidate-awaiting-verification',f.draft.error);assert.equal(calls,1);
  assert.ok(f.draft.runs.at(-1).reusedResponse);
  interrupted=false;
  await engine.advance({...f,current:()=>!interrupted,publish:async draft=>{if(draft.pendingResponse)interrupted=true;},invoke:async input=>{
    calls++;return{value:verification(input),audit:{phase:'challenge',outcome:'completed',requestId:'V-paid'}};
  }});
  f.draft=engine.read(f.root,f.findingId);assert.ok(f.draft.pendingResponse);
  const pending=structuredClone(f.draft),changed=structuredClone(f.draft.reviewCandidate.candidate);
  changed.evidence[0].explanation+=' Its outcome remains subject to the uncaught guard.';
  candidate.save(f.draft,changed,provider.schema,{kind:'controlled-changed-candidate'});
  await engine.advance({...f,localOnly:true,invoke:async()=>assert.fail('Stale paid check cannot dispatch')});
  assert.equal(policy.gate(f.draft).ready,false);assert.match(f.draft.error,/different private candidate/);
  // Unmodified saved candidate + exact paid response is still recoverable.
  f.draft=pending;f.draft.storageRevision=engine.read(f.root,f.findingId).revision;
  f.draft.revision=f.draft.storageRevision+1;engine.write(f.root,f.draft);
  await engine.advance({...f,localOnly:true,invoke:async()=>assert.fail('Paid V recovery cannot dispatch')});
  assert.equal(f.draft.phase,'ready',f.draft.error);assert.equal(calls,2);
});
test('removed original material evidence still needs its own fresh revision review',{skip:!native},async t=>{
  const f=await fixture(t);await generation(f);
  await engine.advance({...f,invoke:async input=>({value:proposal(input),audit:{phase:'challenge',outcome:'completed',requestId:'C'}})});
  const state=f.draft.reviewCandidate,old=structuredClone(state.acceptedBase),next=structuredClone(state.candidate);
  // Replacing a note's stable ID cannot hide its original interpretation. Keep
  // all dependent references consistent, then require the removed-old review.
  const replacement=JSON.parse(JSON.stringify(next).replaceAll('preview-first','renamed-branch'));
  candidate.save(f.draft,replacement,provider.schema,{kind:'controlled-reference-migration'});
  await engine.advance({...f,invoke:async input=>{
    const v=verification(input);assert.ok(input.candidateRevisions.changes.some(c=>c.path==='/evidence/preview-first'&&c.before));
    return{value:v,audit:{phase:'challenge',outcome:'completed',requestId:'V'}};
  }});
  assert.equal(policy.gate(f.draft).ready,false);assert.match(f.draft.error,/preview-first/);
  assert.deepEqual(f.draft.reviewCandidate.acceptedBase,old);
});
