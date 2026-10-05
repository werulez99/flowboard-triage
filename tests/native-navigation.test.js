'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { TriageBoard } = require('../extension/board');
const native = process.env.FLOWBOARD_EXTENSION_PATH;

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
  let result = TriageBoard.prototype.guideAvailability(model);
  assert.deepEqual(result.missingSourceIds,['s2','s3']); assert.equal(result.deficit,1);
  assert.match(result.reason,/Remove 1 exploration card/);
  model.expandedIds.delete('exploration0'); result = TriageBoard.prototype.guideAvailability(model);
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
  const until=Date.now()+5000;let state;
  while(Date.now()<until){state=await call('/state');if(state.reportPreparation.jobs[0].publishable)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(state.reportPreparation.jobs[0].publishable,JSON.stringify(state.reportPreparation));
  await call('/message',{type:'triage:ready'});await call('/message',{type:'triage:select',issueId:'I-1'});
  while(Date.now()<until){state=await call('/state');if(state.lastLoad?.issueId==='I-1')break;await new Promise(resolve=>setTimeout(resolve,10));}
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
