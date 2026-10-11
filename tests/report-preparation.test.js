'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const preparation = require('../extension/report-preparation'), { reconcile }=preparation;
class ReportPreparation extends preparation.ReportPreparation { constructor(root,options){super(root,require('../scripts/fixtures/authoring-output').options(options));} }
const { importReport, parseReport, mapFile } = require('../extension/report');
const { analyze } = require('../extension/runner-adapter'), { SourceCatalog } = require('../extension/source');
const engine = require('../extension/investigation-engine'), policy = require('../extension/guide-policy');
const p = require('../extension/protocol');
const native = process.env.FLOWBOARD_EXTENSION_PATH;
for(const mode of ['omitted','unresolved','complete'])test(`first extraction report coverage through importer and fresh review: ${mode}`,{skip:!native},async t=>{
 const extra='\n\nA separate route `Gate.other(false)` at `src/Gate.sol:7` is also alleged to complete. The proposed change is to remove require, not the current implementation.\n';
 const source=code.replace('\n}\n','\n    function other(bool accepted) external pure { require(accepted, "other"); }\n}\n');
 const f=await fixture(t,1,undefined,reportText(1)+(mode==='complete'?'':extra),source);f.runner.dispose();await f.runner.loop;
 let calls=0;const phases=[],encode=require('../scripts/fixtures/authoring-output').encode;
 f.options.invoke=async input=>{
  calls++;phases.push(input.phase);const plain=require('../extension/packet-context').expand(input);assert.ok(plain.sources.some(s=>s.name?.includes('other')||s.code?.includes('function other'))||mode==='complete','Both original routes are supplied: '+plain.sources.map(s=>s.name).join(', '));
  const value=encode(response(input),input);
  if(input.phase==='generate'&&mode!=='complete'){
    const p=input.finding.reportParagraphs.find(p=>p.text.includes('separate route'));
    if(mode==='omitted')value.reportCoverage.dispositions=value.reportCoverage.dispositions.filter(d=>d.paragraphId!==p.id);
    else{const d=value.reportCoverage.dispositions.find(d=>d.paragraphId===p.id);d.kind='unresolved';d.claimIds=[];d.reason='The original alternate route and its asserted consequence have not been assessed.';value.causal.outcome='blocked';value.walkthrough.assessment.result='unclear';}
  }
  return{value,audit:{phase:input.phase,outcome:'completed'}};
 };
 f.options.configuration=()=>({provider:'none',requestLimit:4});f.runner=new preparation.ReportPreparation(f.root,f.options);await f.runner.ensure();
 if(mode!=='complete'){const catalog=await f.options.catalog(),{entries,report}=reconcile(f.root),draft=engine.create({findingId:'I-1',catalog,request:f.runner.request(entries[0],catalog,report),issue:f.runner.issue(entries[0])}),doc=catalog.document('src/Gate.sol'),fn=catalog.functions.find(fn=>fn.name==='other');
  draft.localPreparation={contextHash:require('../extension/review-candidate').identity(draft),requirements:[{file:'src/Gate.sol',sourceHash:engine.hash(doc.text),line:fn.startLine,endLine:fn.endLine,reason:'The original report explicitly alleges this separate route; supply its complete implementation before generation.'}]};engine.write(f.root,draft);}
 f.options.configuration=()=>({provider:'codex',requestLimit:4});await f.runner.continueFinding('I-1');const d=engine.read(f.root,'I-1'),a=policy.expose(d).assessmentProjection;
 if(mode==='omitted'){assert.ok(d.lastRejected?.validationProblems?.some(p=>p.code==='REPORT_COVERAGE_GAP')||d.error?.includes('disposition'),d.error);assert.deepEqual(phases,['generate','generate'],'The existing single response-repair allowance cannot promote an unchanged omitted route to V.');assert.equal(a.technical.result,'not-assessed');}
 else{assert.equal(calls,2,d.error);assert.equal(a.technical.result,mode==='complete'?'refuted':'insufficient-evidence');assert.equal(a.technical.coverage,mode==='complete'?'complete':'partial');assert.equal(d.publication.ready,mode==='complete');assert.ok(d.reportReview.reviewedIds.length);}
 const before=calls;await f.runner.ensure();assert.equal(calls,before);assert.deepEqual(engine.read(f.root,'I-1').reportCoverage,d.reportCoverage);
});
test('owned mixed workload isolates repeated job deadlines but distinct failed peers open the shared circuit',{skip:!native},async t=>{
 const f=await fixture(t,3),health=require('../extension/provider-health');f.options.providerResources={directory:path.join(f.root,'health')};
 f.options.configuration=()=>({provider:'codex',workers:1,requestLimit:18});let slow=0;
 const invoke=async(input,options)=>{
  f.calls.push([input.finding.id,input.phase]);
  if(input.finding.id==='I-1'){slow++;throw Object.assign(Error('Controlled job deadline'),{code:'PROVIDER_TIMEOUT',retryable:true,audit:{requestId:options.requestId,phase:input.phase,outcome:'timeout',failureKind:'timeout',finishedAt:new Date().toISOString(),teardown:{confirmed:true}}});}
  return{value:response(input),audit:{requestId:options.requestId,phase:input.phase,outcome:'completed',teardown:{confirmed:true}}};
 };invoke.isProviderTransport=true;f.options.invoke=invoke;await f.runner.ensure();
 assert.equal(slow,2);assert.ok(f.runner.artifact('I-2'));assert.ok(f.runner.artifact('I-3'));assert.equal(health.status('codex',f.options.providerResources).open,false);
 for(const [i,jobKey]of ['peer-a','peer-b'].entries())await health.record('codex',{requestId:'wide-'+i,outcome:'timeout',failureKind:'timeout',teardown:{confirmed:true}},{...f.options.providerResources,jobKey});
 assert.equal(health.status('codex',f.options.providerResources).open,true);await health.record('codex',{outcome:'completed',requestId:'late'},f.options.providerResources);assert.equal(health.status('codex',f.options.providerResources).open,true);
});
// Independently readable fictional behavior: require(false) reverts. No state
// writes exist. Controlled responses test scheduling/reference plumbing only.
const code = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Gate {\n    function finish(bool accepted) external pure {\n        require(accepted, "rejected");\n    }\n}\n';
const reportText = count => '# Findings\n\n## Found by 2 phases\nThese findings were reported twice.\n\n' + Array.from({ length: count }, (_, i) => `### I-${i + 1}: Gate.finish completes with accepted=false\n**Severity**: Informational\n\nThe report says Gate.finish(false) completes normally instead of reverting.\n`).join('\n');
function response(input) {
  const unit = input.sources.find(item => item.name === 'Gate::finish');
  const quote = '        require(accepted, "rejected");', note = 'When accepted is false, require reverts the call. It cannot complete normally under the reported condition.';
  const obligations = ['applicability', 'entry', 'conditions', 'behavior', 'settlement', 'rule', 'impact', 'counterevidence'].map(kind => ({ id: kind, claimId: 'c1', kind,
    question: `Check ${kind}`, state: 'established', reason: note, evidence: ['guard'], documentation: [] }));
  const checks = [...obligations.map(item => item.id), 'event'].map(target => ({ target, reason: note, evidence: ['guard'], documentation: [] }));
  const reviews = [{ evidenceId: 'guard', result: 'kept', reason: note, checkedSourceIds: [unit.id] }];
  if (input.checkOnly) return { result: 'kept', problems: [], explanationReviews: reviews, checks };
  return { property: { text: 'The report alleges normal completion for a false accepted input.', basis: 'report-assumption', evidence: [], documentation: [] },
    claims: [{ id: 'c1', allegation: 'The false-accepted invocation completes normally.', actor: 'Caller', entry: unit.id, implementation: 'Gate.finish(bool)', conditions: ['accepted is false'],
      requiredFacts: ['The false condition would need to pass require.'], supportsIf: 'Normal return.', contradictsIf: 'Revert on the stated input.', status: 'contradicted', reason: note, evidence: ['guard'], unknowns: [], nextQuestion: '' }],
    evidence: [{ id: 'guard', claimId: 'c1', sourceId: unit.id, line: 5, endLine: 5, quote, stance: 'contradicts', explanation: note }],
    explanationReviews: input.phase === 'challenge' ? reviews : [], transitions: [], questions: [],
    conclusion: { status: 'contradicted-in-scope', text: note, limitations: [] },
    walkthrough: { steps: [{ evidenceId: 'guard', title: 'The guard rejects false', paragraphId: '', phrase: '' }], assessment: { result: 'invalid', why: note, supportingEvidence: '', opposingEvidence: 'guard' } },
    causal: { scope: 'The supplied Gate.finish(false) source behavior; no executed test.', summary: note, outcome: 'refuted', obligations,
      events: [{ id: 'event', invocationId: 'finish-1', transaction: 'tx1', phase: 'guard', claimId: 'c1', evidenceId: 'guard', callSiteId: '', title: 'False does not pass the guard', role: 'Decisive contradiction',
        actor: 'Caller', caller: 'msg.sender', receiver: 'Gate', conditions: ['accepted is false'], what: note, why: 'The reported normal completion is prevented by this guard.', inputs: [], changes: [], effect: 'rolled-back', paragraphId: '', phrase: '' }], relationships: [], order: ['event'], checks: input.phase === 'challenge' ? checks : [] }
  };
}
async function fixture(t, count = 3, invoke, report = reportText(count), source = code, extraFiles={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-report-jobs-'));
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/Gate.sol'), source); fs.writeFileSync(path.join(root, 'report.md'), report);
  for(const [file,text]of Object.entries(extraFiles)){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);}
  await importReport(path.join(root, 'report.md'), root, native, { deferMapping: true });
  const result = await analyze(native, root, { mode: 'source' }); let catalog = new SourceCatalog(root, result.runner, result.result);
  const calls = [], updates = [];
  const options = { configuration: () => ({ provider: 'codex', requestLimit: count * 4 }), catalog: async () => catalog,
    changed: status => updates.push(status), invoke: async input => { calls.push([input.finding.id, input.phase, input.checkOnly]); return { value: invoke ? await invoke(input, calls) : response(input), audit: { phase: input.phase, outcome: 'completed', provider: 'controlled-fixture' } }; } };
  const runner = new ReportPreparation(root, options);
  t.after(async () => { runner.dispose(); await runner.loop; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, options, runner, calls, updates, getCatalog:()=>catalog, replaceCatalog: value => catalog = value };
}
for(const outcome of ['timeout','completed','setup-failure'])test(`supported regression handler handles ${outcome} with exact currentness and saved reopen`,{skip:!native},async t=>{
 const file='test/Observation.t.sol',source='pragma solidity ^0.8.20;\nimport {Gate} from "../src/Gate.sol";\ncontract Observation {\n // I-1: existing Gate regression setup\n function testGate() external pure {\n  assert(true);\n }\n}\n';
 const f=await fixture(t,1,undefined,reportText(1)+'\nExisting local test context: `test/Observation.t.sol:3-5` (`Observation.testGate`).\n',code,{[file]:source});
 await f.runner.ensure();const draft=engine.read(f.root,'I-1'),technical=require('../extension/technical-assessment');assert.equal(technical.current(draft),true);
 const unit=draft.sources.find(u=>u.source.file===file);assert.ok(unit,'The actual initial packet acquired the referenced existing test');
 const oldReview=structuredClone(draft.technicalReview),projections=[],{TriageBoard}=require('../extension/board'),issue=require('../extension/store').readIssue(f.root,'I-1');
 const {report,entries}=reconcile(f.root),entry=entries.find(i=>i.id==='I-1');
 const model={id:'I-1',investigationDraft:draft,catalog:f.getCatalog(),request:f.runner.request(entry,f.getCatalog(),report),issue:f.runner.issue(entry)};
 const board=Object.assign(Object.create(TriageBoard.prototype),{root:f.root,callbacks:{},investigationCurrent:()=>true,assertCurrent:()=>f.getCatalog().assertFresh(),
  vscode:{window:{showWarningMessage:async()=> 'Run existing regression'}},
  publishInvestigation:async(m,d)=>{m.investigationDraft=d;projections.push(policy.expose(d).assessmentProjection);},startInvestigation:async()=>f.runner.continueFinding('I-1')});
 const experiment=require('../extension/experiment');
 t.mock.method(experiment,'run',async(u,options)=>({id:'observed',sourceId:u.id,source:u.source,claimId:options.claimId,origin:'executed-observation',outcome:outcome==='setup-failure'?'setup-failure':'passed',interpretation:'Controlled existing assertion result, not proof of a finding.',tests:[outcome==='setup-failure'?{name:'setUp()',status:'Failure'}:{name:'testGate()',status:'Success'}],command:['forge',...experiment.command(u)],limits:['Fictional controlled setup']}));
 f.options.invoke=async input=>{f.calls.push([input.finding.id,input.phase,input.checkOnly]);assert.equal(input.experiments.at(-1).id,'observed');assert.equal(input.checkOnly,true);
  if(outcome==='completed')return{value:response(input),audit:{phase:'challenge',outcome:'completed',provider:'controlled-fixture'}};
  await f.runner.control('pause');throw Object.assign(Error('Controlled timeout after observation'),{audit:{outcome:'timeout',phase:'challenge',cleanupConfirmed:true}});};
 await board.runInvestigationTest(model,{sourceId:unit.id,claimId:'c1'});
 assert.equal(projections.at(-1).technical.result,outcome==='setup-failure'?'refuted':'not-assessed');if(outcome!=='setup-failure')assert.match(projections.at(-1).technical.why,/interpretation/);
 const reopened=engine.read(f.root,'I-1');assert.equal(reopened.experiments.at(-1).id,'observed');assert.equal(technical.current(reopened),outcome!=='timeout');
 assert.equal(policy.expose(reopened).assessmentProjection.technical.result,outcome!=='timeout'?'refuted':'not-assessed');
 if(outcome!=='completed')assert.deepEqual(reopened.technicalReview,oldReview);else assert.notEqual(reopened.technicalReview.identity,oldReview.identity);
 assert.equal(f.calls.length,outcome==='setup-failure'?2:3,JSON.stringify({phase:reopened.phase,error:reopened.error}));
 const prior=reopened.runs[1].retainedResponse;assert.ok(prior.archive);
 const retained=JSON.parse(fs.readFileSync(path.join(f.root,prior.archive),'utf8'));
 assert.equal(retained.hash,prior.hash);assert.deepEqual(retained.input.experiments,[],'The old paid-equivalent response is retained against its own observation set');
 const calls=f.calls.length;engine.read(f.root,'I-1');assert.equal(f.calls.length,calls,'Opening cannot repeat the timed-out check');
});
function candidatePatch(value) {
  value=structuredClone(value);delete value.walkthrough.steps;
  return {mode:'candidate-patch-v1',updates:Object.entries(value).filter(([key])=>!['inputReviews','explanationReviews'].includes(key)).map(([key,item])=>({path:'/'+key,valueJSON:JSON.stringify(item)}))};
}
test('selected local recheck works with exhausted allowance and provider none without resuming siblings',{skip:!native},async t=>{
  const f=await fixture(t,2);f.options.configuration=()=>({provider:'codex',requestLimit:8,workers:1});
  f.options.invoke=async input=>{f.calls.push(input.phase);await f.runner.control('pause');return{value:response(input),audit:{phase:input.phase,outcome:'completed'}};};
  await f.runner.continueFinding('I-1');const before=structuredClone(f.runner.state),draft=engine.read(f.root,'I-1');
  draft.phase='blocked';draft.failureKind='local-reading';draft.failureCode='LOCAL_PACKET_LIMIT';draft.revision++;engine.write(f.root,draft);
  f.runner.state.resources.limit=f.runner.state.resources.requests;f.runner.state.jobs['I-1'].requestLimit=f.runner.state.jobs['I-1'].requests;f.runner.save();
  f.options.configuration=()=>({provider:'none'});let calls=f.calls.length;
  await f.runner.continueFinding('I-1',{recheckLocalPreparation:true});
  const saved=engine.read(f.root,'I-1');assert.equal(saved.phase,'local-preparation-ready',saved.error);assert.equal(f.calls.length,calls);
  assert.equal(f.runner.state.resources.requests,before.resources.requests);assert.deepEqual(f.runner.state.resources.receipts,before.resources.receipts);
  assert.equal(f.runner.state.jobs['I-2'].requests,0);assert.equal(f.runner.state.jobs['I-1'].repairAvailable,false);
  await f.runner.ensure();assert.equal(f.calls.length,calls);assert.equal(engine.read(f.root,'I-1').localPreparation.preflight.dispatchable,true);
});
function checkedCandidate(input) {
  const value=response({...input,checkOnly:true});value.inputReviews=[];
  value.explanationReviews=value.explanationReviews.map(item=>{
    const change=input.candidateRevisions.changes.find(c=>c.path==='/evidence/'+item.evidenceId);
    return {...item,result:change?change.before?'repaired':'added':'kept'};
  });
  value.checks.push(...input.candidateRevisionTargets.map(target=>({target,reason:'The full supplied false guard provides the requested source behavior while preserving the original allegation and condition.',evidence:['guard'],documentation:[]})));
  return value;
}
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:(...args)=>resolve(...args)};};
test('completed provider receipt survives checkpoint ENOSPC without acceptance or another reservation',{skip:!native},async t=>{
  const f=await fixture(t,1),atomic=p.atomicJson;let failed=0;
  t.mock.method(p,'atomicJson',(root,file,...args)=>{
    if(root===f.root&&file.startsWith('.flowboard/provider-results/')){failed++;throw Object.assign(Error('controlled checkpoint full'),{code:'ENOSPC'});}
    return atomic(root,file,...args);
  });
  await f.runner.ensure();
  assert.equal(f.calls.length,1);assert.equal(failed,1);assert.equal(f.runner.state.resources.requests,1);
  const receipts=Object.values(p.readWorkspaceJson(f.root,'.flowboard/report-preparation.json').resources.receipts);
  assert.equal(receipts.length,1);assert.equal(receipts[0].outcome,'completed');assert.ok(receipts[0].finishedAt);
  assert.equal(receipts[0].audit.responseStorage.state,'failed');assert.equal(receipts[0].hostAcceptedAt,undefined);
  assert.equal(engine.read(f.root,'I-1').claims.length,0);assert.equal(f.runner.status().ready,0);
  assert.equal(f.runner.state.jobs['I-1'].failureKind,'storage');
});
for(const receiptFault of [false,true,'followup'])test(`ordinary coordinator repairs a retained rejection once and recovers terminal storage (${receiptFault||'normal'})`,{skip:!native},async t=>{
  const stages=[],f=await fixture(t,2);let original,failReceipt=false;
  const atomic=p.atomicJson;t.mock.method(p,'atomicJson',function(root,file,value){
    if(failReceipt&&file==='.flowboard/report-preparation.json'&&Object.values(value.resources?.receipts||{}).some(r=>r.reviewPurpose==='rejected-proposal-repair'&&r.finishedAt)){
      failReceipt=false;throw Object.assign(Error('controlled terminal receipt ENOSPC'),{code:'ENOSPC'});
    }return atomic(root,file,value);
  });
  f.options.invoke=async (input,options)=>{
    stages.push([input.finding.id,input.reviewPurpose||input.phase]);
    let value=response(input);
    if(input.finding.id==='I-1'&&input.phase==='generate'){
      value.inputReviews=[];delete value.walkthrough.steps;
      value.claims.push({...structuredClone(value.claims[0]),id:'c2',allegation:'The same false call settles successfully.'});
      value.causal.obligations.push(...value.causal.obligations.map(o=>({...o,id:o.id+'-second',claimId:'c2'})));original=structuredClone(require('../scripts/fixtures/authoring-output').encode(value,input));
    } else if(['rejected-proposal-repair','rejected-proposal-followup'].includes(input.reviewPurpose)){
      const note={...input.earlierDraft.evidence[0],id:'guard-second',claimId:'c2'};
      value={mode:'candidate-patch-v1',updates:[{path:'/evidence/guard-second',valueJSON:JSON.stringify(note)},{path:'/claims/c2/evidence',valueJSON:'["guard-second"]'},
        ...input.earlierDraft.causal.obligations.filter(o=>o.claimId==='c2').map(o=>({path:'/causal/obligations/'+o.id+'/evidence',valueJSON:'["guard-second"]'}))]};f.runner.control('pause');failReceipt=receiptFault===true;
      if(receiptFault==='followup'&&input.reviewPurpose==='rejected-proposal-repair')value={mode:'candidate-edit-v2',edits:[
        {op:'add',target:'/questions',value:{id:'read-guard',claimId:'c1',text:'Read the exact finish guard.',action:'symbol',target:'Gate::finish',why:'Inspect the normal completion prerequisite.'}},
        {op:'add',target:'/evidence',value:{id:'bad-selection',claimId:'c1',stance:'context',explanation:'Not accepted.',selection:{sourceId:input.sources[0].id,sourceHash:'0'.repeat(64),line:5,endLine:5}}}]};
    } else if(input.reviewPurpose==='candidate-verification'){
      value={result:'kept',problems:[],inputReviews:[],explanationReviews:input.earlierDraft.evidence.map(e=>({evidenceId:e.id,result:e.id==='guard'?'kept':'added',reason:e.explanation,checkedSourceIds:[e.sourceId]})),
        checks:[...require('../extension/review-capacity').targets(input.earlierDraft.causal).map(t=>t.key),...input.candidateRevisionTargets].map(target=>({target,reason:'The require(false) guard reverts before any normal settlement for both claims.',evidence:['guard','guard-second'],documentation:[]}))};
    }
    return{value,audit:{phase:input.phase,requestId:options.requestId,outcome:'completed',teardown:{confirmed:true}}};
  };
  await f.runner.ensure();assert.ok(f.runner.artifact('I-2'));const before=f.runner.state.resources.requests;
  assert.equal(engine.read(f.root,'I-1').claims.length,0);assert.ok(f.runner.status().jobs.find(j=>j.id==='I-1').repairAvailable);
  await f.runner.ensure();assert.equal(f.runner.state.resources.requests,before,'Unchanged local replay is unpaid.');
  const a=f.runner.continueFinding('I-1',{repairSavedAnalysis:true}),b=f.runner.continueFinding('I-1',{repairSavedAnalysis:true});await Promise.all([a,b]);
  if(receiptFault==='followup'){
    const failed=engine.read(f.root,'I-1'),used=f.runner.state.resources.requests,count=stages.length;
    assert.equal(failed.reviewCandidate,undefined);assert.equal(failed.currentRejection.reviewPurpose,'rejected-proposal-repair');
    assert.equal(f.runner.state.jobs['I-1'].validationProblems[0].code,'SOURCE_SELECTION_VERSION');
    assert.equal(failed.currentRejection.materialQuestions[0].id,'read-guard');
    assert.ok(f.runner.state.jobs['I-1'].missingInputs.some(q=>q.id==='read-guard'));
    assert.ok(f.runner.state.jobs['I-1'].rejectionHistory.some(r=>r.validationProblems.some(p=>p.code==='REVIEW_REFERENCE_SCOPE')));
    await f.runner.ensure();assert.equal(stages.length,count);assert.equal(f.runner.state.resources.requests,used);
    const authorization={id:'unique-owned-followup',responseHash:failed.currentRejection.responseHash};
    await f.runner.continueFinding('I-1',{recheckLocalPreparation:true,followupAuthorization:authorization});
    const prepared=engine.read(f.root,'I-1');assert.equal(prepared.rejectedProposal.state,'repair-dispatched');assert.equal(prepared.rejectedProposal.followup.state,'pending');
    assert.ok(prepared.actions.some(a=>a.questionId==='read-guard'&&a.sourceIds.length),'Rejected typed question reaches ordinary local acquisition.');
    assert.deepEqual(prepared.rejectedProposal.proposal,failed.rejectedProposal.proposal,'Hints never install rejected edits.');
    assert.equal(stages.length,count);assert.equal(f.runner.state.resources.requests,used);assert.equal(prepared.pendingResponse,undefined);
    const archive=prepared.rejectedProposal.followup.archive;
    const retained=require('../extension/provider-result').read(f.root,'I-1',archive,{phase:'challenge',snapshot:prepared.snapshot,corrections:prepared.corrections,previous:archive.previous});
    assert.equal(engine.hash(retained.result.value),authorization.responseHash);
    await Promise.all([f.runner.continueFinding('I-1'),f.runner.continueFinding('I-1')]);
    assert.equal(stages.filter(s=>s[1]==='rejected-proposal-followup').length,1);
    const candidate=engine.read(f.root,'I-1');assert.ok(candidate.reviewCandidate,candidate.error);
    assert.equal(candidate.rejectedProposal.followup.state,'dispatched');assert.equal(candidate.reviewCandidate.acceptedBase,undefined);
    assert.deepEqual(require('../extension/provider-result').read(f.root,'I-1',archive,{phase:'challenge',snapshot:candidate.snapshot,corrections:candidate.corrections,previous:archive.previous}).result.value,retained.result.value);
    assert.ok(candidate.reviewCandidate.lineage[0].authoringMapping.selections.length);
  }
  if(receiptFault===true){
    assert.equal(engine.read(f.root,'I-1').failureCode,'RECEIPT_STORAGE_FAILED');
    const used=f.runner.state.resources.requests,called=stages.length;
    f.runner.dispose();await f.runner.loop;f.runner=new ReportPreparation(f.root,f.options);
    await f.runner.ensure();
    assert.equal(stages.length,called);assert.equal(f.runner.state.resources.requests,used);
    const receipt=Object.values(f.runner.state.resources.receipts).find(r=>r.reviewPurpose==='rejected-proposal-repair');
    assert.equal(receipt.outcome,'completed');assert.ok(receipt.finishedAt);assert.ok(f.runner.artifact('I-2'));
  }
  const draft=engine.read(f.root,'I-1');assert.ok(draft.reviewCandidate,draft.error);assert.equal(draft.claims.length,0);assert.equal(f.runner.artifact('I-1'),null);assert.ok(f.runner.artifact('I-2'));
  assert.equal(f.runner.state.jobs['I-1'].hasPrivateCandidate,true);assert.equal(f.runner.state.jobs['I-1'].retainedRejection,false,'A completed private repair can offer verification, not another link-repair action.');
  const old=require('../extension/provider-result').read(f.root,'I-1',draft.rejectedProposal.original,{phase:'generate',snapshot:draft.snapshot,corrections:draft.corrections,previous:null});assert.deepEqual(old.result.value,original);
  await f.runner.continueFinding('I-1');assert.ok(f.runner.artifact('I-1'),engine.read(f.root,'I-1').error);
  assert.deepEqual(stages.filter(s=>s[0]==='I-1').map(s=>s[1]),['generate','rejected-proposal-repair',...(receiptFault==='followup'?['rejected-proposal-followup']:[]),'candidate-verification']);
  assert.equal(f.runner.state.jobs['I-1'].requests,receiptFault==='followup'?4:3);assert.equal(f.runner.state.jobs['I-2'].requests,2);
  const count=stages.length;f.options.configuration=()=>({provider:'none'});await f.runner.ensure();assert.equal(stages.length,count);
});
async function seedCorrectionRace(t,findingRequestLimit=6) {
  const f=await fixture(t,2);f.options.configuration=()=>({provider:'codex',workers:1,requestLimit:12,findingRequestLimit});
  f.runner.prioritize('I-1');
  f.options.invoke=async input=>{
    f.calls.push([input.finding.id,input.phase,input.reviewPurpose]);
    let value=response(input);
    if(input.phase==='generate')value.questions=[{id:'guard-question',claimId:'c1',text:'Interpret the local guard.',action:'inspect',target:value.evidence[0].sourceId,why:'The guard is decisive.'}];
    if(input.candidateOnly){value=candidatePatch(response({...input,checkOnly:false}));f.runner.control('pause');}
    return {value,audit:{phase:input.phase,outcome:'completed'}};
  };
  await f.runner.continueFinding('I-1');
  assert.equal(engine.read(f.root,'I-1').reviewCandidate.state,'awaiting-verification');
  assert.equal(f.calls.length,2);return f;
}
test('completed negative candidate verification exposes exact feedback and a terminal cycle on reopen without more requests',{skip:!native},async t=>{
  const f=await seedCorrectionRace(t),problems=['Clarify the guard condition without changing the reported scope.','Do not describe a reverted intermediate effect as committed.'];
  f.options.invoke=async (input,options)=>{
    f.calls.push([input.finding.id,input.phase,input.reviewPurpose]);
    const value=input.candidateOnly?candidatePatch(response({...input,checkOnly:false})):checkedCandidate(input);
    if(input.checkOnly){value.result='repair';value.problems=problems;}
    return{value,audit:{phase:input.phase,outcome:'completed',requestId:options.requestId}};
  };
  await f.runner.continueFinding('I-1');
  assert.equal(engine.read(f.root,'I-1').reviewCandidate.state,'repair-requested');
  await f.runner.continueFinding('I-1');
  const draft=engine.read(f.root,'I-1'),job=f.runner.state.jobs['I-1'];
  assert.equal(draft.reviewCandidate.state,'terminal',draft.error);
  assert.equal(job.privateCandidateState,'terminal');assert.equal(job.verificationCompletion.result,'repair');
  assert.equal(f.runner.status().jobs.find(j=>j.id==='I-1').privateCandidateState,'terminal','The ordinary webview DTO must carry lifecycle eligibility, not only the private journal.');
  assert.equal(job.verificationCompletion.published,false);assert.equal(job.assessmentProjection.technical.result,'not-assessed');
  assert.deepEqual(job.validationProblems.filter(p=>p.target==='/reviewCandidate').map(p=>p.message),problems);assert.ok(job.validationProblems.every(p=>p.code==='CANDIDATE_VERIFICATION_REPAIR'));
  assert.ok(job.validationProblems.some(p=>p.target.startsWith('/evidence/')&&p.source),'Known note feedback must open exact code; unbound summary prose gets no guessed anchor.');
  const calls=f.calls.length,used=job.requests,exact=structuredClone(draft.reviewCandidate);
  f.options.configuration=()=>({provider:'none'});await f.runner.ensure();
  assert.equal(f.calls.length,calls);assert.equal(f.runner.state.jobs['I-1'].requests,used);assert.deepEqual(engine.read(f.root,'I-1').reviewCandidate,exact);
  const mismatched=structuredClone(draft);mismatched.reviewCandidate.verification.candidateHash='other-artifact';const projected={};
  f.runner.recoveryStatus(projected,mismatched);assert.equal(projected.verificationCompletion,null,'A received check cannot be attributed to another candidate.');
});
for(const limit of [6,8])test(`explicit terminal successor uses ordinary capacity and immutable history (${limit})`,{skip:!native},async t=>{
  const f=await seedCorrectionRace(t,limit);
  let reject=true,authoringFeedback;
  f.options.invoke=async(input,options)=>{
    f.calls.push([input.finding.id,input.phase,input.reviewPurpose]);
    let value;
    if(input.candidateOnly){
      authoringFeedback=input.hostReview;const next=response({...input,checkOnly:false});
      if(!reject)next.evidence[0].explanation+=' The false guard prevents a committed effect in this transaction.';
      value=candidatePatch(next);
    }else{value=checkedCandidate(input);if(reject){value.result='repair';value.problems=['Reconcile the guard and committed-effect explanation.'];}}
    return{value,audit:{phase:input.phase,outcome:'completed',requestId:options.requestId,teardown:{confirmed:true}}};
  };
  await f.runner.continueFinding('I-1');await f.runner.continueFinding('I-1');
  const before=engine.read(f.root,'I-1'),parent=structuredClone(before.reviewCandidate),used=f.runner.state.jobs['I-1'].requests,calls=f.calls.length;
  assert.equal(parent.state,'terminal');assert.equal(used,5);
  const revision={id:'explicit-revision',candidateHash:parent.candidateHash,feedbackHash:require('../extension/review-feedback').current(parent).responseHash,feedbackRequestId:parent.verification.requestId,reason:'Reconcile the exact verifier objection about the guarded transaction effect.'};
  const later=structuredClone(before);later.reviewCandidate.verification.requestId='later-identical-review';
  assert.throws(()=>require('../extension/review-candidate').revise(later,require('../extension/semantic-provider').schema,revision),/current terminal review/,'An old UI cannot revise a different verifier attempt even if its candidate and response bytes happen to match.');
  reject=false;
  await Promise.all([f.runner.continueFinding('I-1',{reviseAnalysis:revision}),f.runner.continueFinding('I-1',{reviseAnalysis:revision})]);
  const after=engine.read(f.root,'I-1');
  if(limit===6){assert.deepEqual(after.reviewCandidate,parent);assert.equal(f.calls.length,calls);assert.match(f.runner.state.jobs['I-1'].reason,/remaining finding\/report requests: 1\//);}
  else{
    assert.equal(f.calls.length,calls+2,after.error);assert.equal(f.runner.state.jobs['I-1'].requests,used+2);
    assert.deepEqual(after.revisionPredecessors[0].candidate,parent);assert.equal(after.revisionPredecessors[0].id,revision.id);
    assert.deepEqual(authoringFeedback.response,parent.verification.response);assert.ok(f.runner.artifact('I-1'),after.error);
    assert.equal(after.candidateHistory.at(-1).repairCount,2,'Lifetime repair accounting is monotonic, not reset for the successor.');
    await f.runner.continueFinding('I-1',{reviseAnalysis:revision});assert.equal(f.calls.length,calls+2);
  }
  const finalCalls=f.calls.length;f.options.configuration=()=>({provider:'none'});await f.runner.ensure();assert.equal(f.calls.length,finalCalls);
  if(limit===6)assert.match(f.runner.revisionEligibility(f.runner.state.jobs['I-1'],engine.read(f.root,'I-1')).reason,/remaining finding\/report requests: 1\//,'Provider-none inspection must not imply that enabling a provider alone funds the missing pair.');
  assert.deepEqual(engine.read(f.root,'I-1').corrections,before.corrections);
});
function correctThroughBoard(f) {
  const model={id:'I-1',investigationDraft:engine.read(f.root,'I-1')};
  const board={root:f.root,callbacks:{reportPreparation:()=>f.runner},investigationCurrent:()=>true,publishInvestigation:async(m,d)=>m.investigationDraft=d};
  return require('../extension/board').TriageBoard.prototype.correctInvestigation.call(board,model,{revision:model.investigationDraft.revision,
    change:{claimId:'c1',field:'conditions',value:'Only accepted=false is the reported path.',reason:'Keep the reported condition explicit.'}});
}
test('active batch saves a queued finding correction before its held sibling settles and only explicit continuation sees new premises',{skip:!native},async t=>{
  const f=await seedCorrectionRace(t),entered=deferred(),held=deferred();
  f.options.invoke=async input=>{f.calls.push([input.finding.id,input.phase,input.reviewPurpose]);if(input.finding.id==='I-2'&&input.phase==='generate'){entered.resolve();await held.promise;}return{value:response(input),audit:{phase:input.phase,outcome:'completed'}};};
  f.runner.prioritize('I-2');const running=f.runner.control('resume');await entered.promise;
  try {
    await Promise.race([correctThroughBoard(f),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Correction waited for sibling loop')),2000);timer.unref();})]);
    const saved=engine.read(f.root,'I-1'),journal=p.readWorkspaceJson(f.root,'.flowboard/report-preparation.json',8*1024*1024);
    assert.equal(saved.phase,'corrected');assert.equal(saved.corrections.length,1);assert.equal(saved.reviewCandidate,undefined);
    assert.equal(journal.jobs['I-1'].correctionHold.state,'applied');assert.equal(journal.jobs['I-1'].requests,2);
    assert.equal(journal.jobs['I-2'].requests,1);assert.equal(f.runner.tasks.get('I-2').abort.signal.aborted,false);
  } finally {held.resolve();await running;}
  assert.equal(f.calls.filter(c=>c[0]==='I-1').length,2);assert.ok(f.runner.artifact('I-2'));
  f.runner.dispose();await f.runner.loop;
  f.runner=new ReportPreparation(f.root,{...f.options,configuration:()=>({provider:'none'}),invoke:()=>assert.fail('Reopen is local')});
  t.after(()=>f.runner.dispose());await f.runner.ensure();assert.equal(engine.read(f.root,'I-1').corrections.length,1);assert.ok(f.runner.artifact('I-2'));
  assert.equal(engine.read(f.root,'I-1').phase,'corrected');
  let seen;const seenStages=[];
  f.runner.options.configuration=()=>({provider:'codex',requestLimit:12});
  f.runner.options.invoke=async input=>{seen=input;seenStages.push([input.phase,input.reviewPurpose]);throw Object.assign(Error('Controlled stop after explicit continuation capture'),{code:'REPORT_PAUSED'});};
  await f.runner.continueFinding('I-1');assert.deepEqual(seenStages,[['challenge','candidate-completion']]);
  assert.ok(JSON.stringify(seen).includes('Only accepted=false is the reported path.'));assert.equal(f.runner.state.jobs['I-1'].requests,3);
});
test('active finding correction retains a late answer without approving it and leaves unconfirmed cleanup held',{skip:!native},async t=>{
  for(const cleanup of [true,false]){
    const f=await seedCorrectionRace(t),entered=deferred(),held=deferred();
    f.options.invoke=async(input,options)=>{
      f.calls.push([input.finding.id,input.phase,input.reviewPurpose]);
      if(input.finding.id==='I-1'){entered.resolve();await held.promise;assert.equal(options.signal.aborted,true);return {value:checkedCandidate(input),audit:{phase:'challenge',requestId:options.requestId,outcome:'completed',teardown:{confirmed:cleanup}}};}
      return {value:response(input),audit:{phase:input.phase,outcome:'completed'}};
    };
    const running=f.runner.continueFinding('I-1');await entered.promise;
    const correction=correctThroughBoard(f);
    assert.equal(p.readWorkspaceJson(f.root,'.flowboard/report-preparation.json',8*1024*1024).jobs['I-1'].correctionHold.state,'pending');
    held.resolve();
    if(cleanup)await correction;else await assert.rejects(correction,/cleanup is unconfirmed/);
    await running;
    const job=f.runner.state.jobs['I-1'],receipt=f.runner.state.resources.receipts[job.correctionHold.reservationId];
    assert.equal(job.requests,3);assert.ok(receipt.audit.retainedResponse);assert.equal(f.runner.artifact('I-1'),null);
    const retained=receipt.audit.retainedResponse,archived=fs.readFileSync(path.join(f.root,retained.archive),'utf8');
    assert.equal(JSON.parse(archived).hash,retained.hash);
    require('../extension/provider-result').save(f.root,'I-1',{input:{phase:'generate'},result:{value:{later:true}},units:[],snapshot:{},corrections:[],previous:null});
    assert.equal(fs.readFileSync(path.join(f.root,retained.archive),'utf8'),archived,'A later response checkpoint cannot erase this superseded paid answer.');
    const saved=engine.read(f.root,'I-1');assert.equal(policy.gate(saved).ready,false);
    assert.equal(saved.corrections.length,cleanup?1:0);assert.equal(job.correctionHold.state,cleanup?'applied':'pending');
    if(!cleanup){await f.runner.continueFinding('I-1');assert.equal(job.requests,3);assert.equal(job.correctionHold.state,'pending');}
  }
});
test('a durable correction intent survives host reload and settles locally without reserving a request',{skip:!native},async t=>{
  const f=await seedCorrectionRace(t),draft=engine.read(f.root,'I-1');
  f.runner.holdCorrection('I-1',draft,{claimId:'c1',field:'conditions',value:'The false input is the sole reported condition.',reason:'Saved before host shutdown.'});
  assert.equal(engine.read(f.root,'I-1').corrections.length,0);
  f.runner.dispose();await f.runner.loop;
  f.runner=new ReportPreparation(f.root,{...f.options,configuration:()=>({provider:'none'}),invoke:()=>assert.fail('Recovery must not invoke a provider')});
  t.after(()=>f.runner.dispose());await f.runner.ensure();
  const recovered=engine.read(f.root,'I-1');
  assert.equal(recovered.corrections.length,1);assert.equal(recovered.corrections[0].value,'The false input is the sole reported condition.');
  assert.equal(recovered.claims[0].conditions[0],'accepted is false');assert.equal(recovered.claims[0].needsReassessment,true);
  assert.equal(recovered.reviewCandidate,undefined);assert.equal(f.runner.state.jobs['I-1'].correctionHold.state,'applied');
  assert.equal(f.runner.state.jobs['I-1'].requests,2);assert.equal(f.runner.artifact('I-1'),null);
  await f.runner.ensure();assert.equal(engine.read(f.root,'I-1').corrections.length,1);assert.equal(f.runner.state.resources.requests,2);
});
test('active correction cancels only its actual owned local child with confirmed cleanup',{skip:!native},async t=>{
  const f=await seedCorrectionRace(t),entered=deferred();let childPid;
  const resources=fs.mkdtempSync(path.join(os.tmpdir(),'correction-provider-'));t.after(()=>fs.rmSync(resources,{recursive:true,force:true}));
  f.options.providerResources={directory:resources};
  f.options.invoke=async(input,options)=>require('../extension/semantic-provider').runCodex(input,{...options,timeoutMs:5000,
    spawn:(_exe,_args,settings)=>{
      const child=require('node:child_process').spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"local-correction-control"})+"\\n");setInterval(()=>{},1000);});'],settings);
      childPid=child.pid;child.stdout.once('data',()=>entered.resolve());return child;
    }});
  f.options.invoke.isProviderTransport=true;
  const running=f.runner.continueFinding('I-1');await entered.promise;
  await correctThroughBoard(f);await running;
  const job=f.runner.state.jobs['I-1'],receipt=f.runner.state.resources.receipts[job.correctionHold.reservationId];
  assert.equal(receipt.audit.teardown.confirmed,true);assert.equal(receipt.audit.teardown.strategy,'owned-process-group');
  assert.equal(require('../extension/provider-process').processGroup(receipt.audit.teardown).confirmed,true);
  assert.equal(engine.read(f.root,'I-1').corrections.length,1);assert.equal(job.requests,3);assert.equal(f.runner.state.jobs['I-2'].requests,0);assert.ok(childPid);
});
test('selection promotes two durable stages without owning preparation or starving siblings', { skip: !native }, async t => {
  let release, entered;
  const held = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
  const f = await fixture(t, 3, async input => {
    if (input.finding.id === 'I-1' && input.phase === 'generate') { entered(); await held; }
    return response(input);
  });
  f.options.configuration = () => ({ provider: 'codex', workers: 1, requestLimit: 6 });
  const running = f.runner.ensure(); await started;
  try {
    f.runner.prioritize('I-3'); f.runner.prioritize('I-3');
    assert.equal(f.calls.length, 1, 'Selection must not dispatch alongside the current worker.');
  } finally { release(); }
  await running;
  assert.deepEqual(f.calls.slice(0, 3).map(([id, phase]) => [id, phase]),
    [['I-1', 'generate'], ['I-3', 'generate'], ['I-3', 'challenge']]);
  assert.equal(f.runner.status().ready, 3); assert.equal(f.calls.length, 6);
  f.runner.control('pause'); const before = f.calls.length;
  f.runner.prioritize('I-2'); await f.runner.ensure();
  assert.equal(f.calls.length, before, 'Priority does not authorize resuming or spending.');
});
test('offline production packet inspection preserves workspace bytes and dispatches no provider', { skip: !native }, async t => {
  const f = await fixture(t, 1), destination = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-packet-test-'));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  const inventory = () => fs.readdirSync(path.join(f.root, '.flowboard'), { recursive: true }).filter(file => fs.statSync(path.join(f.root, '.flowboard', file)).isFile())
    .sort().map(file => [file, fs.readFileSync(path.join(f.root, '.flowboard', file), 'utf8')]);
  const before = inventory();
  const child = require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, '../scripts/inspect-review-packet.js'), f.root, 'I-1', path.join(destination, 'packet')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const metrics = JSON.parse(child.stdout);
  assert.equal(metrics.providerRequests, 0); assert.equal(metrics.reportCount, 1);
  assert.match(metrics.schemaHash, /^[a-f0-9]{64}$/);
  const packet = JSON.parse(fs.readFileSync(path.join(destination, 'packet/input.json')));
  assert.ok(packet.finding.reportParagraphs.some(part => part.text.includes('Gate.finish(false) completes normally instead of reverting.')));
  assert.ok(packet.sources.some(unit => unit.code.includes('require(accepted')));
  assert.deepEqual(inventory(), before); assert.deepEqual(f.calls, []);
});
test('corrupt individual investigations cannot prevent intact siblings reopening with no provider', { skip: !native }, async t => {
  for (const brokenId of ['I-1', 'I-2']) {
    const f = await fixture(t, 2); await f.runner.ensure();
    const intactId = brokenId === 'I-1' ? 'I-2' : 'I-1';
    const intact = engine.read(f.root, intactId), before = f.calls.length;
    const file = path.join(f.root, `.flowboard/investigations/${brokenId}.json`), corrupt = '{ interrupted private record';
    fs.writeFileSync(file, corrupt); f.runner.dispose(); await f.runner.loop;
    const reopened = new ReportPreparation(f.root, { ...f.options, configuration: () => ({ provider: 'none' }) });
    t.after(() => reopened.dispose()); await reopened.ensure();
    assert.ok(reopened.published(intact), 'A single damaged record must not block a later valid guide.');
    assert.equal(reopened.status().ready, 1); assert.equal(f.calls.length, before);
    assert.equal(reopened.state.jobs[brokenId].state, 'failed');
    assert.match(reopened.state.jobs[brokenId].reason, /record|saved|recover/i);
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'Original invalid bytes remain available for recovery.');
    await reopened.ensure(); assert.ok(reopened.published(intact));
  }
});
test('a fresh host restores an intact sibling with no provider despite missing, malformed and corrupt records', { skip: !native }, async t => {
  const f = await fixture(t, 4); await f.runner.ensure(); f.runner.dispose(); await f.runner.loop;
  const file = id => path.join(f.root, `.flowboard/investigations/${id}.json`);
  fs.writeFileSync(file('I-1'), '{ broken private JSON'); fs.unlinkSync(file('I-2'));
  fs.writeFileSync(file('I-3'), JSON.stringify({ findingId: 'I-3', claims: 'not a draft' }));
  const bytes = fs.readFileSync(file('I-1'), 'utf8');
  const child = require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, 'restore'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const restored = JSON.parse(child.stdout);
  assert.notEqual(restored.pid, process.pid); assert.equal(restored.indexes, 1);
  assert.deepEqual(restored.calls, []); assert.deepEqual(restored.readable, ['I-4']);
  assert.equal(restored.jobs['I-1'].state, 'failed'); assert.equal(restored.jobs['I-3'].state, 'failed');
  assert.equal(restored.jobs['I-2'].publishable, false);
  assert.equal(fs.readFileSync(file('I-1'), 'utf8'), bytes);
});
test('a crash after a durable provider response reuses generation in a fresh process without a phantom reservation', { skip: !native }, async t => {
  const f = await fixture(t, 1), catalog = await f.options.catalog(), { report, entries } = reconcile(f.root);
  const request = f.runner.request(entries[0], catalog, report), issue = f.runner.issue(entries[0]);
  const value = response({ phase: 'challenge', sources: engine.makeContext(catalog, request, issue).units });
  // The full challenged controlled fixture can be accepted in either stage.
  fs.writeFileSync(path.join(f.root, '.flowboard/controlled-answer.json'), JSON.stringify(value));
  const run = mode => require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, mode], { encoding: 'utf8', timeout: 15000 });
  const crash = run('crash-after-response'); assert.equal(crash.status, 73, crash.stderr);
  const saved = engine.read(f.root, 'I-1'); assert.ok(saved.pendingResponse); assert.equal(saved.claims.length, 0);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, '.flowboard/report-preparation.json')));
  assert.equal(state.resources.requests, 1);
  assert.deepEqual(Object.values(state.resources.receipts).map(receipt => receipt.outcome), ['completed']);
  const resumed = run('resume'); assert.equal(resumed.status, 0, resumed.stderr);
  const result = JSON.parse(resumed.stdout);
  assert.deepEqual(result.calls, ['challenge'], 'The completed generation is read from the private checkpoint, not dispatched again.');
  assert.deepEqual(result.readable, ['I-1']); assert.equal(result.status.requests, 2);
  assert.ok(Object.values(result.receipts).every(receipt => receipt.finishedAt && receipt.outcome === 'completed'));
  const accepted = engine.read(f.root, 'I-1'); assert.ok(accepted.runs.some(run => run.phase === 'generate' && run.reusedResponse));
  assert.equal(accepted.pendingResponse, undefined);
  const reopen = run('restore'); assert.equal(reopen.status, 0, reopen.stderr);
  assert.deepEqual(JSON.parse(reopen.stdout).calls, []); assert.deepEqual(JSON.parse(reopen.stdout).readable, ['I-1']);
});
test('a final paid response recovers after historical default expiry in a disabled-provider host at 2/2', { skip: !native }, async t => {
  const f = await fixture(t, 2), catalog = await f.options.catalog(), { report, entries } = reconcile(f.root);
  // Retained small ledgers remain valid historical states. New cold reports
  // instead stop at the shortfall preflight tested separately above.
  f.options.configuration = () => ({ provider: 'none', requestLimit: 2 }); await f.runner.ensure();
  f.runner.state.mode = 'running'; f.runner.save();
  const request = f.runner.request(entries[0], catalog, report), issue = f.runner.issue(entries[0]);
  fs.writeFileSync(path.join(f.root, '.flowboard/controlled-answer.json'), JSON.stringify(response({ phase: 'challenge', sources: engine.makeContext(catalog, request, issue).units })));
  const run = mode => require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, mode], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run('crash-after-challenge').status, 73);
  const pending = engine.read(f.root, 'I-1'); assert.equal(pending.pendingResponse.phase, 'challenge');
  const before = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json', 8 * 1024 * 1024);
  assert.equal(before.resources.requests, 2); assert.equal(before.resources.limit, 2);
  assert.ok(Object.values(before.resources.receipts).every(item => item.outcome === 'completed'));
  before.mode = 'paused'; before.batch = { startedAt: new Date(Date.now() - 3600000).toISOString(),
    deadlineAt: new Date(Date.now() - 1800000).toISOString(), finishedAt: new Date(Date.now() - 1800000).toISOString(), outcome: 'deadline-exceeded' };
  p.atomicJson(f.root, '.flowboard/report-preparation.json', before);
  const reopened = run('restore'); assert.equal(reopened.status, 0, reopened.stderr);
  const state = JSON.parse(reopened.stdout);
  assert.deepEqual(state.calls, []); assert.deepEqual(state.readable, ['I-1']);
  assert.equal(state.status.requests, 2); assert.equal(state.status.requestLimit, 2);
  assert.equal(state.jobs['I-2'].publishable, false, 'Unpaid sibling work must remain stopped.');
  const accepted = engine.read(f.root, 'I-1');
  assert.equal(accepted.causal.summary, pending.causal.summary);
  assert.ok(accepted.runs.some(run => run.phase === 'challenge' && run.reusedResponse));
  assert.equal(accepted.pendingResponse, undefined);
  const restored = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json', 8 * 1024 * 1024);
  assert.equal(restored.batch.startedAt, before.batch.startedAt); assert.equal(restored.batch.historicalStop.deadlineAt, before.batch.deadlineAt);
  assert.deepEqual(restored.resources, before.resources, 'Unpaid recovery does not rewrite receipts/accounting.');
  const again = JSON.parse(run('restore').stdout);
  assert.deepEqual(again.calls, []); assert.deepEqual(again.readable, ['I-1']); assert.equal(again.status.requestLimit, 2);
});
test('local recovery cannot publish stale code, damaged responses or a generation missing its challenge', { skip: !native }, async t => {
  for (const scenario of ['stale-code', 'damaged-response', 'missing-challenge']) await t.test(scenario, async t => {
    const f = await fixture(t, 1), catalog = await f.options.catalog(), { report, entries } = reconcile(f.root);
    const request = f.runner.request(entries[0], catalog, report), issue = f.runner.issue(entries[0]);
    fs.writeFileSync(path.join(f.root, '.flowboard/controlled-answer.json'), JSON.stringify(response({ phase: 'challenge', sources: engine.makeContext(catalog, request, issue).units })));
    const run = mode => require('node:child_process').spawnSync(process.execPath,
      [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, mode], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run(scenario === 'missing-challenge' ? 'crash-after-response' : 'crash-after-challenge').status, 73);
    const ledger = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json', 8 * 1024 * 1024);
    if (scenario === 'stale-code') fs.writeFileSync(path.join(f.root, 'src/Gate.sol'), code.replace('rejected', 'updated!'));
    if (scenario === 'damaged-response') fs.writeFileSync(path.join(f.root, '.flowboard/provider-results/I-1.json'), '{ damaged response');
    const reopened = run('restore'); assert.equal(reopened.status, 0, reopened.stderr);
    const result = JSON.parse(reopened.stdout);
    assert.deepEqual(result.calls, []); assert.deepEqual(result.readable, []);
    assert.equal(result.status.requests, ledger.resources.requests); assert.equal(result.status.requestLimit, ledger.resources.limit);
    assert.notEqual(result.jobs['I-1'].state, 'running');
    if (scenario === 'missing-challenge') assert.equal(engine.read(f.root, 'I-1').checkpoint.stage, 'challenge');
  });
});

test('FIRST pending-response recovery projects the recovered missing input through board status without spending', { skip: !native }, async t => {
  const f = await fixture(t, 1), catalog = await f.options.catalog(), { report, entries } = reconcile(f.root);
  const value = response({ phase: 'challenge', sources: engine.makeContext(catalog, f.runner.request(entries[0], catalog, report), f.runner.issue(entries[0])).units });
  fs.writeFileSync(path.join(f.root,'.flowboard/controlled-generation.json'),JSON.stringify(value));
  value.claims[0].status = 'unresolved'; value.claims[0].unknowns = ['The asserted receiver identity is unavailable.'];
  value.questions = [{ id: 'receiver', claimId: 'c1', text: 'Which receiver is actually configured?', action: 'missing-context', target: 'deployment', why: 'The asserted runtime route depends on that identity.' }];
  value.causal.outcome = 'blocked';
  fs.writeFileSync(path.join(f.root, '.flowboard/controlled-answer.json'), JSON.stringify(value));
  const child = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, 'crash-after-challenge'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 73, child.stderr);
  const pending = engine.read(f.root, 'I-1'); assert.equal(pending.pendingResponse.phase, 'challenge');
  const ledger = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json', 8 * 1024 * 1024).resources;
  const { TriageBoard } = require('../extension/board'), messages = [];
  const board = Object.assign(Object.create(TriageBoard.prototype), { disposed: false, models: new Map(), callbacks: { reportPreparation: () => f.runner }, post: async m => messages.push(m) });
  f.options.changed = () => board.reportProgress(); f.options.configuration = () => ({ provider: 'none', requestLimit: 2 });
  await f.runner.ensure(); await new Promise(resolve => setImmediate(resolve));
  const saved = engine.read(f.root, 'I-1'), job = f.runner.status().jobs[0], delivered = messages.at(-1).report.jobs[0];
  assert.equal(saved.failureKind, 'material-evidence'); assert.equal(job.failureKind, saved.failureKind);
  assert.deepEqual(job.missingInputs.map(({id,claimId,text,why})=>({id,claimId,text,why})), saved.questions.map(({ id, claimId, text, why }) => ({ id, claimId, text, why })));
  assert.equal(job.missingInputs[0].action,'missing-context');
  assert.deepEqual(delivered, job); assert.equal(f.calls.length, 0);
  assert.equal(f.runner.state.resources.requests, ledger.requests); assert.equal(f.runner.state.resources.limit, ledger.limit);
  assert.equal(f.runner.published(saved), false);
});
test('a durable substantively checked model finishes host validation locally without resuming paid work', { skip: !native }, async t => {
  const f = await fixture(t, 1); await f.runner.ensure(); f.runner.dispose();
  const saved = engine.read(f.root, 'I-1'), summary = saved.causal.summary;
  // Simulate interruption after assembled challenge checks, before sealing.
  saved.phase = 'blocked'; saved.checkpoint.stage = 'challenge';
  delete saved.publication; saved.error = 'Interrupted before final host validation'; saved.revision++;
  engine.write(f.root, saved);
  const ledger = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json');
  ledger.mode = 'paused'; ledger.resources.limit = ledger.resources.requests;
  p.atomicJson(f.root, '.flowboard/report-preparation.json', ledger);
  const child = require('node:child_process').spawnSync(process.execPath,
    [path.join(__dirname, 'fixtures/reopen-preparation-host.js'), f.root, 'restore'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.calls, []); assert.deepEqual(result.readable, ['I-1']);
  assert.equal(result.status.requests, 2); assert.equal(result.status.requestLimit, 2);
  assert.equal(result.status.mode, 'paused');
  assert.equal(engine.read(f.root, 'I-1').causal.summary, summary);
});
test('a live health lock cannot discard a completed generation, consume a phantom receipt, or require regeneration', { skip: !native }, async t => {
  const health = require('../extension/provider-health'), ownership = require('../extension/provider-ownership');
  let heldLock, heldOwner, lockOnce = true;
  const f = await fixture(t, 1, input => {
    if (lockOnce) {
      lockOnce = false;
      heldLock = path.join(f.root, 'provider-state', `health-${health.identity('codex')}.lock`);
      const owner = ownership.ownerMetadata(); heldOwner = owner.owner; ownership.publish(heldLock, owner);
    }
    return response(input);
  });
  f.options.invoke.isProviderTransport = true;
  f.options.providerResources = { directory: path.join(f.root, 'provider-state'), lockWaitMs: 20 };
  t.after(() => { if (heldLock) ownership.removeOwned(heldLock, heldOwner); });
  await f.runner.ensure();
  const draft = engine.read(f.root, 'I-1');
  assert.deepEqual(f.calls.map(call => call[1]), ['generate']);
  assert.equal(draft.claims.length, 1); assert.ok(draft.runs[0].resultAccepted);
  assert.equal(draft.runs[0].healthUpdateError.code, 'PROVIDER_HEALTH_UNAVAILABLE');
  assert.equal(draft.checkpoint.stage, 'challenge'); assert.equal(f.runner.state.mode, 'paused');
  assert.equal(f.runner.state.resources.requests, 1);
  assert.deepEqual(Object.values(f.runner.state.resources.receipts).map(receipt => receipt.outcome), ['completed']);
  ownership.removeOwned(heldLock, heldOwner);
  await f.runner.ensure({ retry: true });
  assert.deepEqual(f.calls.map(call => call[1]), ['generate', 'challenge']);
  assert.equal(f.runner.status().ready, 1); assert.equal(f.runner.status().requests, 2);
  assert.ok(Object.values(f.runner.state.resources.receipts).every(receipt => receipt.finishedAt));
});
test('superseded indexing restarts queued jobs without replacing interruption with user pause', { skip: !native }, async t => {
  const f = await fixture(t, 2), obtain = f.options.catalog;
  let entered, indexes = 0; const started = new Promise(resolve => entered = resolve);
  f.options.catalog = async signal => {
    indexes++;
    if (indexes === 1) { entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Source indexing consumer cancelled')), { once: true })); }
    return obtain();
  };
  const pending = f.runner.ensure(); await started;
  f.runner.invalidate('Saved source changed during indexing.');
  f.runner.ensure(); await pending;
  assert.equal(indexes, 2, 'Only the superseded and current indexes are requested.');
  assert.equal(f.runner.status().ready, 2);
  assert.equal(f.calls.length, 4); assert.equal(f.runner.state.mode, 'completed');
  assert.equal(f.runner.tasks.size, 0);
});
test('a genuine index failure is finite and an explicit pause survives edit-during-index', { skip: !native }, async t => {
  const broken = await fixture(t, 1);
  broken.options.catalog = async () => { throw new Error('Controlled parser initialization failure'); };
  await broken.runner.ensure();
  assert.equal(broken.runner.state.mode, 'paused'); assert.match(broken.runner.state.reason, /parser initialization/);
  assert.equal(broken.calls.length, 0); assert.equal(broken.runner.tasks.size, 0); assert.equal(broken.runner.loop, null);
  const f = await fixture(t, 1), obtain = f.options.catalog; let begin, indexes = 0;
  const started = new Promise(resolve => begin = resolve);
  f.options.catalog = async signal => {
    indexes++;
    if (indexes === 1) { begin(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Source indexing consumer cancelled')), { once: true })); }
    return obtain();
  };
  const pending = f.runner.ensure(); await started; await f.runner.control('pause');
  f.runner.invalidate('A saved edit superseded indexing.'); await pending;
  assert.equal(f.runner.state.mode, 'paused'); assert.equal(indexes, 1); assert.equal(f.calls.length, 0);
  await f.runner.ensure({ retry: true }); assert.equal(f.runner.status().ready, 1); assert.equal(f.calls.length, 2);
});
test('an abandoned pre-metadata report lock recovers, while a live owner cannot lose its state', { skip: !native || process.platform !== 'linux' }, async t => {
  const f = await fixture(t, 1), file = path.join(f.root, '.flowboard/report-preparation.lock.json');
  fs.writeFileSync(file, ''); await f.runner.ensure(); assert.equal(f.runner.status().ready, 1);
  const ownership = require('../extension/provider-ownership'), owner = ownership.ownerMetadata(); ownership.publish(file, owner);
  const original = fs.readFileSync(path.join(f.root, '.flowboard/report-preparation.json'), 'utf8');
  await f.runner.ensure();
  assert.equal(fs.readFileSync(path.join(f.root, '.flowboard/report-preparation.json'), 'utf8'), original);
  assert.equal(ownership.snapshot(file).entry.owner, owner.owner);
  ownership.removeOwned(file, owner.owner);
});
test('a missed saved-input event rejects late old-scope answers but verdict-only changes do not cancel analysis', { skip: !native }, async t => {
  for (const semantic of [true, false]) {
    let begin, release; const started = new Promise(resolve => begin = resolve), held = new Promise(resolve => release = resolve);
    const f = await fixture(t, 1, async input => { if (input.phase === 'generate') { begin(); await held; } return response(input); });
    const pending = f.runner.ensure(); await started;
    try {
      const { report, entries } = reconcile(f.root), catalog = await f.options.catalog(), request = f.runner.request(entries[0], catalog, report);
      if (semantic) request.finding.preconditions = ['accepted must be true']; else request.finding.status = 'insufficient-evidence';
      require('../extension/store').writeDraft(f.root, 'I-1', request);
    } finally { release(); await pending; }
    assert.equal(f.runner.status().ready, semantic ? 0 : 1);
    assert.equal(f.calls.length, semantic ? 1 : 2);
    assert.ok(Object.values(f.runner.state.resources.receipts).every(receipt => receipt.finishedAt));
  }
});
test('saved conditions and edited summary reach generation and challenge, and cannot silently retain the old scope', { skip: !native }, async t => {
  const packets = []; let addressPremises = false;
  const f = await fixture(t, 1, input => {
    packets.push(JSON.parse(JSON.stringify(input)));
    const value = response(input);
    if (addressPremises) {
      value.inputReviews = input.semanticInput.premises.map(premise => ({ id: premise.id, status: 'applied',
        reason: 'The supplied researcher condition selects true. The original report specifically alleges the distinct false input.',
        claimIds: ['c1'], eventIds: ['event'], evidence: ['guard'] }));
      if (!input.checkOnly) {
        const note = 'Under the researcher-selected true input the guard succeeds. The report requires false, which is outside this selected scenario; this does not establish behavior in other implementations.';
        value.claims[0].conditions = ['accepted is true']; value.claims[0].reason = note;
        value.evidence[0].explanation = note; value.causal.summary = note;
        value.causal.scope = 'Only the researcher-selected true input, not a conclusion about unrelated inputs or implementations.';
        Object.assign(value.causal.events[0], { title: 'True satisfies the guard', conditions: ['accepted is true'], what: note, why: note, effect: 'condition' });
        value.conclusion.text = note; value.walkthrough.assessment.why = note;
        for (const obligation of value.causal.obligations) obligation.reason = note;
      }
    }
    return value;
  });
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 12, findingRequestLimit: 6 });
  await f.runner.ensure(); assert.ok(f.runner.artifact('I-1'));
  const { report, entries } = reconcile(f.root), catalog = await f.options.catalog();
  const saved = f.runner.request(entries[0], catalog, report);
  saved.finding.preconditions = ['accepted must be true'];
  saved.finding.summary = 'Researcher scope: check the true-input route.';
  require('../extension/store').writeDraft(f.root, 'I-1', saved);
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 12, findingRequestLimit: 12 });
  f.runner.invalidate('Researcher changed scope.', { findingId: 'I-1', saved: true });
  await f.runner.ensure();
  assert.equal(f.runner.artifact('I-1'), null, 'An unchanged false-input answer cannot pass under a new premise hash.');
  const failed = engine.read(f.root, 'I-1'); assert.match(failed.error, /saved preconditions|saved summary/);
  addressPremises = true; await f.runner.ensure({ retry: true });
  const draft = engine.read(f.root, 'I-1'); assert.ok(f.runner.published(draft), draft.error);
  const changed = packets.filter(packet => packet.semanticInput.saved.preconditions?.length);
  assert.ok(changed.some(packet => packet.phase === 'generate')); assert.ok(changed.some(packet => packet.phase === 'challenge'));
  for (const packet of changed) {
    assert.deepEqual(packet.semanticInput.saved.preconditions, ['accepted must be true']);
    assert.equal(packet.semanticInput.saved.summary, saved.finding.summary);
    assert.equal(packet.finding.savedSummary, undefined, 'Saved researcher fields appear in one canonical object, not duplicated in finding.');
    assert.ok(packet.finding.reportParagraphs.some(paragraph => paragraph.text.includes('false')), 'Original report quotation is retained unchanged.');
  }
  assert.deepEqual(draft.claims[0].conditions, ['accepted is true']);
  assert.equal(draft.inputReviews.length, 2); assert.equal(draft.inputReviews[0].status, 'applied');
});
test('phase group is accounted as context; ambiguous sections block instead of disappearing', () => {
  const parsed = parseReport(reportText(3), { manifest: true });
  assert.equal(parsed.issues.length, 3); assert.equal(parsed.manifest.findingCount, 3);
  const group = parsed.manifest.sections.find(section => section.title === 'Found by 2 phases');
  assert.equal(group.classification, 'context'); assert.ok(group.line && group.endLine);
  const ambiguous = parseReport('# Unclassified concern\nSomething important has no ID or finding fields.\n\n' + reportText(1), { manifest: true });
  assert.equal(ambiguous.manifest.ambiguities.length, 1);
});
test('a checked finding is immediately readable while a sibling is still checking and another fails', { skip: !native }, async t => {
  let release, entered = false;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, 4, async input => {
    if (input.finding.id === 'I-2' && input.phase === 'challenge') { entered = true; await held; }
    if (input.finding.id === 'I-4') return {};
    const value = input.candidateOnly ? {mode:'candidate-patch-v1',updates:[]} : response(input);
    if (input.reviewPurpose && input.checkOnly) value.inputReviews=[];
    if (input.finding.id === 'I-3' && !input.checkOnly && !input.candidateOnly) {
      value.claims[0].status = 'unresolved'; value.claims[0].unknowns = ['The deployment configuration is unavailable.'];
      value.causal.outcome = 'blocked'; value.causal.obligations[0].state = 'open';
      value.conclusion.limitations = ['The deployment configuration is unavailable.'];
    }
    return value;
  });
  const pending = f.runner.ensure();
  try {
    const deadline = Date.now() + 5000;
    while (!(entered && f.runner.state?.jobs['I-1']?.publishable) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(entered && f.runner.state.jobs['I-1'].publishable, 'A finishes its own checks while B waits at challenge.');
    const ready = engine.read(f.root, 'I-1');
    assert.equal(f.runner.published(ready), true, 'A sibling must never be the reading gate for an accepted finding.');
    assert.equal(policy.expose(ready, { findingId: ready.findingId, findingReady: f.runner.published(ready) }).phase, 'ready');
    assert.equal(f.runner.status().published, false, 'Report completion remains a separate aggregate.');
  } finally { release(); await pending; }
  assert.equal(f.runner.state.jobs['I-3'].state, 'blocked');
  assert.equal(f.runner.state.jobs['I-4'].state, 'failed');
  for (const id of ['I-1', 'I-2']) assert.ok(f.runner.published(engine.read(f.root, id)));
  const requests = f.calls.length;
  await f.runner.control('pause'); await f.runner.ensure();
  const reopened = new ReportPreparation(f.root, f.options); t.after(() => reopened.dispose());
  await reopened.ensure();
  for (const id of ['I-1', 'I-2']) assert.ok(reopened.published(engine.read(f.root, id)), 'Pause and host restart preserve accepted compatible guides.');
  assert.equal(f.calls.length, requests, 'Reopening or pausing accepted work makes zero provider requests.');
});
test('pausing at the final accepted stage cannot hide that guide on reopen', { skip: !native }, async t => {
  const f = await fixture(t, 1);
  const changed = f.options.changed;
  f.options.changed = status => { changed(status); if (status.ready === 1 && status.mode === 'running') return f.runner.control('pause'); };
  await f.runner.ensure();
  assert.ok(f.runner.published(engine.read(f.root, 'I-1')));
  await f.runner.ensure();
  assert.ok(f.runner.published(engine.read(f.root, 'I-1')), 'Revalidation precedes the paused-mode early exit.');
  assert.equal(f.calls.length, 2);
});
test('a missed finding-input watcher cannot reuse a completed aggregate after a researcher correction', { skip: !native }, async t => {
  const f = await fixture(t, 2); await f.runner.ensure();
  const a = engine.read(f.root, 'I-1'), b = engine.read(f.root, 'I-2'), acceptedA = f.runner.artifact('I-1');
  const { report, entries } = reconcile(f.root), catalog = await f.options.catalog();
  const corrected = structuredClone(f.runner.request(entries.find(entry => entry.id === 'I-2'), catalog, report));
  corrected.finding.expectedBehavior = 'Researcher correction: only true accepted inputs are expected to return normally.';
  corrected.finding.status = 'invalid';
  corrected.finding.triage.decisionReason = 'The original false-input normal-return allegation fails at the require.';
  corrected.finding.triage.evidence.push({ id: 'human-guard', stance: 'contradicts', source: b.evidence[0].source, note: 'The require rejects the reported false input.' });
  require('../extension/store').writeDraft(f.root, 'I-2', corrected);
  // No watcher callback, no source change, and the old aggregate is complete.
  // Reopening must still reconcile content, without spending a new request.
  f.options.configuration = () => ({ provider: 'none', requestLimit: 8 });
  await f.runner.ensure();
  assert.equal(f.runner.published(a), true); assert.equal(f.runner.artifact('I-1'), acceptedA);
  assert.equal(f.runner.published(b), false, 'The old B explanation has a different expected behavior input.');
  assert.equal(f.calls.length, 4);
  assert.equal(require('../extension/store').readDraft(f.root, 'I-2').finding.status, 'invalid', 'Human judgment is preserved, not replaced by preparation state.');
});
test('a full saved native canvas opens, removal frees a slot, and the checked guide recovers without AI', { skip: !native }, async t => {
  const source = code.replace('\n}\n', '\n    function unrelated() external pure { }\n}\n');
  const f = await fixture(t, 1, undefined, reportText(1), source); await f.runner.ensure();
  const host = await require('../scripts/workflow-host').start({ workspace: f.root, report: path.join(f.root, 'report.md') });
  t.after(() => host.close());
  const call = async (route, value) => (await fetch(host.origin + route, { headers: { 'X-Workflow-Token': host.secret, 'Content-Type': 'application/json' }, ...(value ? { method: 'POST', body: JSON.stringify(value) } : {}) })).json();
  const wait = async predicate => {
    const until = Date.now() + 3000;
    while (Date.now() < until) { const state = await call('/state'); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
    const state = await call('/state'); assert.fail(`Native host did not reach expected state: ${state.errors.join('; ')}`);
  };
  const send = message => call('/message', message);
  const open = async token => {
    await send({ type: 'triage:select', issueId: 'I-1', token });
    const state = await wait(state => state.lastLoad?.issueId === 'I-1' && state.lastLoad.token !== token);
    await send({ type: 'triage:rendered', issueId: 'I-1', token: state.lastLoad.token }); return state.lastLoad;
  };
  await send({ type: 'triage:ready' }); const first = await open();
  assert.equal(first.investigationDraft.phase, 'ready');
  const state = structuredClone(first.state), template = state.cards[0];
  state.cards = Array.from({ length: 200 }, (_, i) => ({ ...template, id: `exploration-${i}`, name: 'unrelated', startLine: 7, endLine: 7, code: '    function unrelated() external pure { }', x: i * 800, y: 0 }));
  state.edges = []; state.notes = [{ id: 'human-note', text: 'Keep my research', x: 10, y: 10 }];
  await send({ type: 'triage:persist', issueId: 'I-1', token: first.token, state });
  await wait(state => state.snapshots['I-1']?.state.cards.length === 200);
  const reopened = await open(first.token);
  assert.equal(reopened.state.cards.length, 200, JSON.stringify({ warnings: reopened.warnings, error: reopened.error, errors: (await call('/state')).errors })); assert.equal(reopened.state.notes[0].text, 'Keep my research');
  assert.equal(reopened.guideAvailability.ready, false); assert.match(reopened.guideAvailability.reason, /200/);
  assert.equal(reopened.investigationDraft.phase, 'ready', 'Materialization capacity is not failed semantic evidence.');
  const reduced = structuredClone(reopened.state); reduced.cards.pop();
  await send({ type: 'triage:persist', issueId: 'I-1', token: reopened.token, state: reduced });
  await wait(state => state.snapshots['I-1']?.state.cards.length === 199);
  const draft = reopened.investigationDraft;
  await send({ type: 'triage:investigationFocus', issueId: 'I-1', token: reopened.token, evidenceId: 'guard', investigationRevision: draft.revision });
  const until = Date.now() + 3000; let focus;
  while (!focus && Date.now() < until) { focus = (await call('/events')).messages.findLast(message => message.type === 'triage:investigationFocus'); if (!focus) await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(focus, 'The host materializes and focuses the exact missing function after a removal.');
  assert.equal(focus.source.line, 5); assert.equal(focus.guideAvailability.ready, true);
  const recovered = await call('/state');
  assert.deepEqual(recovered.errors, []);
  assert.equal(f.calls.length, 2, 'Canvas recovery and reopening spend zero new provider calls.');
});
test('editing one imported finding preserves another accepted artifact and cumulative allowance', { skip: !native }, async t => {
  const f = await fixture(t, 2); await f.runner.ensure(); await f.runner.control('pause');
  const first = engine.read(f.root, 'I-1'), digest = f.runner.artifact('I-1'), requests = f.calls.length;
  const changed = reportText(2).replace('### I-2: Gate.finish', '### I-2: Different condition for Gate.finish');
  fs.writeFileSync(path.join(f.root, 'report.md'), changed);
  await importReport(path.join(f.root, 'report.md'), f.root, native, { deferMapping: true });
  f.runner.invalidate('Finding text changed', { kind: 'report' });
  assert.ok(f.runner.published(first), 'An unrelated report section does not revoke A.');
  await f.runner.control('pause'); await f.runner.ensure();
  assert.equal(f.runner.artifact('I-1'), digest);
  assert.equal(f.runner.published(engine.read(f.root, 'I-2')), false);
  assert.equal(f.calls.length, requests); assert.equal(f.runner.state.resources.requests, requests);
});
test('a unique full path can reconcile citation case, but colliding files cannot', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-case-path-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); const a = path.join(root, 'src/Gate.sol'), b = path.join(root, 'Src/GATE.sol');
  fs.writeFileSync(a, code);
  assert.equal(mapFile(root, 'SRC/Gate.sol', [a]), 'src/Gate.sol');
  if (fs.existsSync(path.join(root, 'Src'))) { t.diagnostic('Case-folding volume: a second path differing only by case cannot exist. Unique-path reconciliation checked.'); return; }
  fs.mkdirSync(path.join(root, 'Src'));
  fs.writeFileSync(b, code); assert.equal(mapFile(root, 'SRC/Gate.sol', [a,b]), null);
});
test('cold import prepares all findings and publishes each accepted artifact independently', { skip: !native }, async t => {
  const { root, runner, calls, updates } = await fixture(t);
  await runner.ensure();
  for (const id of ['I-1', 'I-2', 'I-3']) assert.deepEqual(calls.filter(call => call[0] === id).map(call => call[1]), ['generate', 'challenge']);
  assert.equal(runner.status().published, true); assert.equal(runner.status().ready, 3);
  assert.equal(runner.status().costUSD, null, 'Unavailable cost is not reported as zero dollars.');
  assert.ok(updates.some(status => status.ready === 1 && status.published === false));
  const draft = engine.read(root, 'I-1'); assert.ok(runner.published(draft));
  assert.ok(policy.expose(draft, { findingId: draft.findingId, findingReady: true, published: false }).causal, 'Aggregate incompleteness is not a reading gate.');
  await runner.ensure(); assert.equal(calls.length, 6, 'Identical reopen/reimport reuses all compatible work.');
  assert.equal(reconcile(root).entries.length, 3);
});
test('a timed-out challenge resumes the accepted generation, while unrelated jobs run first', { skip: !native }, async t => {
  let failed = false;
  const f = await fixture(t, 3, input => {
    if (input.finding.id === 'I-1' && input.phase === 'challenge' && !failed) { failed = true; throw Object.assign(new Error('Injected timeout'), { audit: { phase: 'challenge', outcome: 'failed' } }); }
    return response(input);
  });
  await f.runner.ensure();
  assert.equal(f.runner.status().published, true);
  assert.equal(f.calls.filter(([id, phase]) => id === 'I-1' && phase === 'generate').length, 1);
  assert.equal(f.calls.at(-1)[0], 'I-1', 'Retry is behind the other initial attempts.');
  const resumed = engine.read(f.root, 'I-1');
  assert.ok(resumed.actions.some(action => action.kind === 'checkpoint-resume'));
  assert.equal(resumed.runs.filter(run => run.phase === 'challenge').length, 2);
});
test('one failed explanation prevents report completion but not other accepted guides and has a finite stop', { skip: !native }, async t => {
  const f = await fixture(t, 3, input => {
    const value = response(input); if (input.finding.id === 'I-2') return {};
    return value;
  });
  await f.runner.ensure();
  assert.equal(f.runner.status().published, false); assert.equal(f.runner.status().ready, 2);
  assert.equal(f.runner.state.jobs['I-2'].state, 'failed'); assert.ok(f.calls.length <= 8);
  const before = f.calls.length; await f.runner.ensure(); assert.equal(f.calls.length, before, 'A stopped malformed result is not retried forever.');
});
test('an explicit insufficient cap pauses before dispatch and explicit sufficient Resume can finish', { skip: !native }, async t => {
  const f = await fixture(t, 3); f.options.configuration = () => ({ provider: 'codex', requestLimit: 1, workers: 1 });
  await f.runner.ensure(); assert.equal(f.runner.status().mode, 'paused'); assert.equal(f.calls.length, 0);
  assert.match(f.runner.status().reason, /planned 6 requests/);
  assert.equal(f.runner.status().published, false); assert.equal(f.runner.status().ready, 0);
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 6, workers: 1 });
  await f.runner.control('resume');
  assert.equal(f.calls.length, 6); assert.equal(f.runner.status().ready, 3);
});
test('exhausted ordinary report Resume explicitly adds allowance and resumes its paid challenge, not generation', { skip: !native }, async t => {
  let fail = true;
  const f = await fixture(t, 1, input => {
    if (input.phase === 'challenge' && fail) throw Object.assign(Error('Controlled timeout'), { failureKind: 'timeout', audit: { outcome: 'failed', failureKind: 'timeout' } });
    return response(input);
  });
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 2, findingRequestLimit: 2, workers: 1 });
  await f.runner.ensure();
  assert.equal(f.runner.status().requests, 2); assert.equal(f.runner.status().ready, 0);
  assert.equal(engine.read(f.root, 'I-1').checkpoint.stage, 'challenge');
  await f.runner.continueFinding('I-1');
  assert.equal(f.calls.length, 2, 'Finding continuation does not replenish the shared allowance.');
  fail = false;
  await f.runner.control('resume');
  assert.deepEqual(f.calls.map(call => call[1]), ['generate', 'challenge', 'challenge']);
  assert.equal(f.runner.status().requests, 3); assert.equal(f.runner.status().requestLimit, 4);
  assert.equal(f.runner.status().ready, 1, 'Explicit ordinary report Resume is effective; it must not be blanket-disabled at zero remaining allowance.');
});
test('cancellation ignores a late provider response and preserves researcher files', { skip: !native }, async t => {
  let release; const wait = new Promise(resolve => release = resolve);
  const f = await fixture(t, 2, async input => { await wait; return response(input); });
  const note = path.join(f.root, '.flowboard/human-note.txt'); fs.writeFileSync(note, 'Keep my research.');
  const running = f.runner.ensure();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.runner.control('cancel'); release(); await running;
  assert.equal(f.runner.status().published, false); assert.equal(f.runner.status().mode, 'cancelled');
  assert.equal(f.runner.status().ready, 0); assert.equal(fs.readFileSync(note, 'utf8'), 'Keep my research.');
  assert.equal(engine.read(f.root, 'I-1').claims.length, 0);
});
test('changed shared source revokes affected guides and unchanged human records survive', { skip: !native }, async t => {
  const f = await fixture(t, 2); await f.runner.ensure(); assert.equal(f.runner.status().published, true);
  f.runner.invalidate('Code changed'); assert.equal(f.runner.status().published, false);
  fs.appendFileSync(path.join(f.root, 'src/Gate.sol'), '\n// changed saved snapshot\n');
  const result = await analyze(native, f.root, { mode: 'source' }); f.replaceCatalog(new SourceCatalog(f.root, result.runner, result.result));
  await f.runner.ensure(); assert.equal(f.calls.length, 8); assert.equal(f.runner.status().published, true);
  assert.ok(fs.readdirSync(path.join(f.root, '.flowboard/recovery')).some(name => name.startsWith('investigation-')));
});
test('host restart revalidates privately; pause finishes the current request but starts no later pass', { skip: !native }, async t => {
  let release; const wait = new Promise(resolve => release = resolve);
  const f = await fixture(t, 2, async input => { await wait; return response(input); });
  const pending = f.runner.ensure();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.runner.control('pause'); release(); await pending;
  assert.equal(f.calls.length, 2, 'Both already-running workers finish, but no challenge is dispatched after pause.'); assert.equal(f.runner.status().mode, 'paused');
  assert.equal(engine.read(f.root, 'I-1').checkpoint.stage, 'challenge');
  const restarted = new ReportPreparation(f.root, f.options);
  t.after(() => restarted.dispose());
  await restarted.control('resume');
  assert.equal(f.calls.filter(([id, phase]) => id === 'I-1' && phase === 'generate').length, 1);
  assert.equal(restarted.status().published, true);
});
test('Resume during a finishing request is not lost and does not regenerate the accepted stage', { skip: !native }, async t => {
  let release; const wait = new Promise(resolve => release = resolve);
  const f = await fixture(t, 1, async input => { await wait; return response(input); });
  const running = f.runner.ensure();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  await f.runner.control('pause');
  const resumed = f.runner.control('resume'); release(); await Promise.all([running, resumed]);
  assert.equal(f.runner.status().published, true);
  assert.deepEqual(f.calls.map(call => call[1]), ['generate', 'challenge']);
});
test('a repaired answer can request new local evidence without spending the semantic-repair allowance again', { skip: !native }, async t => {
  let inspected = false, typedRepair = false;
  const f = await fixture(t, 1, (input, calls) => {
    if(input.repairOnly){typedRepair=true;assert.equal(input.authoringFormat,require('../extension/authoring-contract').VERSION);
      const schema=require('../extension/semantic-provider').responseSchema(input);
      assert.equal(require('../extension/challenge-format').valid({mode:'review-edit-v2',edits:[{op:'set',target:'/causal/events/event/changes/0/evidence',value:[]}],inputReviews:[],explanationReviews:[],checks:[]},schema),false);}
    if(input.reviewPurpose && input.checkOnly)return checkedCandidate(input);
    if (input.checkOnly) return { result: 'repair', problems: ['Read the declared check before finalizing.'], explanationReviews: [], checks: [] };
    const value = response(input);
    if (input.phase === 'challenge' && !input.sources.some(unit => unit.name === 'Policy::expected')) {
      value.claims[0].status = 'unresolved'; value.claims[0].unknowns = ['Read the locally available declaration.'];
      value.causal.outcome = 'blocked'; value.causal.obligations[0].state = 'open';
      value.questions = [{ id: 'local', claimId: 'c1', text: 'Read the declaration before finishing.', action: 'symbol', target: 'Policy::expected', why: 'The challenge needs this code.' }];
    } else if (input.phase === 'challenge') {
      inspected = true;
      const unit = input.sources.find(unit => unit.name === 'Policy::expected');
      assert.match(unit.code, /return false;/);
      assert.ok(input.hostReview.newLocalCode);
    }
    return input.candidateOnly?candidatePatch(value):value;
  });
  fs.writeFileSync(path.join(f.root, 'src/Policy.sol'), 'pragma solidity ^0.8.20;\ncontract Policy { function expected() external pure returns (bool) { return false; } }\n');
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 5 });
  const result = await analyze(native, f.root, { mode: 'source' }); f.replaceCatalog(new SourceCatalog(f.root, result.runner, result.result));
  await f.runner.ensure();
  assert.equal(inspected, true);
  assert.equal(typedRepair,true,'The actual inline repair callback uses the same enforced edit grammar.');
  assert.equal(f.calls.length, 5, 'Generation, compact check, repair discovering local context, private completion, full verification.');
  assert.equal(f.runner.status().published, true);
  const saved = engine.read(f.root, 'I-1');
  assert.equal(saved.checkpoint.followups, 1); assert.equal(saved.checkpoint.repairUsed, true);
  assert.ok(saved.actions.some(action => action.target === 'Policy::expected' && action.outcome === 'source-returned'));
});
test('reconciliation changes preserve the shared report budget and human records', { skip: !native }, async t => {
  const f = await fixture(t, 2); await f.runner.ensure();
  const saved = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json');
  saved.identity = 'older-parser'; saved.publication = null;
  p.atomicJson(f.root, '.flowboard/report-preparation.json', saved);
  const again = new ReportPreparation(f.root, f.options); t.after(() => again.dispose());
  await again.ensure();
  assert.equal(again.state.resources.requests, saved.resources.requests, 'A parser/policy migration does not invent a new free report allowance.');
  assert.equal(f.calls.length, 4);
});
test('a 301-entry import schedules every legitimate entry independently before requesting any model work', { skip: !native }, async t => {
  const f = await fixture(t, 301); f.options.configuration = () => ({ provider: 'none', requestLimit: 12 });
  await f.runner.ensure();
  assert.equal(f.runner.status().total, 301); assert.equal(f.runner.status().ready, 0);
  assert.equal(f.runner.status().counts.queued, 301); assert.equal(f.calls.length, 0);
  assert.equal(f.runner.status().published, false);
});
module.exports = { response };

test('authorized two pairs plus generation-only observation consumes exactly five without orphan challenge debt', { skip: !native }, async t => {
  const f = await fixture(t, 4), { EvaluationPlanGuard, packetIdentity } = require('../scripts/evaluation-plan-guard');
  f.options.configuration = () => ({ provider: 'none', requestLimit: 5, workers: 1 }); await f.runner.ensure();
  const catalog = await f.options.catalog(), { report, entries } = reconcile(f.root), cases = [];
  for (const entry of entries.slice(0, 3)) {
    const request = f.runner.request(entry, catalog, report), issue = f.runner.issue(entry); let packet;
    await engine.advance({ root: f.root, catalog, request, issue, findingId: entry.id, draft: engine.create({ findingId: entry.id, catalog, request, issue }),
      provider: 'codex', persist: false, current: () => true, publish: async () => {}, invoke: async input => { packet = input; throw Object.assign(Error('offline capture'), { code: 'REPORT_PAUSED' }); } });
    cases.push({ findingId: entry.id, phases: entry.id === 'I-3' ? ['generate'] : ['generate', 'challenge'], timeoutMs: 600000,
      snapshotHash: engine.hash(packet.snapshot), firstPacket: packetIdentity(packet) });
  }
  const manifest = { root: f.root, maximumRequests: 5, referenceHash: 'independent-control', cases }, ledger = { manifestHash: engine.hash(manifest), used: 0, receipts: [] };
  const guard = new EvaluationPlanGuard({ root: f.root, manifest, approval: { authorized: true, manifestHash: engine.hash(manifest), maximumRequests: 5 }, ledger,
    save: () => {}, acceptedBase: id => engine.read(f.root, id) });
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 5, workers: 1 });
  f.options.phasePlan = id => guard.phasePlan(id);
  f.options.authorizeRequest = ({ input }) => guard.authorize(input);
  f.options.invoke = async (input, options) => {
    const receipt = guard.dispatch(input, options.requestId), value = response(input);
    const result = { value: input.phase === 'generate' ? require('../scripts/fixtures/source-bound-output').encode(value, input) : value, audit: { requestId: options.requestId, outcome: 'completed', phase: input.phase, provider: 'controlled' } };
    result.value=require('../scripts/fixtures/authoring-output').encode(result.value,input);
    f.calls.push([input.finding.id, input.phase]); guard.result(receipt, input, result); return result;
  };
  for (const c of cases) { await f.runner.continueFinding(c.findingId); await f.runner.control('pause');
    t.diagnostic(JSON.stringify({ id: c.findingId, reason: f.runner.state.jobs[c.findingId].reason, receipts: ledger.receipts.map(r => ({ phase: r.phase, completeGeneration: r.completeGeneration })) })); }
  assert.deepEqual(f.calls, [['I-1','generate'],['I-1','challenge'],['I-2','generate'],['I-2','challenge'],['I-3','generate']]);
  assert.equal(ledger.used, 5); assert.equal(f.runner.status().requests, 5);
  assert.equal(f.runner.state.jobs['I-4'].requests, 0); assert.deepEqual(guard.phasePlan('I-4'), []);
  for (const id of ['I-1', 'I-2']) assert.ok(f.runner.published(engine.read(f.root, id)));
  const observation = engine.read(f.root, 'I-3'); assert.ok(observation.claims.length); assert.equal(observation.checkpoint.stage, 'challenge');
  assert.equal(f.runner.published(observation), false); assert.equal(f.runner.state.jobs['I-3'].state, 'blocked');
  assert.equal(require('../extension/batch-plan').owedChallenges(Object.values(f.runner.state.jobs), 'other', id => id !== 'I-3'), 0);
  await f.runner.ensure(); assert.equal(ledger.used, 5); assert.equal(f.calls.length, 5);
  await f.runner.continueFinding('I-3'); assert.equal(ledger.used, 5); assert.equal(f.calls.length, 5);
  assert.equal(require('../extension/batch-plan').owedChallenges([{id:'ordinary', state:'paused', checkpoint:{stage:'challenge'}}], 'other'), 1);
});

for (const selectedCount of [1, 2]) test(`runner/coordinator additive plan admits ${selectedCount} challenges over four prior attempts without sibling debt`, { skip: !native }, async t => {
  const f = await fixture(t, 2, input => {
    const value = response({ ...input, checkOnly: false });
    if (input.phase === 'challenge') {
      throw Object.assign(Error('Controlled interrupted check, retaining a complete generation.'),{audit:{phase:'challenge',outcome:'failed'}});
    }
    return value;
  },reportText(2),code+'\ncontract Policy { function expected() external pure returns (bool) { return false; } }\n');
  f.options.configuration=()=>({provider:'codex',workers:1,requestLimit:5,findingRequestLimit:2});
  await f.runner.ensure();await f.runner.control('pause');
  assert.equal(f.runner.status().requests,4);assert.equal(f.runner.status().ready,0);
  const {EvaluationPlanGuard,packetIdentity,savedBase,accountingBaseline}=require('../scripts/evaluation-plan-guard');
  const {executionOptions,runCases}=require('../scripts/run-evaluation-plan');
  const baseline=accountingBaseline(f.runner.state),priorReceipts=structuredClone(baseline.receipts),catalog=await f.options.catalog();
  const {entries,report}=reconcile(f.root),cases=[];
  for(const entry of entries){const issue=f.runner.issue(entry),request=f.runner.request(entry,catalog,report),saved=engine.read(f.root,entry.id);
    const {packet}=await require('../scripts/saved-stage-packet').inspectSavedStage({root:f.root,catalog,request,issue,findingId:entry.id,saved});
    const firstPacketPath=path.join(f.root,'.flowboard',entry.id+'-approved-input.json');fs.writeFileSync(firstPacketPath,JSON.stringify(packet));
    cases.push({findingId:entry.id,phases:['challenge'],timeoutMs:600000,snapshotHash:engine.hash(saved.snapshot),retainedBaseHash:engine.hash(savedBase(saved)),firstPacket:packetIdentity(packet),firstPacketPath});
  }
  const manifest={root:f.root,referenceHash:'separate-controlled-reference',maximumRequests:selectedCount,cases:cases.slice(0,selectedCount),
    continuation:{parentManifestHash:'controlled-parent',baseline,baselineHash:engine.hash(baseline)}};
  let ledger={manifestHash:engine.hash(manifest),used:0,receipts:[]};
  const approval={authorized:true,manifestHash:engine.hash(manifest),maximumRequests:selectedCount};
  const guard=new EvaluationPlanGuard({manifest,approval,ledger,root:f.root,save:()=>{},acceptedBase:id=>engine.read(f.root,id)});
  assert.equal(guard.continuation(f.runner.state).baselineRequests,4);assert.equal(f.runner.state.resources.limit,5,'Inactive checking does not apply allowance.');
  const changed=structuredClone(f.runner.state);changed.resources.requests=3;assert.throws(()=>guard.continuation(changed),/baseline/i);
  const callbacks=[];
  const invoke=async(input,options)=>{const receipt=guard.dispatch(input,options.requestId);callbacks.push(input.phase);
    const result={value:require('../scripts/fixtures/authoring-output').encode(response(input),input),audit:{requestId:options.requestId,phase:input.phase,outcome:'completed',provider:'fixed-local'}};guard.result(receipt,input,result);return result;};
  f.runner.dispose();await f.runner.loop;
  const runner=new ReportPreparation(f.root,executionOptions({manifest,guard,catalog:async()=>catalog,invoke}));t.after(()=>runner.dispose());
  await runCases(runner,manifest);
  assert.deepEqual(callbacks,Array(selectedCount).fill('challenge'),JSON.stringify(runner.status().jobs.map(j=>({id:j.id,reason:j.reason}))));assert.equal(ledger.used,selectedCount);assert.equal(runner.status().requests,4+selectedCount);assert.equal(runner.state.resources.limit,4+selectedCount);
  for(const [id,receipt]of Object.entries(priorReceipts))assert.deepEqual(runner.state.resources.receipts[id],receipt);
  assert.equal(runner.status().ready,selectedCount);
  if(selectedCount===1){assert.equal(runner.state.jobs['I-2'].requests,2);assert.equal(runner.state.jobs['I-2'].publishable,false);assert.equal(runner.requiresChallenge('I-2'),false);}
  assert.equal(f.runner.requiresChallenge('I-2'),true,'An ordinary sibling still needs its mandatory review.');
  const accounting=JSON.stringify(accountingBaseline(runner.state));
  await runCases(runner,manifest);assert.equal(callbacks.length,selectedCount);assert.equal(JSON.stringify(accountingBaseline(runner.state)),accounting);
  ledger=JSON.parse(JSON.stringify(ledger));const reopened=new EvaluationPlanGuard({manifest,approval,ledger,root:f.root,save:()=>assert.fail('No refund'),acceptedBase:id=>engine.read(f.root,id)});
  assert.ok(reopened.continuation(runner.state));assert.throws(()=>reopened.authorize({phase:'challenge',finding:{id:'I-1'}}),/Aggregate/);
});

test('an old imported report has no inherited elapsed-time stop', { skip: !native }, async t => {
  const f = await fixture(t, 1), file = path.join(f.root, '.flowboard/report.json'), old = JSON.parse(fs.readFileSync(file));
  old.importedAt = new Date(Date.now() - 3600000).toISOString(); fs.writeFileSync(file, JSON.stringify(old));
  await f.runner.ensure(); assert.equal(f.calls.length, 2); assert.equal(f.runner.status().ready, 1);
  assert.equal(f.runner.state.batch.startedAt, old.importedAt);
});

test('ordinary private candidate and complete verification use separate guarded coordinator reservations across reopen', { skip: !native }, async t => {
  const f=await fixture(t,1,async input=>{
    const value=response(input);
    value.questions=[{id:'explain-guard',claimId:'c1',text:'Explain the supplied false guard.',action:'inspect',target:value.claims[0].entry,why:'Retain a private candidate until the complete check.'}];
    f.runner.control('pause');return value;
  });
  await f.runner.ensure();f.runner.dispose();await f.runner.loop;
  assert.equal(f.calls.length,1);assert.equal(f.runner.state.resources.requests,1);
  const {EvaluationPlanGuard,packetIdentity,savedBase,accountingBaseline}=require('../scripts/evaluation-plan-guard');
  const {executionOptions,runCases,verifyParent}=require('../scripts/run-evaluation-plan');
  const catalog=await f.options.catalog(),{entries,report}=reconcile(f.root),entry=entries[0],issue=f.runner.issue(entry);
  const request=f.runner.request(entry,catalog,report);let owner=f.runner,parent;
  const purposes=['candidate-completion','candidate-verification'],calls=[];
  for(const purpose of purposes) {
    const saved=engine.read(f.root,entry.id),base=accountingBaseline(owner.state);
    const {packet}=await require('../scripts/saved-stage-packet').inspectSavedStage({root:f.root,catalog,request,issue,findingId:entry.id,saved});
    assert.equal(packet.reviewPurpose,purpose);assert.equal(owner.state.resources.requests,purpose===purposes[0]?1:2);
    const file=path.join(f.root,purpose+'.json');fs.writeFileSync(file,JSON.stringify(packet));
    const manifest={root:f.root,referenceHash:'separate-controlled-reference',maximumRequests:1,
      reviewCycle:{id:'controlled-candidate-cycle'},cases:[{findingId:entry.id,phases:['challenge'],reviewPurpose:purpose,timeoutMs:purpose===purposes[0]?300000:600000,
        snapshotHash:engine.hash(saved.snapshot),retainedBaseHash:engine.hash(savedBase(saved)),firstPacket:packetIdentity(packet),firstPacketPath:file}],
      continuation:{parentManifestHash:parent?engine.hash(parent.manifest):'controlled-parent',baseline:base,baselineHash:engine.hash(base)}};
    if(parent)Object.assign(manifest.continuation,{parentManifestPath:parent.manifestPath,parentLedgerPath:parent.ledgerPath,parentLedgerHash:engine.hash(parent.ledger)});
    if(parent){verifyParent(manifest);const failed=structuredClone(parent.ledger);failed.receipts[0].outcome='failed';fs.writeFileSync(parent.ledgerPath,JSON.stringify(failed));
      const refused=structuredClone(manifest);refused.continuation.parentLedgerHash=engine.hash(failed);assert.throws(()=>verifyParent(refused),/timeout|cycle/);
      fs.writeFileSync(parent.ledgerPath,JSON.stringify(parent.ledger));}
    const ledger={manifestHash:engine.hash(manifest),used:0,receipts:[]},approval={authorized:true,manifestHash:engine.hash(manifest),maximumRequests:1};
    const guard=new EvaluationPlanGuard({manifest,ledger,approval,root:f.root,save:()=>{},acceptedBase:id=>engine.read(f.root,id)});
    assert.ok(guard.check(packet));assert.equal(ledger.used,0);
    const invoke=async(input,options)=>{
      const receipt=guard.dispatch(input,options.requestId);calls.push(input.reviewPurpose);
      const value=input.candidateOnly?{mode:'candidate-patch-v1',updates:[{path:'/questions',valueJSON:'[]'},
        {path:'/evidence/guard/explanation',valueJSON:JSON.stringify('The false condition reaches require; it reverts instead of returning normally.')}]}:response(input);
      if(input.checkOnly){value.inputReviews=[];value.explanationReviews[0].result='repaired';value.checks.push(...input.candidateRevisionTargets.map(target=>({target,reason:'The local guard supplies the previously requested explanation; the same false-input condition is retained.',evidence:['guard'],documentation:[]})));}
      const result={value:require('../scripts/fixtures/authoring-output').encode(value,input),audit:{requestId:options.requestId,phase:input.phase,outcome:'completed',provider:'fixed-local',teardown:{confirmed:true}}};
      guard.result(receipt,input,result);return result;
    };
    owner=new ReportPreparation(f.root,executionOptions({manifest,guard,catalog:async()=>catalog,invoke}));
    await runCases(owner,manifest);assert.equal(ledger.used,1,JSON.stringify(owner.status().jobs));
    assert.equal(owner.status().requests,base.requests+1);assert.equal(owner.status().ready,inputReady(purpose),JSON.stringify(owner.status().jobs));
    await runCases(owner,manifest);assert.equal(calls.length,purpose===purposes[0]?1:2,'Restart cannot duplicate a consumed stage.');
    assert.throws(()=>guard.authorize(packet),/Aggregate/);
    const manifestPath=path.join(f.root,purpose+'-manifest.json'),ledgerPath=path.join(f.root,purpose+'-ledger.json');
    fs.writeFileSync(manifestPath,JSON.stringify(manifest));fs.writeFileSync(ledgerPath,JSON.stringify(ledger));parent={manifest,ledger,manifestPath,ledgerPath};
    owner.dispose();await owner.loop;
  }
  assert.deepEqual(calls,purposes);assert.equal(engine.read(f.root,entry.id).phase,'ready');
  function inputReady(purpose){return purpose==='candidate-verification'?1:0;}
});

test('historical expiry does not auto-resume a paused job but explicit local continuation works', { skip: !native }, async t => {
  const f = await fixture(t, 1); f.options.configuration = () => ({ provider: 'none', requestLimit: 6 }); await f.runner.ensure();
  f.runner.state.batch = { startedAt: new Date(Date.now()-3600000).toISOString(), deadlineAt: new Date(Date.now()-1800000).toISOString(), outcome: 'deadline-exceeded' };
  f.runner.state.mode = 'paused'; f.runner.state.jobs['I-1'].state = 'paused'; f.runner.save();
  const startedAt = f.runner.state.batch.startedAt;
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 6 }); await f.runner.ensure();
  assert.equal(f.calls.length, 0); assert.equal(f.runner.state.mode, 'paused');
  await f.runner.continueFinding('I-1'); assert.equal(f.calls.length, 2); assert.equal(f.runner.status().ready, 1);
  assert.equal(f.runner.state.batch.startedAt, startedAt);
});
for(const extraAuthoring of [false,true])test(`scoped runner preserves spent R and same V with explicit follow-up=${extraAuthoring}`,{skip:!native},async t=>{
  const f=await fixture(t,1, input=>{const value=response(input);value.inputReviews=[];delete value.walkthrough.steps;value.claims[0].evidence.push('absent-note');return value;});
  await f.runner.ensure();f.runner.dispose();await f.runner.loop;
  const {EvaluationPlanGuard,packetIdentity,savedBase,accountingBaseline}=require('../scripts/evaluation-plan-guard'),{executionOptions,runCases,verifyParent}=require('../scripts/run-evaluation-plan');
  const catalog=await f.options.catalog(),{entries,report}=reconcile(f.root),entry=entries[0],issue=f.runner.issue(entry),request=f.runner.request(entry,catalog,report);
  const draft=engine.read(f.root,entry.id);assert.equal(draft.claims.length,0);engine.beginRejectedRepair({root:f.root,draft,catalog,request,issue});
  let owner=f.runner,parent={manifest:{cases:[{findingId:entry.id,phases:['generate']}]},ledger:{used:1,receipts:[{outcome:'completed'}]}};
  const storeParent=()=>{parent.manifestPath=path.join(f.root,'parent-'+(parent.manifest.cases[0].reviewPurpose||'G')+'.json');parent.ledgerPath=parent.manifestPath+'.ledger';fs.writeFileSync(parent.manifestPath,JSON.stringify(parent.manifest));fs.writeFileSync(parent.ledgerPath,JSON.stringify(parent.ledger));};storeParent();
  const calls=[];
  for(const purpose of ['rejected-proposal-repair',...(extraAuthoring?['rejected-proposal-followup']:[]),'candidate-verification']){
    if(purpose==='rejected-proposal-followup'){
      owner=new ReportPreparation(f.root,{...f.options,configuration:()=>({provider:'none'}),invoke:()=>assert.fail('Preparing explicit follow-up is local')});
      const rejected=engine.read(f.root,entry.id);
      await owner.continueFinding(entry.id,{recheckLocalPreparation:true,followupAuthorization:{id:'new-authoring-only',responseHash:rejected.currentRejection.responseHash}});
      owner.dispose();await owner.loop;
    }
    const saved=engine.read(f.root,entry.id),baseline=accountingBaseline(owner.state),{packet}=await require('../scripts/saved-stage-packet').inspectSavedStage({root:f.root,catalog,request,issue,findingId:entry.id,saved});
    assert.equal(packet.reviewPurpose,purpose);const inputPath=path.join(f.root,purpose+'.input.json');fs.writeFileSync(inputPath,JSON.stringify(packet));
    const manifest={root:f.root,referenceHash:'private-reference-not-input',maximumRequests:1,reviewCycle:{kind:'received-proposal-repair-v1',id:'one-R-V'},cases:[{findingId:entry.id,phases:['challenge'],reviewPurpose:purpose,
      originalProposalHash:saved.rejectedProposal.original.hash,timeoutMs:purpose.endsWith('verification')?600000:300000,
      ...(purpose==='rejected-proposal-followup'?{followupAuthorization:{id:saved.rejectedProposal.followup.id,responseHash:saved.rejectedProposal.followup.fromResponseHash}}:{}),
      snapshotHash:engine.hash(saved.snapshot),retainedBaseHash:engine.hash(savedBase(saved)),firstPacket:packetIdentity(packet),firstPacketPath:inputPath}],
      continuation:{parentManifestPath:parent.manifestPath,parentLedgerPath:parent.ledgerPath,parentManifestHash:engine.hash(parent.manifest),parentLedgerHash:engine.hash(parent.ledger),baseline,baselineHash:engine.hash(baseline)}};
    verifyParent(manifest);
    if(purpose==='candidate-verification'){const failed=structuredClone(parent.ledger);failed.receipts[0].outcome='failed';fs.writeFileSync(parent.ledgerPath,JSON.stringify(failed));const changed=structuredClone(manifest);changed.continuation.parentLedgerHash=engine.hash(failed);assert.throws(()=>verifyParent(changed),/same one full V/);fs.writeFileSync(parent.ledgerPath,JSON.stringify(parent.ledger));}
    const ledger={manifestHash:engine.hash(manifest),used:0,receipts:[]},approval={authorized:true,manifestHash:engine.hash(manifest),maximumRequests:1};
    const guard=new EvaluationPlanGuard({manifest,ledger,approval,root:f.root,save:()=>{},acceptedBase:id=>engine.read(f.root,id)});
    assert.ok(guard.check(packet));assert.equal(ledger.used,0);assert.throws(()=>guard.check({...packet,referenceOrigin:{...packet.referenceOrigin,recordHash:'changed'}}));
    if(purpose==='rejected-proposal-followup'){
      const codec=require('../extension/packet-context'),plain=codec.expand(packet);
      assert.notDeepEqual(packet.candidateProblems,plain.candidateProblems,'Actual production packet shares repeated diagnostic records.');
      plain.candidateProblems[0].message='Changed rejected guidance';const altered=codec.compact(plain);
      const changed={...manifest,cases:[{...manifest.cases[0],firstPacket:packetIdentity(altered)}]},hash=engine.hash(changed);
      const strict=new EvaluationPlanGuard({manifest:changed,ledger:{manifestHash:hash,used:0,receipts:[]},approval:{authorized:true,manifestHash:hash,maximumRequests:1},root:f.root,save:()=>assert.fail('No reservation'),acceptedBase:id=>engine.read(f.root,id)});
      assert.throws(()=>strict.check(altered),/rejected guidance changed/,'Even a separately hashed packet cannot substitute different retained diagnostics.');
    }
    const invoke=async(input,options)=>{const receipt=guard.dispatch(input,options.requestId);calls.push(input.reviewPurpose);let value;
      if(input.candidateOnly)value={mode:'candidate-patch-v1',updates:[{path:'/claims/c1/evidence',valueJSON:'["guard"]'}]};
      else{value=response(input);value.inputReviews=[];value.checks.push(...input.candidateRevisionTargets.map(target=>({target,reason:'The absent reference is replaced by the already scoped exact require evidence; the same allegation is retained.',evidence:['guard'],documentation:[]})));}
      if(extraAuthoring&&input.reviewPurpose==='rejected-proposal-repair')value={mode:'candidate-edit-v2',edits:Array.from({length:24},(_,i)=>({op:'set',target:'/causal/relationships/not-an-id-'+i,value:[]}))};
      const result={value:require('../scripts/fixtures/authoring-output').encode(value,input),audit:{phase:input.phase,outcome:'completed',requestId:options.requestId,teardown:{confirmed:true}}};guard.result(receipt,input,result);return result;};
    owner=new ReportPreparation(f.root,executionOptions({manifest,guard,catalog:async()=>catalog,invoke}));await runCases(owner,manifest);
    assert.equal(ledger.used,1,JSON.stringify(owner.status().jobs));assert.equal(owner.state.resources.requests,baseline.requests+1);
    const count=calls.length;await runCases(owner,manifest);assert.equal(calls.length,count);assert.throws(()=>guard.authorize(packet),/Aggregate/);
    if(purpose==='rejected-proposal-followup'||purpose==='candidate-verification'){
      const duplicate=structuredClone(manifest);duplicate.authorization='different manifest, same consumed lineage slot';duplicate.continuation.baseline=accountingBaseline(owner.state);duplicate.continuation.baselineHash=engine.hash(duplicate.continuation.baseline);
      const another=new EvaluationPlanGuard({manifest:duplicate,approval:{authorized:true,manifestHash:engine.hash(duplicate),maximumRequests:1},ledger:{manifestHash:engine.hash(duplicate),used:0,receipts:[]},root:f.root,save:()=>assert.fail('No renewed slot')});
      assert.throws(()=>another.continuation(owner.state),/lineage already owns/);
    }
    owner.dispose();await owner.loop;parent={manifest,ledger};storeParent();
  }
  assert.deepEqual(calls,['rejected-proposal-repair',...(extraAuthoring?['rejected-proposal-followup']:[]),'candidate-verification']);assert.equal(engine.read(f.root,entry.id).publication.ready,true);
});

test('204 fresh jobs complete both real engine stages and publication with automatic finite allowance', { skip: !native }, async t => {
  const count = 204, phases = new Map(); let peak = 0, active = 0, indexed = 0;
  const f = await fixture(t, count, async input => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, input.phase === 'generate' ? 2 : 4));
    active--; phases.set(input.finding.id, [...(phases.get(input.finding.id) || []), input.phase]);
    return response(input);
  });
  const originalCatalog = f.options.catalog; f.options.catalog = async () => { indexed++; return originalCatalog(); };
  f.options.configuration = () => ({ provider: 'codex', workers: 16, providerCapacity: 16, requestLimit: 0, batchDeadlineMs: 120000 });
  const start = performance.now(); await f.runner.ensure();
  assert.equal(f.runner.status().ready, count); assert.equal(f.runner.state.batch.outcome, 'completed');
  assert.equal(f.runner.state.resources.requests, count * 2); assert.equal(f.runner.state.resources.limit, count * 6);
  assert.equal(indexed, 1); assert.ok(peak > 2 && peak <= 16);
  assert.equal(phases.size, count); for (const value of phases.values()) assert.deepEqual(value, ['generate', 'challenge']);
  assert.equal(Object.keys(f.runner.state.resources.receipts).length, count * 2);
  for (const id of phases.keys()) assert.ok(f.runner.published(engine.read(f.root, id)));
  t.diagnostic(JSON.stringify({ label: 'Controlled durations, zero external requests; not real batch latency', jobs: count, generationDelayMs: 2, challengeDelayMs: 4,
    importAcceptedAt: f.runner.state.batch.startedAt, importToAcceptedMs: Date.parse(f.runner.state.batch.finishedAt) - Date.parse(f.runner.state.batch.startedAt),
    localAndControlledWallMs: performance.now() - start, peakFixedInvocations: peak, catalogAcquisitions: indexed,
    stageCounts: Object.values(f.runner.state.resources.receipts).reduce((counts, receipt) => { counts[receipt.phase] = (counts[receipt.phase] || 0) + 1; return counts; }, {}) }));
});

test('one response repair survives generation yield and cannot be purchased again during challenge', { skip: !native }, async t => {
  const f = await fixture(t, 1, (input, calls) => calls.length === 1 || input.phase === 'challenge' ? { malformed: true } : response(input));
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 6, workers: 1 });
  await f.runner.ensure();
  assert.deepEqual(f.calls.map(call => call[1]), ['generate', 'generate', 'challenge']);
  const saved = engine.read(f.root, 'I-1'); assert.equal(saved.checkpoint.repairUsed, true); assert.equal(saved.phase, 'blocked');
  assert.equal(f.runner.status().ready, 0);
  await f.runner.ensure(); assert.equal(f.calls.length, 3);
});

test('deadline includes an authorization await and persists expiry through reopening without a reservation', { skip: !native }, async t => {
  const f = await fixture(t, 1); let release, entered;
  // Drive the existing wall-clock boundary explicitly: machine load during
  // indexing must not expire this control before its authorization hold exists.
  let clock = Date.parse(require('../extension/store').readReport(f.root).importedAt);
  t.mock.method(Date, 'now', () => clock);
  const hold = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 6, batchDeadlineMs: 180 });
  f.options.authorizeRequest = async () => { entered(); await hold; };
  const pending = f.runner.ensure(); await started;
  clock += 210; f.runner.armDeadline(); release(); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.runner.state.resources.requests, 0);
  assert.equal(f.runner.state.batch.outcome, 'deadline-exceeded'); const deadline = f.runner.state.batch.deadlineAt;
  await f.runner.ensure({ retry: true }); assert.equal(f.calls.length, 0); assert.equal(f.runner.state.batch.deadlineAt, deadline);
});

test('case-corrected Location reaches normal import, applicability, generation and publication', { skip: !native }, async t => {
  const f = await fixture(t, 1, null, reportText(1) + '\n**Location**: Src/Gate.sol:L5\n');
  await f.runner.ensure();
  assert.equal(f.calls.length, 2); assert.equal(f.runner.status().published, true);
  const saved = engine.read(f.root, 'I-1');
  assert.equal(saved.evidence[0].source.file, 'src/Gate.sol');
  assert.equal(saved.evidence[0].source.line, 5);
  assert.equal(saved.evidence[0].source.sourceHash, engine.hash(code));
});
test('Script/script applicability uses the same indexed path; a folded collision blocks before provider work', { skip: !native }, async t => {
  for (const collision of [false, true]) {
    const f = await fixture(t, 1, null, reportText(1) + '\n**Location**: Script/Gate.sol:L5\n');
    fs.mkdirSync(path.join(f.root, 'script'));
    fs.renameSync(path.join(f.root, 'src/Gate.sol'), path.join(f.root, 'script/Gate.sol'));
    if (collision) {
      fs.mkdirSync(path.join(f.root, 'SCRIPT'));
      fs.writeFileSync(path.join(f.root, 'SCRIPT/GATE.sol'), code.replace('contract Gate', 'contract DifferentGate'));
    }
    const indexed = await analyze(native, f.root, { mode: 'source' });
    f.replaceCatalog(new SourceCatalog(f.root, indexed.runner, indexed.result));
    await f.runner.ensure();
    assert.equal(f.runner.status().published, !collision);
    assert.equal(f.calls.length, collision ? 0 : 2);
    if (collision) assert.match(f.runner.state.jobs['I-1'].reason, /not present unambiguously/);
    else assert.equal(engine.read(f.root, 'I-1').evidence[0].source.file, 'script/Gate.sol');
  }
});
test('the largest supported causal collections survive acceptance, durable storage and reopening without truncation', { skip: !native }, async t => {
  const capacity = require('../extension/review-capacity');
  const f = await fixture(t, 1, input => {
    const output = response({ ...input, checkOnly: false });
    output.claims = Array.from({ length: capacity.limits.claims }, (_, i) => ({ ...output.claims[0], id: `c${i}`, evidence: [`g${i}`] }));
    output.evidence = output.claims.map((claim, i) => ({ ...output.evidence[0], id: `g${i}`, claimId: claim.id }));
    output.causal.obligations = output.claims.flatMap((claim, i) => capacity.kinds.map(kind => ({ ...output.causal.obligations.find(item => item.kind === kind), id: `${claim.id}-${kind}`, claimId: claim.id, evidence: [`g${i}`] })));
    output.causal.events = Array.from({ length: capacity.limits.events }, (_, i) => ({ ...output.causal.events[0], id: `e${i}`, claimId: `c${i % 8}`, evidenceId: `g${i % 8}` }));
    output.causal.order = output.causal.events.map(item => item.id);
    output.causal.relationships = Array.from({ length: capacity.limits.relationships }, (_, i) => ({ from: `e${i < 17 ? i : i - 17}`, to: `e${i < 17 ? i + 1 : 17}`, kind: 'context', explanation: 'Another condition in the same fictional source.', binding: 'Reading context only.', evidence: ['g0'] }));
    output.causal.checks = capacity.targets(output.causal).map(item => ({ target: item.key, reason: 'The stated false condition fails the guard.', evidence: output.evidence.map(item => item.id), documentation: [] }));
    output.explanationReviews = output.evidence.map(item => ({ evidenceId: item.id, result: 'kept', reason: item.explanation, checkedSourceIds: [item.sourceId] }));
    output.walkthrough.steps = output.evidence.map(item => ({ evidenceId: item.id, title: 'Check the guard', paragraphId: '', phrase: '' }));
    output.walkthrough.assessment.opposingEvidence = 'g0';
    if (input.checkOnly) return { result: 'kept', problems: [], explanationReviews: output.explanationReviews, checks: output.causal.checks };
    return output;
  });
  await f.runner.ensure();
  assert.equal(f.runner.status().published, true, f.runner.state.jobs['I-1'].reason);
  const draft = engine.read(f.root, 'I-1');
  assert.equal(draft.claims.length, 8); assert.equal(draft.causal.obligations.length, 64);
  assert.equal(draft.causal.events.length, 18); assert.equal(draft.causal.relationships.length, 30); assert.equal(draft.causal.checks.length, 112);
  assert.equal(policy.gate(draft).ready, true);
});
test('one finding allowance cannot pause other eligible findings or mislabel report spend', { skip: !native }, async t => {
  const f = await fixture(t, 2, input => {
    if (input.finding.id === 'I-1') f.runner.state.jobs['I-1'].requestLimit = 1;
    return response(input);
  });
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 100, workers: 2 });
  await f.runner.ensure();
  assert.equal(f.runner.state.jobs['I-1'].state, 'paused');
  assert.match(f.runner.state.jobs['I-1'].reason, /Finding I-1.*1\/1/);
  assert.equal(f.runner.state.jobs['I-2'].state, 'completed');
  assert.equal(f.runner.status().requests, 3); assert.equal(f.runner.status().requestLimit, 100);
  assert.equal(f.runner.status().published, false); assert.equal(f.runner.status().mode, 'incomplete');
});
test('dirty input before dispatch and during response leaves no running job without a task', { skip: !native }, async t => {
  for (const initiallyDirty of [true, false]) {
    let dirty = initiallyDirty;
    const f = await fixture(t, 1, input => { dirty = true; return response(input); });
    f.options.dirty = () => dirty;
    await f.runner.ensure();
    assert.equal(f.runner.state.jobs['I-1'].state, 'paused');
    assert.match(f.runner.state.jobs['I-1'].reason, /unsaved/);
    assert.equal(f.runner.tasks.size, 0); assert.equal(f.runner.active, null);
    assert.equal(f.calls.length, initiallyDirty ? 0 : 1); assert.equal(f.runner.status().published, false);
  }
});
test('slow work does not starve independent stages; achieved concurrency and receipts remain bounded', { skip: !native }, async t => {
  let release; const slow = new Promise(resolve => release = resolve); let active = 0, maximum = 0;
  const f = await fixture(t, 3, async input => {
    active++; maximum = Math.max(maximum, active);
    if (input.finding.id === 'I-1' && input.phase === 'generate') await slow;
    active--; return response(input);
  });
  const run = f.runner.ensure();
  for (let i = 0; i < 500 && f.runner.state?.jobs['I-3']?.state !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.runner.state.jobs['I-3'].state, 'completed');
  assert.equal(f.runner.state.jobs['I-1'].state, 'running');
  release(); await run;
  assert.equal(maximum, 2); assert.equal(f.runner.status().concurrency.achieved, 2);
  assert.equal(Object.keys(f.runner.state.resources.receipts).length, 6);
  assert.equal(f.runner.status().published, true);
});
test('an inherited small ledger still finishes admitted continuations without spending uncheckable generations', { skip: !native }, async t => {
  const f = await fixture(t, 24);
  f.options.configuration = () => ({ provider: 'none', requestLimit: 6, workers: 2 });
  await f.runner.ensure();
  f.options.configuration = () => ({ provider: 'codex', requestLimit: 6, workers: 2 });
  await f.runner.ensure({ retry: true });
  assert.equal(f.calls.length, 6); assert.ok(f.runner.status().ready >= 1);
  assert.ok(new Set(f.calls.map(call => call[0])).size >= 3, 'Continuations do not monopolize every worker.');
  assert.equal(f.runner.status().published, false, 'Aggregate completion is still false; independently ready findings are already readable.');
  assert.equal(f.runner.tasks.size, 0);
});
test('same-source restart reuses the manifest without one full workspace scan per artifact', { skip: !native }, async t => {
  const f = await fixture(t, 12); await f.runner.ensure();
  const metrics = require('../extension/workspace-snapshot').metrics, before = metrics.reconciliations;
  const again = new ReportPreparation(f.root, f.options); t.after(() => again.dispose());
  await again.ensure();
  assert.equal(f.calls.length, 24); assert.equal(again.status().published, true);
  assert.ok(metrics.reconciliations - before <= 2, 'One shared validation at reuse and one publication check, not N scans.');
});
test('source-only unrelated change keeps checked work; a new named caller invalidates its dependency closure', { skip: !native }, async t => {
  const f = await fixture(t, 1);
  const extra = path.join(f.root, 'src/Unrelated.sol');
  fs.writeFileSync(extra, 'pragma solidity ^0.8.20;\ncontract Unrelated { function color() external pure returns(uint) { return 1; } }\n');
  const reindex = async () => { const indexed = await analyze(native, f.root, { mode: 'source' }); f.replaceCatalog(new SourceCatalog(f.root, indexed.runner, indexed.result)); };
  await reindex(); await f.runner.ensure(); assert.equal(f.calls.length, 2);
  const technical=require('../extension/technical-assessment'),original=engine.read(f.root,'I-1'),projection=policy.expose(original).assessmentProjection;
  assert.equal(technical.current(original),true);assert.equal(projection.technical.result,'refuted');
  fs.writeFileSync(extra, fs.readFileSync(extra, 'utf8').replace('return 1', 'return 2'));
  const start=performance.now();f.runner.invalidate('unrelated change'); await reindex();const indexedAt=performance.now();await f.runner.ensure();const ensuredAt=performance.now();
  assert.equal(f.calls.length, 2); assert.equal(f.runner.status().published, true);
  const compatible=engine.read(f.root,'I-1'),again=policy.expose(compatible).assessmentProjection;
  assert.equal(technical.current(compatible),true);assert.equal(again.technical.result,'refuted');assert.equal(again.technical.identity,projection.technical.identity);
  assert.deepEqual(again.severity,projection.severity);assert.equal(compatible.technicalReview.identity,original.technicalReview.identity);
  assert.equal(compatible.technicalReview.compatibility.proof,'workspace-snapshot-compatible');
  t.diagnostic(JSON.stringify({scope:'one two-file fixture, unrelated source reindex/ensure/saved read+projection',samples:1,reindexMs:indexedAt-start,ensureMs:ensuredAt-indexedAt,reopenProjectionMs:performance.now()-ensuredAt,additionalCallbacks:f.calls.length-2}));
  const changed=structuredClone(compatible);changed.claims[0].conditions.push('New material premise');assert.equal(technical.current(changed),false);
  fs.appendFileSync(extra, '\ncontract Caller { function callGate(Gate g) external { g.finish(false); } }\n');
  f.runner.invalidate('new caller'); await reindex(); await f.runner.ensure();
  assert.equal(f.calls.length, 4);
});
test('a long function keeps its full local body and reads its tail before a substantive challenge', { skip: !native }, async t => {
  const tail = Array.from({ length: 1500 }, (_, i) => `        // Deliberate long-function reading context ${i}: ${'padding '.repeat(10)}`).join('\n');
  // The only decisive guard is AFTER the initial model budget, not merely a
  // comment tail after a guard that was already known. Independently, false
  // still reverts; a prefix alone cannot establish that outcome.
  const long = code.replace('        require(accepted, "rejected");', tail + '\n        require(accepted, "rejected");');
  const guardLine = long.split('\n').findIndex(line => line.includes('require(accepted')) + 1;
  const packets = [];
  const f = await fixture(t, 1, input => {
    input=require('../extension/packet-context').expand(input);
    packets.push(input);
    if(input.reviewPurpose && input.checkOnly)return checkedCandidate(input);
    const result = response(input);
    if (input.phase === 'challenge') {
      assert.equal(input.checkOnly, undefined, 'New tail code may change the argument; do not force check-then-repair.');
      assert.equal(input.candidateOnly, true,'Tail-dependent amendments are constructed privately before full checking.');
      assert.ok(input.sources.some(unit => unit.code.includes(`${guardLine} |         require(accepted, "rejected");`)), 'The decisive tail guard was actually supplied.');
      result.evidence[0].line = result.evidence[0].endLine = guardLine;
      delete result.walkthrough.steps; // Current response schema derives this from causal order.
      return candidatePatch(result);
    }
    assert.ok(!input.sources.some(unit => unit.code.includes('require(accepted')), 'The first packet has not read the decisive guard.');
    result.claims[0] = { ...result.claims[0], status: 'unresolved', reason: 'The complete ending has not been read.', evidence: [], unknowns: ['Read the remaining local function before judging normal completion.'] };
    result.evidence = []; result.walkthrough.steps = [];
    result.walkthrough.assessment = { result: 'unclear', why: 'The available prefix does not establish the outcome.', supportingEvidence: '', opposingEvidence: '' };
    result.conclusion = { status: 'insufficient-evidence', text: 'Read the local tail.', limitations: result.claims[0].unknowns };
    Object.assign(result.causal, { outcome: 'blocked', summary: 'The local tail remains unread.', events: [], order: [], checks: [], obligations: result.causal.obligations.map(item => ({ ...item, state: 'open', evidence: [], reason: 'The relevant tail is not in this packet.' })) });
    return result;
  }, reportText(1), long);
  await f.runner.ensure();
  assert.equal(f.calls.length, 3, JSON.stringify({ reason: f.runner.state.jobs['I-1'].reason, packets: packets.map(input => ({ phase: input.phase, purpose: input.reviewPurpose, sources: input.sources.map(unit => ({ line: unit.line, endLine: unit.endLine })) })) })); assert.equal(f.runner.status().published, true, f.runner.state.jobs['I-1'].reason);
  const draft = engine.read(f.root, 'I-1'), unit = draft.sources.find(item => item.name === 'Gate::finish');
  assert.ok(unit.code.length > 110000); assert.ok(unit.source.endLine > 1500);
  assert.equal(unit.readThrough, unit.source.endLine); assert.ok(unit.code.includes('reading context 1499'));
  const supplied = packets[1].sources.find(item => item.id === unit.id);
  assert.equal(supplied.line, unit.source.line, 'An isolated challenge receives the full function, not only a remembered prefix or new tail.');
  assert.equal(supplied.endLine, unit.source.endLine);
  assert.ok(supplied.code.includes('reading context 0:') && supplied.code.includes('reading context 1499:') && supplied.code.includes(`${guardLine} |         require(accepted, "rejected");`));
  assert.equal(unit.code, long.split('\n').slice(unit.source.line - 1, unit.source.endLine).join('\n'));
  assert.equal(draft.evidence[0].source.line, guardLine); assert.equal(draft.claims[0].status, 'contradicted');
});
test('repeated identical structural failure resumes the challenge then stops without regeneration', { skip: !native }, async t => {
  const f = await fixture(t, 1, input => { const value = response(input); if (input.checkOnly) value.checks.pop(); else value.causal.events[0].caller = ''; return value; });
  await f.runner.ensure(); assert.equal(engine.read(f.root, 'I-1').failureKind, 'structural');
  const generated = f.calls.filter(([, phase]) => phase === 'generate').length;
  await f.runner.control('resume');
  assert.equal(f.calls.filter(([, phase]) => phase === 'generate').length, generated);
  const used = f.calls.length; await f.runner.control('resume');
  assert.equal(f.calls.length, used, 'The unchanged structural failure does not burn repeated allowances.');
  assert.equal(f.runner.status().published, false);
});
test('a missed same-size restored-mtime change revokes publication on reopen', { skip: !native }, async t => {
  const f = await fixture(t, 1); await f.runner.ensure();
  const file = path.join(f.root, 'src/Gate.sol'), stat = fs.statSync(file);
  fs.writeFileSync(file, code.replace('rejected', 'accepted')); fs.utimesSync(file, stat.atime, stat.mtime);
  await f.runner.ensure();
  assert.equal(f.runner.status().published, false); assert.equal(f.calls.length, 2);
  assert.match(f.runner.status().reason, /changed since|Source changed/);
});
test('progress events do not reconcile workspace content or deserialize another finding', { skip: !native }, async t => {
  const f = await fixture(t, 1), metrics = require('../extension/workspace-snapshot').metrics;
  let observed;
  f.options.invoke = async (input, options) => {
    const before = metrics.reconciliations;
    for (let i = 0; i < 100; i++) options.onProgress({ stage: 'model', receivedBytes: i });
    observed = metrics.reconciliations - before;
    return { value: response(input), audit: { phase: input.phase, outcome: 'completed' } };
  };
  await f.runner.ensure(); assert.equal(observed, 0); assert.equal(f.runner.status().published, true);
});
test('four attempted unknowns do not starve a fifth available local question', { skip: !native }, async t => {
  let sawFifth = false;
  const source = code + '\ncontract AdditionalContext { function boundary() external pure returns (uint256) { return 32; } }\n';
  const f = await fixture(t, 1, input => {
    const value = response(input);
    if (input.phase === 'generate') assert.equal(input.sources.some(unit => unit.name === 'AdditionalContext::boundary'), false, 'The unrelated definition is not an initial discovery anchor.');
    else sawFifth = input.sources.some(unit => unit.name === 'AdditionalContext::boundary');
    value.questions = Array.from({ length: 4 }, (_, i) => ({ id: `external-${i}`, claimId: 'c1', text: `Deployment fact ${i} is unavailable.`, action: 'missing-context', target: '', why: 'Requires independently supplied deployment evidence.' }));
    value.questions.push({ id: 'local-fifth', claimId: 'c1', text: 'Read the local boundary declaration.', action: 'symbol', target: 'AdditionalContext::boundary', why: 'This local definition is available after the four unresolved external questions.' });
    value.claims[0].status = 'unresolved'; value.claims[0].unknowns = ['Deployment evidence remains unavailable.'];
    value.causal.outcome = 'blocked'; value.causal.obligations[0].state = 'open'; value.conclusion.limitations = ['Deployment evidence remains unavailable.'];
    return value;
  }, reportText(1), source);
  await f.runner.ensure();
  assert.ok(sawFifth, 'The challenge receives the fifth question\'s actual local code.');
  const draft = engine.read(f.root, 'I-1');
  assert.equal(draft.phase, 'blocked'); assert.equal(f.runner.artifact('I-1'), null);
  assert.ok(draft.actions.some(action => action.sourceIds.some(id => draft.sources.find(unit => unit.id === id)?.name === 'AdditionalContext::boundary')));
  const receipts = draft.actions.filter(action => action.acquisitionKey);
  for (let i = 0; i < 4; i++) assert.ok(receipts.filter(action => action.questionId === `external-${i}`).length <= 1, 'No-progress receipts prevent identical repeated local searches.');
});
test('a compatible privately checked v4 artifact without execution handoffs migrates locally', { skip: !native }, async t => {
  const f = await fixture(t, 1); await f.runner.ensure();
  const saved = engine.read(f.root, 'I-1');
  saved.snapshot.policy = 'checked-explanation-v4'; saved.publication.policy = 'checked-explanation-v4';
  delete saved.causal.events[0].callSiteId;
  saved.publication.digest = policy.digest(saved); saved.revision++; engine.write(f.root, saved);
  await f.runner.control('pause');
  const old = p.readWorkspaceJson(f.root, '.flowboard/report-preparation.json'); old.version = 1; old.publication = null; p.atomicJson(f.root, '.flowboard/report-preparation.json', old);
  const restarted = new ReportPreparation(f.root, f.options); t.after(() => restarted.dispose());
  await restarted.ensure();
  const current = engine.read(f.root, 'I-1');
  assert.equal(current.migration.from, 'checked-explanation-v4'); assert.equal(current.publication.policy, policy.POLICY);
  assert.ok(restarted.published(current)); assert.equal(f.calls.length, 2, 'Local policy migration makes no provider request.');
});
test('a sealed v7 artifact is rechecked under current path policy without buying another review', { skip: !native }, async t => {
  const f = await fixture(t, 1); await f.runner.ensure();
  const saved = engine.read(f.root, 'I-1'), original = structuredClone(saved.causal);
  saved.snapshot.policy = 'checked-explanation-v7'; saved.publication.policy = 'checked-explanation-v7';
  saved.publication.digest = policy.digest(saved); saved.revision++; engine.write(f.root, saved);
  await f.runner.control('pause'); f.runner.dispose();
  const restarted = new ReportPreparation(f.root, { ...f.options, invoke:async()=>assert.fail('Migration cannot dispatch a paid request.') });
  t.after(()=>restarted.dispose()); await restarted.ensure();
  const current = engine.read(f.root, 'I-1');
  assert.equal(current.migration.from,'checked-explanation-v7'); assert.equal(current.publication.policy,policy.POLICY);
  assert.deepEqual(current.causal,original); assert.ok(restarted.published(current)); assert.equal(f.calls.length,2);
});
