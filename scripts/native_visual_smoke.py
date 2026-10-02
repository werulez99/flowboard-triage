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
        elif route in ['/native/flowboard.js', '/tool/triage.js', '/tool/report-view.js', '/tool/review-model.js', '/tool/inline-review.js']:
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
        assert page.locator('.triage-card-role').count() == 2
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
        assert 'Shared anchors/files' in page.locator('.triage-drawer').inner_text()
        assert not page.locator('.triage-source-details').evaluate('node=>node.open')
        page.locator('.card').first.get_by_role('button', name='Inspect', exact=True).click()
        assert 'Demo::increment' in page.locator('#triage-inspector').inner_text()
        page.locator('#triage-inspector .triage-neighbor').first.click()
        assert 'Demo::_add' in page.locator('#triage-inspector').inner_text()
        page.get_by_role('button', name='Back', exact=True).click()
        assert 'Demo::increment' in page.locator('#triage-inspector').inner_text()
        page.get_by_role('button', name='Forward', exact=True).click()
        page.get_by_role('button', name='Focus neighborhood', exact=True).click()
        assert page.locator('.triage-selected-source').count() == 1
        page.get_by_role('button', name='Show all cards', exact=True).click()
        page.get_by_role('button', name='Ask AI about function', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:prompt").cardId.endsWith(":update")')
        page.get_by_role('separator', name='Resize review panel').focus()
        page.keyboard.press('ArrowRight')
        assert page.locator('.triage-drawer').bounding_box()['width'] == 404
        page.get_by_role('separator', name='Resize review panel').dblclick()
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        page.get_by_role('button', name='Fit', exact=True).click()
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-overview.png')), full_page=True)
        page.locator('.triage-tabs').get_by_role('tab', name='Review', exact=True).click()
        assert page.locator('.triage-comparison textarea').count() == 2
        assert page.locator('.triage-checkpoint').count() == 6
        assert 'Still unchecked' in page.locator('#triage-readiness').inner_text()
        page.locator('#triage-field-actualBehavior').fill('increment delegates to _add; _add adds amount to the counter in this fictional demo.')
        page.locator('#triage-field-actor').fill('The demo allows ordinary public counter updates; the fictional specification intends this access.')
        page.locator('#triage-field-status').select_option('invalid')
        page.get_by_text('Existing / additional evidence references', exact=True).click()
        page.locator('#triage-field-evidence').fill('src/Demo.sol:8 — intended public update\nSpecification: fictional demo behavior')
        page.locator('#triage-field-decisionReason').fill('The fictional specification intends this normal counter update; no deviation is established.')
        page.locator('.card').last.get_by_role('button', name='+ Evidence', exact=True).click()
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
        assert page.locator('.triage-evidence-badge.contradicts').count() == 1
        assert page.locator('.triage-inline-note').count() == 1
        assert page.locator('.triage-inline-note').evaluate('node=>node.previousElementSibling.dataset.sourceLine') == '13'
        assert 'counter += amount' in page.locator('.code-line[data-source-line="13"]').inner_text()
        assert 'contradicts claim' in page.locator('.triage-inline-note summary').inner_text().lower()
        page.locator('.triage-inline-note summary').click()
        page.wait_for_function('!document.querySelector(".triage-inline-note").open')
        page.get_by_role('button', name='Notes on', exact=True).click()
        assert page.locator('.triage-inline-note').count() == 0
        page.get_by_role('button', name='Notes off', exact=True).click()
        assert page.locator('.triage-inline-note').count() == 1
        assert not page.locator('.triage-inline-note').evaluate('node=>node.open'), 'Notes toggle preserves disclosure state.'
        assert '1 contradicting' in page.locator('#triage-readiness').inner_text()
        page.get_by_role('button', name='Edit note', exact=True).click()
        page.get_by_label('Edit evidence explanation', exact=True).fill('The helper applies the normal update; reviewed against the fictional specification.')
        page.get_by_role('button', name='Done', exact=True).click()
        page.get_by_label('Filter evidence', exact=True).select_option('supports')
        assert page.locator('.triage-evidence-entry').count() == 0
        page.get_by_label('Filter evidence', exact=True).select_option('all')
        assert 'reviewed against' in page.locator('.triage-evidence-note').inner_text()
        assert 'reviewed against' in page.locator('.triage-inline-note p').text_content()
        assert not page.locator('.triage-inline-note').evaluate('node=>node.open'), 'Editing a note does not force it open.'
        page.locator('.triage-inline-note summary').click()
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
        page.locator('.triage-checkpoint').filter(has_text='Try to disprove the claim').locator('summary').click()
        page.get_by_label('Try to disprove the claim review state', exact=True).select_option('checked')
        page.get_by_label('Try to disprove the claim reasoning', exact=True).fill('Compared the normal update with the fictional specification.')
        # Changing tabs must not reset unsaved review text/status.
        page.locator('.triage-tabs').get_by_role('tab', name='Report', exact=True).click()
        assert 'Fictional review' in page.locator('.triage-report').inner_text()
        assert page.locator('.triage-report h4').count() >= 4
        assert page.locator('.triage-report ol li').count() == 2
        assert page.locator('.triage-report pre code').inner_text() == 'increment(amount);\n// Inspect the normal internal update, not an attack.'
        assert page.locator('.triage-report table tr').count() == 3
        assert page.locator('.triage-report img, .triage-report script, .triage-report a').count() == 0
        assert page.evaluate('window.reportInjected !== true')
        assert page.locator('.triage-report').evaluate('node=>parseFloat(getComputedStyle(node).fontSize)>=14')
        assert page.locator('.triage-drawer').bounding_box()['width'] >= 540
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
        page.get_by_role('button', name='Refresh source map', exact=True).click()
        assert not page.evaluate('window.sent.some(x=>x.type==="triage:refresh")')
        page.once('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='Refresh source map', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:refresh").token==="browser-demo-1"')
        page.locator('.triage-drawer').evaluate('node=>node.scrollTop=0')
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-report.png')), full_page=True)
        page.locator('.triage-tabs').get_by_role('tab', name='Flow', exact=True).click()
        assert page.locator('.triage-flow-item').count() == 2
        assert page.locator('.triage-flow-link').count() == 1
        assert '2 source cards checked' in page.locator('.triage-validation').inner_text()
        assert page.locator('.triage-mapping-badge').count() == 2
        page.get_by_label('Search mapped functions').fill('_add')
        assert page.locator('.triage-flow-item').count() == 1
        page.get_by_label('Search mapped functions').fill('')
        page.locator('.triage-flow-item').last.click()
        page.locator('.triage-tabs').get_by_role('tab', name='Review', exact=True).click()
        assert page.locator('#triage-field-status').input_value() == 'invalid'
        assert 'fictional demo behavior' in page.locator('#triage-field-evidence').input_value()
        assert page.locator('.triage-evidence-entry.contradicts').count() == 1
        assert page.get_by_label('Try to disprove the claim review state', exact=True).input_value() == 'checked'
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
        page.locator('#clear-btn').click()
        page.wait_for_timeout(500)
        assert page.locator('.card').count() == 0
        page.locator('#undo-btn').click()
        assert page.locator('.card').count() == 2
        assert page.locator('.triage-evidence-badge.contradicts').count() == 1
        assert page.locator('.triage-inline-note').count() == 1, 'Native Undo recreates the inline notes with the checked source line.'
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:persist").state.cards.length==2')
        page.get_by_role('button', name='Fit', exact=True).click()
        page.get_by_role('button', name='Arrange', exact=True).click()
        positions = page.locator('.card').evaluate_all('nodes=>nodes.map(node=>({left:node.offsetLeft,width:node.offsetWidth}))')
        assert positions[0]['left'] + positions[0]['width'] < positions[1]['left']
        page.locator('.triage-card-story > summary').click()
        assert 'Finding-level reading outline' in page.locator('.triage-card-story').inner_text()
        assert page.locator('.triage-card-story li').count() >= 2
        assert page.locator('.triage-story-observation').count() == 1
        page.locator('.triage-story-observation button').click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:inspectEvidence").evidence.source.line') == 13
        page.wait_for_function('''() => {
          const card=[...document.querySelectorAll('.card')][1];
          const numbers=document.querySelector('.edge-line').getAttribute('d').match(/-?[\\d.]+/g).map(Number);
          return Math.abs(numbers.at(-1) - (card.offsetTop + card.offsetHeight/2)) < 1;
        }''')
        page.get_by_role('button', name='Fit', exact=True).click()
        page.screenshot(path=str(Path(args.output).with_name(Path(args.output).stem + '-inline.png')), full_page=True)
        page.keyboard.press('Escape')
        page.get_by_role('button', name='Fit', exact=True).click()
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
        assert 'unsaved' not in page.locator('.triage-inline-note summary').inner_text().lower(), 'Save acknowledgment removes stale unsaved labels.'
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
        page.get_by_role('button', name='Ask AI', exact=True).click()
        assert page.evaluate('window.sent.findLast(x=>x.type==="triage:prompt").issueId==="I-02"')
        page.set_viewport_size({'width': 640, 'height': 900})
        page.locator('.triage-tabs').get_by_role('tab', name='Report', exact=True).click()
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
        assert page.locator('.triage-report').is_visible()
        assert page.locator('.card').count() == 0
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
        assert page.locator('.triage-inline-unplaced [data-evidence-id="hidden"]').count() == 1
        assert page.locator('[data-evidence-id="second-statement"]').evaluate('node=>node.previousElementSibling.dataset.sourceLine') == '14'
        assert page.locator('.triage-inline-note img').count() == 0
        assert not page.evaluate('!!window.noteInjected')
        page.keyboard.press('Alt+4')
        assert page.locator('.triage-placement-warning').count() == 2
        # A renderer/code disagreement must fail closed, never shift notes.
        page.evaluate('''() => { const card=[...cards.values()][0];card.clean+=String.fromCharCode(10);renderCodeBody(card);redrawEdges(); }''')
        assert page.locator('.triage-inline-note').count() == 0
        assert 'Inline source mapping unavailable' in page.locator('.triage-inline-unplaced').inner_text()
        assert not errors, errors
        browser.close()
finally:
    server.shutdown()
    server.server_close()
print('Native visual smoke passed: exact-line notes; hidden comments/repeated statements; fail-closed mapping; plain-text rendering; placement diagnostics; retained disclosure state; navigable review story; measured arrangement and Fit bounds; function roles; overview/inspector/navigation; filters; preserved hashes; keyboard/save acknowledgments; pending-edit and session isolation; native Undo; report/source links; narrow layout.')
