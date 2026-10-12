'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ReportPreparation}=require('../extension/report-preparation'),engine=require('../extension/investigation-engine'),policy=require('../extension/guide-policy');
const automatic=require('../extension/automatic-triage'),native=process.env.FLOWBOARD_EXTENSION_PATH;

test('persisted completion-looking fields cannot authorize automatic completion',()=>{
  const job={id:'controlled',findingHash:'old',state:'completed',publishable:true,assessmentCompleted:true,requests:2,requestLimit:3,nextOperation:{kind:'verify',phases:1},
    assessmentSummary:{technical:{identity:'cached',result:'supported'}},assessmentProjection:{technical:{identity:'cached',result:'supported'}}};
  assert.equal(automatic.complete(job),false);
  assert.equal(require('../extension/batch-plan').plan([job],{requests:2,limit:3},2,2).expectedRequests,1);
});
test('dirty selected source withholds cached reading without mutating the saved assessment projection',()=>{
  const owner=new ReportPreparation(os.tmpdir(),{configuration:()=>({provider:'none'}),dirty:id=>id==='I-1'});
  const projection={artifact:{findingId:'I-1',identity:'transport-fixture'},technical:{identity:'transport-fixture',result:'supported',coverage:'complete'}};
  owner.state={jobs:{'I-1':{id:'I-1',state:'completed',assessmentProjection:projection,requests:2,requestLimit:2}},resources:{requests:2,limit:2},ambiguities:[]};
  const row=owner.status(undefined,'I-1').jobs[0];
  assert.equal(row.assessmentAvailable,false);assert.equal(row.assessmentProjection,undefined);assert.equal(row.assessmentState,'unavailable');assert.equal(row.state,'paused');
  assert.equal(owner.state.jobs['I-1'].assessmentProjection,projection,'Projection withholding does not rewrite the checked argument or stored detail.');
});
test('automatic time freezes, unknown historical stops stay unknown, and renewed work preserves the original attempt',t=>{
  const owner=Object.create(ReportPreparation.prototype),start='2026-10-10T10:00:00.000Z',end='2026-10-10T10:02:00.000Z';
  owner.state={jobs:{},ambiguities:[],batch:{startedAt:start,finishedAt:end,outcome:'incomplete'}};
  assert.equal(owner.batchStatus().elapsedMs,120000);
  t.mock.method(Date,'now',()=>Date.parse('2030-01-01T00:00:00.000Z'));
  assert.equal(owner.batchStatus().elapsedMs,120000,'Subsequent reading cannot extend a finished attempt.');
  owner.state.batch={startedAt:start,outcome:'incomplete'};
  assert.equal(owner.batchStatus().elapsedMs,null,'An absent historical stop is not inferred from the current time.');
  owner.beginBatchAttempt();assert.notEqual(owner.state.batch.startedAt,start);
  assert.deepEqual(owner.state.batch.previousAttempts,[{startedAt:start,outcome:'incomplete'}]);
  owner.finishBatch();const stopped=owner.batchStatus();assert.ok(stopped.finishedAt);assert.equal(stopped.previousAttempts[0].finishedAt,undefined);
  assert.deepEqual(owner.batchStatus(),stopped);
});
for(const mode of ['paused','cancelled'])test(`legacy ${mode} pending attempt does not absorb idle reading when explicit work starts`,()=>{
  const owner=Object.create(ReportPreparation.prototype),start='2026-10-10T10:00:00.000Z';
  owner.state={mode,jobs:{},ambiguities:[],batch:{startedAt:start,outcome:'pending'}};
  assert.equal(owner.batchStatus().elapsedMs,null);
  // Generic retry can already have changed mode to running by admission. The
  // initial persisted stop remains authoritative for this boundary decision.
  owner.batchWasStopped=true;owner.state.mode='running';owner.beginBatchAttempt();
  assert.notEqual(owner.state.batch.startedAt,start);assert.deepEqual(owner.state.batch.previousAttempts,[{startedAt:start,outcome:'pending'}]);
  owner.finishBatch();assert.equal(owner.state.batch.previousAttempts[0].finishedAt,undefined);assert.ok(owner.state.batch.finishedAt);
});

async function fixture(t,count=2){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowboard-automatic-lifecycle-')),base=path.join(__dirname,'../scripts/fixtures/teaching-preparation/time');
  fs.cpSync(path.join(base,'project'),root,{recursive:true});
  const original=fs.readFileSync(path.join(base,'report.md'),'utf8'),section=original.slice(original.indexOf('## I-1:'));
  const reportFile=path.join(root,'report.md');fs.writeFileSync(reportFile,'# Controlled automatic lifecycle\n\n'+Array.from({length:count},(_,i)=>section.replace('## I-1:',`## I-${i+1}:`)).join('\n\n'));
  await require('../extension/report').importReport(reportFile,root,native,{deferMapping:true});
  const result=await require('../extension/runner-adapter').analyze(native,root,{mode:'source'}),catalog=new(require('../extension/source').SourceCatalog)(root,result.runner,result.result);
  const f={root,catalog,calls:[],config:{provider:'codex',requestLimit:count*4,workers:1}};
  f.options={configuration:()=>f.config,catalog:async()=>f.catalog,invoke:async(input,options)=>{
    f.calls.push([input.finding.id,input.phase]);
    const value=require('../scripts/fixtures/authoring-output').encode(require('../scripts/fixtures/assessment-output').response(input,{blocked:true}),input);
    assert.ok(require('../extension/challenge-format').valid(value,require('../extension/semantic-provider').responseSchema(input)),'The actual request contract is enforced.');
    return{value,audit:{phase:input.phase,outcome:'completed',requestId:options.requestId,teardown:{confirmed:true}}};
  }};
  f.runner=new ReportPreparation(root,f.options);
  t.after(async()=>{f.runner.dispose();await f.runner.loop;fs.rmSync(root,{recursive:true,force:true});});
  f.reopen=async()=>{f.runner.dispose();await f.runner.loop;f.runner=new ReportPreparation(root,f.options);await f.runner.ensure();};
  return f;
}
for(const damage of ['missing','corrupt'])test(`non-Ready ${damage} canonical record withdraws only its assessment without requests`,{skip:!native},async t=>{
  const f=await fixture(t);await f.runner.ensure();assert.equal(f.runner.status().assessed,2);assert.equal(f.runner.status().ready,0);
  const old=structuredClone(f.runner.state.resources),sibling=engine.read(f.root,'I-2'),file=path.join(f.root,'.flowboard/investigations/I-1.json');
  if(damage==='missing')fs.unlinkSync(file);else fs.writeFileSync(file,'{"invalid":');
  f.config={provider:'none'};await f.reopen();const state=f.runner.status();
  assert.equal(state.assessed,1);assert.equal(state.notAssessed,1);assert.equal(state.triageComplete,false);
  assert.deepEqual(state.assessmentCounts,{supported:1});assert.equal(state.jobs[0].assessmentAvailable,false);assert.equal(state.jobs[0].state,'failed');
  assert.deepEqual(f.runner.state.resources,old);assert.equal(f.calls.length,4);assert.deepEqual(engine.read(f.root,'I-2'),sibling);
  const read=engine.read;let reads=0;t.mock.method(engine,'read',(...args)=>{reads++;return read(...args);});
  for(let i=0;i<3;i++)f.runner.status();assert.equal(reads,0,'Status polling does not reread canonical investigations.');
});
test('catalog failure withdraws every non-Ready current assessment without inventing inconclusive results',{skip:!native},async t=>{
  const f=await fixture(t);await f.runner.ensure();assert.equal(f.runner.status().triageComplete,true);
  f.config={provider:'none'};f.options.catalog=async()=>{throw new Error('Controlled source catalog unavailable');};
  await f.runner.ensure();const state=f.runner.status();
  assert.equal(state.assessed,0);assert.equal(state.assessmentAvailable,0);assert.deepEqual(state.assessmentCounts,{});assert.equal(state.notAssessed,2);
  assert.ok(state.jobs.every(job=>job.state==='stale'&&job.reason.includes('catalog unavailable')));assert.equal(f.calls.length,4);
});
test('changed original finding text withdraws its partial assessment and preserves the unaffected sibling',{skip:!native},async t=>{
  const f=await fixture(t);await f.runner.ensure();const old=engine.read(f.root,'I-1'),boundary=structuredClone(f.runner.state.batch);
  const file=path.join(f.root,'report.md');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('## I-2:','## I-2: Revised allegation:'));
  await require('../extension/report').importReport(file,f.root,native,{deferMapping:true});
  f.runner.invalidate('Original finding text changed',{kind:'report'});
  assert.equal(automatic.complete(f.runner.state.jobs['I-1']),true,'Report invalidation also preserves unrelated non-Ready assessments.');
  assert.equal(automatic.complete(f.runner.state.jobs['I-2']),false);
  f.config={provider:'none'};await f.runner.ensure();const state=f.runner.status();
  assert.equal(state.assessed,1);assert.equal(state.notAssessed,1);assert.equal(state.ready,0);assert.equal(state.triageComplete,false);
  assert.deepEqual(engine.read(f.root,'I-1'),old);assert.equal(f.calls.length,4);
  assert.deepEqual(f.runner.state.batch,boundary,'Current coverage cannot rewrite the earlier completed automatic attempt.');
});
test('a source content change detected on reopen revokes non-Ready assessments before any new request',{skip:!native},async t=>{
  const f=await fixture(t);await f.runner.ensure();const file=path.join(f.root,'src/DeadlineWindow.sol');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('deadline = duration;','deadline = startedAt + duration;'));
  f.config={provider:'none'};await f.runner.ensure();const state=f.runner.status();
  assert.equal(state.assessed,0);assert.equal(state.notAssessed,2);assert.equal(state.assessmentAvailable,0);assert.equal(state.triageComplete,false);assert.equal(f.calls.length,4);
});
test('unreviewed observation needs fresh assessment while an unrelated checked sibling and incidental setup failure remain complete',{skip:!native},async t=>{
  const f=await fixture(t);await f.runner.ensure();const first=engine.read(f.root,'I-1'),second=engine.read(f.root,'I-2');
  first.experiments.push({id:'new-observation',claimId:'c1',sourceId:first.sources[0].id,source:first.sources[0].source,
    outcome:'passed',interpretation:'The controlled assertion needs fresh interpretation.',tests:[{name:'testChanged',status:'Success'}],command:['forge','test'],limits:[]});
  first.phase='experiment-recorded';first.revision++;engine.write(f.root,first);
  second.experiments.push({id:'incidental-setup',claimId:'c1',sourceId:second.sources[0].id,source:second.sources[0].source,
    outcome:'setup-failure',interpretation:'No property assertion executed.',tests:[{name:'setUp()',status:'Failure'}],command:['forge','test'],limits:[]});
  second.revision++;engine.write(f.root,second);
  f.config={provider:'none'};await f.runner.ensure();const state=f.runner.status();
  assert.equal(state.assessed,1);assert.equal(state.notAssessed,1);assert.equal(state.jobs[0].assessmentCompleted,false);assert.equal(state.jobs[1].assessmentCompleted,true);
  assert.equal(state.jobs[0].nextOperation.phase,'challenge');assert.deepEqual(state.assessmentCounts,{supported:1});assert.equal(f.calls.length,4);
  assert.equal(automatic.current(engine.read(f.root,'I-1'),policy.evaluate(engine.read(f.root,'I-1'))),false);
});
test('timeout before required verification is an unassessed operational stop with frozen time',{skip:!native},async t=>{
  const f=await fixture(t,1),invoke=f.options.invoke;
  f.options.invoke=async(input,options)=>{
    if(input.phase!=='challenge')return invoke(input,options);
    f.calls.push([input.finding.id,input.phase]);await f.runner.control('pause');
    throw Object.assign(new Error('Controlled required-verification timeout'),{audit:{phase:'challenge',outcome:'timeout',cleanupConfirmed:true}});
  };
  await f.runner.ensure();const state=f.runner.status(),stopped=state.batch;
  assert.equal(f.calls.length,2);assert.equal(state.assessed,0);assert.equal(state.notAssessed,1);assert.deepEqual(state.assessmentCounts,{});assert.equal(state.triageComplete,false);
  assert.equal(stopped.outcome,'incomplete');assert.ok(stopped.finishedAt);assert.ok(Number.isFinite(stopped.elapsedMs));
  f.config={provider:'none'};await f.reopen();assert.equal(f.calls.length,2);assert.deepEqual(f.runner.status().batch,stopped);
});
test('response storage failure cannot become a semantic inconclusive',{skip:!native},async t=>{
  const f=await fixture(t,1),p=require('../extension/protocol'),save=p.atomicJson;
  t.mock.method(p,'atomicJson',(root,file,...args)=>{
    if(file.startsWith('.flowboard/provider-results/'))throw Object.assign(new Error('Controlled response storage full'),{code:'ENOSPC'});
    return save(root,file,...args);
  });
  await f.runner.ensure();const state=f.runner.status();assert.equal(f.calls.length,1);assert.equal(state.assessed,0);assert.equal(state.notAssessed,1);
  assert.deepEqual(state.assessmentCounts,{});assert.equal(state.triageComplete,false);assert.equal(state.batch.outcome,'incomplete');
  assert.equal(engine.read(f.root,'I-1').failureCode,'RESPONSE_STORAGE_FAILED');assert.ok(Object.values(f.runner.state.resources.receipts)[0].finishedAt);
});
