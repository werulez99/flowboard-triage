#!/usr/bin/env python3
"""Real native Flowboard + triage overlay browser test, using fictional data.

Requires Python Playwright/Chromium and FLOWBOARD_EXTENSION_PATH (pinned 1.2.0).
The HTTP server exposes only whitelisted webview assets on localhost.
"""
import argparse
import copy
import hashlib
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
upstream = Path(os.environ['FLOWBOARD_EXTENSION_PATH'])
fixture = {}

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlparse(self.path).path
        if route == '/':
            body, kind = fixture['html'].encode(), 'text/html'
        elif route in ['/native/flowboard.js', '/tool/triage.js', '/tool/report-view.js', '/tool/review-model.js', '/tool/inline-review.js', '/tool/claim-model.js', '/tool/claim-view.js', '/tool/investigation-view.js', '/tool/reading-model.js', '/tool/walkthrough-model.js']:
            folder = upstream / 'webview' if route.startswith('/native/') else root / 'extension/webview'
            body, kind = (folder / Path(route).name).read_bytes(), 'text/javascript'
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
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with sync_playwright() as playwright:
        launch = {'headless': True}
        if os.environ.get('FLOWBOARD_CHROMIUM_PATH'):
            launch['executable_path'] = os.environ['FLOWBOARD_CHROMIUM_PATH']
        browser = playwright.chromium.launch(**launch)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        def more_action(label):
            page.locator('.triage-more > summary').click()
            page.locator('.triage-more-menu').get_by_role('button', name=label, exact=True).click()
            page.locator('.triage-more').evaluate('node=>node.open=false')

        def inspect_function(last=False):
            page.get_by_role('tab', name='Functions', exact=True).click()
            items = page.locator('.triage-flow-item')
            (items.last if last else items.first).click()

        def view_shortcut(key):
            page.locator('#triage-title').click()
            page.keyboard.press(key)

        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script('window.sent=[]; window.acquireVsCodeApi=()=>({postMessage:message=>window.sent.push(message)});')
        page.goto(origin)
        page.wait_for_function('window.sent.some(x=>x.type==="triage:ready")')
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', {'type': 'restore', 'state': None})
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', fixture['message'])
        assert page.locator('.card').count() == 2
        assert page.locator('.edge-line').count() == 1
        assert page.locator('.triage-card-info').count() == 2
        assert page.locator('.triage-line-number').count() == 6
        assert page.locator('.triage-explanations').count() == 2
        contrast = page.locator('.card-title').first.evaluate('''node=>{
          const luminance=rgb=>{const values=rgb.match(/[\\d.]+/g).slice(0,3).map(x=>Number(x)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return values[0]*.2126+values[1]*.7152+values[2]*.0722;};
          const a=luminance(getComputedStyle(node).color),b=luminance(getComputedStyle(node.closest('.card-header')).backgroundColor);
          return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        }''')
        assert contrast >= 4.5, f'Function names need readable contrast: {contrast}'
        assert page.evaluate('window.sent.some(x=>x.type==="triage:rendered" && x.token==="browser-demo-1")')
        assert page.locator('.triage-drawer').is_visible()
        assert page.locator('.triage-overview').is_visible(), 'A finding opens in the compact overview without a form.'
        assert page.locator('.triage-drawer textarea').count() == 0
        assert 'may have a different cause' in page.locator('.triage-drawer').inner_text()
        assert not page.locator('.triage-source-details').evaluate('node=>node.open')
        inspect_function()
        assert 'Demo::increment' in page.locator('#triage-inspector').inner_text()
        page.locator('#triage-inspector .triage-neighbor').first.click()
        assert 'Demo::_add' in page.locator('#triage-inspector').inner_text()
        page.get_by_role('button', name='Back', exact=True).click()
        assert 'Demo::increment' in page.locator('#triage-inspector').inner_text()
        page.get_by_role('button', name='Forward', exact=True).click()
        page.get_by_role('button', name='Focus neighborhood', exact=True).click()
        assert page.locator('.triage-selected-source').count() == 1
        page.get_by_role('button', name='Show all cards', exact=True).click()
        page.get_by_role('button', name='Copy function prompt', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:prompt").cardId.endsWith(":update")')
        page.get_by_role('separator', name='Resize review panel').focus()
        page.keyboard.press('ArrowRight')
        assert page.locator('.triage-drawer').bounding_box()['width'] == 404
        page.get_by_role('separator', name='Resize review panel').dblclick()
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        page.get_by_role('button', name='All functions', exact=True).click()
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-overview.png')), full_page=True)
        page.keyboard.press('Alt+4')
        assert page.locator('.triage-comparison textarea').count() == 2
        assert page.locator('.triage-checkpoint').count() == 6
        assert 'Still unchecked' in page.locator('#triage-readiness').inner_text()
        page.locator('#triage-field-actualBehavior').fill('increment delegates to _add; _add adds amount to the counter in this fictional demo.')
        page.locator('#triage-field-actor').fill('The demo allows ordinary public counter updates; the fictional specification intends this access.')
        page.locator('#triage-field-status').select_option('invalid')
        page.get_by_text('Existing / additional evidence references', exact=True).click()
        page.locator('#triage-field-evidence').fill('src/Demo.sol:8 — intended public update\nSpecification: fictional demo behavior')
        page.locator('#triage-field-decisionReason').fill('The fictional specification intends this normal counter update; no deviation is established.')
        inspect_function(last=True)
        page.locator('#triage-inspector').get_by_role('button', name='Add code note', exact=True).click()
        page.get_by_label('Inline note category', exact=True).select_option('behavior')
        page.locator('#triage-evidence-stance').select_option('contradicts')
        page.locator('#triage-evidence-line').fill('13')
        page.locator('#triage-evidence-note').fill('The helper applies the normal update, consistent with the fictional specification.')
        page.get_by_role('button', name='Add evidence', exact=True).click()
        pending = page.evaluate('window.sent.findLast(x=>x.type==="triage:bindEvidence")')
        assert pending['evidence']['source']['file'] == 'src/Demo.sol' and pending['evidence']['source']['line'] == 13
        assert page.get_by_role('button', name='Save review', exact=True).is_disabled()
        bound = dict(pending['evidence'])
        bound['source'] = {**bound['source'], 'sourceHash': hashlib.sha256((root / 'examples/project/src/Demo.sol').read_bytes()).hexdigest()}
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))',
                      {'type': 'triage:evidenceBound', 'issueId': pending['issueId'], 'token': pending['token'], 'evidence': bound})
        assert page.locator('.triage-evidence-entry.contradicts').count() == 1
        assert page.locator('.triage-note-relation.contradicts').count() == 1
        assert page.locator('.triage-inline-note').count() == 1
        assert page.locator('.card-code .triage-inline-note').count() == 0
        assert 'counter += amount' in page.locator('.code-line[data-source-line="13"]').inner_text()
        assert 'Against issue I-01' in page.locator('.triage-note-relation').text_content()
        page.locator('.triage-note-links button').click()
        page.locator('.triage-inline-note > summary').click()
        page.wait_for_function('!document.querySelector(".triage-inline-note").open')
        more_action('Hide code notes')
        assert page.locator('.triage-inline-note').count() == 0
        more_action('Show code notes')
        assert page.locator('.triage-inline-note').count() == 1
        assert not page.locator('.triage-inline-note').evaluate('node=>node.open'), 'Notes toggle preserves disclosure state.'
        assert '1 contradicting' in page.locator('#triage-readiness').inner_text()
        page.locator('.triage-evidence-entry').get_by_role('button', name='Edit note', exact=True).click()
        page.get_by_label('Edit evidence explanation', exact=True).fill('The helper applies the normal update; reviewed against the fictional specification.')
        page.get_by_role('button', name='Done', exact=True).click()
        page.get_by_label('Filter evidence', exact=True).select_option('supports')
        assert page.locator('.triage-evidence-entry').count() == 0
        page.get_by_label('Filter evidence', exact=True).select_option('all')
        assert 'reviewed against' in page.locator('.triage-evidence-note').inner_text()
        assert 'reviewed against' in page.locator('.triage-inline-note > p').first.text_content()
        assert not page.locator('.triage-inline-note').evaluate('node=>node.open'), 'Editing a note does not force it open.'
        page.locator('.triage-inline-note > summary').click()
        page.locator('.triage-evidence-reference').click()
        inspect = page.evaluate('window.sent.findLast(x=>x.type==="triage:inspectEvidence")')
        assert inspect['evidence']['source']['sourceHash'] == bound['source']['sourceHash']
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))',
                      {'type': 'triage:evidenceInspected', 'issueId': inspect['issueId'], 'token': inspect['token'], 'evidence': bound,
                       'excerpt': '12  function _add(uint256 amount) internal {\n13    counter += amount;\n14  }'})
        assert '13    counter += amount' in page.locator('.triage-evidence-preview pre').inner_text()
        assert page.locator('.card.triage-evidence-focus').count() == 1
        page.get_by_role('button', name='Copy review brief', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:copyBrief").patch.triage.evidence.length===1')
        page.locator('.triage-checkpoint').filter(has_text='Why the report may be incorrect').locator('summary').click()
        page.get_by_label('Why the report may be incorrect review state', exact=True).select_option('checked')
        page.get_by_label('Why the report may be incorrect reasoning', exact=True).fill('Compared the normal update with the fictional specification.')
        # Changing tabs must not reset unsaved review text/status.
        view_shortcut('Alt+5')
        assert 'Fictional review' in page.locator('.triage-report').inner_text()
        assert page.locator('.triage-report h4').count() >= 4
        assert page.locator('.triage-report ol li').count() == 2
        assert page.locator('.triage-report pre code').inner_text() == 'increment(amount);\n// Inspect the normal internal update, not an attack.'
        assert page.locator('.triage-report table tr').count() == 3
        assert page.locator('.triage-report img, .triage-report script, .triage-report a').count() == 0
        assert page.evaluate('window.reportInjected !== true')
        assert page.locator('.triage-report').evaluate('node=>parseFloat(getComputedStyle(node).fontSize)>=14')
        assert page.locator('.triage-drawer').bounding_box()['width'] >= 360
        page.locator('.triage-source-reference').first.click()
        reference = page.evaluate('window.sent.findLast(x=>x.type==="triage:openReference")')
        assert reference['file'] == 'src/Demo.sol' and reference['line'] == 8
        page.get_by_role('button', name='Copy original', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:copyReport").issueId==="I-01"')
        page.get_by_role('button', name='Raw text', exact=True).click()
        assert page.locator('.triage-report-raw').inner_text() == fixture['message']['reportText']
        page.get_by_role('button', name='Reading view', exact=True).click()
        # Refresh is explicit and cannot discard unsaved review work silently.
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.locator('.triage-source-details > summary').click()
        page.get_by_role('button', name='Refresh code', exact=True).click()
        assert not page.evaluate('window.sent.some(x=>x.type==="triage:refresh")')
        page.once('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='Refresh code', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:refresh").token==="browser-demo-1"')
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-report.png')), full_page=True)
        page.locator('.triage-tabs').get_by_role('tab', name='Functions', exact=True).click()
        assert page.locator('.triage-flow-item').count() == 2
        assert page.locator('.triage-flow-link').count() == 1
        assert '2 source cards checked' in page.locator('.triage-validation').inner_text()
        assert page.locator('.triage-flow-item .triage-mapping').count() == 2
        page.get_by_label('Search mapped functions').fill('_add')
        assert page.locator('.triage-flow-item').count() == 1
        page.get_by_label('Search mapped functions').fill('')
        page.locator('.triage-flow-item').last.click()
        page.keyboard.press('Alt+4')
        assert page.locator('#triage-field-status').input_value() == 'invalid'
        assert 'fictional demo behavior' in page.locator('#triage-field-evidence').input_value()
        assert page.locator('.triage-evidence-entry.contradicts').count() == 1
        assert page.get_by_label('Why the report may be incorrect review state', exact=True).input_value() == 'checked'
        # Cancelling a switch preserves unsaved input and keeps this finding.
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.locator('#triage-bar').get_by_role('button', name='Next finding', exact=True).click()
        assert not page.evaluate('window.sent.some(x=>x.type==="triage:select")')
        page.once('dialog', lambda dialog: dialog.accept())
        page.keyboard.press('Control+s')
        saved = page.evaluate('window.sent.findLast(x=>x.type==="triage:save")')
        assert saved['issueId'] == 'I-01' and saved['patch']['status'] == 'invalid'
        assert len(saved['patch']['evidence']) == 2
        assert saved['patch']['triage']['evidence'][0]['stance'] == 'contradicts'
        assert saved['patch']['triage']['evidence'][0]['source']['sourceHash'] == bound['source']['sourceHash'], 'Editing the evidence explanation preserves its source binding.'
        page.locator('#triage-field-impact').fill('An edit typed while the previous save was pending')
        page.locator('#triage-field-decisionReason').fill('New reasoning typed while the previous save was pending')
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))',
                      {'type': 'triage:reviewSaved', 'issueId': saved['issueId'], 'token': saved['token'], 'editVersion': saved['editVersion'],
                       'finding': {**fixture['message']['finding'], **saved['patch']}, 'library': fixture['message']['library']})
        assert 'save was pending' in page.locator('#triage-field-impact').input_value()
        assert 'save was pending' in page.locator('#triage-field-decisionReason').input_value()
        assert 'unsaved' in page.locator('#triage-status').inner_text()
        # The original native Undo must persist its resulting state, not just
        # the preceding Clear snapshot (upstream posts an untagged Undo message).
        more_action('Clear')
        page.wait_for_timeout(500)
        assert page.locator('.card').count() == 0
        page.locator('#undo-btn').click()
        assert page.locator('.card').count() == 2
        assert page.locator('.triage-note-relation.contradicts').count() == 1
        assert page.locator('.triage-inline-note').count() == 1, 'Native Undo recreates the inline notes with the checked source line.'
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:persist").state.cards.length==2')
        page.get_by_role('button', name='All functions', exact=True).click()
        more_action('Arrange functions')
        positions = page.locator('.card').evaluate_all('nodes=>nodes.map(node=>({left:node.offsetLeft,width:node.offsetWidth}))')
        assert positions[0]['left'] + positions[0]['width'] < positions[1]['left']
        page.locator('.triage-note-links button').click()
        assert page.locator('.card-code .triage-inline-note').count() == 0
        assert page.locator('.triage-inline-note').count() == 1
        page.locator('.triage-inline-note').get_by_role('button', name='Open in editor', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:inspectEvidence").evidence.source.line') == 13
        page.wait_for_function('''() => {
          const card=[...document.querySelectorAll('.card')][1];
          const numbers=document.querySelector('.edge-line').getAttribute('d').match(/-?[\\d.]+/g).map(Number);
          return Math.abs(numbers.at(-1) - (card.offsetTop + card.offsetHeight/2)) < 1;
        }''')
        page.get_by_role('button', name='All functions', exact=True).click()
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-inline.png')), full_page=True)
        page.keyboard.press('Escape')
        page.get_by_role('button', name='All functions', exact=True).click()
        bounds = page.evaluate('''() => ({cards:[...document.querySelectorAll('.card')].map(node=>({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})),scroll:flowboard.scrollLeft,panX,scale})''')
        assert all(card['left'] >= 0 and card['right'] <= 1440 for card in bounds['cards']), bounds
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-inline-canvas.png')), full_page=True)
        page.keyboard.press('Alt+4')
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        page.screenshot(path=args.output, full_page=True)
        page.locator('.triage-drawer').evaluate('node=>{const target=document.querySelector(".triage-evidence-ledger");node.scrollTop+=target.getBoundingClientRect().top-node.getBoundingClientRect().top-75;}')
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-evidence.png')), full_page=True)
        page.once('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='Save review', exact=True).click()
        final_save = page.evaluate('window.sent.findLast(x=>x.type==="triage:save")')
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))',
                      {'type': 'triage:reviewSaved', 'issueId': final_save['issueId'], 'token': final_save['token'], 'editVersion': final_save['editVersion'],
                       'finding': {**fixture['message']['finding'], **final_save['patch']}, 'library': fixture['message']['library']})
        assert 'unsaved' not in page.locator('.triage-inline-note > summary').inner_text().lower(), 'Save acknowledgment removes stale unsaved labels.'
        # A switch snapshots the previous finding, replaces rather than appends,
        # and resets undo so one issue cannot restore another issue's nodes.
        second = dict(fixture['message'])
        second.update({'issueId': 'I-02', 'token': 'browser-demo-2', 'finding': {'title': 'Second fixture', 'status': 'unreviewed'},
                       'state': {'cards': [fixture['message']['state']['cards'][1]], 'edges': [], 'notes': [], 'camera': {'scale': 1, 'panX': 0, 'panY': 0}}, 'connections': []})
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', second)
        assert page.locator('.card').count() == 1
        assert page.locator('.triage-evidence-badge').count() == 0
        assert page.locator('#undo-btn').is_disabled()
        assert page.evaluate('window.sent.some(x=>x.type==="triage:persist" && x.issueId==="I-01" && x.token==="browser-demo-1")')
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))',
                      {'type': 'triage:evidenceBound', 'issueId': 'I-01', 'token': 'browser-demo-1', 'evidence': bound})
        assert page.locator('.triage-evidence-badge').count() == 0, 'Late old evidence cannot leak into a different finding.'
        page.locator('#triage-bar').get_by_role('button', name='Findings', exact=True).click()
        page.get_by_label('Search findings').fill('different')
        assert page.locator('.triage-list button').count() == 1
        page.get_by_label('Finding queue filter').select_option('confirmed')
        assert 'No matching findings' in page.locator('.triage-list').inner_text()
        page.get_by_label('Finding queue filter').select_option('all')
        more_action('Copy AI prompt')
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:prompt").issueId==="I-02"')
        page.set_viewport_size({'width': 640, 'height': 900})
        view_shortcut('Alt+5')
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-narrow.png')), full_page=True)
        page.keyboard.press('Escape')
        assert not page.locator('.triage-drawer').is_visible()
        page.keyboard.press('Alt+2')
        assert page.locator('.triage-overview').is_visible()
        unmapped = dict(second)
        unmapped.update({'issueId': 'I-03', 'token': 'unmapped-demo', 'readOnly': True,
                         'state': {'cards': [], 'edges': [], 'notes': []}, 'hints': {},
                         'warnings': ['No source match for the fictional report.'], 'unresolved': [{'file': 'Missing.sol', 'line': 5, 'reason': 'Not found'}]})
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', unmapped)
        assert 'No matching code was found' in page.locator('[data-reading-group="start"]').inner_text()
        assert page.locator('[data-reading-group="start"] button.primary').is_disabled()
        page.locator('.triage-drawer').get_by_role('button', name='Read report', exact=True).click()
        assert page.locator('.triage-report').is_visible()
        assert page.locator('.card').count() == 0
        page.locator('.triage-source-details > summary').click()
        assert 'No source match' in page.locator('.triage-source-details').inner_text()
        # Rendering-only synthetic fixture: original coordinates must survive
        # hidden comments, duplicate statements, markup and missing map coverage.
        synthetic = copy.deepcopy(fixture['message'])
        card = synthetic['state']['cards'][0]
        card.update({'code': 'function increment(uint256 amount) external {\n// hidden comment\ncounter += amount;\n// second comment\ncounter += amount;\n}', 'startLine': 10, 'endLine': 15})
        source_hash = 'e' * 64
        synthetic.update({'issueId': 'synthetic', 'token': 'placement-fixture', 'connections': [],
                          'state': {'cards': [card], 'edges': [], 'notes': []},
                          'hints': {card['id']: {**synthetic['hints'][card['id']], 'line': 10, 'endLine': 15, 'sourceHash': source_hash}}})
        def observation(identity, line, digest=source_hash):
            return {'id': identity, 'stance': 'context', 'note': '<img src=x onerror="window.noteInjected=true"> Plain reviewer text.',
                    'source': {'file': 'src/Demo.sol', 'line': line, 'sourceHash': digest}}
        synthetic['finding'] = {'title': 'Synthetic line-mapping review', 'status': 'unreviewed', 'triage': {'version': 1, 'checks': [],
                                'evidence': [observation('hidden', 11), observation('second-statement', 14), observation('outside', 99), observation('old-hash', 12, 'f' * 64)]}}
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', synthetic)
        assert page.locator('.triage-inline-note').count() == 2
        assert page.locator('[data-evidence-id="hidden"] .triage-inline-unplaced').count() == 1
        assert page.locator('[data-evidence-id="second-statement"] > summary').text_content().startswith('L14')
        assert page.locator('.code-line[data-source-line="14"] .triage-note-marker').count() == 1
        assert page.locator('.triage-inline-note img').count() == 0
        assert not page.evaluate('!!window.noteInjected')
        page.keyboard.press('Alt+4')
        assert page.locator('.triage-placement-warning').count() == 2
        # A renderer/code disagreement must fail closed, never shift notes.
        page.evaluate('''() => { const card=[...cards.values()][0];card.clean+=String.fromCharCode(10);renderCodeBody(card);redrawEdges(); }''')
        assert page.locator('.triage-note-marker,.triage-line-number').count() == 0
        assert page.locator('.card-code .triage-inline-note').count() == 0
        assert 'These lines cannot be shown here' in page.locator('.triage-explanation-body > .triage-inline-unplaced').text_content()
        # Claim-level argument: checked line binding is separate from meaning.
        claim_fixture = copy.deepcopy(fixture['message'])
        claim_fixture.update({'issueId': 'claims-demo', 'token': 'claims-session', 'draftFingerprint': 'claims-draft-one'})
        claim_fixture['finding'] = {**claim_fixture['finding'], 'status': 'insufficient-evidence',
            'expectedBehavior': 'The fictional counter accepts ordinary additions.',
            'triage': {'version': 1, 'checks': [], 'ruleOrigin': {'kind': 'specification', 'reference': 'Fictional demo specification'},
                'evidence': [bound], 'claims': [
                    {'id': 'addition', 'text': 'The helper adds amount to the counter.', 'state': 'supported',
                     'observed': 'The helper writes counter += amount.', 'conditions': 'Normal internal call with amount.',
                     'consequence': 'An ordinary counter update; no defect established.', 'reason': 'The statement matches the fictional source.',
                     'evidence': [{'evidenceId': bound['id'], 'stance': 'supports', 'reason': 'This exact addition establishes the narrow source claim.'}], 'questions': []},
                    {'id': 'unmapped', 'text': 'A separate claim with no source binding.', 'state': 'unreviewed', 'evidence': [], 'questions': []}
                ]}}
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', claim_fixture)
        page.locator('.triage-tabs').get_by_role('tab', name='Statements', exact=True).click()
        page.locator('.triage-claim-select[data-claim-id="addition"]').click()
        assert page.get_by_label('Report statement', exact=True).input_value() == 'The helper adds amount to the counter.'
        assert page.locator('.triage-claim-line').count() == 1
        assert page.locator('.triage-claim-line').get_attribute('data-source-line') == '13'
        assert 78 < page.locator('.triage-claim-line').bounding_box()['y'] < 300, 'Source focus targets the line, not the center of a potentially long function.'
        assert page.locator('.card.triage-dimmed').count() == 1
        page.locator('.triage-selected-source .triage-note-links button').click()
        assert 'Supports statement addition' in page.locator('.triage-inline-note').inner_text()
        assert 'Against issue claims-demo' in page.locator('.triage-inline-note').inner_text()
        assert 'This exact addition' in page.locator('.triage-claim-relevance').inner_text(), 'Reasoning is readable in Claims, not duplicated under the code.'
        page.locator('.triage-claim-evidence').get_by_role('button', name='src/Demo.sol:13', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:inspectEvidence").evidence.source.line') == 13
        page.get_by_role('button', name='Copy review brief', exact=True).click()
        copied = page.evaluate('window.sent.findLast(x=>x.type==="triage:copyBrief")')
        assert copied['patch']['triage']['claims'][0]['state'] == 'supported'
        assert copied['patch']['triage']['evidence'][0]['stance'] == 'contradicts', 'Claim stance does not rewrite the overall evidence stance.'
        page.locator('#triage-bar').get_by_role('button', name='All functions', exact=True).click()
        assert page.locator('.card.triage-dimmed').count() == 0
        page.locator('.triage-claim-source-actions').get_by_role('button', name='Read code', exact=True).click()
        more_action('Arrange functions')
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        page.get_by_role('button', name='All functions', exact=True).click()
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-claims.png')), full_page=True)
        page.get_by_text('Edit statement explanation', exact=True).click()
        page.get_by_label('What the code does for this statement', exact=True).fill('Updated explanation of the ordinary addition.')
        assert page.get_by_label('Statement review result', exact=True).input_value() == 'unreviewed'
        assert 'Not checked' in page.locator('.triage-claim-select[data-claim-id="addition"] small').text_content()
        page.keyboard.press('Control+s')
        claim_save = page.evaluate('window.sent.findLast(x=>x.type==="triage:save")')
        assert claim_save['issueId'] == 'claims-demo' and claim_save['patch']['triage']['claims'][0]['state'] == 'unreviewed'
        page.get_by_text('Edit statement result', exact=True).click()
        page.get_by_label('Why this statement has this result', exact=True).fill('A newer reason typed while the save was pending.')
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))',
                      {'type': 'triage:reviewSaved', 'issueId': claim_save['issueId'], 'token': claim_save['token'], 'editVersion': claim_save['editVersion'],
                       'finding': {**claim_fixture['finding'], **claim_save['patch']}, 'library': claim_fixture['library']})
        assert 'newer reason' in page.get_by_label('Why this statement has this result', exact=True).input_value()
        page.locator('.triage-claim-list > summary').click()
        page.locator('.triage-claim-select[data-claim-id="unmapped"]').click()
        assert page.locator('.triage-claim-line').count() == 0, 'Unmapped prose cannot borrow another claim source highlight.'
        assert page.locator('.triage-card-story').count() == 0, 'An unbound claim must not attach its story to the previously selected function.'
        assert 'No code note is linked' in page.locator('.triage-claim-detail').inner_text()
        view_shortcut('Alt+5')
        page.locator('.triage-report p').filter(has_text='The public').evaluate('''node=>{
          const range=document.createRange();range.selectNodeContents(node);
          const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
          node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
        }''')
        page.get_by_role('button', name='Review selected text', exact=True).click()
        assert 'The public' in page.get_by_label('Report statement', exact=True).input_value()
        assert page.get_by_label('Statement review result', exact=True).input_value() == 'unreviewed'
        assert page.locator('.triage-claim-line').count() == 0
        assert page.locator('.triage-claim-select').count() == 3
        page.get_by_text('Add or link evidence', exact=True).click()
        page.get_by_role('button', name='Link selected evidence as context', exact=True).click()
        assert page.locator('.triage-claim-evidence.context').count() == 1
        assert page.get_by_label('Statement review result', exact=True).input_value() == 'unreviewed'
        page.set_viewport_size({'width': 640, 'height': 900})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        assert page.locator('.triage-claims').evaluate('node=>node.scrollWidth <= node.clientWidth')
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-claims-narrow.png')), full_page=True)
        # Historical/off-map evidence and markup must not turn into source proof.
        stale_claim = copy.deepcopy(claim_fixture)
        stale_claim['token'] = 'claim-stale-session'
        stale_claim['draftFingerprint'] = 'claims-draft-two'
        stale_claim['finding']['triage']['evidence'][0]['source']['sourceHash'] = 'f' * 64
        stale_claim['finding']['triage']['claims'][0]['text'] = '<img src=x onerror="window.claimInjected=true"> Source review only.'
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', stale_claim)
        page.locator('.triage-tabs').get_by_role('tab', name='Statements', exact=True).click()
        page.locator('.triage-claim-select[data-claim-id="addition"]').click()
        assert page.locator('.triage-claim-line,.triage-inline-note').count() == 0
        assert page.locator('.triage-card-story').count() == 0
        assert 'Code has changed. Check this note again.' in page.locator('.triage-claim-evidence').inner_text()
        assert page.locator('.triage-claims img').count() == 0 and not page.evaluate('!!window.claimInjected')
        stale_claim.update({'token': 'claim-readonly-session', 'readOnly': True})
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', stale_claim)
        page.locator('.triage-tabs').get_by_role('tab', name='Statements', exact=True).click()
        assert page.get_by_role('button', name='Add statement', exact=True, include_hidden=True).is_disabled()
        assert page.get_by_role('button', name='Save review', exact=True).is_disabled()
        span_fixture = copy.deepcopy(fixture['message'])
        span_fixture.update({'issueId': 'span-demo', 'token': 'span-session', 'draftFingerprint': 'span-draft'})
        span_entry = {**bound, 'source': {**bound['source'], 'line': 12, 'endLine': 14}}
        span_fixture['finding']['triage'] = {'version': 1, 'checks': [], 'evidence': [span_entry]}
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', span_fixture)
        assert page.locator('.triage-inline-note').count() == 1
        assert page.locator('.card-code .triage-inline-note').count() == 0
        page.locator('[data-reading-group="start"] button.primary').click()
        assert page.locator('.guide-preparation').is_visible(), 'Read code cannot invent a checked guide for this manual-only fixture.'
        page.locator('.guide-preparation').get_by_role('button', name='Close status', exact=True).click()
        page.get_by_role('button', name='Close review panel', exact=True).click()
        page.get_by_role('button', name='All functions', exact=True).click()
        page.locator('.triage-note-links button').click()
        assert page.locator('.triage-claim-line').count() == 3
        assert 'L12–14' in page.locator('.triage-inline-note > summary').text_content()
        # Optional upstream AI comments must not return between code lines.
        page.evaluate('''() => { const card=[...cards.values()][1];card.data.showAnnotations=true;card.data.summary='Fictional AI summary, not evidence.';card.data.annotations=[{line:2,comment:'Fictional explanation of the addition.'}];renderCodeBody(card);redrawEdges(); }''')
        assert page.locator('.card-code .ai-comment').count() == 0
        assert page.locator('.ai-summary:visible').count() == 0
        assert 'AI explanation · not checked' in page.locator('.triage-native-commentary').text_content()
        assert page.locator('.triage-native-commentary button').text_content() == 'src/Demo.sol:13'
        # A same-draft reload may race the last native layout autosave. Preserve
        # local position/notes, but never replace host source with local data.
        page.evaluate('''() => {
          const card = cards.values().next().value;
          card.x = 431; card.y = 219; card.data.code = 'UNTRUSTED LOCAL CACHE TEXT';
          addNote({id:'local-reading-note', x:70, y:80, html:'Keep my current reading note.'});
        }''')
        span_fixture['token'] = 'span-reload-session'
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', span_fixture)
        assert page.evaluate('() => cards.values().next().value.x') == 431
        assert page.evaluate('() => cards.values().next().value.y') == 219
        assert 'UNTRUSTED LOCAL' not in page.locator('.card-code').first.inner_text()
        assert page.evaluate('() => notes.get("local-reading-note").textEl.textContent') == 'Keep my current reading note.'
        page.set_viewport_size({'width': 1366, 'height': 768})
        historical = copy.deepcopy(span_fixture)
        historical.update({'issueId': 'historical-context-demo', 'token': 'historical-context-session',
                           'readOnly': True, 'sourceStale': True, 'historicalAssessment': {'status': 'invalid'}})
        historical['finding']['triage']['evidence'][0]['needsReview'] = True
        page.evaluate('message=>window.dispatchEvent(new MessageEvent("message",{data:message}))', historical)
        assert 'Historical saved assessment' in page.locator('.triage-drawer').inner_text()
        assert 'Code or settings changed' in page.locator('.triage-drawer').inner_text()
        assert page.locator('.triage-inline-note').count() == 0, 'A historical judgment cannot paint evidence onto fresh code as current.'
        assert page.locator('.card').first.get_by_role('button', name='Add code note', exact=True, include_hidden=True).is_disabled()
        inspect_function()
        assert page.get_by_role('button', name='Open in editor', exact=True).is_enabled(), 'Re-review must retain access to freshly indexed source.'
        page.keyboard.press('Alt+4')
        assert page.get_by_role('button', name='Save review', exact=True).is_disabled()
        page.set_viewport_size({'width': 640, 'height': 768})
        page.get_by_role('button', name='Close review panel', exact=True).click()
        status_box = page.locator('#triage-status').bounding_box()
        assert status_box and status_box['x'] >= 0 and status_box['x'] + status_box['width'] <= 640, 'Historical-source warning must stay visible on a narrow canvas with its panel closed.'
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-historical-narrow.png')), full_page=True)
        assert not errors, errors
        browser.close()
finally:
    server.shutdown()
    server.server_close()
print('Native visual smoke passed: claim selection and exact-line focus; independent claim/evidence stances; report selection; conservative claim reset; claim save races; narrow claim layout; exact-line notes; hidden comments/repeated statements; fail-closed mapping; plain-text rendering; placement diagnostics; retained disclosure state; navigable review story; measured arrangement and Fit bounds; function roles; overview/inspector/navigation; filters; preserved hashes; keyboard/save acknowledgments; pending-edit and session isolation; native Undo; report/source links; narrow layout.')
