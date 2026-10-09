'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const engine=require('../extension/investigation-engine'),policy=require('../extension/guide-policy'),technical=require('../extension/technical-assessment'),profiles=require('../extension/assessment-profile'),capacity=require('../extension/review-capacity');
const provider=require('../extension/semantic-provider'),format=require('../extension/challenge-format'),native=process.env.FLOWBOARD_EXTENSION_PATH;
const factors={consequence:'minor-deviation',party:'Consumer of the modeled clock',asset:'Readiness indication',scale:'Bounded modeled interval',duration:'Until the documented deadline',repeatability:'Each independently configured interval',caps:'Supplied start and duration bounds',permissions:'Source caller',economics:'No financial loss established',recovery:'A new configuration changes the threshold',conditions:[],unknowns:[],evidence:['write','read','rule'],reason:'The established modeled readiness deviation is minor; no financial exposure is asserted.'};
async function run(t,variant='supported'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowboard-assessment-')),base=path.join(__dirname,'../scripts/fixtures/teaching-preparation/time');
 fs.cpSync(path.join(base,'project'),root,{recursive:true});await require('../extension/report').importReport(path.join(base,'report.md'),root,native,{deferMapping:true});
 const indexed=await require('../extension/runner-adapter').analyze(native,root,{mode:'source'}),catalog=new(require('../extension/source').SourceCatalog)(root,indexed.runner,indexed.result),packets=[];
 const runner=new(require('../extension/report-preparation').ReportPreparation)(root,{configuration:()=>({provider:'codex',requestLimit:4}),catalog:async()=>catalog,
  invoke:async input=>{
   packets.push(input);
   if(input.phase==='generate'){
    const value=['optional-refuted','scenarios','shared-scenarios'].includes(variant)?require('../scripts/fixtures/assessment-output').response(input,{refuted:variant==='optional-refuted',scenarios:variant.includes('scenarios'),shared:variant==='shared-scenarios'}):require('../scripts/fixtures/teaching-output').response(input,'time');value.property.derivation=null;value.claims[0].kind='defect';value.claims[0].severityFactors=structuredClone(factors);
    if(variant==='order')value.causal.order=[];
    if(['optional-unknown','optional-refuted'].includes(variant))value.claims[0].severityFactors={...structuredClone(factors),consequence:'unknown',evidence:[]};
    if(variant==='optional-invalid')value.claims[0].severityFactors={...structuredClone(factors),evidence:['absent-optional-reference']};
    if(variant==='optional-null')value.claims[0].severityFactors=null;
    if(variant==='derived'){value.property.basis='derived-security-invariant';value.property.derivation={mechanism:'The documented clock starts at startedAt and waits duration.',reason:'Preserving the full interval requires the absolute threshold startedAt + duration.',assumptions:['The supplied source-clock specification applies.'],counterevidence:'A zero start makes the formulas coincide, outside the assessed positive-start interval.',evidence:['rule','write','read']};}
    if(['mixed','open','bad-aggregate'].includes(variant)){
      const old=value.claims[0],id='separate';value.claims.push({...structuredClone(old),id,allegation:'An additional independent reported route.',kind:'impact-qualification',status:variant==='open'?'unresolved':'contradicted',reason:variant==='open'?'The independent reported route lacks its applicable premise.':'The separate overstatement is not established by this bounded clock behavior.',unknowns:variant==='open'?['An independent scenario premise is unavailable.']:[],severityFactors:null,evidence:['separate-note']});
      value.evidence.push({...structuredClone(value.evidence[0]),id:'separate-note',claimId:id,stance:variant==='open'?'context':'contradicts'});
      value.causal.obligations.push(...value.causal.obligations.map(o=>({...o,id:o.id+'-separate',claimId:id,evidence:['separate-note'],state:variant==='open'?'open':'refuted'})));
      if(variant==='open'){value.causal.outcome='blocked';value.walkthrough.assessment.result='unclear';value.conclusion.limitations=['An independent scenario premise is unavailable.'];}
      if(variant==='bad-aggregate'){value.causal.outcome='refuted';value.walkthrough.assessment.result='invalid';value.walkthrough.assessment.opposingEvidence='separate-note';}
    }
    if(variant==='conditional')value.claims[0].severityFactors.unknowns=['The duration of a real deployment is not assessed; only the supplied source-clock interval is established.'];
    assert.ok(format.valid(value,provider.responseSchema(input)),'Generation uses the real enforced contract');return{value,audit:{phase:'generate',outcome:'completed'}};
   }
   assert.equal(input.checkOnly,true,'A complete explanation needs no extra authoring');
   const value={result:'kept',problems:[],inputReviews:require('../scripts/fixtures/teaching-output').response(input,'time').inputReviews,
    explanationReviews:input.earlierDraft.evidence.map(e=>({evidenceId:e.id,result:'kept',reason:e.explanation,checkedSourceIds:[e.sourceId]})),
    checks:capacity.targets(input.earlierDraft.causal).map(x=>({target:x.key,reason:'Controlled source review of this exact bounded claim, scope and consequence; optional factors introduce no deployment assertion.',evidence:input.earlierDraft.evidence.map(e=>e.id),documentation:[]}))};
   assert.ok(format.valid(value,provider.responseSchema(input)));return{value,audit:{phase:'challenge',outcome:'completed'}};
  }});
 t.after(async()=>{runner.dispose();await runner.loop;fs.rmSync(root,{recursive:true,force:true});});
 const start=performance.now();await runner.ensure();const duration=performance.now()-start,draft=engine.read(root,'I-1');
 t.diagnostic(JSON.stringify({variant,durationMs:duration,purposes:packets.map(p=>p.phase+':'+(p.checkOnly?'checkOnly':p.reviewPurpose||'ordinary')),bytes:packets.map(p=>provider.measureRequest(p).requestBytes),externalRequests:0}));
 return{root,runner,draft,packets,catalog};
}
test('production normalization never publishes supported primary plus refuted secondary as aggregate invalid',{skip:!native},async t=>{
 const {draft,packets}=await run(t,'bad-aggregate');assert.equal(packets.length,1,'Known aggregate contradiction consumes no V');
 assert.equal(draft.failureCode,'TUTORIAL_REPRESENTATION');assert.equal(draft.claims[0].status,'supported');assert.equal(draft.claims[1].status,'contradicted');
 assert.ok(draft.tutorialDiagnostics.details.some(d=>d.code==='ASSESSMENT_AGGREGATION'));
 assert.equal(policy.expose(draft).assessmentProjection.technical.result,'not-assessed');assert.equal(policy.gate(draft).ready,false);
});
for(const variant of ['supported','mixed','open','order','derived','conditional'])test(`ordinary import, full review, safe projection and reopen: ${variant}`,{skip:!native},async t=>{
 const {root,runner,draft,packets}=await run(t,variant);
 assert.equal(packets.length,2,draft.error);assert.ok(technical.current(draft),JSON.stringify({error:draft.error,receipt:draft.technicalReview,runs:draft.runs}));
 const exposed=policy.expose(draft),a=exposed.assessmentProjection;
 assert.equal(a.technical.result,'supported',JSON.stringify(a));assert.equal(a.technical.coverage,variant==='open'?'partial':'complete');
 assert.equal(draft.publication.ready,!['order','open'].includes(variant),draft.error);
 if(variant==='order'){assert.equal(exposed.causal,undefined);assert.equal(exposed.claims.length,0);assert.ok(a.tutorial.problems.some(p=>p.includes('reading order')));assert.ok(a.technical.evidence.length);}
 if(variant==='open')assert.match(a.technical.label,/additional alleged scope unresolved/);
 assert.equal(a.severity.state,variant==='conditional'?'conditional':'assessed');
 const before=packets.length;await runner.ensure();assert.equal(packets.length,before,'Unchanged finished technical assessment is not a retry invitation');
 const reloaded=engine.read(root,'I-1');assert.deepEqual(policy.expose(reloaded).assessmentProjection,a);
 const changed=structuredClone(draft);changed.claims[0].reason+=' Unreviewed addition';assert.equal(policy.expose(changed).assessmentProjection.technical.result,'not-assessed');assert.ok(draft.claims[0].reason);
 const profile=profiles.validate({version:1,name:'Example H/M engagement',revision:'1',labels:{Low:'Low — no payout'},eligibleBands:['High','Medium']});
 const mapped=profiles.project(draft,a,profile);assert.equal(mapped.severity.band,'Low');assert.equal(mapped.engagement.state,variant==='conditional'?'conditional':'excluded');assert.equal(a.technical.result,'supported');
 assert.throws(()=>profiles.validate({...profile,trust:'Administrator is trusted'}),/Invalid engagement/);
 if(variant==='derived'){changed.property.derivation.reason='A different entitlement';assert.equal(policy.expose(changed).assessmentProjection.technical.result,'not-assessed');}
 const old=structuredClone(draft);delete old.technicalReview;if(variant==='order')assert.equal(policy.expose(old).assessmentProjection.technical.result,'not-assessed','Historical V cannot acquire the new scoped review semantics');
});
test('aggregation and scenario checks preserve support, scope and explicit state transitions',()=>{
 const base={property:{basis:'source-contract',evidence:['rule']},claims:[{id:'a',status:'supported',kind:'defect',unknowns:[],evidence:['proof']}],evidence:[{id:'proof',claimId:'a',stance:'supports'}],conclusion:{limitations:[]},causal:{outcome:'refuted',obligations:['rule','behavior','impact'].map(kind=>({claimId:'a',kind,state:'established'})),events:[],relationships:[],order:[]},walkthrough:{assessment:{result:'invalid'}}};
 assert.ok(technical.consistency(base).some(d=>d.code==='ASSESSMENT_AGGREGATION'));
 const defeated=structuredClone(base);defeated.causal.outcome='supported';defeated.causal.obligations.push({claimId:'a',kind:'conditions',state:'refuted'});
 assert.equal(technical.aggregate(defeated).result,'insufficient-evidence');assert.ok(technical.consistency(defeated).some(d=>d.code==='SUPPORT_SCOPE'));
 const contextual=structuredClone(base);contextual.claims[0].status='contradicted';contextual.evidence[0].stance='contradicts';contextual.claims.push({id:'public-fact',kind:'context',status:'supported',unknowns:[]});
 assert.equal(technical.aggregate(contextual).result,'refuted','True public-callability context does not establish a surviving defect');
 base.claims.push({id:'b',status:'unresolved',unknowns:['Independent unavailable premise'],evidence:[]});assert.equal(technical.aggregate(base).result,'supported');assert.equal(technical.aggregate(base).coverage,'partial');
 const reverse=structuredClone(base);reverse.claims.reverse();reverse.evidence.reverse();assert.equal(technical.aggregate(reverse).result,'supported');
 base.claims[0].status='unresolved';assert.equal(technical.aggregate(base).result,'insufficient-evidence');
 base.causal.outcome='blocked';base.causal.events=['x','y'].map((id,i)=>({id,invocationId:id,transaction:'tx',claimId:'a',effect:'read',conditions:[`paused == ${i?'false':'true'}`],inputs:[],changes:[]}));
 base.causal.relationships=[{from:'x',to:'y',kind:'data'}];base.sources=[];const diagnostics=require('../extension/tutorial-diagnostics');assert.ok(diagnostics.inspect(base).details.some(d=>d.code==='SCENARIO_STATE_IDENTITY'),'Without declarations the host cannot prove same-state contradiction');
 base.causal.events[0].changes=[{name:'paused',before:'true',after:'false',evidence:['proof']}];
 const span={file:'src/Switch.sol',sourceHash:'fixture-version',line:1,endLine:1};base.sources=[{id:'switch',source:span,code:'paused = false;',complete:true}];
 Object.assign(base.evidence[0],{sourceId:'switch',source:span,quote:'paused = false;'});
 assert.ok(!diagnostics.inspect(base).details.some(d=>d.code==='SCENARIO_CONTRADICTION'),'An explicit cited state transition is not mutually exclusive static state');
 base.causal.events[0].changes=[];
 base.causal.relationships[0].kind='context';assert.ok(!diagnostics.inspect(base).details.some(d=>d.code==='SCENARIO_CONTRADICTION'));
});
test('a refuted assessment keeps selected profile attribution without manufacturing eligibility or severity',()=>{
 const profile=profiles.validate({version:1,name:'Explicit custom mapping',revision:'2',labels:{},eligibleBands:['High','Medium']});
 const result=profiles.project({}, {technical:{result:'refuted'}},profile);
 assert.equal(result.severity.state,'not-applicable');assert.equal(result.engagement.state,'not-assessed');assert.equal(result.engagement.name,profile.name);assert.equal(result.engagement.identity,profile.identity);
});
for(const variant of ['optional-unknown','optional-invalid','optional-null','optional-refuted'])test(`optional factors do not erase an independently checked core: ${variant}`,{skip:!native},async t=>{
 const {root,draft,packets}=await run(t,variant),shown=policy.expose(draft);
 assert.equal(packets.length,2);assert.equal(draft.publication.ready,true,draft.error);
 assert.equal(shown.assessmentProjection.technical.result,variant==='optional-refuted'?'refuted':'supported');assert.equal(shown.assessmentProjection.severity.state,variant==='optional-refuted'?'not-applicable':'not-assessable');
 assert.equal(shown.claims[0].severityFactors,null,'Unavailable assertions never cross the presentation boundary');
 assert.deepEqual(engine.read(root,'I-1').claims[0].severityFactors,draft.claims[0].severityFactors,'Raw optional content remains intact');
 const changed=structuredClone(draft);changed.causal.obligations.find(o=>o.kind==='impact').state='open';
 assert.equal(policy.gate(changed).ready,false);assert.equal(policy.expose(changed).assessmentProjection.technical.result,'not-assessed');
});
test('new execution evidence withdraws current approval before save; failures/reopen cannot resurrect it',{skip:!native},async t=>{
 const {root,draft,packets}=await run(t),old=structuredClone(draft.technicalReview);
 const observation={id:'observed-local',claimId:draft.claims[0].id,sourceId:draft.sources[0].id,source:draft.sources[0].source,
   outcome:'passed',interpretation:'Existing assertions completed; relevance needs review.',tests:[{name:'testClock',status:'Success',reason:'',logs:['observed 10']}],command:['forge','test'],limits:['Controlled test setup'],startedAt:'first'};
 draft.experiments.push(observation);draft.phase='experiment-recorded';draft.revision++;engine.write(root,draft);
 for(const phase of ['experiment-recorded','blocked','cancelled']){
   draft.phase=phase;engine.write(root,draft);const reopened=engine.read(root,'I-1'),a=policy.expose(reopened).assessmentProjection;
   assert.equal(technical.current(reopened),false);assert.equal(a.technical.result,'not-assessed');assert.match(a.technical.why,/interpretation/);assert.equal(policy.gate(reopened).ready,false);
   assert.equal(a.severity.state,'not-assessable');assert.equal(a.engagement.state,'not-assessed');assert.deepEqual(reopened.technicalReview,old);
 }
 assert.equal(packets.length,2,'Save/reopen is not a new review');
 const incidental=structuredClone(draft);incidental.experiments=[];assert.equal(technical.current(incidental),true);
 incidental.experiments=[{...observation,outcome:'setup-failure',tests:[{name:'setUp()',status:'Failure'}]}];assert.equal(technical.current(incidental),true,'No tested property observation was produced by failed setup');
 incidental.experiments[0].tests.push(...observation.tests);assert.equal(technical.current(incidental),false,'A different successful test is not erased by another suite setup failure');
 technical.seal(draft,{...old});assert.equal(technical.current(draft),false,'Replaying an old receipt cannot bind an observation absent from its input');
 technical.seal(draft,{...old,observations:technical.observations(draft)});assert.equal(technical.current(draft),true,'Control: the review sealing path binds the observations in its actual packet');
 draft.experiments[0].startedAt='later';assert.equal(technical.current(draft),true,'Clock formatting is not substantive identity');
 draft.experiments[0].tests[0].logs=['observed 20'];assert.equal(technical.current(draft),false,'Observed values are material even with unchanged pass status');
});
test('blocked assessment evidence uses the host-approved identity and emits no private narrative',{skip:!native},async t=>{
 const {root,draft,catalog,packets}=await run(t,'order'),messages=[],added=[],opened=[];
 const {TriageBoard}=require('../extension/board'),model={id:'I-1',token:'session',investigationDraft:draft,catalog,sourceById:new Map(),expandedIds:new Set()};
 const board=Object.assign(Object.create(TriageBoard.prototype),{root,models:new Map([['I-1',model]]),activeId:'I-1',activeToken:'session',callbacks:{},
  investigationCurrent:m=>m===model,assertCurrent:()=>catalog.assertFresh(),post:async m=>messages.push(m),native:{addFunction:(...args)=>added.push(args)},
  vscode:{Uri:{file:fsPath=>({fsPath})},Range:class{constructor(...coordinates){this.coordinates=coordinates;}},window:{showTextDocument:async(...args)=>opened.push(args)},workspace:{getConfiguration:()=>({get:()=>''}),openTextDocument:async uri=>({isDirty:false,uri})}}});
 const a=board.exposed(draft).assessmentProjection,entry=a.technical.evidence[0];assert.ok(entry.claimId);assert.ok(entry.claimTitle);
 await board.inspectAssessmentEvidence(model,{assessmentIdentity:a.artifact.identity,evidenceId:entry.id,navigationId:'nav'});
 const focused=messages.find(m=>m.type==='triage:assessmentFocus');assert.deepEqual(focused.source,entry.source);assert.equal(focused.entry.note,entry.note);
 assert.ok(added[0][1].includes(entry.source.line?draft.evidence[0].quote:''));assert.equal(messages.some(m=>m.type==='triage:investigationLinks'),false);
 assert.ok(!messages.some(m=>JSON.stringify(m).includes(draft.causal.events[0].why)),'Withheld event narrative is not an inspection hint');
 const rule=a.technical.evidence.find(e=>e.id==='rule');await board.inspectAssessmentEvidence(model,{assessmentIdentity:a.artifact.identity,evidenceId:rule.id,navigationId:'rule'});
 assert.equal(opened.length,1,'Declaration/specification context opens the exact existing source view, not an invented function');assert.deepEqual(messages.at(-1).source,rule.source);assert.equal(messages.at(-1).editor,true);
 await assert.rejects(board.inspectAssessmentEvidence(model,{assessmentIdentity:'old',evidenceId:entry.id}),/identity/);
 await assert.rejects(board.inspectAssessmentEvidence(model,{assessmentIdentity:a.artifact.identity,evidenceId:'private'}),/not exposed/);
 await assert.rejects(board.focusInvestigation(model,{evidenceId:entry.id}),/private explanation/);
 assert.equal(packets.length,2);assert.deepEqual(engine.read(root,'I-1').technicalReview,draft.technicalReview);
 const newer=engine.read(root,'I-1');newer.experiments.push({id:'new',claimId:'c1',sourceId:entry.sourceId,source:entry.source,outcome:'passed',interpretation:'Needs interpretation',tests:[{name:'testNew',status:'Success'}],command:['forge','test'],limits:[]});newer.revision++;engine.write(root,newer);
 await assert.rejects(board.inspectAssessmentEvidence(model,{assessmentIdentity:a.artifact.identity,evidenceId:entry.id}),/identity/,'A delayed webview/model cannot override the current saved observation state');
});
test('a complete two-scenario tutorial retains independent support after observation, failure and reopen',{skip:!native},async t=>{
 const {root,runner,draft,packets}=await run(t,'scenarios');assert.equal(draft.publication?.ready,true,JSON.stringify({error:draft.error,problems:draft.validationProblems}));assert.equal(draft.causal.events.length,3);
 draft.experiments.push({id:'scope-b-observation',claimId:'separate',sourceId:draft.sources[0].id,source:draft.sources[0].source,outcome:'test-failed',interpretation:'Pending interpretation of the separate scenario.',tests:[{name:'testOther',status:'Failure',reason:'Controlled result to interpret.'}],command:['forge','test'],limits:[]});
 for(const phase of ['experiment-recorded','blocked','cancelled']){draft.phase=phase;draft.revision++;engine.write(root,draft);
 const a=policy.expose(draft).assessmentProjection;
 assert.equal(a.technical.result,'supported');assert.equal(a.technical.coverage,'partial');assert.ok(a.technical.unresolved.includes('separate'));
 assert.ok(a.technical.evidence.every(e=>e.claimId!=='separate'));assert.match(a.technical.remaining.join(' '),/observations/);assert.equal(policy.gate(draft).ready,false);
 assert.deepEqual(policy.expose(engine.read(root,'I-1')).assessmentProjection,a);}
 assert.equal(packets.length,2);
 runner.options.invoke=async input=>{packets.push(input);assert.equal(input.checkOnly,true);await runner.control('pause');throw Object.assign(new Error('Controlled recheck timeout'),{failureKind:'timeout',audit:{phase:'challenge',outcome:'timeout',cleanupConfirmed:true}});};
 await runner.continueFinding('I-1');
 const failed=engine.read(root,'I-1'),after=policy.expose(failed).assessmentProjection;assert.equal(packets.length,3);assert.equal(after.technical.result,'supported');assert.equal(after.technical.coverage,'partial');assert.equal(policy.gate(failed).ready,false);
 draft.experiments[0].claimId='unknown';assert.equal(policy.expose(draft).assessmentProjection.technical.result,'not-assessed');
});
test('an explicit material dependency propagates despite independent reading context',{skip:!native},async t=>{
 const {draft}=await run(t,'shared-scenarios');assert.equal(draft.publication?.ready,true,JSON.stringify({error:draft.error,problems:draft.validationProblems}));
 draft.experiments.push({id:'shared-observation',claimId:'separate',outcome:'passed',tests:[{name:'testOther',status:'Success'}]});
 assert.equal(policy.expose(draft).assessmentProjection.technical.result,'not-assessed');
});
test('profile file failures reach ordered host notifications without changing checked facts or rereading per update',{skip:!native},async t=>{
 const {root,draft,packets}=await run(t),{TriageBoard}=require('../extension/board'),messages=[],file=path.join(root,'engagement.json');let selected='engagement.json',reads=0;
 const commands=[],model={id:'I-1',token:'session',investigationDraft:draft},board=Object.assign(Object.create(TriageBoard.prototype),{root,activeId:'I-1',activeToken:'session',models:new Map([['I-1',model]]),callbacks:{},assertCurrent(){},post:async m=>messages.push(m),
  vscode:{Uri:{file:fsPath=>({fsPath})},workspace:{getConfiguration:()=>({get:()=>selected})},commands:{executeCommand:async(...args)=>commands.push(args)}}});
 const raw=fs.readFileSync;fs.readFileSync=function(name,...args){if(name===file)reads++;return raw.call(this,name,...args);};t.after(()=>{fs.readFileSync=raw;});
 const valid={version:1,name:'Local mapping',revision:'1',labels:{Low:'Not paid'},eligibleBands:['High','Medium']};
 fs.writeFileSync(file,JSON.stringify(valid));await board.remapProfile();const original=messages.at(-1),identity=original.artifact.identity;
 assert.equal(reads,1);assert.equal(original.projection.engagement.state,'excluded');
 for(const value of ['{',null,'x'.repeat(17000),JSON.stringify({...valid,trust:'new assumption'})]){
  if(value===null)fs.unlinkSync(file);else fs.writeFileSync(file,value);
  await board.remapProfile();const m=messages.at(-1);assert.equal(m.mapping.state,'unavailable');assert.equal(m.projection.engagement.state,'not-assessed');assert.equal(m.artifact.identity,identity);
  assert.deepEqual(m.projection.technical,original.projection.technical);assert.deepEqual(m.projection.severity,original.projection.severity);
 }
 fs.writeFileSync(file,JSON.stringify(valid));await board.remapProfile();assert.equal(messages.at(-1).projection.engagement.state,'excluded');
 selected='';await board.remapProfile();assert.equal(messages.at(-1).mapping.state,'none-selected');assert.equal(messages.at(-1).projection.engagement.availability,'none-selected');
 selected='../outside.json';await board.remapProfile();assert.equal(messages.at(-1).mapping.state,'unavailable');
 await board.receive({type:'triage:engagementSettings',issueId:'I-1',token:'session'});assert.deepEqual(commands,[['workbench.action.openSettings','@id:flowboardTriage.engagementProfile']]);
 await assert.rejects(board.receive({type:'triage:engagementSettings',issueId:'I-1',token:'stale'}),/out of date/);
 assert.ok(messages.every((m,i)=>m.profileObservation===i+1));assert.equal(packets.length,2);assert.deepEqual(engine.read(root,'I-1').technicalReview,draft.technicalReview);
});
