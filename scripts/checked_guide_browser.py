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
parser.add_argument('--workspace')
parser.add_argument('--report')
parser.add_argument('--finding', default='I-01')
parser.add_argument('--provider', default='codex')
parser.add_argument('--recorded')
parser.add_argument('--baseline', action='store_true')
parser.add_argument('--report-preparation', action='store_true')
parser.add_argument('--batch', action='store_true')
parser.add_argument('--freshness', choices=['source', 'report'], default='report')
parser.add_argument('--output', required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
command = ['node', str(repo / 'scripts/workflow-host.js'), '--provider', args.provider]
if args.report_preparation:
    command += ['--report-preparation']
if args.batch:
    command += ['--quality-batch']
if args.case:
    command += ['--quality-case', args.case]
if args.recorded:
    command += ['--quality-responses', args.recorded]
if args.workspace:
    command += ['--workspace', args.workspace]
if args.report:
    command += ['--report', args.report, '--report-finding', args.finding]
process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
result = {'boundary': 'Production code and renderer; real provider; simulated editor transport. No live Cursor UI control.', 'case': args.case, 'checks': []}
if args.recorded: result['boundary'] = 'Production preparation and renderer with recorded fictional provider responses; exact matching source IDs translated for a new temporary project. Simulated editor transport; no fresh AI reasoning.'
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
        page.add_init_script('''window.sent=[];window.hostMessages=[];
          window.acquireVsCodeApi=()=>({postMessage(m){if(!window.closing){window.sent.push(m);return window.__send(m);}}});
          let cursor=0;window.polling=false;window.timer=setInterval(async()=>{if(window.polling||window.closing)return;window.polling=true;
          try{const b=await window.__poll(cursor);cursor=b.cursor;for(const m of b.messages){window.hostMessages.push(m);window.dispatchEvent(new MessageEvent('message',{data:m}));}}finally{window.polling=false;}},75);''')
        page.goto(host['origin'])
        page.wait_for_selector('.triage-list button', timeout=30000)
        page.locator('.triage-list button').filter(has_text=args.finding + ' ·').first.click()
        page.wait_for_function('id=>window.hostMessages.some(m=>m.type==="triage:load"&&m.issueId===id)', arg=args.finding, timeout=120000)
        page.screenshot(path=str(out / 'preparing.png'))
        deadline = time.monotonic() + 900
        last_stage = None
        while time.monotonic() < deadline:
            state = request('/state'); draft = state['investigation']
            stage = (draft or {}).get('phase'), len(state['providerCalls']), len((draft or {}).get('sources', []))
            if stage != last_stage:
                (out / 'progress.json').write_text(json.dumps(state, indent=2))
                last_stage = stage
            terminal_report = not state.get('reportPreparation') or state['reportPreparation']['mode'] not in ['running', 'interrupted']
            if draft and draft['phase'] in ['ready', 'blocked', 'provider-required'] and terminal_report: break
            if state['lastLoad'].get('preparation', {}).get('state') == 'blocked': break
            page.wait_for_timeout(500)
        page.wait_for_timeout(700)
        state = request('/state'); draft = state['investigation']
        result.update(draft=draft, hostErrors=state['errors'], logs=state['logs'], providerCalls=state['providerCalls'])
        result['reportPreparation'] = state.get('reportPreparation')
        (out / 'state.json').write_text(json.dumps(state, indent=2))
        page.screenshot(path=str(out / ('initial.png' if draft and draft['phase'] == 'ready' else 'blocked.png')))
        if args.baseline:
            result['checks'].append('Captured the installed older renderer in its normal selected-finding state.')
        elif draft and draft['phase'] == 'ready':
            page.wait_for_selector('.guide-controls:visible')
            controls = page.locator('.guide-controls')
            steps = draft['causal']['order']; visited = []
            before_calls = len(state['providerCalls'])
            for i, identity in enumerate(steps):
                event = next(e for e in draft['causal']['events'] if e['id'] == identity)
                entry = next(e for e in draft['evidence'] if e['id'] == event['evidenceId'])
                assert page.locator('.guide-annotation').get_attribute('data-step-id') == identity
                spans = page.locator('.guide-active-card .triage-claim-line').evaluate_all('(ns)=>ns.map(n=>Number(n.dataset.sourceLine))')
                assert spans == list(range(entry['source']['line'], entry['source']['endLine'] + 1)), (identity, spans, entry['source'])
                unit = next(u for u in draft['sources'] if u['id'] == entry['sourceId'])
                original = page.locator('.guide-active-card [data-source-line]').count()
                assert original == len(unit['code'].split('\n')), (original, unit['name'])
                quote = page.locator('.guide-report blockquote')
                if quote.count(): assert quote.inner_text() in state['lastLoad']['reportText']
                visited.append({'event': identity, 'lines': spans, 'explanation': page.locator('.guide-annotation').inner_text()})
                page.screenshot(path=str(out / f'step-{i + 1}.png'))
                if i + 1 < len(steps):
                    camera_before = page.evaluate('()=>({scale,panX,panY})')
                    controls.get_by_role('button', name='Next step', exact=True).click()
                    following = next(e for e in draft['causal']['events'] if e['id'] == steps[i + 1])
                    following_entry = next(e for e in draft['evidence'] if e['id'] == following['evidenceId'])
                    if following_entry['sourceId'] == entry['sourceId']:
                        assert page.evaluate('()=>({scale,panX,panY})') == camera_before
            result['visited'] = visited
            result['checks'].append('Every event has its exact range, full original function and faithful report paragraph.')
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
            entry = next(e for e in draft['evidence'] if e['id'] == event['evidenceId'])
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
            for width, height in [(1440,900),(1280,800),(1366,768),(640,800)]:
                page.set_viewport_size({'width':width,'height':height}); page.wait_for_timeout(150)
                code = page.locator('#flowboard').bounding_box(); aside = page.locator('.guide-aside').bounding_box()
                assert code['x'] + code['width'] <= aside['x'] + 1 if width > 760 else code['y'] + code['height'] <= aside['y'] + 1
                visible = page.locator('.guide-active-card .triage-claim-line').first.bounding_box()
                assert visible and visible['y'] >= code['y'] and visible['y'] < code['y'] + code['height'], ('Exact active line is offscreen', width, visible, code)
                header = page.locator('.guide-active-card .card-header').bounding_box()
                assert header['y'] >= code['y'] - 1 and header['y'] + header['height'] <= code['y'] + code['height'], ('Function identity left the reading area', width, header, code)
                page.screenshot(path=str(out / f'layout-{width}.png'))
            page.set_viewport_size({'width':1440,'height':900}); page.evaluate('document.body.classList.add("vscode-light")')
            page.screenshot(path=str(out / 'light.png'))
            result['lightContrast'] = contrast()[:6]
            assert all(item['ratio'] >= 4.5 for item in result['darkContrast'] + result['lightContrast']), 'Reading text contrast below 4.5:1.'
            result['checks'].append('Four viewport sizes, narrow stacked code/explanation and light theme rendered.')
            page.evaluate('document.body.classList.remove("vscode-light")')
            if len(steps) > 1:
                page.keyboard.press('Alt+Shift+ArrowLeft')
                assert page.locator('.guide-annotation').get_attribute('data-step-id') == steps[-2]
                page.keyboard.press('Alt+Shift+ArrowRight')
                assert page.locator('.guide-annotation').get_attribute('data-step-id') == steps[-1]
            page.get_by_role('button', name='Read full report', exact=True).click()
            page.locator('.guide-report-links summary').click()
            page.locator('.guide-report-links button').first.click()
            assert page.locator('.guide-annotation').get_attribute('data-step-id') == steps[0]
            result['checks'].append('Keyboard steps and original-report-to-step navigation use the same prepared route.')
            # Recreate the controller and renderer, not merely hide/show a panel.
            # Persisting is a normal automatic product action, not JSON setup.
            page.evaluate('persistNow()'); page.wait_for_timeout(300)
            checkpoint = request('/state')['snapshots'][args.finding]['state']
            position = checkpoint['view']['walkthrough']['position']
            page.evaluate('window.closing=true;clearInterval(window.timer)')
            request('/action', {'name':'reopen'})
            page.reload()
            page.wait_for_selector('.triage-list button')
            page.locator('.triage-list button').filter(has_text=args.finding + ' ·').first.click()
            page.wait_for_selector('.guide-annotation', timeout=30000)
            assert page.locator('.guide-annotation').get_attribute('data-step-id') == steps[0]
            assert page.evaluate('()=>({scale,panX,panY})') == position['camera']
            assert len(request('/state')['providerCalls']) == before_calls
            assert request('/state')['lastLoad']['finding']['status'] == 'unreviewed'
            result['checks'].append('A recreated board restores the saved step/camera without a new provider request or changed researcher judgment.')
            if args.batch:
                page.get_by_role('button', name='Findings', exact=True).click()
                page.locator('.triage-list button').filter(has_text='I-02 ·').first.click()
                page.wait_for_function('()=>document.querySelector("#triage-title")?.textContent.startsWith("I-02:")')
                page.wait_for_selector('.guide-annotation:visible')
                assert len(request('/state')['providerCalls']) == before_calls
                assert request('/state')['reportPreparation']['published']
                page.screenshot(path=str(out / 'never-selected-second-finding.png'))
                result['secondFinding'] = request('/state')['investigation']
                result['checks'].append('The never-selected second finding was prepared in the backend and opens with zero additional provider requests.')
            if args.case:
                # Freshness is tested after screenshots so captured guide data
                # still describes the original, unchanged fictional source.
                request('/action', {'name': args.freshness + '-change'})
                page.wait_for_function('() => !document.body.classList.contains("guide-reading")')
                assert page.locator('.guide-annotation:visible').count() == 0
                assert len(request('/state')['providerCalls']) == before_calls
                result['checks'].append('Changing the ' + args.freshness + ' withholds the published guide and does not silently regenerate or alter the human result.')
        else:
            assert page.locator('.guide-controls:visible').count() == 0
            assert page.locator('.guide-preparation:visible').count() == 1
            assert page.locator('.guide-annotation:visible').count() == 0
            result['checks'].append('Incomplete explanation is withheld, with an explicit preparation status.')
        result['pageErrors'] = errors
        assert not errors, errors
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
