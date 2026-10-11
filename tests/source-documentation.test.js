'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const engine=require('../extension/investigation-engine'),packets=require('../extension/packet-context');
const native=process.env.FLOWBOARD_EXTENSION_PATH;
const code=['pragma solidity ^0.8.20;','contract Reward {',' /// @notice Fraction scale: 1e18 represents the whole amount.',' uint256 public constant MAX_REWARD = 1e18;',' uint256 public reward;',' /**','  * @notice Configure the reward fraction.','  * @param value A fraction scaled by 1e18, not basis points.','  */',' function setReward(uint256 value) external {','  require(value <= MAX_REWARD);','  reward = value;',' }',' /// @notice Unrelated metadata description.',' function unrelated() external pure returns (uint256) { return 7; }','}'].join('\n');
async function fixture(t,{body='',extraFiles={}}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowboard-source-docs-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'src'));
 fs.writeFileSync(path.join(root,'src/Reward.sol'),code);fs.writeFileSync(path.join(root,'report.md'),'### I-1: Reward.setReward unit comparison\nThe report compares the input accepted by Reward.setReward and its MAX_REWARD bound.\n'+body);
 for(const [file,text]of Object.entries(extraFiles)){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);}
 await require('../extension/report').importReport(path.join(root,'report.md'),root,native,{deferMapping:true});
 const indexed=await require('../extension/runner-adapter').analyze(native,root),catalog=new(require('../extension/source').SourceCatalog)(root,indexed.runner,indexed.result);
 const {report,entries}=require('../extension/report-preparation').reconcile(root),runner=new(require('../extension/report-preparation').ReportPreparation)(root,{configuration:()=>({provider:'none'}),catalog:async()=>catalog});t.after(()=>runner.dispose());
 const issue=runner.issue(entries[0]),request=runner.request(entries[0],catalog,report),draft=engine.create({findingId:entries[0].id,request,catalog,issue});
 return{root,catalog,runner,request,issue,draft,findingId:entries[0].id,current:()=>true,publish:async()=>{},provider:'none'};
}
test('ordinary import supplies exact adjacent NatSpec independently of unchanged callable coordinates',{skip:!native},async t=>{
 const f=await fixture(t);let packet,calls=0,reservations=0;
 await engine.advance({...f,preparationOnly:true,prepareRequest:input=>{packet=packets.expand(input);return input;},invoke:()=>{calls++;throw Error('No live provider');},beforeRequest:()=>{reservations++;}});
 assert.equal(calls,0);assert.equal(reservations,0);assert.equal(f.draft.phase,'local-preparation-ready',f.draft.error);
 const fn=packet.sources.find(s=>s.name==='Reward::setReward'),constant=packet.sources.find(s=>s.name==='Reward::MAX_REWARD (state)');
 assert.equal(fn.line,10);assert.equal(fn.endLine,13);assert.match(fn.code,/10 \|  function setReward/);assert.equal(constant.line,4);
 const docs=packet.sources.filter(s=>s.contextKind==='excerpt'&&/adjacent/i.test(s.reason));assert.equal(docs.length,1);
 assert.deepEqual(docs[0].providedRanges,[{line:3,endLine:3},{line:6,endLine:9}]);assert.match(docs[0].code,/3 \| .*1e18/);assert.match(docs[0].code,/8 \| .*not basis points/);assert.doesNotMatch(docs[0].code,/Unrelated metadata|function unrelated|uint256 public reward/);
 const original=f.catalog.document('src/Reward.sol');assert.equal(docs[0].sourceHash,engine.hash(original.text));assert.equal(fn.sourceHash,docs[0].sourceHash);
 require('../extension/source-coverage').packet(packet,f.draft.sources);assert.equal(f.draft.explanationReviews?.length||0,0);assert.equal(f.draft.technicalReview,undefined);
 const reopened=engine.read(f.root,f.findingId);assert.equal(reopened.sources.find(s=>s.id===docs[0].id).code,original.lines.slice(docs[0].line-1,docs[0].endLine).join('\n'));
});
function retained(f){
 const context=engine.makeContext(f.catalog,f.request,f.issue),entry=context.units.find(s=>s.name==='Reward::setReward');context.prime();
 const question={id:'q-rule',claimId:'c1',text:'Read the exact local reward-unit documentation and assess its applicability.',action:'missing-context',target:'Reward specification',why:'The expected input scale remains unresolved.'};
 const value={inputReviews:[],property:{text:'The intended reward-unit rule needs interpretation.',basis:'unresolved',evidence:[],documentation:[]},
  claims:[{id:'c1',allegation:'The setter may accept a value expressed in the wrong unit.',actor:'Caller',entry:entry.id,implementation:'Reward.setReward',conditions:[],requiredFacts:['Applicable reward unit'],supportsIf:'An established rule differs from reachable behavior.',contradictsIf:'The claimed mismatch is excluded.',status:'unresolved',reason:'The expected rule remains unresolved.',evidence:[],unknowns:['Applicable reward unit'],nextQuestion:question.text}],
  evidence:[],explanationReviews:[],transitions:[],questions:[question],conclusion:{status:'insufficient-evidence',text:'The rule is unresolved.',limitations:['Applicable reward unit']},
  walkthrough:{assessment:{result:'unclear',why:'The rule is unresolved.',supportingEvidence:'',opposingEvidence:''}},
  causal:{scope:'The imported source-conditional unit allegation.',summary:'The expected unit remains unresolved.',outcome:'blocked',obligations:[],events:[],relationships:[],order:[],checks:[]}};
 Object.assign(f.draft,engine.accept(value,f.draft,context.units));f.draft.sources=context.units;f.draft.runs=[{phase:'generate',resultAccepted:true,requestId:'scripted-retained-generation'}];
 f.draft.phase='blocked';f.draft.failureKind='material-evidence';f.draft.checkpoint={stage:'complete',followups:1,repairUsed:false};engine.write(f.root,f.draft);return value;
}
test('ordinary selected Recheck acquires omitted adjacent documentation without regeneration or inherited approval',{skip:!native},async t=>{
 const f=await fixture(t);retained(f);const old=engine.read(f.root,f.findingId),material=require('../extension/review-content').project(old);let calls=0;
 f.runner.options.invoke=async()=>{calls++;throw Error('Local action must not call provider');};await f.runner.ensure();
 await f.runner.continueFinding(f.findingId,{recheckLocalPreparation:true});
 const current=engine.read(f.root,f.findingId);assert.equal(calls,0);assert.equal(f.runner.state.resources.requests,0);
 assert.ok(current.sources.some(s=>s.modelRanges?.some(r=>r.line===6&&r.endLine===9)),current.error);
 assert.deepEqual(require('../extension/review-content').project(current),material);assert.deepEqual(current.runs,old.runs);assert.equal(current.technicalReview,old.technicalReview);
 assert.equal(current.localPreparation.revalidation.semanticApproval,false);assert.equal(current.localPreparation.revalidation.newSource,true);
 const context=engine.makeContext(f.catalog,f.request,f.issue);context.restore(current.sources,current);const before=JSON.stringify(context.units);assert.equal(context.acquireDocumentation().sourceIds.length,0);assert.equal(JSON.stringify(context.units),before,'Repeated local acquisition is idempotent.');
 const packet={sources:engine.modelSources(context.units,Infinity,true)};require('../extension/source-coverage').packet(packet,context.units);assert.match(packet.sources.find(s=>s.modelRanges||s.providedRanges)?.code||'',/1e18/);
});
test('retained private completion receives newly acquired comment context and preserves its immutable reference',{skip:!native},async t=>{
 const f=await fixture(t),value=retained(f),schema=require('../extension/semantic-provider').schema,candidates=require('../extension/review-candidate');
 f.draft.checkpoint.stage='challenge';const saved=candidates.save(f.draft,value,schema,{kind:'scripted-authoring',requestId:'scripted-candidate'});saved.state='repair-requested';saved.verification={requestId:'scripted-negative',response:{result:'repair',problems:['Interpret the applicable unit rule.'],explanationReviews:[],inputReviews:[],checks:[]}};
 const before=structuredClone(saved);let packet,calls=0;
 await engine.advance({...f,preparationOnly:true,prepareRequest:input=>{packet=packets.expand(input);return input;},invoke:()=>{calls++;throw Error('No provider');}});
 assert.equal(calls,0);assert.equal(f.draft.phase,'local-preparation-ready',f.draft.error);assert.equal(packet.phase,'challenge');assert.equal(packet.reviewPurpose,'candidate-repair');assert.deepEqual(f.draft.reviewCandidate,before);
 assert.ok(packet.sources.some(s=>s.code.includes('not basis points')));assert.deepEqual(packet.earlierDraft,value);require('../extension/source-coverage').packet(packet,f.draft.sources,[value]);
 const historical=JSON.stringify(before);engine.write(f.root,f.draft);assert.equal(JSON.stringify(engine.read(f.root,f.findingId).reviewCandidate),historical);
});
test('adjacency binds exact NatSpec, not ordinary comments, intervening declarations or shared-line headers',{skip:!native},async t=>{
 const f=await fixture(t),file=path.join(f.root,'src/Reward.sol');
 const source=['pragma solidity ^0.8.20;','contract Reward {',' /// Intended only for unrelated.',' uint256 unrelated;',' function distant() external {}',' // Ordinary comment, not NatSpec.',' function plain() external {}',' /** @notice Shared line must not pick a function. */',' function first() external {} function second() external {}',' /// Shared state declarations must not pick one.',' uint256 left; uint256 right;',' /** @notice Complete unicode documentation: α.','  * @dev Kept in its exact original coordinates.','  */',' function documented() external {}','}'].join('\r\n');fs.writeFileSync(file,source);
 const indexed=await require('../extension/runner-adapter').analyze(native,f.root),catalog=new(require('../extension/source').SourceCatalog)(f.root,indexed.runner,indexed.result);
 for(const name of ['distant','plain','first','second'])assert.equal(catalog.adjacentDocumentation(catalog.functions.find(fn=>fn.name===name)),null,name);
 for(const declaration of catalog.stateDeclarations('src/Reward.sol','Reward').filter(d=>['left','right'].includes(d.symbol)))assert.equal(catalog.adjacentDocumentation(declaration),null,declaration.symbol);
 const doc=catalog.adjacentDocumentation(catalog.functions.find(fn=>fn.name==='documented'));assert.deepEqual([doc.line,doc.endLine,doc.declarationLine],[12,14,15]);
 assert.match(catalog.document('src/Reward.sol').lines.slice(doc.line-1,doc.endLine).join('\n'),/α/);
});
test('comment-only source edits invalidate old context; explicit sparse views keep exact rows and respect packet capacity',{skip:!native},async t=>{
 const f=await fixture(t);await engine.advance({...f,preparationOnly:true});const old=engine.read(f.root,f.findingId),context=old.sources.find(s=>s.modelRanges);
 assert.throws(()=>engine.modelSources([context],1,false),/exact ranges must not be silently omitted/);
 const file=path.join(f.root,'src/Reward.sol');fs.writeFileSync(file,code.replace('not basis points','possibly basis points'));
 const indexed=await require('../extension/runner-adapter').analyze(native,f.root),catalog=new(require('../extension/source').SourceCatalog)(f.root,indexed.runner,indexed.result),next=engine.makeContext(catalog,f.request,f.issue);
 assert.throws(()=>next.restore(old.sources,old),/no longer matches/);next.prime();next.acquireDocumentation();
 const revised=engine.modelSources(next.units,Infinity,true).find(s=>s.providedRanges);assert.notEqual(revised.sourceHash,context.source.sourceHash);assert.match(revised.code,/possibly basis points/);assert.doesNotMatch(revised.code,/not basis points/);
});
test('restored sparse complete-function context acquires only its adjacent comment; a full supplied view needs no duplicate',{skip:!native},async t=>{
 const f=await fixture(t),doc=f.catalog.document('src/Reward.sol'),context=engine.makeContext(f.catalog,f.request,f.issue);
 const id=context.add({name:'Selected source context',kind:'context',contextKind:'excerpt',file:doc.uri.fsPath,startLine:1,endLine:doc.lineCount,contract:null,calls:[],memberCalls:[],modifiers:[]},'Exact selected callable.');
 const selected=context.units.find(s=>s.id===id);selected.modelRanges=[{line:10,endLine:13}];
 // Restore precisely this prior bounded view; no separate function identity
 // is available in functions.values() to accidentally help the acquisition.
 const restored=engine.makeContext(f.catalog,f.request,f.issue);restored.restore([selected],{sources:[selected],claims:[],evidence:[],actions:[]});
 const acquired=restored.acquireDocumentation();assert.deepEqual(acquired.sourceIds,[id]);assert.deepEqual(restored.units[0].modelRanges,[{line:6,endLine:13}]);
 const view=engine.modelSources(restored.units,Infinity,true)[0];assert.match(view.code,/not basis points/);assert.doesNotMatch(view.code,/Unrelated metadata|MAX_REWARD =/);require('../extension/source-coverage').packet({sources:[view]},restored.units);
 delete restored.units[0].modelRanges;assert.equal(restored.acquireDocumentation().sourceIds.length,0);assert.equal(restored.units.length,1);
});
test('original report counterpart anchors survive model omission and prioritization while unrelated discovery is deferred',{skip:!native},async t=>{
 const counterpart=['pragma solidity ^0.8.20;','contract Counterpart {',' uint16 public constant MAX_REWARD_BPS = 1000;',' function configure(uint256 base, uint256 maximum) external pure {','  require(base <= maximum && maximum <= MAX_REWARD_BPS);',' }','}'].join('\n');
 const setup=['pragma solidity ^0.8.20;','import {Counterpart} from "../src/Counterpart.sol";','contract Setup {',' function configure(Counterpart target) external {','  target.configure(50, 500);',' }','}'].join('\n');
 const f=await fixture(t,{body:'\n**Root Cause**\nThe comparison explicitly cites src/Counterpart.sol:L3 and Counterpart.configure, configured in script/Setup.sol:L5.\n\n**Mitigation**\nA proposed future edit could use src/Noise.sol:L4 instead.\n',extraFiles:{'src/Counterpart.sol':counterpart,'script/Setup.sol':setup,'src/Noise.sol':['pragma solidity ^0.8.20;','contract Noise {',...Array.from({length:35},(_,i)=>` function noise${i}() external pure returns (uint256) { return ${i}; }`),'}'].join('\n')}});
 retained(f);const context=engine.makeContext(f.catalog,f.request,f.issue);context.restore(f.draft.sources,f.draft);
 const anchor=context.units.find(s=>s.source.file==='src/Counterpart.sol'&&s.source.line<=3&&s.source.endLine>=3),script=context.units.find(s=>s.name==='Setup::configure');assert.ok(anchor);assert.ok(script);
 assert.ok(!f.draft.evidence.some(e=>e.sourceId===anchor.id));assert.ok(!f.draft.questions.some(q=>q.target===anchor.id),'The controlled author omitted this original material reference.');
 for(const fn of f.catalog.functions.filter(fn=>fn.contract==='Noise'))context.add(fn,'Unrelated discovery candidate.');assert.ok(context.units.length>32);
 const deferred=context.prioritize(f.draft);assert.ok(deferred.some(value=>value.includes('noise')));assert.ok(context.units.some(s=>s.id===anchor.id));assert.ok(context.units.some(s=>s.id===script.id));
 const inherited=context.units.filter(s=>s.id!==anchor.id);context.restore(inherited,f.draft);assert.ok(!context.units.some(s=>s.id===anchor.id),'Legacy saved omission is reproduced before prospective reacquisition.');
 context.prioritize(f.draft);assert.ok(context.units.some(s=>s.id===anchor.id));
 f.draft.sources=context.units;f.draft.checkpoint.stage='challenge';engine.write(f.root,f.draft);let packet;
 await engine.advance({...f,preparationOnly:true,prepareRequest:input=>{packet=packets.expand(input);return input;},invoke:()=>assert.fail('No provider')});assert.equal(f.draft.phase,'local-preparation-ready',f.draft.error);
 const supplied=packet.sources.find(s=>s.id===anchor.id),call=packet.sources.find(s=>s.id===script.id);assert.match(supplied.code,/3 \|  uint16 public constant MAX_REWARD_BPS = 1000;/);assert.ok(call.code.split('\n').includes(`5 | ${setup.split('\n')[4]}`));
 assert.ok(packet.requiredSourceIds.includes(anchor.id));assert.ok(packet.requiredSourceIds.includes(script.id));
 require('../extension/source-coverage').packet(packet,f.draft.sources,[packet.earlierDraft]);
 assert.throws(()=>require('../extension/source-coverage').packet({...packet,sources:packet.sources.filter(s=>s.id!==anchor.id)},f.draft.sources,[packet.earlierDraft]),/Required review source.*not supplied/);
 assert.ok(!packet.sources.some(s=>s.name==='Noise::noise1'),'Proposed-fix-only source is not promoted to a current report root.');
});
