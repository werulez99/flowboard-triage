'use strict';
// Fixed fictional source interpretations exercise production orchestration and
// admission. They are not real-model accuracy or real-provider latency data.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),childProcess=require('node:child_process');
const engine=require('../extension/investigation-engine'),policy=require('../extension/guide-policy');
const technical=require('../extension/technical-assessment'),automatic=require('../extension/automatic-triage');
const provider=require('../extension/semantic-provider'),format=require('../extension/challenge-format');
const coverage=require('../extension/report-coverage'),packetContext=require('../extension/packet-context');
const checkpoint=require('../extension/provider-result');
const {ReportPreparation,reconcile}=require('../extension/report-preparation');
const fixtureOutput=require('../scripts/fixtures/assessment-output'),native=process.env.FLOWBOARD_EXTENSION_PATH;

const kinds=['supported','refuted','inconclusive','supported-partial'];
const variant=id=>kinds[(Number(id.slice(2))-1)%kinds.length];
const independent='A separate original allegation concerns a deployment-specific route. Its implementation identity and applicable rule are not supplied, so its behavior and consequence remain unresolved.';
const hasUnknown=kind=>kind==='inconclusive'||kind==='supported-partial';
const zeroStart=kind=>kind==='refuted'||kind==='inconclusive';
const expected=kind=>({result:zeroStart(kind)?kind==='refuted'?'refuted':'insufficient-evidence':'supported',coverage:hasUnknown(kind)?'partial':'complete'});
function reportText(count){
  return '# Fictional automatic assessment report\n\n'+Array.from({length:count},(_,i)=>{
    const id='I-'+(i+1),kind=variant(id),zero=zeroStart(kind);
    return `## ${id}: ${zero?'DeadlineWindow.schedule allegedly accepts a zero start':'DeadlineWindow stores a duration instead of an absolute deadline'}\n`+
      '**Severity**: Informational\n**Location**: src/DeadlineWindow.sol:5,11,13,17\n\n**Description**:\n'+
      (zero?'This allegation concerns only startedAt = 0 and duration = 5. It claims DeadlineWindow.schedule(0, 5) completes and changes deadline, making DeadlineWindow.ready(5) return true because of that invocation.':'DeadlineWindow.schedule receives a positive startedAt and duration, but stores only duration in deadline. A subsequent DeadlineWindow.ready(clock) can return true for duration <= clock < startedAt + duration, earlier than the documented deadline.')+
      '\n\n**Expected behavior**:\nThe documented source rule requires deadline = startedAt + duration. This is an integer-clock fixture with no real deployment, assets or executed experiment.\n'+
      (hasUnknown(kind)?'\n'+independent+'\n':'');
  }).join('\n');
}
function response(input){
  const plain=packetContext.expand(input),kind=variant(plain.finding.id);
  assert.ok(kinds.includes(kind),'Every imported ID has one explicit fixture scenario.');
  if(plain.phase==='challenge')assert.equal(plain.checkOnly,true,'Each complete technical argument receives full verification, without an extra authoring stage.');
  const value=fixtureOutput.response(plain,{refuted:zeroStart(kind)});
  if(plain.phase==='generate'){
    // Only the optional reading sequence is absent. The exact claim, evidence,
    // causal events/relationships and all material obligations remain present.
    value.causal.order=[];
    if(zeroStart(kind))assert.ok(plain.finding.reportParagraphs.some(p=>p.text.includes('startedAt = 0')),'The refuted condition belongs to the original allegation, not a reviewer substitution.');
    if(hasUnknown(kind)){
      const paragraph=plain.finding.reportParagraphs.find(p=>p.text===independent);
      assert.ok(paragraph,'The independent unresolved scope remains an original paragraph.');
      const disposition=value.reportCoverage.dispositions.find(d=>d.paragraphId===paragraph.id);
      assert.ok(disposition);Object.assign(disposition,{kind:'unresolved',claimIds:[],reason:independent});
      value.causal.outcome='blocked';value.walkthrough.assessment.result='unclear';
      if(kind==='inconclusive'){
        value.conclusion.status='insufficient-evidence';
        value.conclusion.text='The zero-start invocation is refuted by its entry guard. The independent original deployment-specific allegation remains unresolved.';
      }
    }
  }
  const encoded=require('../scripts/fixtures/authoring-output').encode(value,plain);
  assert.ok(format.valid(encoded,provider.responseSchema(input)),'Every scripted response passes the actual provider-enforced schema.');
  return encoded;
}
async function fixture(t,count){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowboard-automatic-batch-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.cpSync(path.join(__dirname,'../scripts/fixtures/teaching-preparation/time/project'),root,{recursive:true});
  const text=reportText(count),file=path.join(root,'report.md');fs.writeFileSync(file,text);
  await require('../extension/report').importReport(file,root,native,{deferMapping:true});
  const indexed=await require('../extension/runner-adapter').analyze(native,root,{mode:'source'});
  const catalog=new(require('../extension/source').SourceCatalog)(root,indexed.runner,indexed.result);
  const reconciliation=reconcile(root);
  assert.equal(reconciliation.entries.length,count);assert.equal(reconciliation.report.issues.length,count);
  assert.equal(reconciliation.report.originalReport,text,'The importer retains every original allegation.');
  return{root,catalog,...reconciliation};
}
function inspect(draft,entry,issue){
  const kind=variant(entry.id),wanted=expected(kind),evaluated=policy.evaluate(draft);
  assert.ok(technical.current(draft),entry.id+': '+(draft.error||'current technical receipt required'));
  assert.ok(automatic.current(draft,evaluated),entry.id+': full current assessment can finish without a tutorial');
  assert.equal(evaluated.assessment.technical.result,wanted.result,entry.id);
  assert.equal(evaluated.assessment.technical.coverage,wanted.coverage,entry.id);
  assert.equal(evaluated.checked,false);assert.equal(draft.publication.ready,false);assert.deepEqual(draft.causal.order,[]);
  assert.deepEqual(draft.runs.map(r=>[r.phase,r.outcome,r.resultAccepted]),[['generate','completed',true],['challenge','completed',true]],entry.id);
  assert.equal(draft.technicalReview.requestId,draft.runs[1].requestId);
  assert.equal(draft.reportCoverage.reportHash,coverage.reportHash(draft));
  assert.deepEqual(coverage.problems(draft,draft,{required:true,review:true}),[],entry.id+' original/current report coverage');
  const paragraphs=coverage.paragraphs(draft),dispositions=draft.reportCoverage.dispositions;
  assert.deepEqual(new Set(dispositions.map(d=>d.paragraphId)),new Set(paragraphs.map(p=>p.id)));
  assert.deepEqual(new Set(draft.reportReview.reviewedIds),new Set(dispositions.map(d=>d.id)));
  assert.equal(coverage.unresolved(draft).length,hasUnknown(kind)?1:0);
  assert.equal(issue.reportText,entry.body);assert.ok(entry.body.includes(zeroStart(kind)?'startedAt = 0':'positive startedAt'));
  if(hasUnknown(kind)){
    assert.ok(issue.reportText.includes(independent));
    assert.ok(evaluated.assessment.technical.remaining.some(reason=>reason.includes(independent)),entry.id+' exposes the exact independent unresolved reason.');
  }
  return{identity:draft.technicalReview.identity,review:engine.hash(draft.technicalReview),argument:engine.hash(require('../extension/review-content').project(draft)),
    reportCoverage:engine.hash(draft.reportCoverage),reportReview:engine.hash(draft.reportReview),sourceDigest:draft.snapshot.sourceDigest};
}
function fileHashes(root,files){return Object.fromEntries([...new Set(files)].sort().map(file=>[file,engine.hash(fs.readFileSync(path.join(root,file)).toString('base64'))]));}

test('four fixed assessment variants pass ordinary source acquisition and full G/V admission without tutorial order',{skip:!native},async t=>{
  const f=await fixture(t,4),coordinator=new ReportPreparation(f.root,{});
  t.after(()=>coordinator.dispose());
  for(const entry of f.entries){
    const issue=f.report.issues.find(issue=>issue.id===entry.id),request=coordinator.request(entry,f.catalog,f.report),phases=[];
    const draft=engine.create({findingId:entry.id,request,issue,catalog:f.catalog});
    await engine.advance({root:f.root,findingId:entry.id,request,issue,catalog:f.catalog,draft,provider:'codex',persist:false,current:()=>true,publish:async()=>{},
      invoke:async input=>{phases.push(input.phase);return{value:response(input),audit:{phase:input.phase,outcome:'completed',provider:'scripted-assessment-fixture',teardown:{confirmed:true}}};}});
    assert.deepEqual(phases,['generate','challenge'],entry.id+': '+draft.error);inspect(draft,entry,issue);
    const job={id:entry.id,findingHash:engine.hash([entry.id,entry.title,entry.body]),state:'completed',publishable:false};
    assert.equal(automatic.bind(job,draft,policy.evaluate(draft)),true);assert.equal(automatic.complete(job),true);
    assert.equal(require('../extension/batch-plan').plan([job],{requests:2,limit:6},2,2).expectedRequests,0);
  }
});

test('160 mixed ordinary findings finish automatic triage with zero Ready tutorials and stable read/retry/reopen accounting',{skip:!native,timeout:240000},async t=>{
  const count=160,f=await fixture(t,count),calls=new Map();let catalogRequests=0;
  const options={configuration:()=>({provider:'codex',workers:8,providerCapacity:8,requestLimit:0}),
    catalog:async()=>{catalogRequests++;return f.catalog;},
    invoke:async(input,options)=>{calls.set(input.finding.id,[...(calls.get(input.finding.id)||[]),input.phase]);
      assert.ok(options.requestId,'The fixture carries the exact coordinator reservation into the terminal receipt.');
      return{value:response(input),audit:{requestId:options.requestId,phase:input.phase,outcome:'completed',provider:'scripted-assessment-batch',teardown:{confirmed:true}}};}};
  const coordinator=new ReportPreparation(f.root,options);
  t.after(async()=>{coordinator.dispose();await coordinator.loop;});
  const started=performance.now();await coordinator.ensure();const status=coordinator.status();
  assert.equal(status.total,count);assert.equal(status.assessed,count,JSON.stringify({mode:status.mode,reason:status.reason,counts:status.counts,stopped:status.stopped}));
  assert.equal(status.notAssessed,0);assert.equal(status.ready,0);assert.equal(status.published,false);assert.equal(status.triageComplete,true);
  assert.deepEqual(status.assessmentCounts,{supported:80,refuted:40,'insufficient-evidence':40});
  assert.equal(status.mode,'completed');assert.equal(status.batch.outcome,'completed');assert.ok(Number.isFinite(status.batch.elapsedMs));
  assert.equal(status.batch.elapsedMs,Date.parse(status.batch.finishedAt)-Date.parse(status.batch.startedAt));
  assert.equal(status.plan.expectedRequests,0);assert.equal(status.plan.dependencyDepth,0);assert.equal(status.plan.requestWavesLowerBound,0);
  assert.equal(status.plan.awaitingEvidence,0,'Checked unresolved scope does not leave automatic processing unfinished.');
  assert.ok(status.jobs.every(job=>job.assessmentCompleted&&!job.publishable));
  assert.equal(status.requests,count*2);assert.equal(status.requestLimit,count*6);assert.equal(catalogRequests,1);
  assert.equal(calls.size,count);for(const stages of calls.values())assert.deepEqual(stages,['generate','challenge']);
  const ledger=structuredClone(coordinator.state.resources),jobs=Object.fromEntries(Object.entries(coordinator.state.jobs).map(([id,j])=>[id,{requests:j.requests,requestLimit:j.requestLimit}]));
  assert.equal(Object.keys(ledger.receipts).length,count*2);
  const identities={},files=['.flowboard/report.json'];
  for(const entry of f.entries){
    const draft=engine.read(f.root,entry.id),issue=f.report.issues.find(issue=>issue.id===entry.id);
    identities[entry.id]=inspect(draft,entry,issue);
    for(const run of draft.runs){
      const receipt=ledger.receipts[run.requestId];assert.ok(receipt,entry.id+' has an exact reserved request receipt');
      assert.equal(receipt.findingId,entry.id);assert.equal(receipt.phase,run.phase);assert.equal(receipt.outcome,'completed');assert.ok(receipt.hostAcceptedAt);
      assert.match(run.retainedResponse?.hash,/^[a-f0-9]{64}$/);
      assert.deepEqual(receipt.audit.retainedResponse,run.retainedResponse,entry.id+' preserves the same exact response reference in its run and terminal receipt.');
      if(run.retainedResponse.archive)files.push(run.retainedResponse.archive);
    }
    // Ordinary G/V keeps one bounded last-response checkpoint per finding.
    // Earlier run/receipt references remain durable; immutable raw archives
    // belong to the production supersession/retained-history paths.
    const verified=draft.runs.at(-1),retained=checkpoint.read(f.root,entry.id,verified.retainedResponse,
      {phase:'challenge',snapshot:draft.snapshot,corrections:draft.corrections,previous:verified.retainedResponse.previous});
    assert.ok(retained,entry.id+' final V checkpoint remains hash-valid for the exact current context.');
    assert.equal(retained.input.finding.id,entry.id);assert.equal(retained.input.checkOnly,true);
    assert.equal(retained.reservation.id,verified.requestId);assert.equal(retained.reservation.phase,'challenge');
    assert.equal(retained.result.audit.requestId,verified.requestId);
    assert.ok(format.valid(retained.result.value,provider.responseSchema(retained.input)));
    files.push('.flowboard/provider-results/'+entry.id+'.json');
    files.push('.flowboard/investigations/'+entry.id+'.json');
  }
  const unchanged=fileHashes(f.root,files),batch=structuredClone(status.batch);
  // Time passing after the completed run models later manual reading. It does
  // not mock the clock or manufacture an active-work time measurement.
  await new Promise(resolve=>setTimeout(resolve,20));
  for(const id of ['I-1','I-2','I-3','I-4']){
    const shown=coordinator.status(undefined,id);assert.equal(shown.batch.elapsedMs,batch.elapsedMs);
    assert.equal(shown.jobs.find(j=>j.id===id).assessmentCompleted,true);engine.read(f.root,id);
  }
  await coordinator.ensure();await coordinator.ensure({retry:true});
  assert.deepEqual(coordinator.status().batch,batch,'No-op ensure or generic retry creates no new automatic attempt.');
  assert.deepEqual(coordinator.state.resources,ledger,'No receipt or report allowance is renewed for unavailable tutorials.');
  assert.deepEqual(Object.fromEntries(Object.entries(coordinator.state.jobs).map(([id,j])=>[id,{requests:j.requests,requestLimit:j.requestLimit}])),jobs);
  assert.equal([...calls.values()].reduce((n,stages)=>n+stages.length,0),count*2);assert.deepEqual(fileHashes(f.root,files),unchanged);
  coordinator.dispose();await coordinator.loop;
  const reopened=childProcess.spawnSync(process.execPath,[path.join(__dirname,'fixtures/reopen-preparation-host.js'),f.root,'restore'],
    {encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});
  assert.equal(reopened.status,0,reopened.stderr||reopened.error?.message||'Fresh process reopen failed.');
  const restored=JSON.parse(reopened.stdout);assert.notEqual(restored.pid,process.pid);assert.equal(restored.indexes,1);assert.deepEqual(restored.calls,[]);
  assert.equal(restored.status.assessed,count);assert.equal(restored.status.notAssessed,0);assert.equal(restored.status.triageComplete,true);assert.equal(restored.status.ready,0);
  assert.deepEqual(restored.status.assessmentCounts,status.assessmentCounts);assert.deepEqual(restored.status.batch,batch);assert.deepEqual(restored.receipts,ledger.receipts);
  assert.equal(restored.status.requests,ledger.requests);assert.equal(restored.status.requestLimit,ledger.limit);assert.equal(restored.status.plan.expectedRequests,0);
  assert.deepEqual(fileHashes(f.root,files),unchanged,'A fresh host preserves exact canonical arguments, final response checkpoints and any actual immutable archives.');
  for(const entry of f.entries)assert.deepEqual(inspect(engine.read(f.root,entry.id),entry,f.report.issues.find(issue=>issue.id===entry.id)),identities[entry.id]);
  t.diagnostic(JSON.stringify({label:'Scripted orchestration only; zero real-provider requests, not model accuracy or real batch latency',findings:count,
    results:status.assessmentCounts,assessed:status.assessed,readyTutorials:status.ready,scriptedRequests:status.requests,catalogRequests,
    automaticElapsedMs:batch.elapsedMs,testWallIncludingReadingAndFreshReopenMs:performance.now()-started,reopenProviderCallbacks:restored.calls.length}));
});
