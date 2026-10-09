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
    const value=require('../scripts/fixtures/teaching-output').response(input,'time');value.property.derivation=null;value.claims[0].kind='defect';value.claims[0].severityFactors=structuredClone(factors);
    if(variant==='order')value.causal.order=[];
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
 base.causal.relationships=[{from:'x',to:'y',kind:'data'}];base.sources=[];const diagnostics=require('../extension/tutorial-diagnostics');assert.ok(diagnostics.inspect(base).details.some(d=>d.code==='SCENARIO_CONTRADICTION'));
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
