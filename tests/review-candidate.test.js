'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const actualEngine=require('../extension/investigation-engine'),fixtureAuthoring=require('../scripts/fixtures/authoring-output');
const engine={...actualEngine,advance:options=>actualEngine.advance({...options,invoke:fixtureAuthoring.invoke(options.invoke)})},provider=require('../extension/semantic-provider'),candidate=require('../extension/review-candidate');
const format=require('../extension/challenge-format'),policy=require('../extension/guide-policy'),capacity=require('../extension/review-capacity');
const native=process.env.FLOWBOARD_EXTENSION_PATH;
async function fixture(t,kind='route',index=0,extra=0) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-route-'));
  const folder=kind==='time'?'teaching-preparation/time':`${kind}-preparation`;
  fs.cpSync(path.join(__dirname,`../scripts/fixtures/${folder}/project`),root,{recursive:true});
  if(extra)fs.writeFileSync(path.join(root,'Required.sol'),'pragma solidity ^0.8.20;\ncontract Required {\n'+Array.from({length:extra},(_,i)=>` function definition${i}() internal pure returns(uint) { return ${i}; }\n`).join('')+'}\n');
  await require('../extension/report').importReport(path.join(__dirname,`../scripts/fixtures/${folder}/report.md`),root,native,{deferMapping:true});
  const indexed=await require('../extension/runner-adapter').analyze(native,root,{mode:'source'}),catalog=new(require('../extension/source').SourceCatalog)(root,indexed.runner,indexed.result);
  const report=require('../extension/store').readReport(root),issue=report.issues[index],entry=require('../extension/report').parseReport(report.originalReport,{manifest:true}).issues[index];
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
  assert.equal(f.draft.phase,'challenging',f.draft.error);return structuredClone(f.draft);
}
function proposal(input) {
  input=require('../extension/packet-context').expand(input);
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
for(const variant of ['refutation','missing-rule','receipt-failure'])test(`received unaccepted proposal repairs privately and fully verifies (${variant})`,{skip:!native},async t=>{
  const missingRule=variant==='missing-rule',receiptFailure=variant==='receipt-failure';let notifications=0;
  const f=await fixture(t,'mixed');f.draft=engine.create(f);let original,calls=0;
  await engine.advance({...f,invoke:async input=>{
    calls++;const value=require('../scripts/fixtures/mixed-ready-output').response(input);delete value.walkthrough.steps;value.inputReviews=[];
    value.claims.push({...structuredClone(value.claims[0]),id:'c2',allegation:'The same false condition permits successful settlement.'});
    value.causal.obligations.push(...value.causal.obligations.map(o=>({...o,id:o.id+'-second',claimId:'c2'})));
    if(missingRule){
      // Gate control, not a new source interpretation: structural repair
      // cannot erase an explicitly material normative premise.
      const unknown='No supplied normative rule establishes the reported required treatment of this rejected request.';
      value.claims[0].unknowns=[unknown];value.claims[0].status='unresolved';
      value.questions=[{id:'rule',claimId:'c1',text:unknown,action:'missing-context',target:'Applicable specification',why:'The stated conclusion still depends on this premise.'}];
      value.conclusion.limitations=[unknown];value.causal.outcome='blocked';
      value.causal.obligations.find(o=>o.kind==='rule').state='open';value.walkthrough.assessment.result='unclear';
    }
    original=structuredClone(value);return {value,audit:{phase:'generate',outcome:'completed',requestId:'original-G'}};
  }});
  assert.equal(f.draft.failureCode,'REVIEW_REFERENCE_SCOPE');assert.ok(f.draft.validationProblems.length>1);
  assert.equal(f.draft.claims.length,0);f.draft=engine.read(f.root,f.findingId);
  const noCalls=()=>assert.fail('Opening/replay must not invoke');
  await engine.advance({...f,localOnly:true,invoke:noCalls});assert.equal(calls,1);
  engine.beginRejectedRepair(f);const reference=structuredClone(f.draft.rejectedProposal.original);
  assert.equal(f.draft.claims.length,0);assert.equal(f.draft.reviewCandidate,undefined);
  const bad=structuredClone(f.draft);bad.corrections.push({value:'new'});assert.throws(()=>require('../extension/rejected-proposal').assertCurrent(bad,provider.schema),/identity changed/);
  const reservation={id:'R',phase:'challenge',reviewPurpose:'rejected-proposal-repair'};
  await engine.advance({...f,beforeRequest:async()=>reservation,onResult:async()=>{notifications++;if(receiptFailure)throw Object.assign(Error('receipt disk full'),{code:'ENOSPC'});},invoke:async input=>{
    calls++;assert.equal(input.reviewPurpose,'rejected-proposal-repair');assert.equal(input.referenceOrigin.kind,'received-rejected');assert.equal(input.candidateOnly,true);
    const note={...input.earlierDraft.evidence[0],id:'guard-second',claimId:'c2'};
    return{value:{mode:format.CANDIDATE,updates:[{path:'/evidence/guard-second',valueJSON:JSON.stringify(note)},
      ...(missingRule?[{path:'/questions',valueJSON:JSON.stringify(input.earlierDraft.questions.map(q=>({...q,id:'rule-current'})))}]:[]),
      {path:'/claims/c2/evidence',valueJSON:'["guard-second"]'},...input.earlierDraft.causal.obligations.filter(o=>o.claimId==='c2').map(o=>({path:'/causal/obligations/'+o.id+'/evidence',valueJSON:'["guard-second"]'}))]},audit:{phase:'challenge',outcome:'completed',requestId:'R'}};
  }});
  if(receiptFailure){
    assert.equal(notifications,1);assert.equal(f.draft.failureCode,'RECEIPT_STORAGE_FAILED');assert.equal(f.draft.claims.length,0);
    assert.equal(f.draft.rejectedProposal.state,'repair-dispatched');
    f.draft=engine.read(f.root,f.findingId);assert.ok(f.draft.pendingResponse,'New failures preserve replay identity before receipt finalization.');
    // The older regression saved this state without pendingResponse. Reconcile
    // only the exact owned R checkpoint, not an unrelated latest response.
    delete f.draft.pendingResponse;f.draft.revision++;engine.write(f.root,f.draft);f.draft=engine.read(f.root,f.findingId);
    await engine.advance({...f,localOnly:true,recoveryReservation:reservation,onResult:async(a,r)=>{notifications++;assert.equal(r.id,'R');assert.equal(a.outcome,'completed');},invoke:noCalls});
    assert.equal(calls,2);assert.equal(notifications,2);assert.equal(f.draft.phase,'candidate-awaiting-verification',f.draft.error);
  }
  assert.equal(f.draft.phase,'candidate-awaiting-verification',f.draft.error);assert.equal(f.draft.claims.length,0);
  assert.equal(f.draft.reviewCandidate.acceptedBase,undefined);assert.equal(f.draft.reviewCandidate.referenceBase.evidence.length,1);
  assert.equal(policy.gate(f.draft).ready,false);assert.equal(policy.expose(f.draft).rejectedProposal,undefined);
  const savedOriginal=require('../extension/provider-result').read(f.root,f.findingId,reference,{phase:'generate',snapshot:f.draft.snapshot,corrections:f.draft.corrections,previous:null});
  assert.deepEqual(savedOriginal.result.value,original,'Complete original G survives replacement last-response checkpoint.');
  f.draft=engine.read(f.root,f.findingId);
  await engine.advance({...f,invoke:async input=>{
    calls++;assert.equal(input.checkOnly,true);assert.equal(input.earlierDraft.claims.length,2);
    return {value:{result:'kept',problems:[],inputReviews:[],explanationReviews:input.earlierDraft.evidence.map(e=>({evidenceId:e.id,result:e.id==='guard'?'kept':'added',reason:e.explanation,checkedSourceIds:[e.sourceId]})),
      checks:[...capacity.targets(input.earlierDraft.causal).map(t=>t.key),...input.candidateRevisionTargets].map(target=>({target,reason:'False fails the exact require; both alleged successful outcomes are prevented by the uncaught revert.',evidence:input.earlierDraft.evidence.map(e=>e.id),documentation:[]}))},audit:{phase:'challenge',outcome:'completed',requestId:'V'}};
  }});
  assert.equal(calls,3);assert.equal(f.draft.phase,missingRule?'blocked':'ready',f.draft.error);assert.equal(f.draft.claims.length,2);
  assert.equal(f.draft.rejectedProposal,undefined);assert.equal(f.draft.rejectedProposalHistory[0].original.hash,reference.hash);
  assert.deepEqual(f.draft.lastRejected.output,original);assert.equal(policy.expose(f.draft).lastRejected,undefined,'Immutable original remains private after either checked publication or a blocked disposition.');
  assert.equal(engine.read(f.root,f.findingId).publication.ready,!missingRule);
  if(missingRule){
    const coordinator=new(require('../extension/report-preparation').ReportPreparation)(f.root,{configuration:()=>({provider:'none'}),catalog:async()=>f.catalog,invoke:()=>assert.fail('Blocked reopen is local')});
    t.after(()=>coordinator.dispose());await coordinator.ensure();
    assert.equal(coordinator.state.jobs[f.findingId].missingInputs[0].id,'rule-current','Status follows the verified blocked revision, not superseded original questions.');
  }
});
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
  await engine.advance({...f,invoke:async input=>{
    count++;assert.equal(input.reviewPurpose,'candidate-verification');assert.equal(input.checkOnly,true);assert.ok(!input.repairOnly);
    const packets=require('../extension/packet-context'),plain=packets.expand(input),wire=JSON.parse(JSON.stringify(input));
    assert.deepEqual(packets.expand(wire),plain);
    assert.equal(plain.earlierDraft.evidence.length,32);assert.equal(plain.earlierDraft.causal.events.length,15);
    assert.deepEqual(plain.candidateRevisions,input.candidateRevisions);assert.deepEqual(plain.candidateRevisionTargets,input.candidateRevisionTargets);
    assert.deepEqual(plain.semanticInput,input.semanticInput);assert.equal(provider.requestMetrics(input).dispatchable,true);
    t.diagnostic(`Complete 32-note/15-event candidate verification transport: ${provider.requestMetrics(input).requestBytes} UTF-8 bytes; deterministic, not a model run.`);
    return {value:verification(input),audit:{phase:'challenge',outcome:'completed',requestId:'V'}};
  }});
  assert.equal(count,2);assert.equal(f.draft.phase,'ready',f.draft.error);
  const saved=engine.read(f.root,f.findingId);assert.equal(saved.evidence.length,32);assert.equal(saved.claims[0].evidence.length,32);assert.equal(saved.explanationReviews.length,32);
  assert.equal(saved.candidateHistory[0].acceptedBase.evidence.length,12);assert.equal(saved.candidateHistory[0].verification.result,'kept');
  const missingReceipt=structuredClone(saved);delete missingReceipt.candidateVerification;assert.equal(policy.gate(missingReceipt).ready,false);
  const changedReceipt=structuredClone(saved);changedReceipt.candidateVerification.checks.pop();assert.equal(policy.gate(changedReceipt).ready,false);
  assert.equal(policy.expose(saved).candidateHistory,undefined);
  const model=require('../extension/webview/walkthrough-model').build(saved,f.issue.reportText);assert.equal(model.steps.length,15);assert.equal(model.draft.evidence.length,32);
});
test('analytical context above forty survives candidate checkpoint, reopen, unpaid replay and full verification',{skip:!native},async t=>{
  const f=await fixture(t,'route',0,45);await generation(f);
  const originalUnits=structuredClone(f.draft.sources),originalIds=originalUnits.map(u=>u.id),doc=f.catalog.document('Required.sol');
  f.draft.localPreparation={contextHash:candidate.identity(f.draft),requirements:[...f.draft.sources.map(u=>({...u.source,reason:'Retain this original fixture source for the full check.'})),...f.catalog.functions.filter(fn=>fn.name.startsWith('definition')).map(fn=>({file:'Required.sol',sourceHash:engine.hash(doc.text),line:fn.startLine,endLine:fn.endLine,reason:'Controlled required definition, independently versioned and retained.'}))]};
  let interrupted=false,calls=0;
  await engine.advance({...f,current:()=>!interrupted,publish:async d=>{if(d.pendingResponse)interrupted=true;},invoke:async input=>{
    calls++;assert.ok(input.sources.length>45);assert.ok(input.sources.length<=capacity.limits.sources);
    assert.ok(originalIds.every(id=>input.sources.some(s=>s.id===id)),JSON.stringify(originalUnits.filter(s=>!input.sources.some(v=>v.id===s.id)).map(s=>({id:s.id,name:s.name,source:s.source}))));assert.equal(provider.requestMetrics(input).dispatchable,true);
    return{value:proposal(input),audit:{phase:'challenge',outcome:'completed',requestId:'large-context-C'}};
  }});
  f.draft=engine.read(f.root,f.findingId);assert.ok(f.draft.pendingResponse,f.draft.error);const ids=f.draft.sources.map(u=>u.id);
  await engine.advance({...f,localOnly:true,invoke:()=>assert.fail('Checkpoint recovery is unpaid')});
  assert.equal(f.draft.phase,'candidate-awaiting-verification',f.draft.error);assert.equal(calls,1);
  f.draft=engine.read(f.root,f.findingId);
  await engine.advance({...f,invoke:async input=>{calls++;assert.equal(input.checkOnly,true);assert.ok(ids.every(id=>input.sources.some(s=>s.id===id)));
    assert.equal(provider.requestMetrics(input).dispatchable,true);return{value:verification(input),audit:{phase:'challenge',outcome:'completed',requestId:'large-context-V'}};}});
  assert.equal(f.draft.phase,'ready',f.draft.error);assert.equal(calls,2);assert.equal(engine.read(f.root,f.findingId).publication.ready,true);
});
test('exact candidate verification rejects an omitted old note range before reserving',{skip:!native},async t=>{
  const f=await fixture(t);await generation(f);
  await engine.advance({...f,invoke:async input=>({value:proposal(input),audit:{phase:'challenge',outcome:'completed',requestId:'C'}})});
  let reservations=0,calls=0;
  await engine.advance({...f,prepareRequest:input=>{
    const plain=require('../extension/packet-context').expand(input),note=plain.earlierDraft.evidence[0],source=plain.sources.find(s=>s.id===note.sourceId);
    // Retain the ID and valid exact header bytes, but omit its old evidence.
    const line=source.line;assert.ok(note.line>line);source.providedRanges=[{line,endLine:line}];source.complete=false;source.code=source.code.split('\n')[0];return require('../extension/packet-context').compact(plain);
  },beforeRequest:()=>{reservations++;},invoke:()=>{calls++;assert.fail('Incomplete source view cannot dispatch');}});
  assert.equal(reservations,0);assert.equal(calls,0);assert.equal(f.draft.failureCode,'LOCAL_READING_LIMIT');assert.match(f.draft.error,/evidence.*not supplied/);
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
test('checked long qualifications and claim reasoning survive candidate save, verification and publication exactly',{skip:!native},async t=>{
  const f=await fixture(t);await generation(f);
  const qualification=' MATERIAL SCOPE: only this false-approval invocation rolls back; no historical deployment loss is established.';
  const explanation='The checked guard bounds this source interpretation. '.repeat(82)+qualification;
  const reason='The same guarded condition applies to this invocation. '.repeat(45)+qualification;
  assert.ok(explanation.length>4000);assert.ok(reason.length>2000);
  await engine.advance({...f,invoke:async input=>{const v=proposal(input);v.updates[1].valueJSON=JSON.stringify(explanation);v.updates.push({path:'/claims/c1/reason',valueJSON:JSON.stringify(reason)});return{value:v,audit:{phase:'challenge',outcome:'completed'}};}});
  assert.equal(f.draft.phase,'candidate-awaiting-verification',f.draft.error);
  f.draft=engine.read(f.root,f.findingId);
  await engine.advance({...f,invoke:async input=>{assert.equal(input.earlierDraft.evidence.find(e=>e.id==='approval-guard').explanation,explanation);return{value:verification(input),audit:{phase:'challenge',outcome:'completed'}};}});
  assert.equal(f.draft.phase,'ready',f.draft.error);
  const saved=engine.read(f.root,f.findingId),model=require('../extension/webview/walkthrough-model').build(policy.expose(saved),f.issue.reportText);
  assert.equal(saved.evidence.find(e=>e.id==='approval-guard').note,explanation);
  assert.equal(saved.claims[0].reason,reason);assert.equal(model.steps.find(s=>s.analyticalEvidence.id==='approval-guard').analyticalEvidence.note,explanation);
});
test('human correction of a saved private candidate remains readable and cannot inherit its checks',{skip:!native},async t=>{
  const f=await fixture(t);await generation(f);
  await engine.advance({...f,invoke:async input=>({value:proposal(input),audit:{phase:'challenge',outcome:'completed'}})});
  const old=structuredClone(f.draft.reviewCandidate);
  const model={id:f.findingId,investigationDraft:f.draft};
  const coordinator=new(require('../extension/report-preparation').ReportPreparation)(f.root,{configuration:()=>({provider:'none'}),catalog:async()=>f.catalog});
  await coordinator.ensure();t.after(()=>coordinator.dispose());
  const board={root:f.root,callbacks:{reportPreparation:()=>coordinator},
    investigationCurrent:()=>true,publishInvestigation:async(_model,draft)=>{f.draft=draft;},startInvestigation:()=>assert.fail('Correction cannot launch a request')};
  await require('../extension/board').TriageBoard.prototype.correctInvestigation.call(board,model,{revision:f.draft.revision,change:{claimId:'c1',field:'conditions',value:'The reported path uses approved=false only.',reason:'Retain the scoped condition.'}});
  assert.equal(coordinator.state.jobs[f.findingId].correctionHold.state,'applied');
  const reopened=engine.read(f.root,f.findingId);assert.equal(reopened.phase,'corrected');assert.equal(reopened.reviewCandidate,undefined);
  assert.equal(reopened.invalidatedCandidates.at(-1).candidate.candidateHash,old.candidateHash);assert.equal(reopened.corrections.at(-1).value,'The reported path uses approved=false only.');
  assert.equal(policy.gate(reopened).ready,false);assert.equal(reopened.candidateVerification,undefined);
  f.draft=reopened;let calls=0;
  await engine.advance({...f,invoke:async input=>{calls++;assert.equal(input.reviewPurpose,'candidate-completion');assert.equal(input.phase,'challenge');throw Object.assign(Error('Controlled capture, no transport'),{code:'LOCAL_RECOVERY_PENDING'});}});
  assert.equal(calls,1);assert.equal(f.draft.corrections.at(-1).value,'The reported path uses approved=false only.');
});
test('legacy correction drift is recovered only when the exact recorded transition explains it',{skip:!native},async t=>{
  const f=await fixture(t);await generation(f);
  await engine.advance({...f,invoke:async input=>({value:proposal(input),audit:{phase:'challenge',outcome:'completed'}})});
  const candidateState=structuredClone(f.draft.reviewCandidate);
  engine.correct(f.draft,{claimId:'c1',field:'conditions',value:'approved=false',reason:'Scoped correction'});
  // Reproduce the old writer: correction was saved but its candidate remained.
  f.draft.reviewCandidate=candidateState;delete f.draft.invalidatedCandidates;delete f.draft.correctionHistory;
  engine.write(f.root,f.draft);
  const recovered=engine.read(f.root,f.findingId);
  assert.equal(recovered.recoveryRequired,undefined);assert.equal(recovered.candidateRecovery.kind,'recorded-correction');
  assert.equal(recovered.reviewCandidate,undefined);assert.equal(recovered.invalidatedCandidates[0].candidate.candidateHash,candidateState.candidateHash);
  assert.equal(recovered.corrections.at(-1).value,'approved=false');assert.equal(policy.gate(recovered).ready,false);
  const tampered=structuredClone(f.draft);tampered.reviewCandidate.candidate.evidence[0].explanation+=' Unsupported edit.';tampered.revision++;engine.write(f.root,tampered);
  const refused=engine.read(f.root,f.findingId);assert.equal(refused.recoveryRequired.code,'CANDIDATE_STALE');
  assert.throws(()=>candidate.assertCurrent(refused,provider.schema),/identity changed/);
  await engine.advance({...f,draft:refused,invoke:async()=>assert.fail('Read-only drift must never dispatch')});
});
test('unsupported text and lists reject before freeze, and a proven legacy promotion mismatch stays unpublished',{skip:!native},async t=>{
  const content=require('../extension/review-content'),unicode='\u{1F9EA}'.repeat(content.MAX_TEXT);
  assert.equal(content.text(unicode),unicode);assert.equal(format.valid(unicode,content.string),true,'Schema and persistence count Unicode characters alike.');
  assert.throws(()=>content.text(unicode+'!'),/bound/);assert.equal(format.valid(unicode+'!',content.string),false);
  const f=await fixture(t);await generation(f);
  const units=f.draft.sources,wire=candidate.wire(f.draft,provider.schema);
  for(const mutate of [v=>v.evidence[0].explanation='x'.repeat(16385),v=>v.claims[0].conditions=Array.from({length:13},(_,i)=>`Distinct condition ${i}`)]){
    const value=structuredClone(wire);mutate(value);
    assert.throws(()=>engine.accept(value,f.draft,units,{candidateOnly:true}),/bound|schema|structural/);
    assert.throws(()=>candidate.save(f.draft,value,provider.schema,{kind:'controlled'}),/bound|structural/);
    assert.equal(f.draft.reviewCandidate,undefined);
  }
  await engine.advance({...f,invoke:async input=>({value:proposal(input),audit:{phase:'challenge',outcome:'completed'}})});
  await engine.advance({...f,invoke:async input=>({value:verification(input),audit:{phase:'challenge',outcome:'completed'}})});
  assert.equal(f.draft.publication.ready,true);
  const before=structuredClone(f.draft.candidateHistory);delete f.draft.checkedContentHash;
  f.draft.evidence[0].note=f.draft.evidence[0].note.slice(0,20);
  assert.equal(policy.gate(f.draft).ready,false);assert.match(policy.gate(f.draft).problems[0],/semantic content differs/);
  assert.deepEqual(f.draft.candidateHistory,before);
  const unsupported=await fixture(t);unsupported.draft=engine.create(unsupported);let calls=0;
  await engine.advance({...unsupported,invoke:async input=>{calls++;const value=fixed(input);value.evidence[0].explanation='x'.repeat(16385);return{value,audit:{phase:'generate',outcome:'completed'}};}});
  assert.equal(calls,1,'Unsupported representation must not buy an automatic rewrite.');
  assert.equal(unsupported.draft.failureCode,'REVIEW_CONTENT_BOUND');assert.ok(unsupported.draft.pendingResponse);
  assert.equal(unsupported.draft.lastRejected.output.evidence[0].explanation.length,16385);
  assert.equal(unsupported.draft.reviewCandidate,undefined);assert.equal(policy.gate(unsupported.draft).ready,false);
});
test('complete, qualified and externally blocked explanations omit no-op authorship but retain full checks and blocked reuse',{skip:!native},async t=>{
  for(const mode of ['supported','complete','qualified','external']){
    const f=await fixture(t,mode==='supported'?'time':'mixed',mode==='external'?2:0),purposes=[];
    f.draft=engine.create(f);
    const invoke=async input=>{
      purposes.push(input.phase==='generate'?'generate':input.reviewPurpose||(input.checkOnly?'checkOnly':'patch'));
      const value=mode==='supported'?require('../scripts/fixtures/teaching-output').response(input,'time'):require('../scripts/fixtures/mixed-ready-output').response(input);
      if(mode==='qualified'&&input.phase==='generate')value.claims[0].conditions.push('This source-level result is limited to accepted=false; a true input can return normally.');
      return {value,audit:{phase:input.phase,outcome:'completed'}};
    };
    await engine.advance({...f,invoke});f.draft=engine.read(f.root,f.findingId);
    await engine.advance({...f,invoke});f.draft=engine.read(f.root,f.findingId);
    assert.deepEqual(purposes,['generate','checkOnly'],mode);
    assert.equal(f.draft.causal.checks.length,capacity.targets(f.draft.causal).length);assert.equal(f.draft.explanationReviews.length,f.draft.evidence.length);
    assert.equal(policy.gate(f.draft).ready,mode!=='external',f.draft.error);
    if(mode==='qualified')assert.match(f.draft.claims[0].conditions.at(-1),/true input can return/);
    if(mode==='external'){
      assert.equal(f.draft.failureKind,'material-evidence');assert.equal(f.draft.checkpoint.stage,'complete');
      const semantic=structuredClone(require('../extension/review-content').project(f.draft));
      await engine.advance({...f,invoke:async()=>assert.fail('Unchanged checked external blocker must not restart authoring or checking')});
      assert.deepEqual(require('../extension/review-content').project(f.draft),semantic);
      engine.correct(f.draft,{claimId:'c1',field:'conditions',value:'A new receiver identity is supplied by the researcher.'});
      assert.equal(candidate.needsCompletion(f.draft),true);assert.equal(policy.gate(f.draft).ready,false);
    }else{
      assert.equal(engine.revalidate(f.draft,f.catalog,f.request,f.issue),true);
      assert.equal(policy.gate(f.draft).ready,true);
    }
  }
});
