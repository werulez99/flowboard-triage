#!/usr/bin/env python3
"""Production preparation -> host gate -> native rendering, with fixed model responses.

All four fictional findings stay in the imported report. Editor transport and
model responses are controlled. This is not real model reasoning or Cursor.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
repository = Path(__file__).resolve().parent.parent
output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
process = subprocess.Popen(['node', str(repository/'scripts/workflow-host.js'), '--mixed-fixture', '--defer-mapping'],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=repository)
result = {'boundary':'Real importer, native parser, coordinator, engine, host gate, storage and native renderer. Fixed fictional model responses; simulated editor IO; no external provider calls.', 'checks':[]}
try:
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(process.stderr.read())
    host = json.loads(line)
    def request(route, payload=None):
        body = None if payload is None else json.dumps(payload).encode()
        call = urllib.request.Request(host['origin']+route, data=body,
            headers={'X-Workflow-Token':host['secret'],'Content-Type':'application/json'})
        with urllib.request.urlopen(call, timeout=15) as response:
            return json.load(response)
    def job(state, identity):
        return next(item for item in state['reportPreparation']['jobs'] if item['id']==identity)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('FLOWBOARD_CHROMIUM_PATH'))
        page = browser.new_page(viewport={'width':1440,'height':900}, reduced_motion='reduce')
        errors=[]; page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept() if dialog.message.startswith('Switch finding? Your unfinished review will be checkpointed') else dialog.dismiss())
        page.expose_function('__workflowSend', lambda message: request('/message',message))
        page.expose_function('__workflowPoll', lambda cursor: request('/events?after='+str(cursor)))
        page.add_init_script('''
            window.sent=[];window.hostMessages=[];
            window.acquireVsCodeApi=()=>({postMessage(message){if(window.__workflowClosing)return;window.sent.push(message);return window.__workflowSend(message)}});
            let cursor=0,polling=false;
            window.__workflowPollTimer=setInterval(async()=>{
                if(polling)return;polling=true;
                try{const result=await window.__workflowPoll(cursor);cursor=result.cursor;for(const message of result.messages){window.hostMessages.push(message);window.dispatchEvent(new MessageEvent('message',{data:message}))}}
                finally{polling=false}
            },25);
        ''')
        def wait(predicate, seconds=8):
            until=time.monotonic()+seconds
            while time.monotonic()<until:
                state=request('/state')
                if predicate(state): return state
                page.wait_for_timeout(50)
            state=request('/state')
            raise AssertionError(json.dumps({'status':state.get('reportPreparation'),'errors':state.get('errors'),'pageErrors':errors},indent=2))
        def position():
            return page.evaluate('()=>({camera:{scale,panX,panY},step:document.querySelector(".guide-annotation")?.dataset.stepId,lines:[...document.querySelectorAll(".triage-claim-line")].map(n=>Number(n.dataset.sourceLine)),codeScroll:document.querySelector(".guide-active-card .card-code")?.parentElement.scrollTop})')
        def open_finding(identity):
            old=request('/state').get('token')
            page.locator('#triage-bar').get_by_role('button',name='Findings',exact=True).click()
            page.locator(f'[data-finding-id="{identity}"]').click()
            page.wait_for_function('value=>window.sent.some(m=>m.type==="triage:rendered"&&m.issueId===value.id&&m.token!==value.old)',arg={'id':identity,'old':old})
            page.wait_for_selector('.guide-annotation')
        def stop_polling():
            page.evaluate('()=>{window.__workflowClosing=true;clearInterval(window.__workflowPollTimer)}')
            page.wait_for_timeout(80)
        page.goto(host['origin'])
        page.wait_for_function('()=>window.hostMessages.some(m=>m.type==="triage:library")')
        state=wait(lambda state: state.get('mixedHeld') and job(state,'I-1')['publishable'] and job(state,'I-3')['state']=='blocked' and job(state,'I-4')['state']=='failed')
        assert state['reportPreparation']['total']==4 and not state['reportPreparation']['published']
        assert len(state['library'])==4 and state['reportPreparation']['mode']=='running'
        opened_at=time.monotonic(); open_finding('I-1'); first_readable_ms=(time.monotonic()-opened_at)*1000
        state=request('/state'); draft=state['investigation']
        assert draft['phase']=='ready' and draft['publication']['ready']
        assert draft['claims'][0]['status']=='contradicted' and draft['causal']['outcome']=='refuted'
        assert state['privatePreparationDraft']['publication']['digest']==draft['publication']['digest']
        assert page.locator('.guide-active-card').count()==1 and position()['lines']==[8]
        assert 'require(accepted, "rejected");' in page.locator('.guide-active-card .card-code').inner_text()
        assert 'false accepted input fails' in page.locator('.guide-annotation').inner_text()
        assert 'The report claims GuardBook.finish(false) completes without reverting.' in page.locator('.guide-annotation').inner_text()
        assert 'This invocation reverts.' in page.locator('.guide-values').inner_text()
        assert 'The transaction reverts;' not in page.locator('.guide-values').inner_text(), 'A rolled-back call must not assert that an outer caller cannot catch its failure.'
        page.screenshot(path=str(output/'a-ready-while-b-running.png'))
        result['checks'].append('The intact report has A accepted, B held in challenge, C externally blocked, D failed. A opens a checked native source refutation immediately.')
        controls=page.locator('.guide-controls')
        original=position()
        page.locator('.guide-active-card .triage-line-number').first.click()
        field=page.locator('#triage-evidence-note'); field.fill('Manual draft retained while another finding becomes ready.')
        field.evaluate('node=>node.setSelectionRange(7,12)')
        editing=position(); requests_before=len(state['providerCalls'])
        released=time.monotonic(); request('/action',{'name':'release-mixed'})
        state=wait(lambda state: job(state,'I-2')['publishable'])
        accepted_observed_ms=(time.monotonic()-released)*1000
        page.wait_for_function('()=>window.hostMessages.some(m=>m.type==="triage:reportPreparation"&&m.report?.jobs?.some(j=>j.id==="I-2"&&j.publishable))')
        assert position()==editing
        assert field.input_value()=='Manual draft retained while another finding becomes ready.'
        assert field.evaluate('node=>[node.selectionStart,node.selectionEnd]')==[7,12]
        assert len(state['providerCalls'])==requests_before, 'Releasing the existing challenge must not dispatch another request.'
        controls.get_by_role('button',name='Return to step',exact=True).click()
        assert position()==original
        page.locator('#triage-bar').get_by_role('button',name='Findings',exact=True).click()
        assert page.locator('[data-finding-id="I-2"] .triage-ready-action').is_visible()
        assert 'supplied remote receiver' in page.locator('[data-finding-id="I-3"]').inner_text()
        assert 'no usable claim/evidence structure' in page.locator('[data-finding-id="I-4"]').inner_text()
        page.screenshot(path=str(output/'mixed-ready-rows.png'))
        result['checks'].append('B becomes independently Ready through challenge and host validation; A keeps its function, highlight, camera, manual text and caret. B enables without refresh.')
        # A return after free exploration and B's first guide are both local.
        page.locator('#triage-bar').get_by_role('button',name='Walkthrough',exact=True).click()
        assert position()==original
        page.wait_for_timeout(160)
        state=request('/state'); used=len(state['providerCalls'])
        request('/message',{'type':'triage:reportControl','issueId':'I-1','token':state['token'],'action':'pause'})
        wait(lambda state: state['reportPreparation']['mode']=='paused')
        assert page.locator('.guide-annotation').is_visible()
        for action in ['reopen','restart-mixed-coordinator']:
            # The harness closes its transport before disposing the panel;
            # wait for ordinary debounced autosave, not a fabricated snapshot.
            wait(lambda state: (state['snapshots'].get('I-1',{}).get('state',{}).get('workingCopy') or {}).get('evidenceInput',{}).get('note')=='Manual draft retained while another finding becomes ready.')
            saved_before=request('/state')['snapshots'].get('I-1')
            stop_polling(); request('/action',{'name':action}); page.reload()
            page.wait_for_function('()=>window.hostMessages.some(m=>m.type==="triage:library")')
            open_finding('I-1'); assert position()==original
            page.locator('.guide-active-card .triage-line-number').first.click()
            actual_note=page.locator('#triage-evidence-note').input_value()
            assert actual_note=='Manual draft retained while another finding becomes ready.', {'action':action,'actual':actual_note,'savedWorkingCopy':saved_before['state'].get('workingCopy')}
            controls.get_by_role('button',name='Return to step',exact=True).click()
            open_finding('I-2'); assert position()['lines']==[11]
            assert 'zero count' in page.locator('.guide-annotation').inner_text()
            state=request('/state')
            assert job(state,'I-1')['publishable'] and job(state,'I-2')['publishable']
            assert state['reportPreparation']['mode']=='paused' and len(state['providerCalls'])==used
        result['checks'].append('Pause, controller reopen and a new coordinator/controller using persisted artifacts keep A/B readable and A’s draft/reading position, with zero extra controlled requests.')
        result.update({'productionExtension':host['productionExtension'],'productionVersion':host['productionVersion'],
            'firstReadyOpenMs':first_readable_ms,'releaseToAcceptedObservedMs':accepted_observed_ms,
            'controlledRequests':len(state['providerCalls']),'externalProviderRequests':0,
            'finalJobs':state['reportPreparation']['jobs'],'pageErrors':errors,'hostErrors':state['errors']})
        assert not errors and not state['errors']
        stop_polling(); browser.close()
finally:
    process.terminate()
    try: process.wait(timeout=15)
    except subprocess.TimeoutExpired: process.kill(); process.wait()
    (output/'checks.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
