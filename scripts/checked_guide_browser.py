#!/usr/bin/env python3
"""Production preparation/controller/native renderer; simulated editor I/O.
Real provider by default; --recorded explicitly replays fictional responses.
External workspaces are read-only. Private captures
must be stored outside this repository and are never packaging inputs.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import traceback
import urllib.request
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--case')
parser.add_argument('--teaching-case', choices=['time','lifecycle','accounting'])
parser.add_argument('--workspace')
parser.add_argument('--report')
parser.add_argument('--finding', default='I-01')
parser.add_argument('--provider', default='codex')
parser.add_argument('--request-limit', type=int, default=12, choices=range(1, 13))
parser.add_argument('--recorded')
parser.add_argument('--baseline', action='store_true')
parser.add_argument('--report-preparation', action='store_true')
parser.add_argument('--production-selection', action='store_true', help='Use actual extension cached selection; saved-workspace provider must be none. Owned local publication metadata may be revalidated; human/source files stay read-only.')
parser.add_argument('--outline-check', action='store_true', help='Additional functional-only initial-list and per-function outline/detour checks; keep separate from compared timing batches.')
parser.add_argument('--local-recheck', action='store_true', help='Exercise the selected local preparation action with provider none; never a model request.')
parser.add_argument('--reopens', type=int, default=1, choices=range(1, 21))
parser.add_argument('--batch', action='store_true')
parser.add_argument('--freshness', choices=['source', 'report'], default='report')
parser.add_argument('--output', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
command = ['node', str(repo / 'scripts/workflow-host.js'), '--provider', args.provider]
command += ['--request-limit', str(args.request_limit)]
if args.production_selection:
    command += ['--production-selection']
if args.report_preparation:
    command += ['--report-preparation']
if args.batch:
    command += ['--quality-batch']
if args.case:
    command += ['--quality-case', args.case]
if args.teaching_case:
    command += ['--teaching-fixture', args.teaching_case, '--defer-mapping']
if args.recorded:
    command += ['--quality-responses', args.recorded]
if args.workspace:
    command += ['--workspace', args.workspace]
if args.report:
    command += ['--report', args.report, '--report-finding', args.finding]
process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
result = {'boundary': 'Production code and renderer; real provider; simulated editor transport. No live Cursor UI control.', 'case': args.case, 'checks': []}
if args.recorded: result['boundary'] = 'Production preparation and renderer with recorded fictional provider responses; exact matching source IDs translated for a new temporary project. Simulated editor transport; no fresh AI reasoning.'
if args.teaching_case: result['boundary'] = 'Ordinary import/preparation/acceptance/native renderer; fixed local teaching responses only, zero external requests. Simulated editor IO.'
if args.workspace and args.provider == 'none': result['boundary'] = 'Saved workspace artifact, current source checks, board controller and native renderer; provider disabled. Simulated editor transport, not actual Cursor activation/playback.'
try:
    line = process.stdout.readline()
    if not line: raise RuntimeError(process.stderr.read())
    host = json.loads(line)
    result.update(version=host['productionVersion'], extension=host['productionExtension'])
    def request(route, body=None):
        call = urllib.request.Request(host['origin'] + route, data=None if body is None else json.dumps(body).encode(), headers={'X-Workflow-Token': host['secret'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(call, timeout=55) as response: return json.loads(response.read())
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('FLOWBOARD_CHROMIUM_PATH'))
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        errors = []; page.on('pageerror', lambda error: errors.append(error.stack))
        page.expose_function('__send', lambda m: request('/message', m))
        page.expose_function('__poll', lambda n: request('/events?after=' + str(n)))
        def contrast():
            return page.evaluate('''() => {
              const rgb=s=>(s.match(/[\\d.]+/g)||[]).map(Number);
              const blend=(a,b)=>a.slice(0,3).map((v,i)=>v*(a[3]??1)+b[i]*(1-(a[3]??1)));
              const lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
              const results=[];
              for(const el of document.querySelectorAll('.guide-annotation p,.guide-mechanism,.guide-controls button:not(:disabled),.guide-active-card .code-line span')) {
                if(!el.textContent.trim()||!el.getBoundingClientRect().height)continue;
                const chain=[];for(let p=el;p;p=p.parentElement)chain.unshift(p);
                let bg=[13,17,23];for(const p of chain)bg=blend(rgb(getComputedStyle(p).backgroundColor),bg);
                const fg=blend(rgb(getComputedStyle(el).color),bg),a=lum(fg),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
                results.push({text:el.textContent.slice(0,60),ratio:Math.round(ratio*100)/100});
              }
              return results.sort((a,b)=>a.ratio-b.ratio);
            }''')
        page.add_init_script('''window.sent=[];window.hostMessages=[];window.actualFindingClick=null;
          document.addEventListener('click',event=>{if(event.target.closest('[data-finding-id]'))window.actualFindingClick=performance.now()},true);
          window.acquireVsCodeApi=()=>({postMessage(m){if(!window.closing){window.sent.push(m);return window.__send(m);}}});
          let cursor=0;window.polling=false;window.timer=setInterval(async()=>{if(window.polling||window.closing)return;window.polling=true;
          try{const b=await window.__poll(cursor);cursor=b.cursor;for(const m of b.messages){window.hostMessages.push(m);window.dispatchEvent(new MessageEvent('message',{data:m}));}}finally{window.polling=false;}},75);''')
        page.goto(host['origin'])
        finding_row = '[data-finding-id=' + json.dumps(args.finding) + ']'
        page.wait_for_selector(finding_row, timeout=30000)
        if args.outline_check:
            assert page.locator(finding_row+' .triage-preparation-badge').inner_text() == 'Ready'
            assert page.locator(finding_row+' .triage-ready-action').is_visible()
            page.get_by_label('Finding queue filter').select_option('preparation:ready')
            assert page.locator('[data-finding-id]:visible').count() == 1
            page.get_by_label('Finding queue filter').select_option('all')
            result['checks'].append('The real saved Ready guide is discoverable in the initial report list/filter before selection, beside paused siblings.')
        cold_select = time.monotonic()
        page.locator(finding_row).click()
        page.wait_for_function('id=>window.hostMessages.some(m=>m.type==="triage:load"&&m.issueId===id)', arg=args.finding, timeout=120000)
        page.screenshot(path=str(out / 'preparing.png'))
        deadline = time.monotonic() + 900
        last_stage = None
        while time.monotonic() < deadline:
            state = request('/state'); draft = state.get('privatePreparationDraft') or state['investigation']
            stage = (draft or {}).get('phase'), len(state['providerCalls']), len((draft or {}).get('sources', []))
            if stage != last_stage:
                (out / 'progress.json').write_text(json.dumps(state, indent=2))
                last_stage = stage
            terminal_report = not state.get('reportPreparation') or state['reportPreparation']['mode'] not in ['running', 'interrupted']
            selected_ready = bool((state.get('investigation') or {}).get('publication', {}).get('ready'))
            if selected_ready or draft and draft['phase'] in ['blocked', 'provider-required'] and terminal_report: break
            if terminal_report and state.get('reportPreparation', {}).get('mode') in ['incomplete', 'paused', 'cancelled']: break
            if state['lastLoad'].get('preparation', {}).get('state') == 'blocked': break
            page.wait_for_timeout(500)
        page.wait_for_timeout(700)
        state = request('/state'); draft = state.get('privatePreparationDraft') or state['investigation']
        result.update(draft=draft, hostErrors=state['errors'], logs=state['logs'], providerCalls=state['providerCalls'])
        result['reportPreparation'] = state.get('reportPreparation')
        (out / 'state.json').write_text(json.dumps(state, indent=2))
        page.screenshot(path=str(out / ('initial.png' if draft and draft['phase'] == 'ready' else 'blocked.png')))
        if args.baseline:
            result['checks'].append('Captured the installed older renderer in its normal selected-finding state.')
        elif draft and draft['phase'] == 'ready':
            def visual(event):
                note = next(e for e in draft['evidence'] if e['id'] == event['evidenceId'])
                return event.get('anchor') or note
            def original_unit(event):
                anchor = visual(event)
                exposed = state.get('exposedInvestigation') or draft
                return exposed.get('nativeSources', {}).get(event['id']) or next(u for u in draft['sources'] if u['id'] == anchor['sourceId'])
            page.wait_for_selector('.guide-controls:visible')
            controls = page.locator('.guide-controls')
            steps = draft['causal']['order']; visited = []
            expected = {event['id']: {'findingId':args.finding,'invocationId':event['invocationId'], 'event':json.dumps(event,separators=(',', ':'),ensure_ascii=False),
                'what':event['what'],'code':original_unit(event)['code'],'file':original_unit(event)['source']['file'],
                'start':original_unit(event)['source']['line'],
                'highlights':list(range(visual(event)['source']['line'],visual(event)['source']['endLine']+1))} for event in draft['causal']['events']}
            readable_script = (repo / 'scripts/verified-readable.js').read_text() + '\nwindow.installReadable(' + json.dumps(expected) + ');'
            page.add_init_script(readable_script)
            page.evaluate(readable_script)
            def verify_readable(identity):
                try:
                    page.wait_for_function('id=>window.isReadable(id)', arg=identity, timeout=30000)
                except Exception:
                    page.screenshot(path=str(out / 'readable-failure.png'))
                    result['readableFailure']={'expected':identity,'actual':page.locator('.guide-annotation').get_attribute('data-step-id'),
                        'panes':page.evaluate('''()=>({aside:document.querySelector('.guide-aside')?.scrollTop,explanation:window.readableIntersection(document.querySelector('.guide-explanation')),code:window.readableIntersection(document.querySelector('.guide-active-card .triage-claim-line'))})''')}
                    raise
            verify_readable(steps[0])
            clipping = page.evaluate('''id => {
              const aside=document.querySelector('.guide-aside'), line=document.querySelector('.guide-active-card .triage-claim-line');
              const explanation=document.querySelector('.guide-explanation');
              const visible=window.isReadable(id), saved=aside.style.cssText;
              // Real DOM clipping ancestors, with the same identity/content.
              // Position the clipping top below the explanation without
              // changing the explanation's window coordinates.
              const top=aside.getBoundingClientRect().top, bottom=explanation.getBoundingClientRect().bottom;
              aside.style.clipPath='none'; aside.style.overflow='hidden';
              aside.style.paddingTop='0'; aside.style.top=(bottom+5)+'px';
              aside.style.transform='none'; explanation.style.transform=`translateY(-${bottom+5-top}px)`;
              const clippedExplanation=window.isReadable(id);
              aside.style.cssText=saved; explanation.style.transform='';
              let pane=line.parentElement;
              while(pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane=pane.parentElement;
              if(!pane)throw new Error('No native code scroll viewport');
              const scroll=pane.scrollTop, style=pane.style.cssText;
              for(const [key,value] of [['height','1px'],['min-height','0'],['max-height','1px'],['overflow','hidden'],['flex','none']]) pane.style.setProperty(key,value,'important');
              const clippedCode=window.isReadable(id);
              pane.style.cssText=style;pane.scrollTop=scroll;
              return {visible,clippedExplanation,clippedCode,restored:window.isReadable(id)};
            }''', steps[0])
            assert clipping == {'visible':True,'clippedExplanation':False,'clippedCode':False,'restored':True}, clipping
            result['checks'].append('Real DOM clipping of the explanation pane and native code viewport is rejected; unchanged visible content passes.')
            result['coldSelectToVerifiedMs'] = (time.monotonic()-cold_select)*1000
            before_calls = len(state['providerCalls'])
            orientation_scroll = page.evaluate('''() => {
              const pane=document.querySelector('.guide-mechanism');
              pane.scrollTop=Math.min(90,pane.scrollHeight-pane.clientHeight);
              return pane.scrollTop;
            }''')
            if orientation_scroll and len(steps) > 1:
                page.wait_for_timeout(40)
                controls.get_by_role('button', name='Next step', exact=True).click()
                verify_readable(steps[1])
                controls.get_by_role('button', name='Previous step', exact=True).click()
                verify_readable(steps[0])
                page.wait_for_function('value=>document.querySelector(".guide-mechanism").scrollTop===value', arg=orientation_scroll)
                result['checks'].append('Long first-step orientation scroll survives native Next/Previous without hiding the current operation.')
            page.evaluate('document.querySelector(".guide-mechanism").scrollTop=0')
            for i, identity in enumerate(steps):
                verify_readable(identity)
                event = next(e for e in draft['causal']['events'] if e['id'] == identity)
                entry = visual(event)
                assert page.locator('.guide-annotation').get_attribute('data-step-id') == identity
                spans = page.locator('.guide-active-card .triage-claim-line').evaluate_all('(ns)=>ns.map(n=>Number(n.dataset.sourceLine))')
                assert spans == list(range(entry['source']['line'], entry['source']['endLine'] + 1)), (identity, spans, entry['source'])
                viewport = page.locator('#flowboard').bounding_box()
                header = page.locator('.guide-active-card .card-header').bounding_box()
                first_line = page.locator('.guide-active-card .triage-claim-line').first.bounding_box()
                for label, box in [('function header', header), ('active line', first_line)]:
                    assert box and box['x'] >= viewport['x'] - 1 and box['x'] < viewport['x'] + viewport['width'] and box['y'] >= viewport['y'] - 1 and box['y'] + min(box['height'],24) <= viewport['y'] + viewport['height'], (label, identity, box, viewport)
                unit = original_unit(event)
                original = page.locator('.guide-active-card [data-source-line]').count()
                assert original == len(unit['code'].split('\n')), (original, unit['name'])
                annotation = page.locator('.guide-annotation').bounding_box()
                dock = page.locator('.guide-aside').bounding_box()
                assert annotation and dock and annotation['width'] > 100 and annotation['height'] > 20
                assert annotation['x'] >= dock['x'] - 1 and annotation['x'] + annotation['width'] <= dock['x'] + dock['width'] + 1
                quote = page.locator('.guide-report blockquote')
                if quote.count(): assert quote.inner_text() in state['lastLoad']['reportText']
                page.wait_for_timeout(35)
                assert page.locator('.guide-anchor > path').evaluate_all('(nodes)=>nodes.every(node=>node.getAttribute("mask")==="url(#guide-outside-cards)")'), 'An overlay connection can obscure original code.'
                visited.append({'event': identity, 'lines': spans, 'explanation': page.locator('.guide-annotation').inner_text()})
                page.screenshot(path=str(out / f'step-{i + 1}.png'))
                if i + 1 < len(steps):
                    camera_before = page.evaluate('()=>({scale,panX,panY})')
                    controls.get_by_role('button', name='Next step', exact=True).click()
                    following = next(e for e in draft['causal']['events'] if e['id'] == steps[i + 1])
                    following_entry = visual(following)
                    if following_entry['sourceId'] == entry['sourceId']:
                        assert page.evaluate('()=>({scale,panX,panY})') == camera_before
            result['visited'] = visited
            result['checks'].append('Every event has its exact range, full original function and faithful report paragraph.')
            if args.outline_check:
                distinct={}
                for identity in steps:
                    e=expected[identity]; distinct.setdefault((e['file'],e['start']),identity)
                for identity in [*distinct.values(),steps[-1]]:
                    event=next(e for e in draft['causal']['events'] if e['id']==identity)
                    controls.get_by_role('button',name='Step outline',exact=True).click()
                    page.locator('.guide-outline').get_by_role('button',name=event['title'],exact=True).click()
                    verify_readable(identity)
                    # Opening a long annotation's bottom source link is an
                    # intentional scroll. Return must retain that position,
                    # not force its introductory explanation back on screen.
                    page.locator('.guide-file-link').scroll_into_view_if_needed()
                    position='()=>({scale,panX,panY,aside:document.querySelector(".guide-aside").scrollTop,code:document.querySelector(".guide-active-card .card-code").parentElement.scrollTop})'
                    before=page.evaluate(position)
                    page.locator('.guide-file-link').click()
                    controls.get_by_role('button',name='Return to step',exact=True).click()
                    assert page.evaluate(position) == before
                    page.evaluate('document.querySelector(".guide-aside").scrollTop=0')
                    verify_readable(identity)
                result['checks'].append('Outline jumps and source detour/Return from every original function preserve exact event, highlight, readable scroll and camera.')
            # The end result is reachable in the same reading surface, without
            # a new model request or a camera jump. This is not a human verdict.
            result_camera = page.evaluate('()=>({scale,panX,panY})')
            page.get_by_role('button', name='Review assessment', exact=True).click()
            assert page.locator('.guide-aside .guide-opinion .guide-ai-part').count() == 4
            assert page.locator('.guide-aside .guide-opinion .guide-result').is_visible()
            assessment_box = page.locator('.guide-aside .guide-opinion .guide-result').bounding_box()
            assert assessment_box['y'] >= 100 and assessment_box['y'] + assessment_box['height'] <= 900
            assert page.evaluate('()=>({scale,panX,panY})') == result_camera
            assert len(request('/state')['providerCalls']) == before_calls
            page.screenshot(path=str(out / 'assessment.png'))
            # Resume the active explanation for the remaining layout checks.
            page.evaluate('document.querySelector(".guide-aside").scrollTop=0')
            result['checks'].append('The final assessment has four parts and a visible entry without moving code or invoking the provider.')
            camera = page.evaluate('()=>({scale,panX,panY})')
            current_step = page.locator('.guide-annotation').get_attribute('data-step-id')
            page.locator('.guide-file-link').click(); page.wait_for_timeout(250)
            entry = visual(event)
            opened = request('/state')['opened'][-1]
            assert opened['file'] == entry['source']['file'] and opened['selection']['startLine'] == entry['source']['line'] - 1
            controls.get_by_role('button', name='Return to step', exact=True).click()
            assert page.evaluate('()=>({scale,panX,panY})') == camera
            controls.get_by_role('button', name='Explore freely', exact=True).click()
            controls.get_by_role('button', name='Resume walkthrough', exact=True).click()
            assert page.locator('.guide-annotation').get_attribute('data-step-id') == current_step
            assert len(request('/state')['providerCalls']) == before_calls
            result['checks'].append('Editor link, detour return and free exploration preserve the step and camera; navigation makes no provider calls.')
            result['darkContrast'] = contrast()[:6]
            if args.outline_check:
                # Return deliberately restored the bottom-link reading point.
                # The separate resize control starts by reading the intro.
                page.evaluate('document.querySelector(".guide-aside").scrollTop=0')
            for width, height in [(1440,900),(1280,800),(1366,768),(1051,800),(1050,800),(801,800),(800,800),(799,800),(761,800),(760,800),(759,800),(640,800)]:
                page.set_viewport_size({'width':width,'height':height}); page.wait_for_timeout(150)
                if args.outline_check: verify_readable(current_step)
                code = page.locator('#flowboard').bounding_box(); aside = page.locator('.guide-aside').bounding_box()
                assert code['x'] + code['width'] <= aside['x'] + 1 if width > 800 else code['y'] + code['height'] <= aside['y'] + 1
                visible = page.locator('.guide-active-card .triage-claim-line').first.bounding_box()
                assert visible and visible['y'] >= code['y'] and visible['y'] < code['y'] + code['height'], ('Exact active line is offscreen', width, visible, code)
                header = page.locator('.guide-active-card .card-header').bounding_box()
                assert header['y'] >= code['y'] - 1 and header['y'] + header['height'] <= code['y'] + code['height'], ('Function identity left the reading area', width, header, code)
                page.screenshot(path=str(out / f'layout-{width}.png'))
            page.set_viewport_size({'width':1440,'height':900}); page.evaluate('document.body.classList.add("vscode-light")')
            page.screenshot(path=str(out / 'light.png'))
            result['lightContrast'] = contrast()[:6]
            assert all(item['ratio'] >= 4.5 for item in result['darkContrast'] + result['lightContrast']), 'Reading text contrast below 4.5:1.'
            result['checks'].append('Desktop and narrow viewport sizes, responsive breakpoint boundaries, stacked code/explanation and light theme rendered.')
            page.evaluate('document.body.classList.remove("vscode-light")')
            if len(steps) > 1:
                page.keyboard.press('Alt+Shift+ArrowLeft')
                assert page.locator('.guide-annotation').get_attribute('data-step-id') == steps[-2]
                page.keyboard.press('Alt+Shift+ArrowRight')
                assert page.locator('.guide-annotation').get_attribute('data-step-id') == steps[-1]
            page.get_by_role('button', name='Read full report', exact=True).click()
            page.locator('.guide-report-links summary').click()
            first_event = next(e for e in draft['causal']['events'] if e['id'] == steps[0])
            # Report paragraph order need not equal the tutorial reading order.
            page.locator('.guide-report-links').get_by_role('button', name='Step 1: ' + first_event['title'], exact=True).click()
            assert page.locator('.guide-annotation').get_attribute('data-step-id') == steps[0]
            result['checks'].append('Keyboard steps and original-report-to-step navigation use the same prepared route.')
            # Exact browser-readable boundary, not two animation frames.
            if len(steps) > 1:
                result['playbackTransitions'] = page.evaluate('''async steps => {
                  const values=[];
                  let current=0;
                  for(let round=0;round<3;round++) for(const direction of [1,-1]) for(let i=0;i<steps.length-1;i++) {
                    const next=current+direction, label=direction>0?'Next step':'Previous step';
                    const control=[...document.querySelectorAll('.guide-controls button')].find(b=>b.textContent===label);
                    window.armReadable(steps[next]);
                    const start=performance.now();control.click();
                    await new Promise((resolve,reject)=>{const end=performance.now()+30000;const poll=()=>{if(window.readableResult)resolve();else if(performance.now()>end)reject(new Error('Next step not readable'));else requestAnimationFrame(poll)};poll()});
                    const a=window.readableExpected[steps[current]],b=window.readableExpected[steps[next]];
                    values.push({from:steps[current],to:steps[next],crossFunction:a.file!==b.file||a.start!==b.start,ms:window.readableResult.at-start});
                    current=next;
                  }return values;
                }''', steps)
                result['playbackMs']=[value['ms'] for value in result['playbackTransitions']]
                assert len(request('/state')['providerCalls']) == before_calls
            # Recreate the controller and renderer, not merely hide/show a panel.
            # Persisting is a normal automatic product action, not JSON setup.
            page.evaluate('persistNow()'); page.wait_for_timeout(300)
            checkpoint = request('/state')['snapshots'][args.finding]['state']
            position = checkpoint['view']['walkthrough']['position']
            result['savedOpenSamples'] = []
            trace_cursor = len(request('/state').get('productionTrace', []))
            for sample in range(args.reopens):
                page.evaluate('window.closing=true;clearInterval(window.timer)')
                started = time.monotonic()
                request('/action', {'name':'reopen'})
                page.reload()
                page.wait_for_selector(finding_row)
                page.evaluate('id=>window.armReadable(id)', steps[0])
                click_start = time.monotonic()
                page.locator(finding_row).click()
                page.wait_for_function('()=>window.readableResult !== null', timeout=30000)
                endpoint = page.evaluate('window.readableResult')
                verify_readable(steps[0])
                verified = time.monotonic()
                click_ms = endpoint['at'] - endpoint['clickAt']
                assert page.evaluate('()=>({scale,panX,panY})') == position['camera']
                reopened = request('/state')
                assert reopened['lastLoad']['investigationDraft']['causal'] == draft['causal'], 'Unchanged-input opening changed accepted causal content.'
                assert len(reopened['providerCalls']) == before_calls
                assert reopened['lastLoad']['finding']['status'] == 'unreviewed'
                traces = reopened.get('productionTrace', [])
                result['savedOpenSamples'].append({'totalMs':(verified-started)*1000,'automationClickToVerifiedMs':(verified-click_start)*1000,
                    'actualClickToVerifiedMs':click_ms,'browserEndpoint':endpoint,'diagnosticsCompletedMs':(time.monotonic()-started)*1000,'hostTrace':traces[trace_cursor:]})
                trace_cursor = len(traces)
            result['productionTrace'] = request('/state').get('productionTrace', [])
            result['checks'].append('A recreated board restores the saved step/camera without a new provider request or changed researcher judgment.')
            # An ordinary native deletion during exploration must not strand
            # the guide on a known-but-no-longer-rendered function.
            controls = page.locator('.guide-controls')
            controls.get_by_role('button', name='Explore freely', exact=True).click()
            if page.evaluate('mode') != 'select':
                page.locator('#triage-bar > .triage-more > summary').click()
                page.locator('#mode-btn').click()
                page.locator('#triage-bar > .triage-more > summary').click()
            # The native title is deliberately text-selectable; select the
            # header padding, not its title, for native Delete/Undo behavior.
            page.locator('.guide-active-card .card-header').click(position={'x': 5, 'y': 5})
            removed_card = page.evaluate('[...cards].find(([, card])=>card.el.classList.contains("guide-active-card"))[0]')
            page.keyboard.press('Delete')
            assert page.locator('.guide-active-card').count() == 0
            page.get_by_role('button', name='Undo', exact=True).click()
            page.wait_for_function('id=>cards.has(id)', arg=removed_card)
            assert page.evaluate('id=>cards.get(id).codeEl.textContent.length>0', removed_card)
            result['checks'].append('Native Undo restores a deleted original function, including its code, during free exploration.')
            restored_header = page.evaluate('id=>{const box=cards.get(id).el.querySelector(".card-header").getBoundingClientRect();return {x:box.x,y:box.y};}', removed_card)
            page.mouse.click(restored_header['x'] + 5, restored_header['y'] + 5)
            page.keyboard.press('Delete')
            controls.get_by_role('button', name='Resume walkthrough', exact=True).click()
            page.wait_for_selector('.guide-active-card .triage-claim-line', timeout=30000)
            assert page.locator('.guide-annotation').get_attribute('data-step-id') == steps[0]
            # Materialization can precede the native layout/focus frame. Wait
            # for the actual readable endpoint, not merely a highlighted DOM node.
            page.wait_for_function('''() => {
              const viewport=document.querySelector('#flowboard').getBoundingClientRect();
              return ['.guide-active-card .card-header','.guide-active-card .triage-claim-line'].every(selector=>{
                const node=document.querySelector(selector); if(!node)return false;
                const box=node.getBoundingClientRect();return box.x>=viewport.x-1&&box.x<viewport.right&&box.y>=viewport.y-1&&box.y<viewport.bottom;
              });
            }''', timeout=10000)
            for node in ['.guide-active-card .card-header', '.guide-active-card .triage-claim-line']:
                box = page.locator(node).first.bounding_box(); viewport = page.locator('#flowboard').bounding_box()
                assert box['x'] >= viewport['x'] - 1 and box['x'] < viewport['x'] + viewport['width'] and box['y'] >= viewport['y'] - 1 and box['y'] < viewport['y'] + viewport['height']
            assert len(request('/state')['providerCalls']) == before_calls
            page.screenshot(path=str(out / 'deferred-function-return.png'))
            result['checks'].append('Deleting the active native function during exploration then resuming restores its checked card, visible header and exact range without AI.')
            # Save that ordinary deletion, then recreate the controller. Ready
            # required functions must be present in the initial load, before a
            # missing-card focus message can race the renderer.
            controls.get_by_role('button', name='Explore freely', exact=True).click()
            page.locator('.guide-active-card .card-header').click(position={'x': 5, 'y': 5})
            page.keyboard.press('Delete')
            page.evaluate('persistNow()'); page.wait_for_timeout(250)
            page.evaluate('window.closing=true;clearInterval(window.timer)')
            request('/action', {'name':'reopen'}); page.reload()
            page.wait_for_selector(finding_row)
            opened_at = time.monotonic()
            page.locator(finding_row).click()
            page.wait_for_function('id=>window.hostMessages.some(m=>m.type==="triage:load"&&m.issueId===id)', arg=args.finding)
            first_load = request('/state')['lastLoad']
            first_event = next(e for e in draft['causal']['events'] if e['id'] == steps[0])
            first_evidence = next(e for e in draft['evidence'] if e['id'] == first_event['evidenceId'])
            first_unit = original_unit(first_event)
            assert any(c['startLine'] == first_unit['source']['line'] and c['code'] == first_unit['code'] for c in first_load['state']['cards'])
            page.get_by_role('button', name='Walkthrough', exact=True).click()
            page.wait_for_selector('.guide-active-card .triage-claim-line')
            result['sameHostPreparedOpenMs'] = (time.monotonic() - opened_at) * 1000
            assert len(request('/state')['providerCalls']) == before_calls
            result['checks'].append('Reopening a saved board missing its required first function includes the complete checked native card in the initial load before guided focus.')
            if args.batch:
                page.get_by_role('button', name='Findings', exact=True).click()
                page.locator('[data-finding-id="I-02"]').click()
                page.wait_for_function('()=>document.querySelector("#triage-title")?.textContent.startsWith("I-02:")')
                page.wait_for_selector('.guide-annotation:visible')
                assert len(request('/state')['providerCalls']) == before_calls
                assert request('/state')['reportPreparation']['published']
                page.screenshot(path=str(out / 'never-selected-second-finding.png'))
                result['secondFinding'] = request('/state')['investigation']
                result['checks'].append('The never-selected second finding was prepared in the backend and opens with zero additional provider requests.')
            if args.case:
                page.get_by_role('button', name='Summary', exact=True).first.click()
                page.screenshot(path=str(out / 'summary-before-statements.png'))
                (out / 'summary-dom.txt').write_text(page.locator('.triage-drawer').inner_text())
                page.get_by_role('tab', name='Statements', exact=True).click()
                page.locator('.inv-workbench summary').filter(has_text='Correct this review').click()
                correction = page.get_by_role('textbox', name='Investigation correction', exact=True)
                correction.fill('Keep this researcher correction while another finding progresses.')
                correction.evaluate('(node)=>{node.focus();node.setSelectionRange(5,17);window.typedCorrection=node;}')
                current_status = request('/state').get('reportPreparation') or {'published':True,'mode':'completed','ready':1,'total':1}
                page.evaluate('''status => {
                  window.drawerMutations=0;
                  window.drawerObserver=new MutationObserver(changes=>window.drawerMutations+=changes.length);
                  window.drawerObserver.observe(document.querySelector('.triage-drawer'),{subtree:true,childList:true,characterData:true});
                  for(let i=0;i<30;i++) window.dispatchEvent(new MessageEvent('message',{data:{type:'triage:reportPreparation',report:status}}));
                }''', current_status)
                page.wait_for_timeout(150)
                assert page.evaluate('document.activeElement===window.typedCorrection && window.typedCorrection.selectionStart===5 && window.typedCorrection.selectionEnd===17')
                assert page.evaluate('window.drawerMutations') == 0
                result['checks'].append('Thirty background status updates preserve the exact correction input, caret, selection and drawer DOM.')
                # Freshness is tested after screenshots so captured guide data
                # still describes the original, unchanged fictional source.
                request('/action', {'name': args.freshness + '-change'})
                page.wait_for_function('() => !document.body.classList.contains("guide-reading") && !document.querySelector(".guide-annotation")')
                assert page.locator('.guide-annotation:visible').count() == 0
                assert page.locator('.inv-rule,.inv-claim,.inv-conclusion,.guide-opinion').count() == 0
                assert page.evaluate('document.activeElement===window.typedCorrection && window.typedCorrection.isConnected && window.typedCorrection.selectionStart===5 && window.typedCorrection.selectionEnd===17')
                assert correction.input_value().startswith('Keep this researcher correction')
                page.screenshot(path=str(out / 'revoked-statements.png'))
                result['checks'].append('Ready-to-revoked with Statements open removes generated conclusions without an exception or losing the typed correction.')
                assert len(request('/state')['providerCalls']) == before_calls
                result['checks'].append('Changing the ' + args.freshness + ' withholds the published guide and does not silently regenerate or alter the human result.')
        else:
            assert page.locator('.guide-controls:visible').count() == 0
            assert page.locator('.guide-preparation:visible').count() == 1
            assert page.locator('.guide-annotation:visible').count() == 0
            status_text = page.locator('.guide-preparation').inner_text()
            assert 'Make room for the walkthrough' not in status_text, 'Unpublished analysis is not a card-capacity failure.'
            selected_job = next((j for j in (state.get('reportPreparation') or {}).get('jobs', []) if j['id'] == args.finding), None)
            if args.local_recheck:
                assert args.provider == 'none' and selected_job.get('localRecheckAvailable')
                before_requests = state['reportPreparation']['requests']
                before_revision = draft['revision']
                started = time.monotonic()
                action = page.get_by_role('button', name='Recheck local preparation', exact=True)
                assert action.is_visible() and action.is_enabled()
                action.click()
                until = time.monotonic() + 90
                while time.monotonic() < until:
                    state = request('/state')
                    current = state.get('privatePreparationDraft') or state.get('investigation') or {}
                    if current.get('revision', 0) > before_revision and current.get('phase') in ['blocked', 'local-preparation-ready']:
                        break
                    page.wait_for_timeout(250)
                else:
                    raise AssertionError('Selected local recheck did not reach its finite result.')
                assert not state['providerCalls']
                assert state['reportPreparation']['requests'] == before_requests
                assert page.locator('.guide-annotation:visible').count() == 0
                result['localRecheckMs'] = (time.monotonic() - started) * 1000
                page.wait_for_timeout(300)
                page.screenshot(path=str(out / 'local-rechecked.png'))
                result['checks'].append('Actual selected local recheck click reached a finite result, with zero provider calls/reservations and no private candidate annotations.')
                selected_job = next(j for j in state['reportPreparation']['jobs'] if j['id'] == args.finding)
                status_text = page.locator('.guide-preparation').inner_text()
            preparation = state.get('reportPreparation') or {}
            if isinstance(preparation.get('requests'), (int, float)) and isinstance(preparation.get('requestLimit'), (int, float)) and preparation['requests'] >= preparation['requestLimit']:
                assert page.locator('.guide-preparation').get_by_role('button', name='Continue this finding', exact=True).count() == 0
                assert 'Shared report allowance exhausted' in status_text
                result['checks'].append('Exhausted shared allowance does not offer an ineffective finding continuation; retained work remains available.')
            if selected_job and selected_job.get('reason'):
                if not selected_job.get('retainedRejection') or selected_job.get('failureKind') not in ['structural', 'validation']:
                    assert selected_job['reason'] in status_text
            if selected_job and selected_job.get('retainedRejection'):
                assert 'Analysis received · correction required.' in status_text
                assert 'Verification has not started for this proposal.' in status_text
                assert page.locator('.guide-preparation').get_by_role('button', name='Continue this finding', exact=True).count() == 0
                assert page.locator('.guide-preparation').get_by_role('button', name='Repair saved analysis', exact=True).count() == int(bool(selected_job.get('repairAvailable')) and args.provider != 'none')
                assert len(state['providerCalls']) == 0, 'Retained rejection inspection is local, never a repair request.'
                result['checks'].append('Received rejection has a factual recovery message, no replay disguised as repair and no unaccepted tutorial.')
            questions = (selected_job or {}).get('missingInputs', [])
            if questions:
                page.locator('.guide-preparation').get_by_role('button', name='Details', exact=True).click()
                status_text = page.locator('.guide-preparation').inner_text()
                assert 'What still needs checking' in status_text
                assert questions[0]['text'] in status_text
                assert 'paid responses are retained' in status_text
                result['checks'].append('The real incomplete question and retained-work distinction are visible; acquired source is not shown as reviewed.')
                page.screenshot(path=str(out / 'incomplete-details.png'))
            if (selected_job or {}).get('currentAttempt'):
                if not questions:
                    page.locator('.guide-preparation').get_by_role('button', name='Details', exact=True).click()
                details = page.locator('details').filter(has=page.get_by_text('Current received response: correction details', exact=True))
                details.locator('summary').click()
                details.scroll_into_view_if_needed()
                assert details.is_visible()
                text = details.inner_text()
                assert selected_job['currentAttempt']['requestId'] in text
                for problem in selected_job['validationProblems']:
                    assert problem['message'] in text
                    if problem.get('target'):
                        assert problem['target'] in text
                    if problem.get('file'):
                        action = details.get_by_role('button', name=f"Read source lines {problem['line']}-{problem['endLine']}", exact=True)
                        assert action.is_visible() and action.is_enabled()
                        action.click()
                        until = time.monotonic() + 10
                        while time.monotonic() < until:
                            opened = request('/state').get('opened', [])
                            if opened and opened[-1]['file'] == problem['file']:
                                break
                            page.wait_for_timeout(50)
                        else:
                            raise AssertionError('Current diagnostic source action did not open its exact file.')
                history = page.get_by_text('Earlier response history', exact=True)
                assert history.count() == int(bool(selected_job.get('rejectionHistory')))
                assert not request('/state')['providerCalls']
                page.screenshot(path=str(out / 'current-rejection.png'))
                result['checks'].append('Expanded current-attempt diagnostics name this received request and every affected field; earlier failures are separate history, with no provider call.')
            result['checks'].append('Incomplete explanation is withheld, with an explicit preparation status.')
        result['pageErrors'] = errors
        assert not errors, errors
        assert not request('/state')['errors'], request('/state')['errors']
        page.evaluate('window.closing=true;clearInterval(window.timer)'); browser.close()
except Exception as error:
    result['error'] = repr(error)
    result['traceback'] = traceback.format_exc()
    if 'page' in locals():
        try: page.screenshot(path=str(out / 'error.png'))
        except Exception: pass
    if 'request' in locals():
        try:
            result['diagnostic'] = request('/state')
            result['pageErrors'] = errors if 'errors' in locals() else []
        except Exception as diagnostic: result['diagnosticError'] = repr(diagnostic)
finally:
    (out / 'result.json').write_text(json.dumps(result, indent=2))
    process.terminate()
    try: process.wait(timeout=10)
    except subprocess.TimeoutExpired: process.kill(); process.wait()
print(json.dumps({'output':str(out),'phase':result.get('draft',{}).get('phase') if result.get('draft') else None,'checks':result['checks'],'error':result.get('error')}))
if result.get('error'): raise SystemExit(1)
