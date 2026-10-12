'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const batch = require('../extension/batch-plan'), slots = require('../extension/provider-slots'), automatic = require('../extension/automatic-triage');
test('planning distinguishes phases, bounded maximum, configured concurrency and unknown real duration', () => {
  const jobs = Array.from({ length: 200 }, (_, i) => ({ id: String(i), requests: 0, requestLimit: 6 }));
  for (const [capacity, waves] of [[2, 200], [8, 50], [16, 25]]) {
    const plan = batch.plan(jobs, { requests: 0, limit: 1200 }, 32, capacity);
    assert.equal(plan.expectedRequests, 400); assert.equal(plan.maximumRequests, 1200);
    assert.equal(plan.effectiveConcurrency,capacity);assert.equal(plan.dependencyDepth,2);assert.equal(plan.requestWavesLowerBound,waves);
    assert.equal(plan.timing.etaMs,null);assert.match(plan.timing.basis,/no ETA/);assert.match(plan.timing.target,/few-hour/);
    assert.equal(plan.scenario,undefined,'No fixed seconds-per-request or obsolete 20/30-minute forecast is exposed.');
  }
  const serial=batch.plan(jobs.slice(0,1),{requests:0,limit:6},32,32);
  assert.equal(serial.requestWavesLowerBound,2,'Additional slots cannot parallelize one finding\'s authoring and dependent verification.');
  const configured=batch.plan(jobs,{requests:0,limit:1200},3,8);
  assert.equal(configured.effectiveConcurrency,3,'The local worker limit still bounds configured provider capacity.');
});
test('planning counts the admitted operation, not every unavailable tutorial as two requests',()=>{
  const jobs=[
    {id:'ready',publishable:true,state:'completed'},
    {id:'external',nextOperation:{kind:'evidence',phases:0}},
    {id:'local',nextOperation:{kind:'acquire',phases:0}},
    {id:'verify',nextOperation:{kind:'verify',phases:1},requests:5,requestLimit:6},
    {id:'revise',nextOperation:{kind:'revision',phases:2},requests:4,requestLimit:6},
    {id:'forbidden',nextOperation:{kind:'revision',phases:2},requests:0,requestLimit:6},
    {id:'terminal',state:'failed',requests:1,requestLimit:6}
  ];
  const plan=batch.plan(jobs,{requests:10,limit:20},2,2,job=>({available:job.id!=='forbidden'}));
  assert.equal(plan.expectedRequests,3);assert.equal(plan.maximumRequests,3);assert.equal(plan.eligible,2);
  assert.equal(plan.awaitingEvidence,1);assert.equal(plan.localActions,1);assert.equal(plan.admissionBlocked,1);
  assert.deepEqual(plan.phases,{verificationOnly:1,authoringAndVerification:1});
});
test('the shared canonical completion contract removes assessment-only jobs and keeps requested successors',t=>{
  // Unit boundary only: the production admission/currentness contract is
  // exercised through ordinary G/V in automatic-triage-batch.test.js.
  const assessed={id:'assessed',state:'completed',publishable:false,assessmentAvailable:true,
    nextOperation:{kind:'evidence',phases:0},requests:2,requestLimit:6};
  const successor={id:'successor',state:'queued',publishable:true,assessmentAvailable:true,
    checkpoint:{stage:'challenge'},nextOperation:{kind:'verify',phases:1,identity:'current-requested-successor'},requests:3,requestLimit:6};
  const unvalidated={id:'unvalidated-cache',state:'queued',assessmentAvailable:true,assessmentCompleted:true,
    assessmentProjection:{technical:{identity:'cached',result:'insufficient-evidence'}},requests:0,requestLimit:6};
  t.mock.method(automatic,'complete',job=>job===assessed);
  const plan=batch.plan([assessed,successor,unvalidated],{requests:5,limit:18},4,2,()=>({available:true}));
  assert.equal(batch.phases(assessed),0);assert.equal(plan.awaitingEvidence,0,'An admitted assessment is not waiting for external evidence solely to finish teaching.');
  assert.equal(plan.eligible,2);assert.equal(plan.expectedRequests,3);assert.equal(plan.maximumRequests,9);
  assert.deepEqual(plan.phases,{verificationOnly:1,authoringAndVerification:1});
  assert.equal(batch.owedChallenges([assessed,successor],'selected'),1,'A readable predecessor does not discharge its pending successor verification.');
  assert.equal(batch.owedChallenges([assessed,successor],'selected',()=>false),0,'The applicable phase authorization still controls owed verification.');
  const empty=batch.plan([assessed],{requests:2,limit:6},2,2);
  assert.equal(empty.expectedRequests,0);assert.equal(empty.dependencyDepth,0);assert.equal(empty.requestWavesLowerBound,0);
});
test('owed sibling checks keep running authoring and eligible checkpoints without reviving stopped work',()=>{
  const jobs=[
    {id:'selected',checkpoint:{stage:'challenge'},state:'queued'},
    {id:'generated',checkpoint:{stage:'challenge'},state:'queued'},
    {id:'active',stage:'generate',state:'running'},
    ...['blocked','failed','cancelled'].map(state=>({id:state,checkpoint:{stage:'challenge'},state}))
  ];
  assert.equal(batch.owedChallenges(jobs,'selected'),2);
  assert.equal(batch.owedChallenges(jobs,'selected',id=>id!=='active'),1);
});
test('configured shared pool admits four, waits FIFO, refuses conflicting project capacity and retains default two', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-capacity-test-')), held = [];
  t.after(() => { for (const release of held) release(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 4; i++) held.push(await slots.acquire('codex', null, { directory, capacity: 4 }));
  assert.ok(held.every(release => release.capacity.limit === 4));
  await assert.rejects(slots.acquire('codex', null, { directory, capacity: 8 }), /different shared provider capacity/);
  const order = [], abort = new AbortController();
  const a = slots.acquire('codex', abort.signal, { directory, capacity: 4, pollMs: 5 }).then(release => { order.push('a'); held.push(release); });
  const b = slots.acquire('codex', abort.signal, { directory, capacity: 4, pollMs: 5 }).then(release => { order.push('b'); held.push(release); });
  held.shift()(); await a; assert.deepEqual(order, ['a']); held.shift()(); await b; assert.deepEqual(order, ['a', 'b']);
  for (const release of held.splice(0)) release();
  const normal = await slots.acquire('codex', null, { directory }); assert.equal(normal.capacity.limit, 2); normal();
});
