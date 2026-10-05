#!/usr/bin/env python3
"""Native renderer regression with explicit fictional presentation data.

This exercises the actual webview/card/navigation code, not provider reasoning,
host acceptance or an activated Cursor window. No provider is invoked.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--baseline', action='store_true')
parser.add_argument('--product-root', help='Render an archived product tree with the same controlled UI fixture.')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
product = Path(args.product_root).resolve() if args.product_root else root
upstream = Path(os.environ['FLOWBOARD_EXTENSION_PATH'])
output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
fixture = {}
assets = {'flowboard.js', 'triage.js', 'report-view.js', 'review-model.js', 'inline-review.js', 'claim-model.js', 'claim-view.js', 'investigation-view.js', 'reading-model.js', 'review-capacity.js', 'walkthrough-model.js'}
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlparse(self.path).path
        if route == '/':
            body, kind = fixture['html'].encode(), 'text/html'
        elif route.split('/')[-1] in assets and route.startswith(('/native/', '/tool/')):
            folder = upstream / 'webview' if route.startswith('/native/') else product / 'extension/webview'
            body, kind = (folder / Path(route).name).read_bytes(), 'text/javascript'
        else:
            self.send_error(404); return
        self.send_response(200); self.send_header('Content-Type', kind); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_args):
        pass
server = HTTPServer(('127.0.0.1', 0), Handler)
origin = f'http://127.0.0.1:{server.server_port}'
fixture.update(json.loads(subprocess.check_output(['node', str(product / 'scripts/render-fixture.js'), origin])))
threading.Thread(target=server.serve_forever, daemon=True).start()
message = fixture['message']
policy = subprocess.check_output(['node', '-p', 'require("./extension/webview/review-capacity").POLICY'], cwd=product, text=True).strip()
sources = []
for index, card in enumerate(message['state']['cards']):
    hint = message['hints'][card['id']]
    sources.append({'id': f'u{index}', 'name': f"Demo::{card['name']}", 'code': card['code'], 'complete': True,
                    'source': {key: hint[key] for key in ['file', 'line', 'endLine', 'sourceHash']}})
    sources[-1]['parameterSpans'] = json.loads(subprocess.check_output(['node','-e',
        'const u=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(require("./extension/call-bindings").parameterSpans(u.code,u.name.split("::").at(-1),u.source.line)));',json.dumps(sources[-1])],cwd=root,text=True))
# Obtain occurrence coordinates from the actual production tokenizer. These
# presentation records are not themselves evidence of host-gate acceptance.
sources[0]['relatedCalls'] = json.loads(subprocess.check_output(['node', '-e',
    'const b=require("./extension/call-bindings");process.stdout.write(JSON.stringify(b.unitSites(JSON.parse(process.argv[1]))));', json.dumps(sources[0])], cwd=root, text=True))
evidence = []
for identity, unit, line, explanation in [('entry', sources[0], 9, 'The entry passes amount to the internal helper.'),
                                        ('update', sources[1], 13, 'The helper adds amount to counter; a revert would undo this write.')]:
    evidence.append({'id': identity, 'sourceId': unit['id'], 'claimId': 'c1', 'findingId': 'I-01', 'origin': 'model-interpretation',
                     'source': {**unit['source'], 'line': line, 'endLine': line}, 'quote': unit['code'].splitlines()[line-unit['source']['line']],
                     'stance': 'context', 'note': explanation, 'explanationReview': {'result': 'kept', 'reason': 'Controlled renderer data, not an independent semantic check.'}})
events = [{'id': 's1', 'invocationId': 'entry-1', 'transaction': 'tx1', 'phase': 'call', 'claimId': 'c1', 'evidenceId': 'entry',
           'callSiteId': sources[0]['relatedCalls'][0]['id'],
           'title': 'Pass the requested amount', 'role': 'Public entry for this counter update.', 'what': evidence[0]['note'],
           'why': 'The input is passed unchanged.', 'actor': 'Caller', 'caller': 'msg.sender', 'receiver': 'Demo',
           'conditions': [], 'inputs': [], 'changes': [], 'effect': 'intermediate'},
          {'id': 's2', 'invocationId': 'helper-1', 'transaction': 'tx1', 'phase': 'write', 'claimId': 'c1', 'evidenceId': 'update',
           'title': 'Update the counter', 'role': 'Internal counter update.', 'what': evidence[1]['note'], 'why': 'This is the only write in the supplied helper.',
           'actor': 'Caller', 'caller': 'msg.sender', 'receiver': 'Demo', 'conditions': [],
           'inputs': [{'name': 'amount', 'expression': 'amount', 'units': 'counter units', 'origin': 'increment argument', 'evidence': ['entry']}],
           'changes': [{'name': 'counter', 'before': 'counter before the call', 'operation': '+ amount', 'after': 'counter before the call + amount', 'units': 'counter units', 'evidence': ['update']}], 'effect': 'intermediate'}]
draft = {'findingId': 'I-01', 'phase': 'ready', 'revision': 1, 'publication': {'ready': True, 'policy': policy},
         'snapshot': {'sourceDigest': 'fixture', 'reportHash': 'fixture'}, 'sources': sources, 'evidence': evidence,
         'claims': [{'id': 'c1', 'allegation': 'The input updates the counter.', 'status': 'supported', 'conditions': [], 'unknowns': [], 'entry': 'u0'}],
         'property': {'text': 'The fixture describes ordinary counter behavior.', 'basis': 'report-assumption', 'evidence': [], 'documentation': []},
         'conclusion': {'text': 'Controlled reading fixture only.', 'limitations': []},
         'walkthrough': {'reportText': message['reportText'], 'assessment': {'result': 'unclear', 'why': 'This fixture is ordinary code, not a validated bug.'}},
         'causal': {'summary': 'A public entry passes the input to the internal update.', 'scope': 'Fictional source only; no execution.',
                    'events': events, 'order': ['s1', 's2'], 'relationships': [{'from': 's1', 'to': 's2', 'kind': 'call', 'callSiteId':sources[0]['relatedCalls'][0]['id'], 'explanation': 'The highlighted expression calls _add.', 'binding': 'amount → amount', 'evidence': ['entry']} ]}}
message['investigationDraft'] = draft
message['finding']['triage'] = {'evidence': [{'id': 'manual', 'kind': 'source', 'stance': 'context', 'note': 'Researcher note at the declaration, separate from the active call.',
    'source': {**sources[0]['source'], 'line': 8, 'endLine': 8}, 'quote': sources[0]['code'].splitlines()[0]}]}
base = copy.deepcopy(message)
base['library'] += [{'id': 'I-03', 'title': 'Missing external implementation', 'severity': 'Info', 'status': 'unreviewed'},
                    {'id': 'I-04', 'title': 'Provider transport failure', 'severity': 'Info', 'status': 'unreviewed'}]
result = {'boundary': 'Actual native renderer, controlled fictional presentation DTO; no provider calls, no host gate or live editor validation.', 'checks': [], 'observed': {}}
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=os.environ.get('FLOWBOARD_CHROMIUM_PATH'))
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, reduced_motion='reduce')
        errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script('window.sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.sent.push(m)});')
        page.goto(origin); page.wait_for_function('window.sent.some(x=>x.type==="triage:ready")')
        def emit(value):
            page.evaluate('data=>window.dispatchEvent(new MessageEvent("message",{data}))', value)
        loads = 0
        def load():
            global loads
            loads += 1
            data = copy.deepcopy(base); data['draftFingerprint'] = 'fresh-browser-case-' + str(loads)
            emit({'type': 'restore', 'state': None}); emit(data); page.wait_for_selector('.guide-annotation')
        def capture():
            return page.evaluate('()=>({camera:{scale,panX,panY},step:document.querySelector(".guide-annotation")?.dataset.stepId,lines:[...document.querySelectorAll(".triage-claim-line")].map(n=>Number(n.dataset.sourceLine))})')
        load(); page.screenshot(path=str(output / 'initial.png'))
        controls = page.locator('.guide-controls')
        before = capture()
        # Native history and guide progress describe different locations. The
        # return snapshot must be captured before history mutates the selection.
        page.locator('.card').filter(has=page.get_by_text('Demo::increment(uint256)',exact=True)).get_by_role('button',name='Explore function',exact=True).click()
        page.locator('.card').filter(has=page.get_by_text('Demo::_add(uint256)',exact=True)).get_by_role('button',name='Explore function',exact=True).click()
        page.locator('#triage-bar').get_by_role('button',name='Walkthrough',exact=True).click()
        controls.get_by_role('button',name='Next step',exact=True).click()
        guided_b=capture()
        page.keyboard.press('Alt+ArrowLeft')
        history_a=capture()
        controls.get_by_role('button',name='Resume walkthrough',exact=True).click()
        result['observed']['historyGuideReturn']={'expected':guided_b,'explored':history_a,'returned':capture()}
        if not args.baseline:
            assert capture()==guided_b, 'History must pause before changing the active guide source or checked lines.'
            result['checks'].append('Native history detours capture the guide before changing cards; Resume restores its exact original step/range/camera.')
        load()
        page.locator('.guide-active-card .triage-note-links button').filter(has_text='L8').click()
        page.locator('.guide-annotation').get_by_role('button',name='src/Demo.sol:8 · Open in editor',exact=True).click()
        inspection=page.evaluate('window.sent.findLast(m=>m.type==="triage:inspectEvidence")')
        if not args.baseline:
            before_retry=capture()
            emit({'type':'triage:navigationFailed','issueId':'I-01','token':base['token'],'navigationId':inspection['navigationId'],'reason':'Controlled local navigation failure.'})
            page.locator('.guide-annotation').get_by_role('button',name='Retry opening code',exact=True).click()
            retried=page.evaluate('window.sent.findLast(m=>m.type==="triage:inspectEvidence")')
            assert retried['navigationId']!=inspection['navigationId'] and retried['evidence']==inspection['evidence']
            assert capture()==before_retry, 'Retry must keep the detour and its original return point.'
            emit({'type':'triage:evidenceInspected','issueId':'I-01','token':base['token'],'navigationId':retried['navigationId'],
                  'evidence':base['finding']['triage']['evidence'][0],'excerpt':'Original checked declaration.'})
            assert 'Could not open' not in page.locator('.guide-annotation').inner_text()
            result['checks'].append('Retry resends the failed manual evidence operation with a fresh navigation ID; it does not return to the numbered step or spend a provider request.')
        controls.get_by_role('button',name='Return to step',exact=True).click()
        controls.get_by_role('button',name='Next step',exact=True).click()
        before_late=capture()
        emit({'type':'triage:evidenceInspected','issueId':'I-01','token':base['token'],'navigationId':inspection.get('navigationId'),
              'evidence':base['finding']['triage']['evidence'][0],'excerpt':'Original checked declaration.'})
        result['observed']['lateManualEvidence']={'before':before_late,'after':capture()}
        if not args.baseline:
            assert capture()==before_late, 'A superseded manual evidence result must not replace a later step.'
            page.locator('.guide-active-card .triage-line-number').first.click()
            field=page.locator('#triage-evidence-note');field.fill('Keep this later note and selection.')
            field.evaluate('node=>node.setSelectionRange(5,15)');editing=capture()
            emit({'type':'triage:evidenceInspected','issueId':'I-01','token':base['token'],'navigationId':inspection.get('navigationId'),
                  'evidence':base['finding']['triage']['evidence'][0],'excerpt':'A superseded inspection delivered again.'})
            assert capture()==editing and field.input_value()=='Keep this later note and selection.'
            assert field.evaluate('node=>[node.selectionStart,node.selectionEnd]')==[5,15]
            result['checks'].append('Late manual evidence responses cannot retarget a subsequent step or rebuild a later note editor, text or caret.')
        load()
        page.locator('.guide-active-card .triage-note-links button').filter(has_text='L8').click()
        page.locator('#triage-bar').get_by_text('More',exact=True).click()
        page.locator('.triage-more-menu').get_by_role('button',name='Edit review',exact=True).click()
        result['observed']['noteEditLayout']=page.evaluate('document.body.classList.contains("guide-note-editing")')
        page.get_by_role('tab',name='Functions',exact=True).click()
        result['observed']['functionsAfterNoteLayout']=page.evaluate('document.body.classList.contains("guide-note-editing")')
        load(); page.locator('.guide-active-card .triage-line-number').first.click()
        page.get_by_role('tab',name='Functions',exact=True).click()
        result['observed']['functionsAfterGutterLayout']=page.evaluate('document.body.classList.contains("guide-note-editing")')
        if not args.baseline:
            assert result['observed']['noteEditLayout'] and not result['observed']['functionsAfterNoteLayout'] and not result['observed']['functionsAfterGutterLayout']
            result['checks'].append('Every drawer route recomputes the note-editor layout after its tab and visibility change.')
            for phase in ['absent','preparing','blocked']:
                data=copy.deepcopy(base);data['draftFingerprint']='unready-note-'+phase
                data['investigationDraft']=None if phase=='absent' else {'findingId':'I-01','phase':phase,'publication':{'ready':False},'error':'A fixture dependency is unavailable.' if phase=='blocked' else ''}
                emit({'type':'restore','state':None});emit(data)
                page.locator('#triage-bar').get_by_text('More',exact=True).click()
                page.locator('.triage-more-menu').get_by_role('button',name='Edit review',exact=True).click()
                page.locator('.triage-evidence-reference').first.click()
                old=page.evaluate('window.sent.findLast(m=>m.type==="triage:inspectEvidence")')
                target=page.locator('.card').filter(has=page.get_by_text('Demo::_add(uint256)',exact=True))
                target.locator('.triage-line-number').first.click(force=True)
                field=page.locator('#triage-evidence-note');field.fill('Keep the new function note '+phase)
                field.evaluate('node=>node.setSelectionRange(5,12)');before=capture()
                emit({'type':'triage:evidenceInspected','issueId':'I-01','token':base['token'],'navigationId':old['navigationId'],
                    'evidence':base['finding']['triage']['evidence'][0],'excerpt':'Late note A while editing B.'})
                assert capture()==before, phase+' must not navigate to the old saved note'
                assert field.input_value()=='Keep the new function note '+phase
                assert field.evaluate('node=>document.activeElement===node && node.selectionStart===5 && node.selectionEnd===12')
            result['checks'].append('Without a guide (absent, preparing or blocked), a new function note revokes older async evidence navigation and retains exact source, text, focus and caret.')
            load();before=capture()
            crowded=copy.deepcopy(base); crowded['draftFingerprint']='crowded-two-missing'
            crowded['state']['cards']=[];crowded['state']['edges']=[];crowded['hints']={};crowded['connections']=[]
            for index in range(199):
                card=copy.deepcopy(base['state']['cards'][0]);card.update(id=f'explore-{index}',name='exploration',file='Exploration.sol',code='    function exploration() external {}',startLine=50,endLine=50,x=30+index*720,y=30)
                hint=copy.deepcopy(base['hints'][base['state']['cards'][0]['id']]);hint.update(file='src/Exploration.sol',line=50,endLine=50,range='src/Exploration.sol:50-50')
                crowded['state']['cards'].append(card);crowded['hints'][card['id']]=hint
            crowded['guideAvailability']={'ready':False,'limit':200,'materializedCount':199,'deficit':1,'missingSourceIds':['u0','u1'],'reason':'The guide needs two missing function cards.'}
            emit(crowded)
            page.locator('#triage-bar').get_by_role('button',name='Walkthrough',exact=True).click()
            assert page.locator('.guide-annotation').count()==0
            assert 'Remove 1 exploration card' in page.locator('.guide-preparation').inner_text()
            page.locator('.guide-status-row').get_by_role('button',name='Close status',exact=True).click()
            page.locator('.triage-drawer').get_by_role('button',name='Close review panel',exact=True).click()
            page.locator('#triage-bar').get_by_text('More',exact=True).click()
            page.locator('#mode-btn').click()
            page.locator('#triage-bar').get_by_text('More',exact=True).click()
            # Header padding selects the native card. Its title deliberately
            # allows text selection instead and must not be treated as delete.
            page.locator('.card-header').first.click(position={'x':4,'y':4});page.keyboard.press('Delete')
            assert page.locator('.card').count()==198
            page.locator('#triage-bar').get_by_role('button',name='Walkthrough',exact=True).click()
            pending=page.evaluate('window.sent.findLast(m=>m.type==="triage:investigationFocus")')
            assert page.evaluate('()=>{const focus=window.sent.findLastIndex(m=>m.type==="triage:investigationFocus"),saved=window.sent.findLastIndex(m=>m.type==="triage:persist"&&m.state.cards.length===198);return saved>=0&&saved<focus}'), 'Freed native slots must reach the host before an immediate materialization request.'
            assert 'Opening the checked code' in page.locator('.guide-annotation').inner_text()
            emit({'type':'triage:navigationFailed','issueId':'I-01','token':base['token'],'navigationId':pending['navigationId'],'reason':'The original code changed before this card could open.'})
            assert 'Opening the checked code' not in page.locator('.guide-annotation').inner_text()
            assert 'Could not open this step' in page.locator('.guide-annotation').inner_text()
            assert page.locator('.guide-annotation').get_by_role('button',name='Retry opening code',exact=True).is_visible()
            assert page.locator('.card').count()==198
            result['checks'].append('A 199-card board with two missing guide functions reports its exact deficit; native deletion frees room, and failed materialization stops with a retry instead of a spinner.')
        load()
        if not args.baseline:
            assert page.evaluate('()=>[...CSS.highlights.get("flowboard-call-occurrence")].map(range=>range.toString())') == ['_add(amount)']
        page.locator('.guide-active-card .triage-note-links button').filter(has_text='L8').click()
        result['observed']['noteNavigation'] = capture()
        result['observed']['noteDetourVisible'] = controls.get_by_role('button', name='Return to step', exact=True).count() == 1
        if not args.baseline:
            assert result['observed']['noteDetourVisible'], 'A different code note must explicitly leave the current step.'
            assert capture()['lines'] == [8]
            assert 'Researcher note' in page.locator('.guide-annotation').inner_text()
            controls.get_by_role('button', name='Return to step', exact=True).click()
            assert capture() == before, 'Return restores the exact step, highlight and camera.'
            result['checks'].append('Manual note marker/link uses an explicit anchored detour and restores the original step.')
        load()
        page.locator('.guide-active-card .triage-line-number').first.click()
        page.wait_for_timeout(100)
        result['observed']['manualEditor'] = {'code': page.locator('#flowboard').bounding_box(), 'drawer': page.locator('.triage-drawer').bounding_box(),
                                             'return': controls.get_by_role('button', name='Return to step', exact=True).count()}
        page.screenshot(path=str(output / 'manual-note.png'))
        if not args.baseline:
            box = result['observed']['manualEditor']; assert box['return'] == 1
            assert box['code']['x'] >= box['drawer']['x'] + box['drawer']['width'] - 1, box
            note = page.locator('#triage-evidence-note'); note.fill('Keep this unfinished note.')
            note.evaluate('n=>n.setSelectionRange(5,9)')
            emit({'type': 'triage:reportPreparation', 'report': {'mode': 'running', 'published': False, 'ready': 1, 'total': 4,
                 'counts': {'completed': 1, 'running': 1, 'blocked': 1, 'failed': 1},
                 'jobs': [{'id': 'I-01', 'state': 'completed', 'publishable': True}, {'id': 'I-02', 'state': 'running', 'publishable': False}], 'active': []}})
            assert note.input_value() == 'Keep this unfinished note.'
            assert note.evaluate('n=>[n.selectionStart,n.selectionEnd]') == [5,9]
            controls.get_by_role('button', name='Return to step', exact=True).click()
            assert capture() == before
            result['checks'].append('Gutter note editing keeps code beside the editor; sibling progress preserves note/caret and Return.')
            waiting = copy.deepcopy(base)
            waiting['draftFingerprint'] = 'unready-manual-edit'
            waiting['investigationDraft'] = {'findingId':'I-01','phase':'preparing','revision':0,
                'preparation':{'state':'checking','reason':'Checking this finding.'},'claims':[],'evidence':[],'sources':[]}
            emit({'type':'restore','state':None}); emit(waiting)
            page.locator('.guide-status-row').get_by_role('button',name='Details',exact=True).click()
            page.get_by_role('button',name='Explore code',exact=True).click()
            page.locator('.triage-line-number').first.click()
            field = page.locator('#triage-evidence-note'); field.fill('Do not replace this draft when preparation finishes.')
            field.evaluate('node=>node.setSelectionRange(4,11)')
            position = capture()
            emit({'type':'triage:investigation','issueId':'I-01','token':base['token'],'draft':base['investigationDraft']})
            assert page.locator('.guide-annotation').count()==0, 'An accepted result must not steal an explicitly selected note editor.'
            assert capture()==position and field.input_value()=='Do not replace this draft when preparation finishes.'
            assert field.evaluate('node=>[node.selectionStart,node.selectionEnd]')==[4,11]
            result['checks'].append('Late selected-finding readiness does not replace deliberate exploration or an unfinished manual note.')
            load()
            mixed = {'mode':'running','published':False,'ready':1,'total':4,'counts':{'completed':1,'running':1,'blocked':1,'failed':1},'active':[{'id':'I-02','stage':'challenge'}],
                     'jobs':[{'id':'I-01','state':'completed','publishable':True},{'id':'I-02','state':'running','publishable':False},
                             {'id':'I-03','state':'blocked','publishable':False,'reason':'The deployed implementation is not available.'},
                             {'id':'I-04','state':'failed','publishable':False,'reason':'The provider process stopped before returning a result.'}]}
            emit({'type':'triage:reportPreparation','report':mixed})
            assert capture() == before and page.locator('.guide-annotation').is_visible()
            page.locator('#triage-bar').get_by_role('button',name='Findings',exact=True).click()
            assert page.locator('[data-finding-id="I-01"] .triage-ready-action').is_visible()
            assert not page.locator('[data-finding-id="I-02"] .triage-ready-action').is_visible()
            paused = capture()
            mixed['jobs'][1].update(state='completed',publishable=True); mixed['ready']=2
            emit({'type':'triage:reportPreparation','report':mixed})
            assert page.locator('[data-finding-id="I-02"] .triage-ready-action').is_visible()
            assert capture() == paused, 'A ready sibling must not change the selected tutorial, camera or code.'
            assert 'Your result: Not reviewed' in page.locator('[data-finding-id="I-01"]').inner_text()
            assert 'deployed implementation' in page.locator('[data-finding-id="I-03"]').inner_text()
            page.screenshot(path=str(output / 'mixed-state.png'))
            for mode in ['paused','cancelled']:
                mixed['mode']=mode; emit({'type':'triage:reportPreparation','report':mixed})
                assert page.locator('[data-finding-id="I-01"] .triage-ready-action').is_visible()
            result['checks'].append('A ready native guide stays usable beside running/blocked/failed findings; sibling Ready and report pause update badges only.')
        load()
        result['observed']['breakpoints'] = []
        for width in [759,760,761,799,800,801,1050,1051,1280,1440]:
            page.set_viewport_size({'width':width,'height':800}); page.wait_for_timeout(100)
            code = page.locator('#flowboard').bounding_box(); aside = page.locator('.guide-aside').bounding_box()
            result['observed']['breakpoints'].append({'width':width,'code':code,'aside':aside})
            if not args.baseline:
                assert code['height'] > 180 and code['width'] > 300, (width,code,aside)
                if width <= 800:
                    assert abs(code['width']-width) <= 1 and code['y']+code['height'] <= aside['y']+1, (width,code,aside)
                else:
                    assert code['x']+code['width'] <= aside['x']+1, (width,code,aside)
                header = page.locator('.guide-active-card .card-header').bounding_box()
                assert header['x'] >= code['x']-1 and header['y'] >= code['y']-1, (width,header,code)
            if width in [761,800,1280]: page.screenshot(path=str(output / f'layout-{width}.png'))
        if not args.baseline: result['checks'].append('Native code/explanation remain disjoint at 759/760/761,799/800/801,1050/1051 and desktop widths.')
        if not args.baseline:
            result['observed']['shortWindows'] = []
            for width in [760,801,1280]:
                page.set_viewport_size({'width':width,'height':600}); page.wait_for_timeout(100)
                code=page.locator('#flowboard').bounding_box(); aside=page.locator('.guide-aside').bounding_box()
                header=page.locator('.guide-active-card .card-header').bounding_box()
                line=page.locator('.guide-active-card .triage-claim-line').first.bounding_box()
                result['observed']['shortWindows'].append({'width':width,'code':code,'aside':aside,'line':line})
                assert code['height']>100 and header['y']>=code['y']-1
                assert line['y']>=code['y']-1 and line['y']+min(line['height'],24)<=code['y']+code['height']+1
                assert controls.get_by_role('button',name='Next step',exact=True).is_visible()
            result['checks'].append('Short 600px editor panes retain the current original code range and explicit step controls.')
            page.set_viewport_size({'width':1280,'height':800}); load()
            first = capture()
            page.keyboard.press('Alt+Shift+ArrowRight')
            assert capture()['step']=='s2'
            page.keyboard.press('Alt+Shift+ArrowLeft')
            assert capture()==first
            page.locator('.guide-active-card .triage-line-number').first.click()
            field=page.locator('#triage-evidence-note'); field.fill('Keyboard editing stays inside this note.')
            position=capture(); page.keyboard.press('Alt+Shift+ArrowRight')
            assert capture()==position and field.input_value()=='Keyboard editing stays inside this note.'
            controls.get_by_role('button',name='Return to step',exact=True).click()
            result['checks'].append('Keyboard step shortcuts navigate prepared steps but do not intercept typing in a note.')
            controls.get_by_role('button',name='Next step',exact=True).click()
            current = capture()
            page.locator('.guide-parameter-table').get_by_role('button',name='Read caller argument',exact=True).click()
            assert capture()['lines']==[9]
            assert page.evaluate('()=>[...CSS.highlights.get("flowboard-call-occurrence")].map(range=>range.toString())')==['amount']
            controls.get_by_role('button',name='Return to step',exact=True).click()
            assert capture()==current
            page.locator('.guide-parameter-table').get_by_role('button',name='Read callee parameter',exact=True).click()
            assert capture()['lines']==[12]
            assert page.evaluate('()=>[...CSS.highlights.get("flowboard-call-occurrence")].map(range=>range.toString())')==['amount']
            controls.get_by_role('button',name='Return to step',exact=True).click()
            assert capture()==current
            page.locator('.guide-parameter-table button').filter(has_text='Read origin').first.click()
            pending = page.evaluate('window.sent.findLast(message=>message.type==="triage:investigationFocus")')
            emit({'type':'triage:investigationFocus','issueId':'I-01','token':base['token'],'navigationId':pending['navigationId'],
                  'evidenceId':'entry','claimId':'c1','cardId':base['state']['cards'][0]['id'],'source':evidence[0]['source']})
            assert capture()['lines']==[9]
            controls.get_by_role('button',name='Return to step',exact=True).click()
            assert capture()==current
            assert page.locator('.guide-state-watch').count()==1
            page.screenshot(path=str(output/'parameter-evidence.png'))
            page.evaluate('document.body.classList.add("vscode-light")'); page.screenshot(path=str(output/'light.png'))
            page.evaluate('document.body.classList.remove("vscode-light")')
            result['checks'].append('Parameter evidence opens the exact caller range and returns to the callee; symbolic changes remain scoped to one invocation.')
            # Same-line calls cannot be distinguished by a line highlight.
            # Ask the production occurrence parser for both coordinate spans.
            same_line = copy.deepcopy(base)
            same_code = '    function increment(uint256 amount) external {\n        _add(amount); _add(amount + 1);\n    }'
            unit = same_line['investigationDraft']['sources'][0]; unit['code'] = same_code
            unit['source']['sourceHash'] = hashlib.sha256(same_code.encode()).hexdigest()
            unit['relatedCalls'] = json.loads(subprocess.check_output(['node','-e',
                'process.stdout.write(JSON.stringify(require("./extension/call-bindings").unitSites(JSON.parse(process.argv[1]))));',json.dumps(unit)],cwd=root,text=True))
            first_card = same_line['state']['cards'][0]; first_card['code']=same_code
            same_line['hints'][first_card['id']]['sourceHash']=unit['source']['sourceHash']
            same_line['finding']['triage']={'evidence':[]}
            entries=[]; steps=[]
            for index, site in enumerate(unit['relatedCalls']):
                entry={**copy.deepcopy(evidence[0]),'id':f'call-{index}','source':{**unit['source'],'line':9,'endLine':9},'quote':same_code.splitlines()[1]}
                entries.append(entry)
                steps.append({**copy.deepcopy(events[0]),'id':f'same-{index}','evidenceId':entry['id'],'callSiteId':site['id'],'title':f'Read occurrence {index+1}'})
            same_line['investigationDraft']['evidence']=entries
            same_line['investigationDraft']['causal'].update(events=steps,order=[step['id'] for step in steps],relationships=[])
            same_line['draftFingerprint']='same-line-occurrences'; same_line['investigationDraft']['revision']=10
            emit(same_line); page.wait_for_selector('.guide-annotation')
            assert page.evaluate('()=>[...CSS.highlights.get("flowboard-call-occurrence")].map(range=>range.toString())')==['_add(amount)']
            cam=page.evaluate('()=>({scale,panX,panY})')
            controls.get_by_role('button',name='Next step',exact=True).click()
            assert page.evaluate('()=>[...CSS.highlights.get("flowboard-call-occurrence")].map(range=>range.toString())')==['_add(amount + 1)']
            assert page.evaluate('()=>({scale,panX,panY})')==cam
            result['checks'].append('Two calls on one line highlight different exact UTF-16 occurrence ranges without moving the camera.')

            # Stress the same native renderer with eighteen prepared events and
            # 1,044 original code lines on twelve cards. This is a rendering
            # workload, not new accepted semantic evidence or a timing promise.
            large=copy.deepcopy(base); large['draftFingerprint']='large-reading-workload'; large['finding']['triage']={'evidence':[]}
            large['finding']['title']='Fictional long-function reading workload'
            draft_large=large['investigationDraft']; draft_large['revision']=20; draft_large['sources']=[]; draft_large['evidence']=[]
            draft_large['causal'].update(events=[],order=[],relationships=[])
            draft_large['causal']['summary']='Read repeated counter updates in two separate function contexts. This controlled rendering workload is not a finding assessment or an execution trace.'
            large['state']['cards']=[]; large['state']['edges']=[]; large['hints']={}; large['connections']=[]
            source_file='src/LargeReadingFixture.sol'
            source_lines=['// SPDX-License-Identifier: MIT','pragma solidity ^0.8.20;','contract Demo {','    uint256 private counter;']
            for index in range(12):
                lines=402 if index<2 else 24
                start=10+index*500
                code='    function readContext'+str(index)+'(uint256 amount) internal {\n'+'\n'.join('        counter += amount; // local reading statement '+str(n) for n in range(lines-2))+'\n    }'
                source_lines.extend(['']*(start-1-len(source_lines))); source_lines.extend(code.splitlines())
                card=copy.deepcopy(base['state']['cards'][0])
                card.update(id=f'large-card-{index}',name='readContext'+str(index),code=code,file='LargeReadingFixture.sol',fsPath=str(output/source_file),startLine=start,endLine=start+lines-1,x=30+index*720,y=30)
                hint=copy.deepcopy(base['hints'][base['state']['cards'][0]['id']]); hint.update(file=source_file,line=start,endLine=start+lines-1,sourceHash='',
                    range=f'{source_file}:{start}-{start+lines-1}',signature=f'function readContext{index}(uint256 amount)',identity={'contract':'Demo','signature':f'readContext{index}(uint256)'})
                large['state']['cards'].append(card); large['hints'][card['id']]=hint
                unit={'id':f'large-unit-{index}','name':f'Demo::readContext{index}','source':{k:hint[k] for k in ['file','line','endLine','sourceHash']},'code':code,'complete':True}
                draft_large['sources'].append(unit)
                if index<2:
                    for offset in range(9):
                        line=start+1+offset*45
                        entry={'id':f'large-note-{index}-{offset}','claimId':'c1','sourceId':unit['id'],'source':{**unit['source'],'line':line,'endLine':line},'quote':code.splitlines()[line-start],
                               'stance':'context','note':'This statement adds the symbolic amount to counter. It is not a measured outcome.','origin':'model-interpretation','explanationReview':{'result':'kept'}}
                        event={**copy.deepcopy(events[1]),'id':f'large-step-{index}-{offset}','evidenceId':entry['id'],'inputs':[],'changes':[],'callSiteId':'','invocationId':f'frame-{index}',
                            'title':f'Read update {offset+1} in readContext{index}', 'role':'A separate internal function containing repeated counter updates.',
                            'what':entry['note'], 'why':'This is one of many additions in this function. Reading selected statements does not establish its total committed effect.',
                            'actor':'Not established in this rendering fixture','caller':'Internal caller not selected','transaction':f'context-{index}', 'conditions':[]}
                        draft_large['evidence'].append(entry); draft_large['causal']['events'].append(event); draft_large['causal']['order'].append(event['id'])
            source_lines.append('}')
            source_text='\n'.join(source_lines)+'\n'; source_hash=hashlib.sha256(source_text.encode()).hexdigest()
            (output/'src').mkdir(exist_ok=True); (output/source_file).write_text(source_text)
            for hint in large['hints'].values(): hint['sourceHash']=source_hash
            for unit in draft_large['sources']:
                unit['source']['sourceHash']=source_hash
                assert '\n'.join(source_lines[unit['source']['line']-1:unit['source']['endLine']])==unit['code']
            for entry in draft_large['evidence']: entry['source']['sourceHash']=source_hash
            draft_large['snapshot']['sourceDigest']=source_hash
            page.set_viewport_size({'width':1440,'height':900})
            (output/'large-message.json').write_text(json.dumps(large))
            opened_at=page.evaluate('performance.now()'); emit(large)
            page.wait_for_selector('.guide-active-card .triage-claim-line')
            result['largeGuide']={'cards':12,'codeLines':1044,'steps':18,'firstReadableMs':page.evaluate('performance.now()')-opened_at}
            result['largeGuide']['samplesMs']=page.evaluate('''async()=>{
                const times=[];
                for(let i=0;i<54;i++){
                    const label=(Math.floor(i/17)%2)?'Previous step':'Next step';
                    const control=[...document.querySelectorAll('.guide-controls button')].find(b=>b.textContent===label);
                    const start=performance.now();control.click();
                    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                    const row=document.querySelector('.guide-active-card .triage-claim-line'),box=row.getBoundingClientRect(),view=document.querySelector('#flowboard').getBoundingClientRect();
                    if(box.y<view.y||box.y+Math.min(box.height,24)>view.bottom)throw new Error('Active range left the native reading viewport');
                    const card=cards.get(document.querySelector('.guide-active-card').dataset.id)||[...cards.values()].find(card=>card.el.classList.contains('guide-active-card'));
                    const location=document.querySelector('.guide-active-card .card-meta').textContent;
                    if(!location.includes(`src/LargeReadingFixture.sol:${card.data.startLine}-${card.data.endLine}`))throw new Error('Native source header differs from the displayed original function');
                    if(document.querySelector('.guide-annotation').textContent.includes('only write'))throw new Error('A repeated-update fixture incorrectly claims a sole write');
                    times.push(performance.now()-start);
                }return times;
            }''')
            samples=sorted(result['largeGuide']['samplesMs']); result['largeGuide']['medianMs']=samples[len(samples)//2]; result['largeGuide']['p95Ms']=samples[int(len(samples)*.95)]
            result['largeGuide']['domElements']=page.locator('*').count()
            page.screenshot(path=str(output/'large-guide.png'))
            result['checks'].append('Eighteen-step native playback over twelve cards / 1,044 full code lines keeps the active original range readable; timings include cross-function moves.')
            base['finding'].update(status='confirmed',confidence='high'); load()
            page.locator('.guide-active-card .triage-line-number').first.click()
            field=page.locator('#triage-evidence-note');field.fill('Researcher correction survives withdrawal.')
            field.evaluate('node=>node.setSelectionRange(11,21)')
            pending_draft={'findingId':'I-01','phase':'preparing','revision':2,'preparation':{'state':'checking','reason':'Rechecking this finding.'},'claims':[],'evidence':[],'sources':[]}
            emit({'type':'triage:investigation','issueId':'I-01','token':base['token'],'draft':pending_draft})
            assert page.locator('.guide-annotation').count()==0
            assert field.input_value()=='Researcher correction survives withdrawal.'
            assert field.evaluate('node=>[node.selectionStart,node.selectionEnd]')==[11,21]
            emit({'type':'triage:sourceStale','issueId':'I-01','token':base['token']})
            state=page.evaluate('window.sent.findLast(message=>message.type==="triage:persist").state')
            assert state['workingCopy']['evidenceInput']['note']=='Researcher correction survives withdrawal.'
            assert 'status' not in state['workingCopy']['patch'] and 'confidence' not in state['workingCopy']['patch'], 'Machine invalidation must not overwrite the human result.'
            result['checks'].append('Selected-artifact withdrawal/source change removes generated notes but preserves typed corrections, caret and human judgment.')
        result['pageErrors'] = errors
        if not args.baseline: assert not errors, errors
        browser.close()
finally:
    server.shutdown()
    (output / 'checks.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps({'output':str(output),'boundary':result['boundary'],'checks':result['checks'],
                  'largeGuide':{key:value for key,value in result.get('largeGuide',{}).items() if key!='samplesMs'},'pageErrors':result.get('pageErrors',[])}, indent=2))
