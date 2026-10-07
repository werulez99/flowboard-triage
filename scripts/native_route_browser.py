#!/usr/bin/env python3
"""Checked, causal multi-function native route; fixed fictional model responses.

Use --product-extension with an archived checkout's extension/ for a genuine
before/after run of the SAME fixture and driver. No provider calls are made.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright

parser=argparse.ArgumentParser()
parser.add_argument('--output',required=True)
parser.add_argument('--product-extension')
parser.add_argument('--production-selection',action='store_true',help='Activate the actual extension selection/sourceCatalog route with minimal editor IO; no test cache.')
parser.add_argument('--samples',type=int,default=3,choices=range(1,11))
parser.add_argument('--reopens',type=int,default=20,choices=range(1,51))
parser.add_argument('--baseline',action='store_true',help='Record the known stale rollback-watch defect instead of asserting its fix; all other checks still run.')
parser.add_argument('--reader-scenes',action='store_true',help='Capture a finite matched set of native reader scenes, without external requests.')
args=parser.parse_args()
repository=Path(__file__).resolve().parent.parent
output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
env=os.environ.copy()
if args.product_extension:env['FLOWBOARD_TRIAGE_EXTENSION_PATH']=str(Path(args.product_extension).resolve())
started=time.monotonic()
process=subprocess.Popen(['node',str(repository/'scripts/workflow-host.js'),'--route-fixture','--defer-mapping']+(['--production-selection'] if args.production_selection else []),cwd=repository,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
result={'boundary':'Actual importer, parser, coordinator, gate, storage and native renderer; fixed fictional answers and simulated editor transport. No real model, protocol execution or Cursor activation.',
    'checks':[],'samples':args.samples,'reopenSamples':args.reopens,'machine':{'platform':platform.platform(),'cpuCount':os.cpu_count()},
    'fixtureHashes':{str(file.relative_to(repository)):hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted((repository/'scripts/fixtures/route-preparation').rglob('*')) if file.is_file()}}
def summary(values):
    return {'count':len(values),'medianMs':statistics.median(values),'p95Ms':sorted(values)[max(0,math.ceil(len(values)*.95)-1)] if len(values)>=20 else None,'maxMs':max(values),'allMs':values}
try:
    line=process.stdout.readline()
    if not line:raise RuntimeError(process.stderr.read())
    host=json.loads(line)
    result.update(product=host['productionExtension'],version=host['productionVersion'],nativeDependency=os.environ.get('FLOWBOARD_EXTENSION_PATH'))
    def request(route,payload=None):
        body=None if payload is None else json.dumps(payload).encode()
        req=urllib.request.Request(host['origin']+route,data=body,headers={'X-Workflow-Token':host['secret'],'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('FLOWBOARD_CHROMIUM_PATH'))
        page=browser.new_page(viewport={'width':1440,'height':900},reduced_motion='reduce')
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        page.expose_function('__routeSend',lambda message:request('/message',message))
        page.expose_function('__routePoll',lambda cursor:request('/events?after='+str(cursor)))
        page.add_init_script('''window.sent=[];window.hostMessages=[];window.routeEvents=[];
            function timeNative(){for(const name of ['loadSnapshot','redrawEdges']){const old=window[name];if(typeof old!=='function'||old.routeTimed)continue;
                const wrap=function(...args){const start=performance.now();try{return old.apply(this,args)}finally{window.routeEvents.push({event:name,durationMs:performance.now()-start,at:Date.now(),perf:performance.now()})}};
                wrap.routeTimed=true;window[name]=wrap;}}
            document.addEventListener('click',e=>{const row=e.target.closest('[data-finding-id]');if(row)window.routeEvents.push({event:'actual-finding-click',findingId:row.dataset.findingId,at:Date.now(),perf:performance.now()})},true);
            window.acquireVsCodeApi=()=>({postMessage(m){if(window.routeClosing)return;window.sent.push(m);if(m.type==='triage:rendered')window.routeEvents.push({event:'rendered-send',at:Date.now(),perf:performance.now(),token:m.token});return window.__routeSend(m)}});
            let cursor=0,polling=false;window.routeTimer=setInterval(async()=>{if(polling||window.routeClosing)return;polling=true;try{const b=await window.__routePoll(cursor);cursor=b.cursor;for(const m of b.messages){timeNative();window.hostMessages.push(m);if(m.type==='triage:load')window.routeEvents.push({event:'load-received',at:Date.now(),perf:performance.now(),token:m.token,findingId:m.issueId});window.dispatchEvent(new MessageEvent('message',{data:m}))}}finally{polling=false}},25);''')
        def wait_state(predicate):
            until=time.monotonic()+15
            while time.monotonic()<until:
                state=request('/state')
                if predicate(state):return state
                page.wait_for_timeout(25)
            raise AssertionError(json.dumps({'status':state.get('reportPreparation'),'errors':state.get('errors'),'pageErrors':errors},indent=2))
        page.goto(host['origin'])
        page.wait_for_function('()=>window.hostMessages.some(m=>m.type==="triage:library")')
        state=wait_state(lambda s:s['reportPreparation']['jobs'][0]['state'] in ['completed','blocked','failed'])
        assert state['reportPreparation']['jobs'][0]['publishable'],state['reportPreparation']
        result['harnessStartToObservedAcceptedMs']=(time.monotonic()-started)*1000
        result['preparationTimingScope']='Includes process/browser startup and observation delay; fixed responses, not real provider or cold semantic latency.'
        result['controlledRequests']=len(state['providerCalls']);assert result['controlledRequests']==2,state['providerCalls']
        result['selectionRoute']=state.get('selectionRoute','controller-harness')
        page.locator('[data-finding-id="I-1"]').click();page.wait_for_selector('.guide-annotation')
        state=request('/state');draft=state['investigation']
        assert draft['publication']['ready'] and draft['phase']=='ready'
        assert draft['causal']['outcome']=='refuted' and draft['claims'][0]['status']=='contradicted'
        artifact=draft['publication']['digest'];units={u['id']:u for u in draft['sources']};evidence={e['id']:e for e in draft['evidence']}
        events={e['id']:e for e in draft['causal']['events']};order=draft['causal']['order']
        assert len(order)==15 and len({evidence[events[id]['evidenceId']]['sourceId'] for id in order})==5
        checked={'id':None}
        def anchor(identity):
            event=events[identity];proof=evidence[event['evidenceId']];unit=units[proof['sourceId']]
            return {'event':identity,'what':event['what'],'line':proof['source']['line'],'endLine':proof['source']['endLine'],'file':unit['source']['file'],
                    'name':unit['name'].split('::')[-1],'start':unit['source']['line'],'end':unit['source']['endLine'],'code':unit['code'],
                    'callSite':next((call for call in unit.get('relatedCalls',[]) if call['id']==event.get('callSiteId')),None)}
        def verify(identity,reading_details=False):
            expected=anchor(identity)
            observed=page.evaluate('''e=>{
                const note=document.querySelector('.guide-annotation'),card=document.querySelector('.guide-active-card');
                if(!note||!card)return {error:'No active native card/annotation'};
                const row=card.querySelector(`[data-source-line="${e.line}"]`),end=card.querySelector(`[data-source-line="${e.end}"]`),header=card.querySelector('.card-header');
                const board=document.getElementById('flowboard').getBoundingClientRect(),r=row?.getBoundingClientRect(),h=header.getBoundingClientRect();
                const explanation=note.querySelector('.guide-explanation'),n=explanation?.getBoundingClientRect(),dock=note.parentElement.getBoundingClientRect();
                const exact=[...document.querySelectorAll('.triage-claim-line')].map(n=>Number(n.dataset.sourceLine));
                return {event:note.dataset.stepId,annotation:explanation?.innerText,header:header.innerText,text:card.querySelector('.card-code').innerText,fullTail:!!end,
                    annotationVisible:!!n&&n.width>0&&n.height>0&&n.top>=Math.max(0,dock.top)-1&&n.bottom<=Math.min(innerHeight,dock.bottom)+1&&n.left>=0&&n.right<=innerWidth,
                    lines:exact,visible:!!r&&r.top>=board.top-1&&r.bottom<=board.bottom+1&&r.right>board.left&&r.left<board.right,
                    headerVisible:h.top>=board.top-1&&h.bottom<=board.bottom+1,
                    occurrence:CSS.highlights.has('flowboard-call-occurrence')?[...CSS.highlights.get('flowboard-call-occurrence')].map(r=>r.toString()):[],
                    camera:{scale,panX,panY},codeScroll:card.querySelector('.card-code').parentElement.scrollTop,guideScroll:document.querySelector('.guide-aside').scrollTop,domElements:document.querySelectorAll('*').length};
            }''',expected)
            assert observed.get('event')==identity,observed
            assert ' '.join(observed.get('annotation','').split())==' '.join(expected['what'].split()),observed
            if not reading_details:assert observed['annotationVisible'],observed
            assert observed['lines']==list(range(expected['line'],expected['endLine']+1)),observed
            assert expected['name'] in observed['header'] and expected['file'] in observed['header'],observed
            assert observed['fullTail'] and observed['visible'] and observed['headerVisible'],{'expected':expected,'observed':observed}
            if expected['callSite']:
                assert observed['occurrence']==[expected['code'][expected['callSite']['span']['start']:expected['callSite']['span']['end']]],observed
            checked['id']=identity
            return observed
        def click_step(label,identity):
            expected=anchor(identity)
            measured=page.evaluate(r'''async e=>{
                const button=[...document.querySelectorAll('.guide-controls button')].find(b=>b.textContent===e.label);
                if(!button||button.disabled)throw new Error('Prepared navigation action unavailable: '+e.label);
                const start=performance.now();button.click();
                while(performance.now()-start<3000){
                    await new Promise(resolve=>requestAnimationFrame(resolve));
                    const a=e.anchor,note=document.querySelector('.guide-annotation'),card=document.querySelector('.guide-active-card');
                    const header=card?.querySelector('.card-header'),line=card?.querySelector(`[data-source-line="${a.line}"]`);
                    const board=document.querySelector('#flowboard').getBoundingClientRect(),h=header?.getBoundingClientRect(),r=line?.getBoundingClientRect();
                    const n=note?.querySelector('.guide-explanation')?.getBoundingClientRect(),dock=note?.parentElement.getBoundingClientRect();
                    const noteOK=n&&n.width>0&&n.height>0&&n.top>=Math.max(0,dock.top)-1&&n.bottom<=Math.min(innerHeight,dock.bottom)+1&&n.left>=0&&n.right<=innerWidth;
                    const lines=[...document.querySelectorAll('.triage-claim-line')].map(n=>Number(n.dataset.sourceLine));
                    const exact=Array.from({length:a.endLine-a.line+1},(_,i)=>a.line+i);
                    const occurrence=CSS.highlights.has('flowboard-call-occurrence')?[...CSS.highlights.get('flowboard-call-occurrence')].map(r=>r.toString()):[];
                    const callOK=!a.callSite || JSON.stringify(occurrence)===JSON.stringify([a.code.slice(a.callSite.span.start,a.callSite.span.end)]);
                    const normalize=text=>text.replace(/\s+/g,' ').trim();
                    if(noteOK && note?.dataset.stepId===a.event && normalize(note.innerText).includes(normalize(a.what)) && header?.innerText.includes(a.name) && header.innerText.includes(a.file) &&
                        JSON.stringify(lines)===JSON.stringify(exact) && card.querySelector(`[data-source-line="${a.end}"]`) && callOK &&
                        h.top>=board.top-1 && h.bottom<=board.bottom+1 && r?.top>=board.top-1 && r.bottom<=board.bottom+1 && r.right>board.left && r.left<board.right)
                        return performance.now()-start;
                }
                throw new Error('Correct readable source/annotation/highlight did not settle: '+e.anchor.event);
            }''',{'label':label,'anchor':expected})
            previous=checked['id']
            if timed_navigation:
                (within if previous and evidence[events[previous]['evidenceId']]['sourceId']==evidence[events[identity]['evidenceId']]['sourceId'] else cross).append(measured)
            verify(identity);return measured
        def restart():
            options=page.locator('.guide-controls details');options.locator('summary').click();options.get_by_role('button',name='Restart',exact=True).click();verify(order[0])
        verify(order[0]);page.screenshot(path=str(output/'first-step.png'))
        controls=page.locator('.guide-controls');latencies=[];opening=[];within=[];cross=[];timed_navigation=True
        for run in range(args.samples):
            if run:restart()
            for identity in order[1:]:
                latencies.append(click_step('Next step',identity))
                if run==0 and identity in ['preview-return','first-write','second-write','approval-reject','rollback']:
                    page.screenshot(path=str(output/(identity+'.png')))
            page.locator('.guide-state-watch > summary').click()
            watch=page.locator('.guide-state-watch').inner_text()
            result['rollbackWatch']=watch
            if not args.baseline:
                assert 'Rolled back' in watch and 'Attempted value, not persisted: A + 1' in watch,watch
                assert 'Provisional change' not in watch,watch
            if run==0:page.screenshot(path=str(output/'rollback-watch.png'))
            # Backtracking is navigation, not reverse execution.
            for identity in reversed(order[:-1]):latencies.append(click_step('Previous step',identity))
        assert len(request('/state')['providerCalls'])==2
        timed_navigation=False
        result['checks'].append('All 15 checked events traverse five actual native functions, exact call occurrences, repeated arguments, four returns and an uncaught rollback; complete long helper and late return stay readable.')
        # Outline is the same native route, not a second tutorial surface.
        for target in [order[-1],order[0]]:
            controls.get_by_role('button',name='Step outline',exact=True).click()
            page.locator('.guide-outline').get_by_role('button',name=events[target]['title'],exact=True).click()
            verify(target)
        result['checks'].append('Outline jumps across the route retain the exact event/source identity in the original native cards.')
        # Cross-function evidence detour opens the exact caller argument and
        # returns to the same helper invocation, camera, scroll and highlight.
        for identity in order[1:8]:click_step('Next step',identity)
        verify('first-write')
        caller=page.locator('.guide-parameter-table').get_by_role('button',name='Read caller argument',exact=True)
        # Deliberately read the argument details before detouring. The Return
        # endpoint is that actual scroll position, not the earlier top prose.
        caller.scroll_into_view_if_needed()
        original=verify('first-write',reading_details=True)
        caller.click();page.wait_for_selector('.guide-annotation[data-step-id^="input:"]')
        assert 'Read the caller argument' in page.locator('.guide-annotation').inner_text()
        controls.get_by_role('button',name='Return to step',exact=True).click()
        restored=verify('first-write',reading_details=True)
        assert {k:original[k] for k in ['event','lines','camera','codeScroll','guideScroll']}=={k:restored[k] for k in ['event','lines','camera','codeScroll','guideScroll']}
        reveal=page.get_by_role('button',name='Current operation',exact=True)
        if reveal.count():reveal.click()
        else:page.locator('.guide-aside').evaluate('(n)=>{n.scrollTop=0}')
        verify('first-write')
        result['checks'].append('A material caller argument opens an exact evidence detour; Return restores the first increment invocation rather than the second use of the same function.')
        modern_reader=page.locator('.guide-resize').count()>0
        if modern_reader:
            page.locator('.guide-aside').evaluate('(n)=>{n.scrollTop=180}')
            prior=verify('first-write',reading_details=True)
            controls.get_by_role('button',name='Hide explanation',exact=True).click()
            controls.get_by_role('button',name='Show explanation',exact=True).click()
            assert verify('first-write',reading_details=True)['guideScroll']==prior['guideScroll']
            divider=page.get_by_role('separator',name='Resize explanation pane',exact=True)
            old_width=divider.get_attribute('aria-valuenow');divider.focus();divider.press('ArrowLeft')
            assert float(divider.get_attribute('aria-valuenow'))>float(old_width)
            assert verify('first-write',reading_details=True)['event']==prior['event']
            divider.press('Home')
            options=controls.locator('.guide-options');options.locator('summary').click()
            options.get_by_role('button',name='Turn wrapping off',exact=True).click()
            assert verify('first-write',reading_details=True)['event']==prior['event']
            controls.locator('.guide-options > summary').click()
            controls.get_by_role('button',name='Wrap code',exact=True).click()
            page.get_by_role('button',name='Current operation',exact=True).click();verify('first-write')
            result['checks'].append('Keyboard resize, collapse/restore and code wrapping preserve the exact invocation; collapse restores the explanation reading position without another request.')
        # Persist the unchanged prepared artifact and navigation, then measure
        # ordinary reopen in this same host (not reload-only DOM mutation).
        result['reopenPhases']=[]
        trace_cursor=len(state.get('productionTrace',[]))
        warm_index_count=sum(t['event']=='index-start' for t in state.get('productionTrace',[]))
        for run in range(args.reopens):
            wait_state(lambda s:(s.get('snapshots',{}).get('I-1',{}).get('state',{}).get('view',{}).get('walkthrough') or {}).get('index')==order.index('first-write'))
            page.evaluate('()=>{window.routeClosing=true;clearInterval(window.routeTimer)}');page.wait_for_timeout(60)
            started=time.monotonic();request('/action',{'name':'reopen'});host_done=time.monotonic()
            page.reload();reload_done=time.monotonic()
            page.wait_for_function('()=>window.hostMessages.some(m=>m.type==="triage:library")')
            library_done=time.monotonic()
            click_command=page.evaluate('performance.now()')
            page.locator('[data-finding-id="I-1"]').click();page.wait_for_selector('.guide-annotation')
            annotation_done=time.monotonic()
            verify('first-write');verified=time.monotonic();opening.append((verified-started)*1000)
            browser_trace=page.evaluate('''()=>{const m=window.hostMessages.filter(m=>m.type==='triage:load').at(-1);
                window.routeEvents.push({event:'guide-readable-verified',findingId:m.issueId,token:m.token,at:Date.now(),perf:performance.now()});
                return {events:window.routeEvents,verified:performance.now()}}''')
            actual_click=next(e for e in browser_trace['events'] if e['event']=='actual-finding-click')
            result['reopenPhases'].append({'hostMs':(host_done-started)*1000,'reloadMs':(reload_done-host_done)*1000,
                'libraryMs':(library_done-reload_done)*1000,'selectionMs':(annotation_done-library_done)*1000,
                'verificationMs':(verified-annotation_done)*1000,'automationBeforeClickMs':actual_click['perf']-click_command,
                'actualClickToVerifiedMs':browser_trace['verified']-actual_click['perf'],'browserTrace':browser_trace['events']})
            state=request('/state');assert state['investigation']['publication']['digest']==artifact and len(state['providerCalls'])==2
            traces=state.get('productionTrace',[]);result['reopenPhases'][-1]['hostTrace']=traces[trace_cursor:];trace_cursor=len(traces)
            if args.production_selection:
                assert sum(t['event']=='index-start' for t in traces)==warm_index_count,'Warm production selection unexpectedly reindexed unchanged source.'
        result['checks'].append('Compatible saved reopen retains the same accepted artifact and repeated-invocation position with no new controlled requests.')
        if args.reader_scenes:
            result['readerScenes']=[]
            scenes=[(1440,900,'attempt','dark'),(1440,900,'check-guard','dark'),(1440,900,'first-write','dark'),
                (1440,900,'second-write','dark'),(1440,900,'preview-return','dark'),(1440,900,'first-return','dark'),
                (1440,900,'second-call','dark'),(1440,900,'rollback','dark'),(1024,800,'first-write','dark'),
                (801,600,'first-write','dark'),(761,900,'first-write','dark'),(800,900,'first-write','dark'),
                (801,900,'first-write','dark'),(1024,800,'first-write','light')]
            for width,height,identity,theme in scenes:
                page.set_viewport_size({'width':width,'height':height})
                page.evaluate("theme=>{document.body.classList.remove('vscode-dark','vscode-light');document.body.classList.add('vscode-'+theme)}",theme)
                controls.get_by_role('button',name='Step outline',exact=True).click()
                page.locator('.guide-outline').get_by_role('button',name=events[identity]['title'],exact=True).click()
                page.locator('.guide-outline').evaluate('(n)=>{n.open=false}')
                page.wait_for_timeout(120)
                verify(identity)
                if modern_reader:
                    actual=page.evaluate('''()=>{
                      const title=document.querySelector('.guide-active-card .card-title'),r=title.getBoundingClientRect(),header=title.closest('.card-header').getBoundingClientRect();
                      const footer=document.querySelector('.guide-active-card .guide-handoff'),f=footer.getBoundingClientRect(),caption=document.querySelector('.guide-caption').getBoundingClientRect();
                      const current=document.querySelector('.guide-current-title');
                      return {titleFits:r.left>=header.left&&r.right<=header.right&&title.scrollWidth<=title.clientWidth+1&&title.scrollHeight<=title.clientHeight+1,
                        next:footer.querySelector('strong').textContent,footerScroll:footer.scrollHeight>footer.clientHeight+1,footerVisible:f.bottom<=innerHeight&&f.top>=0,
                        captionVisible:caption.width>0&&caption.top>=0&&caption.bottom<=innerHeight,currentVisible:current.getBoundingClientRect().height>0,
                        valuesFit:[...document.querySelectorAll('.guide-values')].every(n=>n.scrollWidth<=n.clientWidth+1)};
                    }''')
                    assert actual['titleFits'] and actual['footerVisible'] and not actual['footerScroll'] and actual['captionVisible'] and actual['valuesFit'],actual
                    if width>800:assert actual['currentVisible'],actual
                    next_index=order.index(identity)+1
                    if next_index<len(order):assert actual['next']=='Next · '+events[order[next_index]]['title'],actual
                filename=f'scene-{width}x{height}-{identity}-{theme}.png'
                page.screenshot(path=str(output/filename))
                result['readerScenes'].append({'file':filename,'viewport':[width,height],'event':identity,'theme':theme,'scale':page.evaluate('scale')})
                if modern_reader and identity=='first-write' and width==1024:
                    page.locator('.guide-values').scroll_into_view_if_needed()
                    page.screenshot(path=str(output/f'values-{width}x{height}-{theme}.png'))
                    page.get_by_role('button',name='Current operation',exact=True).click();verify(identity)
            page.evaluate("()=>{document.body.classList.remove('vscode-light');document.body.classList.add('vscode-dark')}")
        # The problematic responsive boundaries, including a short pane, use
        # the same checked route; no replacement mockup or CSS-only viewport.
        for width in [759,760,761,799,800,801,1050,1051,1280,1440]:
            page.set_viewport_size({'width':width,'height':600 if width==801 else 900});page.wait_for_timeout(40)
            verify('first-write')
            if width in [761,801]:page.screenshot(path=str(output/f'width-{width}.png'))
        result['checks'].append('The checked route remains readable at all requested boundary widths, including an 801×600 pane.')
        result.update(navigation=summary(latencies),withinFunction=summary(within),crossFunction=summary(cross),cachedHostReopen=summary(opening),codeLines=sum(len(unit['code'].splitlines()) for unit in units.values()),events=len(order),functions=5,
            domElements=verify('first-write')['domElements'],pageErrors=errors,hostErrors=state['errors'],externalProviderRequests=0,
            targets={'cachedFirstReadableP95Under500ms':summary(opening)['p95Ms']<500 if summary(opening)['p95Ms'] is not None else None,'stepP95Under100ms':summary(latencies)['p95Ms']<100 if summary(latencies)['p95Ms'] is not None else None})
        assert not errors and not state['errors']
        page.evaluate('()=>{window.routeClosing=true;clearInterval(window.routeTimer)}');page.wait_for_timeout(60);browser.close()
except Exception as error:
    result['failure']=repr(error)
    raise
finally:
    process.terminate()
    try:process.wait(timeout=15)
    except subprocess.TimeoutExpired:process.kill();process.wait()
    (output/'checks.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
