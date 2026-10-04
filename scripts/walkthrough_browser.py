#!/usr/bin/env python3
"""Exercise the actual native renderer and controller, using a recorded real AI
review of an identical fictional fixture. Editor transport is simulated, not a
live Cursor window. This tests navigation, not the truth of the AI's reasoning.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import urllib.request
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--recording', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
record = json.loads(Path(args.recording).read_text())
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
process = subprocess.Popen(['node', str(root / 'scripts/workflow-host.js'), '--quality-case', record['case'],
                            '--provider', 'none', '--quality-recording', args.recording], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True)
result = {'boundary': 'Actual renderer/controller; simulated editor transport; recorded real fictional review.', 'checks': []}
try:
    first = process.stdout.readline()
    if not first:
        raise RuntimeError(process.stderr.read())
    host = json.loads(first)
    result.update(version=host['productionVersion'], extension=host['productionExtension'])
    def request(route, body=None):
        req = urllib.request.Request(host['origin'] + route, data=None if body is None else json.dumps(body).encode(),
                                     headers={'X-Workflow-Token': host['secret'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.loads(response.read())
    with sync_playwright() as playwright:
        launch = {'headless': True}
        if os.environ.get('FLOWBOARD_CHROMIUM_PATH'):
            launch['executable_path'] = os.environ['FLOWBOARD_CHROMIUM_PATH']
        browser = playwright.chromium.launch(**launch)
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('__send', lambda message: request('/message', message))
        page.expose_function('__poll', lambda cursor: request('/events?after=' + str(cursor)))
        page.add_init_script('''window.sent=[]; window.hostMessages=[];
          window.acquireVsCodeApi=()=>({postMessage(m){if(!window.closing){window.sent.push(m);return window.__send(m);}}});
          let cursor=0;window.polling=false;window.timer=setInterval(async()=>{if(window.polling||window.closing)return;window.polling=true;
          try{let b=await window.__poll(cursor);cursor=b.cursor;for(let m of b.messages){window.hostMessages.push(m);window.dispatchEvent(new MessageEvent('message',{data:m}));}}
          finally{window.polling=false;}},50);''')
        page.goto(host['origin'])
        page.wait_for_function('() => window.hostMessages.some(m=>m.type==="triage:library")')
        def select():
            page.locator('#triage-bar').get_by_role('button', name='Findings', exact=True).click()
            page.locator('.triage-drawer .triage-list button').filter(has_text='I-01 ·').first.click()
            page.wait_for_function('() => window.hostMessages.some(m=>m.type==="triage:load"&&m.issueId==="I-01")')
            page.wait_for_timeout(350)
        select()
        page.screenshot(path=str(output / 'summary.png'))
        page.locator('[data-reading-group="start"] button.primary').click()
        page.wait_for_selector('.guide-controls:visible')
        page.wait_for_timeout(400)
        controls = page.locator('.guide-controls')
        count = int(controls.locator('strong').inner_text().split()[-1])
        result['steps'] = count
        assert count >= 2
        assert page.locator('.guide-ai-part').count() == 4
        assert page.locator('.card-code .guide-annotation').count() == 0
        def camera():
            return page.evaluate('()=>({scale,panX,panY})')
        visited = []
        for index in range(count):
            step = page.locator('.guide-annotation').get_attribute('data-step-id')
            spans = page.locator('.triage-claim-line').evaluate_all('(nodes)=>nodes.map(n=>Number(n.dataset.sourceLine))')
            visited.append({'step': step, 'lines': spans, 'text': page.locator('.guide-annotation').inner_text()})
            if index == count - 1:
                page.screenshot(path=str(output / 'assessment.png'))
            if page.locator('.guide-annotation .guide-file-link').count():
                checked = request('/state')['investigation']
                entry = next(item for item in checked['evidence'] if 'note-' + item['id'] == step)
                assert spans == list(range(entry['source']['line'], entry['source']['endLine'] + 1)), (step, spans, entry['source'])
                cam = camera()
                page.locator('.guide-file-link').click()
                page.wait_for_timeout(180)
                opened = request('/state')['opened'][-1]
                assert opened['file'] == entry['source']['file']
                assert opened['selection']['startLine'] == entry['source']['line'] - 1
                assert opened['selection']['endLine'] == entry['source']['endLine'] - 1
                controls.get_by_role('button', name='Return to step', exact=True).click()
                assert camera() == cam
                quote = page.locator('.guide-report blockquote')
                if quote.count():
                    text = quote.inner_text()
                    assert text in record['initial']['reportText']
                    result['checks'].append('Faithful original paragraph: ' + quote.get_attribute('data-paragraph-id'))
            if index < count - 1:
                controls.get_by_role('button', name='Next', exact=True).click()
                page.wait_for_timeout(250)
        result['visited'] = visited
        result['checks'].append('Every code step highlights its entire exact original span; editor navigation and return agree.')
        # Keyboard movement changes the reading step, not the assessment.
        opinion = page.locator('.guide-result').inner_text()
        page.keyboard.press('Alt+Shift+ArrowLeft')
        page.wait_for_timeout(200)
        assert page.locator('.guide-result').inner_text() == opinion
        while controls.get_by_role('button', name='Back', exact=True).is_enabled():
            controls.get_by_role('button', name='Back', exact=True).click()
            page.wait_for_timeout(160)
        page.wait_for_timeout(200)
        step0 = page.locator('.guide-annotation').get_attribute('data-step-id')
        cam = camera()
        old_focus = page.evaluate('() => window.hostMessages.filter(m=>m.type==="triage:investigationFocus").at(-1)')
        controls.get_by_role('button', name='Next', exact=True).click()
        page.wait_for_timeout(250)
        new_step = page.locator('.guide-annotation').get_attribute('data-step-id')
        new_camera = camera()
        page.evaluate('data=>window.dispatchEvent(new MessageEvent("message",{data}))', old_focus)
        assert camera() == new_camera
        assert page.locator('.guide-annotation').get_attribute('data-step-id') == new_step
        controls.get_by_role('button', name='Back', exact=True).click()
        page.wait_for_timeout(250)
        cam = camera()
        result['checks'].append('A late same-finding focus response cannot replace the newer step.')
        # Supporting/opposing detour is separate from numbered progress.
        links = page.locator('.guide-ai-part[data-part="code"] button')
        if links.count():
            links.last.click()
            page.wait_for_timeout(250)
            detour = page.evaluate('() => window.hostMessages.filter(m=>m.type==="triage:investigationFocus").at(-1)')
            assert page.locator('.guide-annotation').get_attribute('data-step-id') == 'note-' + detour['evidenceId']
            page.screenshot(path=str(output / 'counterevidence-detour.png'))
            controls.get_by_role('button', name='Return to step', exact=True).click()
            assert camera() == cam
            assert page.locator('.guide-annotation').get_attribute('data-step-id') == step0
        controls.get_by_role('button', name='Explore freely', exact=True).click()
        page.locator('#triage-bar').get_by_role('button', name='All functions', exact=True).click()
        controls.get_by_role('button', name='Resume review', exact=True).click()
        assert camera() == cam
        result['checks'].append('Evidence detour and free exploration restore the exact camera and step.')
        if page.locator('.guide-report blockquote').count():
            page.locator('.guide-report').get_by_role('button', name='Read full report', exact=True).click()
            page.locator('.guide-report-links > summary').click()
            page.locator('.guide-report-links button').first.click()
            page.wait_for_timeout(250)
            assert page.locator('.guide-annotation').get_attribute('data-step-id') == step0
            result['checks'].append('Original report paragraph links back to the matching step.')
        for width, height in [(1440, 900), (1280, 800), (1366, 768), (640, 800)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(150)
            aside = page.locator('.guide-aside').bounding_box()
            code = page.locator('#flowboard').bounding_box()
            if width > 800:
                assert code['x'] + code['width'] <= aside['x'] + 1
            else:
                assert code['y'] + code['height'] <= aside['y'] + 1
            assert page.locator('.guide-annotation').evaluate('e=>parseFloat(getComputedStyle(e).fontSize)') >= 14
            page.screenshot(path=str(output / f'walkthrough-{width}.png'))
        page.set_viewport_size({'width': 1440, 'height': 900})
        page.evaluate('document.body.classList.add("vscode-light")')
        page.screenshot(path=str(output / 'walkthrough-light.png'))
        page.evaluate('document.body.classList.remove("vscode-light")')
        # The ordinary save/reopen path must retain tutorial state, not require Save.
        page.evaluate('persistNow()')
        page.wait_for_timeout(300)
        request('/action', {'name': 'reopen'})
        page.goto(host['origin'])
        page.wait_for_function('() => window.hostMessages.some(m=>m.type==="triage:library")')
        select()
        page.wait_for_selector('.guide-controls:visible')
        assert page.locator('.guide-annotation').get_attribute('data-step-id') == step0
        assert camera() == cam
        state = request('/state')
        assert len(state['providerCalls']) == 0
        assert not errors, errors
        assert not state['errors'], state['errors']
        result['checks'].append('Automatic save/reopen preserves step and camera; zero provider calls during navigation/reopen.')
        request('/action', {'name': 'report-change'})
        page.wait_for_function('() => document.querySelector(".guide-aside")?.textContent.includes("Code or report changed")')
        assert controls.get_by_role('button', name='Next', exact=True).is_disabled()
        assert page.locator('.triage-claim-line').count() == 0
        assert page.locator('.guide-annotation').count() == 0
        request('/action', {'name': 'source-change'})
        page.wait_for_timeout(150)
        assert controls.get_by_role('button', name='Next', exact=True).is_disabled()
        result['checks'].append('Changed report and code invalidate old steps and highlights without moving references.')
        result['pageErrors'] = errors
        result['hostErrors'] = state['errors']
        page.evaluate('window.closing=true;clearInterval(window.timer)')
        page.wait_for_function('() => !window.polling')
        browser.close()
finally:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    (output / 'checks.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'version': result.get('version'), 'checks': result['checks'], 'output': str(output)}, indent=2))
