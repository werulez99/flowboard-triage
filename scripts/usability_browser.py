#!/usr/bin/env python3
"""Researcher reading-workflow checks in the real pinned native renderer.

Uses fictional seeded claim data and a mock editor transport, not an AI run or a
real protocol validation. Requires the same environment as native_visual_smoke.py.
With --baseline-ref, serve that local Git revision's companion JS/CSS against the
same pinned renderer and fixture, capture a comparable baseline, and exit.
"""
import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-prefix', required=True, help='Existing output directory plus filename prefix for screenshots.')
parser.add_argument('--baseline-ref', help='Optional local Git revision to compare, for example v0.7.0.')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
output_prefix = Path(args.output_prefix).resolve()
if not output_prefix.parent.is_dir():
    parser.error('The output directory must already exist.')
upstream = Path(os.environ['FLOWBOARD_EXTENSION_PATH'])
fixture = {}
baseline = args.baseline_ref
baseline_assets = {}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlparse(self.path).path
        if route == '/':
            body, kind = fixture['html'].encode(), 'text/html'
        elif re.fullmatch(r'/(tool|native)/[a-z-]+\.js', route):
            folder = upstream / 'webview' if route.startswith('/native/') else root / 'extension/webview'
            if baseline and route.startswith('/tool/'):
                name = Path(route).name
                if name not in baseline_assets:
                    baseline_assets[name] = subprocess.check_output(['git', 'show', baseline + ':extension/webview/' + name], cwd=root)
                body = baseline_assets[name]
            else:
                body = (folder / Path(route).name).read_bytes()
            kind = 'text/javascript'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_args):
        pass

server = HTTPServer(('127.0.0.1', 0), Handler)
origin = f'http://127.0.0.1:{server.server_port}'
fixture.update(json.loads(subprocess.check_output(['node', str(root / 'scripts/render-fixture.js'), origin])))
if baseline:
    old_css = subprocess.check_output(['git', 'show', baseline + ':extension/webview/triage.css'], cwd=root).decode()
    current_css = (root / 'extension/webview/triage.css').read_text()
    fixture['html'] = fixture['html'].replace(current_css, old_css)
    # The baseline predates generated investigations and does not consume this
    # module. Do not request a nonexistent historical asset when comparing it.
    fixture['html'] = re.sub(r'<script[^>]+src="[^"]*/investigation-view\.js"[^>]*></script>', '', fixture['html'])
example = json.loads(subprocess.check_output(['node', '-e', 'process.stdout.write(JSON.stringify(require("./examples/claim-review.json")))'], cwd=root))
message = copy.deepcopy(fixture['message'])
message['finding'] = example['finding']
digest = next(iter(message['hints'].values()))['sourceHash']
for evidence in message['finding']['triage']['evidence']:
    evidence['source']['sourceHash'] = digest
message['finding']['triage']['claims'].append({
    'id': 'contradicted-demo', 'text': 'The helper leaves the counter unchanged.', 'state': 'contradicted',
    'observed': 'The helper contains counter += amount; the statement changes the counter for an ordinary positive input.',
    'conditions': 'An ordinary call and positive amount. This is a fictional source-comprehension check.',
    'consequence': 'The broad claim of no update conflicts with the statement; no security conclusion follows.',
    'reason': 'The actual addition contradicts the report statement in this fictional demonstration.',
    'evidence': [
        {'evidenceId': 'caller-question', 'stance': 'context', 'reason': 'The public declaration supplies context, not the claimed update.'},
        {'evidenceId': 'addition', 'stance': 'contradicts', 'reason': 'The addition contradicts the assertion that no update occurs.'}],
    'questions': ['Does the caller pass a positive amount in the behavior being discussed?']})
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as playwright:
        launch = {'headless': True}
        if os.environ.get('FLOWBOARD_CHROMIUM_PATH'):
            launch['executable_path'] = os.environ['FLOWBOARD_CHROMIUM_PATH']
        browser = playwright.chromium.launch(**launch)
        page = browser.new_page(viewport={'width': 1366, 'height': 768})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script('window.sent=[]; window.acquireVsCodeApi=()=>({postMessage:message=>window.sent.push(message)});')
        page.goto(origin)
        page.wait_for_function('window.sent.some(x=>x.type==="triage:ready")')
        page.evaluate('data=>window.dispatchEvent(new MessageEvent("message",{data}))', {'type': 'restore', 'state': None})
        page.evaluate('data=>window.dispatchEvent(new MessageEvent("message",{data}))', message)
        # Same actual renderer and fictional saved review at ordinary laptop
        # widths. No alternate HTML/CSS mockup is used for these captures.
        if not baseline:
            for width, height in [(1366, 768), (1280, 800), (1440, 900), (640, 800)]:
                page.set_viewport_size({'width': width, 'height': height})
                page.keyboard.press('Alt+2')
                assert page.locator('[data-reading-group]').count() == 4
                assert page.locator('.triage-drawer textarea:visible').count() == 0
                action = page.locator('[data-reading-group="start"] button.primary')
                box = action.bounding_box()
                assert box and box['y'] + box['height'] < height, (width, box)
                assert action.inner_text() == 'Read code'
                page.screenshot(path=str(output_prefix) + f'-summary-{width}.png', full_page=True)
                action.click()
                # These are saved human notes, not a prepared AI walkthrough.
                # The primary action must respect the gate; raw code remains
                # reachable through the native function action without AI.
                assert page.locator('.guide-preparation').is_visible()
                assert not page.locator('.guide-controls').is_visible()
                source_card = page.locator('.card').filter(has=page.locator('[data-source-line="13"]'))
                source_card.get_by_role('button', name='Explore function', exact=True).click()
                source_card.locator('.triage-note-links button').first.click()
                source_card.locator('.triage-inline-note').get_by_role('button', name='Read code', exact=True).click()
                assert page.locator('.triage-claim-line').get_attribute('data-source-line') == '13'
                assert page.evaluate('() => scale') >= .9
                assert page.locator('.card-code .triage-inline-note').count() == 0
                if width == 640:
                    assert not page.locator('.triage-drawer').is_visible(), 'Explicit source exploration should make room without losing the finding.'
                    page.screenshot(path=str(output_prefix) + '-narrow-code.png', full_page=True)
            page.set_viewport_size({'width': 1366, 'height': 768})
            page.keyboard.press('Alt+2')
        page.locator('.triage-tabs').get_by_role('tab', name='Statements', exact=True).click()
        page.locator('.triage-claim-select[data-claim-id="counter-addition"]').click()
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        if baseline:
            page.screenshot(path=str(output_prefix) + '-baseline.png', full_page=True)
            dimensions = page.locator('.triage-claim-evidence').bounding_box()
            page.locator('.triage-card-story > summary').click()
            baseline_story_height = page.locator('.triage-card-story').bounding_box()['height']
            page.screenshot(path=str(output_prefix) + '-baseline-expanded.png', full_page=True)
            restored = copy.deepcopy(message)
            restored['token'] = 'fictional-reopen-baseline'
            restored['state'] = page.evaluate('window.sent.findLast(x=>x.type==="triage:persist").state')
            page.evaluate('data=>window.dispatchEvent(new MessageEvent("message",{data}))', restored)
            print(json.dumps({'baseline_frontend_ref': baseline, 'evidence_top_at_1366x768': dimensions['y'], 'expanded_story_height': baseline_story_height, 'selected_claim_retained_on_mock_reopen': page.locator('.triage-claim-detail[data-claim-id="counter-addition"]').count() == 1}))
            browser.close()
            sys.exit(0)
        assert page.locator('.triage-claim-next').is_visible()
        assert page.locator('.triage-claim-line').count() == 1
        assert page.locator('.triage-claims textarea:visible').count() == 0, 'Reading view should not present editing forms.'
        dimensions = page.locator('.triage-claim-evidence').bounding_box()
        assert dimensions['y'] < 700, dimensions
        assert 'disprove or narrow' in page.locator('.triage-claim-next').inner_text()
        page.screenshot(path=str(output_prefix) + '-dark.png', full_page=True)
        assert page.locator('.card-code .triage-inline-note').count() == 0, 'Explanations must never interrupt code.'
        camera = page.evaluate('() => snapshot().camera')
        page.locator('.triage-selected-source .triage-note-links button').first.click()
        assert page.evaluate('() => snapshot().camera') == camera, 'Opening a note must preserve the camera.'
        assert 'Supports statement counter-addition' in page.locator('.triage-selected-source .triage-inline-note').inner_text()
        assert 'Context for issue I-01' in page.locator('.triage-selected-source .triage-inline-note').inner_text()
        story_height = page.locator('.triage-selected-source .triage-explanations').bounding_box()['height']
        page.screenshot(path=str(output_prefix) + '-dark-expanded.png', full_page=True)
        page.locator('.triage-selected-source .triage-explanation-body > summary').click()
        page.wait_for_function('() => window.sent.findLast(x=>x.type==="triage:persist")?.state.view?.activeClaim==="counter-addition"')
        saved_view = page.evaluate('window.sent.findLast(x=>x.type==="triage:persist").state')
        another = copy.deepcopy(message)
        another.update({'issueId': 'another-fictional-finding', 'token': 'another-fictional-session', 'finding': {'title': 'Unrelated fictional finding', 'status': 'unreviewed'}})
        page.evaluate('data=>window.dispatchEvent(new MessageEvent("message",{data}))', another)
        assert page.locator('.triage-claim-detail').count() == 0
        restored = copy.deepcopy(message)
        restored.update({'token': 'fictional-reopen-current', 'state': saved_view})
        page.evaluate('data=>window.dispatchEvent(new MessageEvent("message",{data}))', restored)
        assert page.locator('.triage-claim-detail[data-claim-id="counter-addition"]').count() == 1, 'The selected argument should return with its saved board.'
        assert page.locator('.triage-claim-line').count() == 1
        page.get_by_text('Edit this evidence link', exact=True).click()
        page.get_by_label('Evidence stance for counter-addition addition', exact=True).select_option('context')
        assert page.get_by_label('Evidence stance for counter-addition addition', exact=True).is_visible(), 'Changing stance must keep the current evidence editor open.'
        page.get_by_label('Evidence stance for counter-addition addition', exact=True).select_option('supports')
        page.locator('.triage-claim-list > summary').click()
        page.locator('.triage-claim-select[data-claim-id="intended-access"]').click()
        assert 'What caller policy does the specification require?' in page.locator('.triage-claim-next').inner_text()
        page.locator('.triage-claim-list > summary').click()
        page.locator('.triage-claim-select[data-claim-id="contradicted-demo"]').click()
        assert 'contradicts' in page.locator('.triage-claim-evidence').first.get_attribute('class'), 'Counterevidence should be encountered before context.'
        assert 'Does the caller pass a positive amount' in page.locator('.triage-claim-next').inner_text()
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        page.screenshot(path=str(output_prefix) + '-counterevidence.png', full_page=True)
        page.locator('.triage-claim-evidence').first.get_by_role('button', name='src/Demo.sol:13', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:inspectEvidence").evidence.source.line') == 13
        page.get_by_text('Edit statement explanation', exact=True).click()
        page.get_by_label('What the code does for this statement', exact=True).fill('Updated interpretation requiring re-review.')
        assert 'Not checked' in page.locator('.triage-active-claim-state').inner_text()
        page.get_by_text('Edit statement result', exact=True).click()
        page.get_by_label('Why this statement has this result', exact=True).fill('Pending a fresh check of the source.')
        assert 'Pending a fresh check' in page.locator('.triage-claim-reason').inner_text()
        page.locator('.triage-claim-list > summary').click()
        page.locator('.triage-claim-select[data-claim-id="counter-addition"]').click()
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        contrasts = {}
        for theme in ['vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light']:
            page.evaluate('theme=>{document.body.classList.remove("vscode-light","vscode-high-contrast","vscode-high-contrast-light");document.body.classList.add(theme);}', theme)
            ratio = page.locator('.card-title').first.evaluate('''node=>{
              const l=rgb=>{const a=rgb.match(/[\\d.]+/g).slice(0,3).map(x=>Number(x)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return a[0]*.2126+a[1]*.7152+a[2]*.0722;};
              const a=l(getComputedStyle(node).color),b=l(getComputedStyle(node.closest('.card-header')).backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
            }''')
            assert ratio >= 4.5, (theme, ratio)
            contrast = page.evaluate('''() => {
              const rgb = value => value.match(/[\\d.]+/g).slice(0,3).map(Number);
              const lum = values => values.map(x => x/255).map(x => x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((a,x,i)=>a+x*[.2126,.7152,.0722][i],0);
              const ratio = (a,b) => { const x=lum(rgb(a)),y=lum(rgb(b));return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
              const style=getComputedStyle(document.body), get=name=>style.getPropertyValue(name).trim();
              const values={reading:ratio(get('--fg'),get('--card-bg')),code:ratio(get('--triage-code-fg'),get('--bg')),notes:ratio(get('--triage-note-fg'),get('--triage-note-bg')),
                metadata:ratio(get('--triage-muted'),get('--triage-note-bg')),controls:ratio(get('--triage-control'),get('--card-bg')),selection:ratio(get('--triage-focus'),get('--triage-header'))};
              return values;
            }'''.replace('const rgb = value => value.match(/[\\d.]+/g).slice(0,3).map(Number);', '''const rgb = value => { const probe=document.createElement('span');probe.style.color=value;document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color.match(/[\\d.]+/g).slice(0,3).map(Number); };'''))
            for key, value in contrast.items():
                assert value >= (3 if key in ['controls', 'selection'] else 4.5), (theme, key, value)
            contrasts[theme] = contrast
            page.screenshot(path=str(output_prefix) + '-' + theme + '.png', full_page=True)
        page.set_viewport_size({'width': 640, 'height': 900})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        assert page.locator('.triage-claims').evaluate('node=>node.scrollWidth <= node.clientWidth')
        page.screenshot(path=str(output_prefix) + '-narrow.png', full_page=True)
        page.set_viewport_size({'width': 1366, 'height': 768})
        page.evaluate('document.body.classList.remove("vscode-light","vscode-high-contrast","vscode-high-contrast-light")')
        page.keyboard.press('Escape')
        camera = page.evaluate('() => snapshot().camera')
        page.mouse.move(1240, 670)
        page.mouse.wheel(0, 120)
        page.wait_for_timeout(100)
        assert page.evaluate('() => snapshot().camera.scale') < camera['scale'], 'Native wheel zoom remains available.'
        if page.evaluate('() => mode') != 'pan':
            page.locator('.triage-more > summary').click()
            page.locator('#mode-btn').click()
            page.locator('.triage-more > summary').click()
        camera = page.evaluate('() => snapshot().camera')
        page.mouse.move(1240, 670)
        page.mouse.down()
        page.mouse.move(1280, 690, steps=5)
        page.mouse.up()
        assert page.evaluate('() => snapshot().camera.panX') != camera['panX'], 'Native pan remains available.'
        page.keyboard.press('Alt+2')
        camera = page.evaluate('() => snapshot().camera')
        card_box = page.locator('.triage-selected-source').bounding_box()
        page.get_by_role('tab', name='Statements', exact=True).click()
        assert page.evaluate('() => snapshot().camera') == camera
        assert page.locator('.triage-selected-source').bounding_box()['x'] == card_box['x'], 'Ordinary tab changes must not move the code.'
        page.get_by_role('tab', name='Summary', exact=True).focus()
        page.keyboard.press('ArrowRight')
        assert page.get_by_role('tab', name='Functions', exact=True).get_attribute('aria-selected') == 'true'
        assert page.evaluate('document.activeElement.textContent') == 'Functions'
        # Deliberate layout stress fixture, not protocol evidence: long names,
        # exact repeated statements and an explanation near the function end.
        long_case = copy.deepcopy(message)
        card = long_case['state']['cards'][0]
        long_name = 'recordAnOrdinaryCounterUpdateWithAnIntentionallyLongFunctionNameForReading'
        long_path = 'src/fictional/layout/with/a/long/but/unambiguous/path/ReadableCounterWithALongFileName.sol'
        code = 'function ' + long_name + '(uint256 amount) external {\n' + '    counter += amount;\n' * 60 + '}'
        digest = hashlib.sha256(code.encode()).hexdigest()
        card.update({'name': long_name, 'file': long_path, 'code': code, 'startLine': 1, 'endLine': 62})
        note = {'id': 'long-note', 'stance': 'context', 'category': 'behavior', 'note': 'This is a fictional layout check. ' * 30,
                'source': {'file': long_path, 'line': 60, 'sourceHash': digest}}
        long_case.update({'issueId': 'layout-only', 'token': 'long-layout', 'state': {'cards': [card], 'edges': [], 'notes': []}, 'connections': [],
                         'hints': {card['id']: {**next(iter(message['hints'].values())), 'file': long_path, 'line': 1, 'endLine': 62, 'range': long_path + ':1–62', 'sourceHash': digest}},
                         'finding': {'title': 'Fictional layout check: long code and names', 'status': 'unreviewed', 'summary': 'This is a reading-layout fixture, not a security finding.',
                                     'triage': {'version': 1, 'checks': [], 'evidence': [note]}}})
        page.evaluate('data=>window.dispatchEvent(new MessageEvent("message",{data}))', long_case)
        page.locator('[data-reading-group="start"] button.primary').click()
        assert page.locator('.guide-preparation').is_visible()
        page.locator('.guide-preparation').get_by_role('button', name='Explore code', exact=True).click()
        page.locator('.triage-flow-item').filter(has_text=long_name).first.click()
        page.locator('.triage-note-links button').click()
        page.locator('.triage-inline-note').get_by_role('button', name='Read code', exact=True).click()
        assert page.locator('.code-line').count() == 62
        assert page.locator('.triage-claim-line').get_attribute('data-source-line') == '60'
        assert page.locator('.triage-reading-location').is_visible(), 'Function identity stays available when its header is above the viewport.'
        assert long_name in page.locator('.triage-reading-location').inner_text()
        page.locator('.triage-note-links button').click()
        assert page.locator('.triage-inline-note > p').first.text_content() == note['note']
        page.screenshot(path=str(output_prefix) + '-long-code.png', full_page=True)
        assert not errors, errors
        print(json.dumps({'result': 'passed', 'evidence_top_at_1366x768': dimensions['y'], 'expanded_explanations_height': story_height, 'contrast': contrasts, 'screenshots_prefix': str(output_prefix), 'scenarios': ['four initial-screen widths', 'primary exact-line reading action', 'continuous code', 'note toggle preserves camera', 'separate issue and statement targets', 'selected claim restored after switching', 'unresolved specification', 'counterevidence before context', 'exact-source request', 'conservative edit reset', 'four host theme classes', 'narrow reading layout']}))
        browser.close()
finally:
    server.shutdown()
    server.server_close()
