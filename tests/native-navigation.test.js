'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { TriageBoard } = require('../extension/board');
const native = process.env.FLOWBOARD_EXTENSION_PATH;

test('board final revision check rejects a Git change during its ready await before any view publication', async t => {
  const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
  const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'board-final-revision-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.cpSync(path.join(__dirname,'../examples/project'),root,{recursive:true});
  const git=(...args)=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');git('add','.');
  const commit=()=>git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Fixture');commit();
  const request=structuredClone(require('../examples/finding.json'));request.sourceRevision=git('rev-parse','HEAD');
  let release; const board=Object.assign(Object.create(TriageBoard.prototype),{root,models:new Map(),ready:new Promise(r=>release=r),post:()=>assert.fail('No stale view delivery')});
  const opened=board.open(request,{assertFresh(){}},{},{},null,()=>true);
  commit();release();await assert.rejects(opened,/revision|HEAD|commit/i);
});

test('new report list observes current coordinator without scheduling and orders status delivery', async t => {
  const fs = require('node:fs'), path = require('node:path'), store = require('../extension/store');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'library-observation-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  store.writeDraft(root, 'A', structuredClone(require('../examples/finding.json')));
  const p=require('../extension/protocol'); p.atomicJson(root,'.flowboard/report.json',{reportHash:'report',issues:[{id:'A'}]});
  const status = { project:require('node:crypto').createHash('sha256').update(fs.realpathSync(root)).digest('hex'), reportHash:'report', jobs:[{id:'A',state:'completed',publishable:true},{id:'B',state:'paused',publishable:false},{id:'C',state:'blocked',publishable:false}] };
  const delivered = []; let reads = 0;
  const board = Object.assign(Object.create(TriageBoard.prototype), {root, ready:Promise.resolve(), callbacks:{reportPreparation:()=>({status:()=>{reads++;return status;},ensure:()=>assert.fail('Observation must not start preparation')})},
    native:{panel:{reveal(){},webview:{postMessage:m=>{delivered.push(m);return true;}}}}});
  await board.showLibrary(); assert.equal(reads,1); assert.deepEqual(delivered[0].reportPreparation,status);
  await board.post({type:'triage:reportPreparation',report:{...status,mode:'paused'}});
  assert.equal(delivered[1].reportObservation, delivered[0].reportObservation+1);
  await board.showLibrary(()=>false); board.disposed=true; await board.showLibrary();
  assert.equal(delivered.length,2); assert.equal(reads,1,'Superseded/closed panels do not observe or deliver status.');
  const text=fs.readFileSync(require.resolve('../extension/webview/triage.js'),'utf8');
  const fn=text.slice(text.indexOf('  function observePreparation'),text.indexOf('  let guideAvailability'));
  const context={reportObservation:0,reportContextObservation:0,reportPreparation:null,reportContext:null}; const vm=require('node:vm');
  vm.runInNewContext(fn,context); context.observePreparation(delivered[1],delivered[1].report);
  context.observePreparation(delivered[0],delivered[0].reportPreparation);
  assert.equal(context.reportPreparation.mode,'paused','Late initial delivery cannot replace the live status.');
  board.disposed=false;
  p.atomicJson(root,'.flowboard/report.json',{reportHash:'replacement',issues:[{id:'A'}]});
  await board.showLibrary(); assert.equal(delivered[2].reportPreparation,null,'A former report status must not describe a replacement report with reused finding IDs.');
  context.observePreparation(delivered[2],null);
  context.observePreparation({reportObservation:4},status);
  assert.equal(context.reportPreparation,null,'Late progress from the old coordinator cannot restore stale Ready rows.');
  const replacement={...status,reportHash:'replacement',mode:'paused'};
  const load={type:'triage:load',...board.libraryObservation(),reportPreparation:replacement,reportObservation:5};
  context.observePreparation(load,replacement);
  context.observePreparation({reportObservation:99},status);
  assert.equal(context.reportPreparation,replacement,'Old report progress cannot clear the current observation or advance its sequence.');
  context.observePreparation({reportObservation:6},{...replacement,mode:'completed'});
  assert.equal(context.reportPreparation.mode,'completed');
});

test('actual preparation renderer retains selected job reason and shows current host refusal in dock and expanded view', () => {
  const source = require('node:fs').readFileSync(require.resolve('../extension/webview/triage.js'), 'utf8');
  const definitions = source.slice(source.indexOf('  const preparationJob'), source.indexOf('  const readyDraft'));
  const rendering = source.slice(source.indexOf('  function preparationContent'), source.indexOf('  function guideReveal'));
  const node = (tag, cls, text = '') => ({ tag, text, children: [], hidden: false, disabled: false, scrollTop: 0,
    classList: { toggle() {} }, append(...nodes) { this.children.push(...nodes); }, prepend(...nodes) { this.children.unshift(...nodes); },
    replaceChildren() { this.children = []; }, setAttribute() {}, querySelectorAll() { return []; } });
  const flat = n => [n, ...n.children.flatMap(flat)], surface = node('div');
  const context = { active: 'B', reportPreparation: { project: 'P', reportHash: 'R', mode: 'paused', ready: 1, total: 2, reportName: 'Fixture', requests: 2, requestLimit: 2,
    jobs: [{ id: 'A', publishable: true, state: 'completed' }, { id: 'B', state: 'paused', reason: 'Finding request allowance exhausted.' }],
    admission: { scope: 'report', project: 'P', reportHash: 'R', reason: 'Report preparation is already owned by another local host.', action: 'Reopen after that host stops.' } },
    element: node, button: (label, action) => ({ ...node('button', '', label), action }), preparationLabel: s => s,
    report: '', guideAvailability: null, guideIntent: 'waiting', preparing: null, preparationState: null, investigationDraft: null, sourceStale: false, preparationExpanded: true,
    preparationSurface: surface, document: { body: { classList: { toggle() {} } } }, FlowboardWalkthrough: { build: () => null }, issueIdentifier: () => 'B', send() {} };
  const vm = require('node:vm'); vm.runInNewContext(`${definitions}\n${rendering}\nrenderPreparation();`, context);
  const text = flat(surface).map(n => n.text).join('\n');
  assert.equal((text.match(/This host cannot continue/g) || []).length, 2);
  assert.match(text, /Finding request allowance exhausted/); assert.match(text, /another local host/);
  assert.ok(!flat(surface).some(n => n.text === 'Continue this finding'));
  assert.ok(flat(surface).find(n => n.text === 'Resume entire report').disabled);
  context.active = 'A'; context.FlowboardWalkthrough.build = () => ({ ready: true }); vm.runInNewContext('renderPreparation()', context);
  assert.equal(surface.hidden, true, 'An independent ready walkthrough is not covered by the local refusal.');
  context.active = 'B'; context.reportPreparation.admission = null; context.FlowboardWalkthrough.build = () => null;
  for (const expanded of [false, true]) {
    context.preparationExpanded = expanded; vm.runInNewContext('renderPreparation()', context);
    assert.ok(!flat(surface).some(n => n.tag === 'button' && n.text === 'Continue this finding'));
    assert.match(flat(surface).map(n => n.text).join('\n'), /Shared report allowance exhausted.*explicit additional allowance/);
    if (expanded) {
      assert.equal(flat(surface).find(n => n.text === 'Resume entire report').disabled, false);
      assert.match(flat(surface).map(n => n.text).join('\n'), /Resume entire report explicitly adds ordinary report allowance/);
    }
  }
  context.reportPreparation.requestLimit = 3;
  vm.runInNewContext('renderPreparation()', context); assert.ok(flat(surface).some(n => n.text === 'Continue this finding'));
  context.guideAvailability = { ready: false, reason: 'The walkthrough needs one missing function card.' };
  vm.runInNewContext('renderPreparation()', context);
  const refused = flat(surface).map(n => n.text).join('\n');
  assert.match(refused, /Finding request allowance exhausted/);
  assert.doesNotMatch(refused, /Make room|Free the requested card slots|missing function card/,
    'A stale capacity hint must not cover the current unpublished analysis state.');
});

test('unpublished causal content cannot issue a checked-guide card-capacity hint', () => {
  for (const phase of ['blocked', 'challenging', 'ready']) {
    const model = { investigationDraft: { phase, causal: { events: [] }, sources: [], evidence: [], runs: [], actions: [] } };
    assert.equal(TriageBoard.prototype.guideAvailability(model), null,
      `${phase}: without a current publishable explanation, no layout remedy is claimed.`);
  }
});

test('rematerialized guide card with a reused ID regains readable focus, ordinary same-card delivery preserves camera', () => {
  const source = require('node:fs').readFileSync(require.resolve('../extension/webview/triage.js'), 'utf8');
  const begin = source.indexOf('      if (message.navigationId && guide) {');
  const end = source.indexOf('\n      rememberLocation(); guidePause();', begin);
  const body = source.slice(begin, end);
  for (const pending of [false, true]) {
    let focused = 0, revealed = 0;
    const context = { guidePending:pending, guideRequest:{}, guideError:null, guideMode:'guided', guideDetour:null, guideNavigation:'N', guide:{draft:{}},
      selectedCard:'same-native-id', card:{id:'same-native-id'}, message:{navigationId:'N',source:{file:'src/Guard.sol',sourceHash:'checked',line:30},claimId:'c'},
      checkedLocation:null,activeInvestigationClaim:null,visibleInvestigation:null,activeClaim:null,claimFocus:false,spotlight:false,
      guideReturn:{invocation:'entry',codeScroll:19}, evidenceInput:{note:'Keep draft'}, structuredClone,
      redrawEdges(){},renderGuide(){},schedulePersist(){}, document:{body:{classList:{contains:()=>true}}},
      focusReadable(){focused++;},guideReveal(line){assert.equal(line,30);revealed++;} };
    require('node:vm').runInNewContext(`(function(){${body}})()`,context);
    assert.equal(focused,pending?1:0);assert.equal(revealed,1);assert.equal(context.guidePending,false);
    assert.equal(context.guideReturn.invocation,'entry');assert.equal(context.evidenceInput.note,'Keep draft');
  }
});

test('Retry opening code replays the failed detour operation, not Start or Return', () => {
  const source = require('node:fs').readFileSync(require.resolve('../extension/webview/triage.js'), 'utf8');
  const body = source.slice(source.indexOf('  function retryGuideNavigation('), source.indexOf('  function show(tab)'));
  assert.ok(source.includes("button('Retry opening code', retryGuideNavigation)"));
  for (const type of ['triage:inspectEvidence', 'triage:investigationFocus']) {
    const sent = [], evidence = { id:'A', source:{file:'A.sol',line:10}, quote:'return;' };
    const context = { guideRequest:{type,payload:type==='triage:inspectEvidence'?{evidence,navigationId:'old'}:{evidenceId:'A',navigationId:'old'},issueId:'I',token:'T',guideKey:'G'},
      sourceStale:false,active:'I',token:'T',guide:{key:'G',draft:{revision:3}},guideMode:'detour',guideReturn:{step:'B',scroll:73},
      guideNavigation:null,guidePending:false,guideError:'local failure',evidenceInput:{note:'Keep my draft'},
      profile:()=>({evidence:[evidence]}),renderGuide:()=>{},crypto:{randomUUID:()=> 'new'},structuredClone,
      vscode:{postMessage:message=>sent.push(message)} };
    require('node:vm').runInNewContext(`${body}\nretryGuideNavigation();`, context);
    assert.equal(sent.length,1); assert.equal(sent[0].type,type); assert.equal(sent[0].navigationId,'new');
    assert.equal(sent[0].evidence?.id || sent[0].evidenceId,'A'); assert.equal(context.guideMode,'detour');
    assert.deepEqual(context.guideReturn,{step:'B',scroll:73}); assert.equal(context.evidenceInput.note,'Keep my draft');
    context.sourceStale=true; require('node:vm').runInNewContext('retryGuideNavigation();',context);
    assert.equal(sent.length,1); assert.match(context.guideError,/no longer current/);
  }
});

test('manual navigation generation is revoked by a newer note selection even without a guide', () => {
  const source = require('node:fs').readFileSync(require.resolve('../extension/webview/triage.js'), 'utf8');
  const body = source.slice(source.indexOf('  function beginGuideDetour('), source.indexOf('  function detourStep('));
  for (const mode of ['absent', 'preparing', 'blocked']) {
    const context = { guide: null, sourceStale: false, guideMode: 'closed', guideNavigation: 'old-A-request', guidePending: false,
      selectedCard: 'B', checkedLocation: { file: 'src/B.sol', line: 30 }, evidenceInput: { cardId: 'B', line: 30, note: 'Unfinished manual text.' }, mode };
    require('node:vm').runInNewContext(`${body}\nbeginGuideDetour('new-note');`, context);
    assert.equal(context.guideNavigation, null, `${mode}: the old source request has no authority to move the new note.`);
    assert.equal(context.selectedCard, 'B'); assert.equal(context.evidenceInput.note, 'Unfinished manual text.');
    assert.equal(context.checkedLocation.line, 30);
  }
});

test('guide capacity reports the complete missing-card deficit, not just whether one slot is free', () => {
  const units = [1,2,3].map(id => ({ id:`s${id}`, source:{file:`src/F${id}.sol`,line:10} }));
  const model = { investigationDraft:{sources:units,evidence:units.map(unit => ({id:`e${unit.id}`,sourceId:unit.id})),
    causal:{events:units.map(unit => ({evidenceId:`e${unit.id}`}))}},
    sourceById:new Map([['known',{file:'src/F1.sol',startLine:10}]]), expandedIds:new Set(['known',...Array.from({length:198},(_,i)=>`exploration${i}`)]), catalog:{relative:file=>file} };
  // Isolate layout accounting after exposure. Real accepted/stale exposure is
  // exercised by the host controls; these deliberately tiny units are not a guide.
  const board = { exposed: () => ({ ...model.investigationDraft, phase: 'ready' }) };
  let result = TriageBoard.prototype.guideAvailability.call(board, model);
  assert.deepEqual(result.missingSourceIds,['s2','s3']); assert.equal(result.deficit,1);
  assert.match(result.reason,/Remove 1 exploration card/);
  model.expandedIds.delete('exploration0'); result = TriageBoard.prototype.guideAvailability.call(board, model);
  assert.equal(result.deficit,0); assert.match(result.reason,/Start it to open/);
  assert.equal(result.ready,false,'Room for missing cards does not claim they have already been rendered.');
});

test('real host echoes manual navigation IDs and gives failed guide opening a finite scoped response', {skip:!native}, async t => {
  const host=await require('../scripts/workflow-host').start({mixedFixture:true,deferMapping:true});
  t.after(()=>host.close());
  const call=async(route,value)=>(await fetch(host.origin+route,{headers:{'X-Workflow-Token':host.secret,'Content-Type':'application/json'},...(value?{method:'POST',body:JSON.stringify(value)}:{})})).json();
  const wait=async predicate=>{const until=Date.now()+5000;while(Date.now()<until){const state=await call('/state');if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Host did not reach the expected controlled-fixture state.');};
  await wait(state=>state.reportPreparation?.jobs.some(job=>job.id==='I-1'&&job.publishable));
  await call('/message',{type:'triage:ready'}); await call('/message',{type:'triage:select',issueId:'I-1'});
  const state=await wait(state=>state.lastLoad?.issueId==='I-1'); const load=state.lastLoad;
  await call('/message',{type:'triage:rendered',issueId:'I-1',token:load.token});
  const checked=load.investigationDraft.evidence[0];
  const evidence={id:'manual-note',kind:'source',stance:'context',note:'Inspect the exact guard.',source:checked.source,quote:checked.quote};
  await call('/message',{type:'triage:inspectEvidence',issueId:'I-1',token:load.token,evidence,navigationId:'manual-navigation-1'});
  let inspected; const until=Date.now()+3000;
  while(!inspected&&Date.now()<until){inspected=(await call('/events')).messages.find(message=>message.type==='triage:evidenceInspected');if(!inspected)await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(inspected?.navigationId,'manual-navigation-1'); assert.equal(inspected.evidence.source.line,8);
  await call('/message',{type:'triage:investigationFocus',issueId:'I-1',token:load.token,evidenceId:'not-in-this-review',navigationId:'failed-navigation-2'});
  let failed; const end=Date.now()+3000;
  while(!failed&&Date.now()<end){failed=(await call('/events')).messages.find(message=>message.type==='triage:navigationFailed');if(!failed)await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(failed?.navigationId,'failed-navigation-2'); assert.equal(failed.issueId,'I-1'); assert.match(failed.reason,/Unknown investigation/);
  assert.ok(failed.guideAvailability.ready,'A navigation failure does not revoke the checked artifact.');
});

test('the checked native-route fixture uses real distinct call occurrences, complete late code, returns and rollback', {skip:!native}, async t => {
  const host=await require('../scripts/workflow-host').start({routeFixture:true,deferMapping:true});t.after(()=>host.close());
  const call=async(route,value)=>(await fetch(host.origin+route,{headers:{'X-Workflow-Token':host.secret,'Content-Type':'application/json'},...(value?{method:'POST',body:JSON.stringify(value)}:{})})).json();
  let until=Date.now()+5000,state;
  while(Date.now()<until){state=await call('/state');if(state.reportPreparation.jobs[0].publishable)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(state.reportPreparation.jobs[0].publishable,JSON.stringify(state.reportPreparation));
  await call('/message',{type:'triage:ready'});await call('/message',{type:'triage:select',issueId:'I-1'});
  // Opening is a separate asynchronous boundary, not the unused remainder
  // of the preparation wait. Preserve the same finite per-boundary timeout.
  until=Date.now()+5000;
  while(Date.now()<until){state=await call('/state');if(state.lastLoad?.issueId==='I-1')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(state.lastLoad?.issueId,'I-1','The actual checked native guide must open before inspecting its content.');
  const draft=state.lastLoad.investigationDraft,gate=require('../extension/guide-policy').gate;
  assert.equal(gate(draft).ready,true);assert.equal(state.providerCalls.length,2,'Only the fixed generation and fixed challenge are used.');
  const events=new Map(draft.causal.events.map(event=>[event.id,event]));
  assert.notEqual(events.get('first-call').callSiteId,events.get('second-call').callSiteId);
  assert.equal(events.get('first-write').inputs[0].expression,'delta');assert.equal(events.get('second-write').inputs[0].expression,'1');
  assert.notEqual(events.get('first-write').invocationId,events.get('second-write').invocationId);
  assert.equal(draft.causal.relationships.filter(link=>link.kind==='return').length,4);
  const preview=draft.sources.find(unit=>unit.name==='RouteBook::_preview');
  assert.ok(preview.complete&&preview.code.split('\n').length>95&&preview.code.includes('return completed;'));
  assert.ok(draft.evidence.find(entry=>entry.id==='preview-return').source.line>110);
  const walk=require('../extension/webview/walkthrough-model'),route=walk.build(draft,state.lastLoad.reportText);
  assert.equal(walk.watchedChanges(route,14)[0].effect,'rolled-back');
  assert.equal(walk.watchedChanges(route,14)[0].after,'A + 1','The attempted value remains history, not a fabricated final balance.');
  const wrong=structuredClone(draft);wrong.causal.events.find(event=>event.id==='second-write').inputs[0].expression='delta';
  assert.equal(gate(wrong).ready,false,'A real same-named first call cannot justify the second invocation’s wrong argument.');
});
