#!/usr/bin/env python3
"""Ordinary fictional report selection in the actual renderer/controller.

--fixture-model uses explicitly fixed generation/challenge responses. --provider
codex uses the configured source-only adapter instead. Neither executes tests or
protocol transactions. Editor I/O is shimmed, not a complete Cursor session.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True)
parser.add_argument('--baseline', action='store_true')
parser.add_argument('--fixture-model', action='store_true')
parser.add_argument('--provider', choices=['none', 'codex', 'claude'], default='none')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
output = Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
command = ['node', str(root / 'scripts/workflow-host.js'), '--reading', '--provider', args.provider]
if args.fixture_model:
    command.append('--fixture-model')
process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    initial = process.stdout.readline()
    if not initial:
        raise RuntimeError(process.stderr.read())
    host = json.loads(initial)
    def request(route, payload=None):
        call = urllib.request.Request(host['origin'] + route,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={'X-Workflow-Token': host['secret'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(call, timeout=30) as result:
            return json.loads(result.read())

    with sync_playwright() as playwright:
        launch = {'headless': True}
        if os.environ.get('FLOWBOARD_CHROMIUM_PATH'):
            launch['executable_path'] = os.environ['FLOWBOARD_CHROMIUM_PATH']
        browser = playwright.chromium.launch(**launch)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        errors, screenshots = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('__send', lambda message: request('/message', message))
        page.expose_function('__poll', lambda cursor: request('/events?after=' + str(cursor)))
        page.add_init_script('''
          window.sent=[]; window.hostMessages=[]; window.closing=false;
          window.acquireVsCodeApi=()=>Object.freeze({postMessage(m){if(!window.closing){window.sent.push(m);return window.__send(m);}}});
          let cursor=0; window.polling=false;
          window.timer=setInterval(async()=>{if(window.polling||window.closing)return; window.polling=true;
            try{const batch=await window.__poll(cursor);cursor=batch.cursor;for(const data of batch.messages){window.hostMessages.push(data);window.dispatchEvent(new MessageEvent('message',{data}));}}
            finally{window.polling=false;}},75);
        ''')
        def capture(name):
            target = str(output.with_name(output.stem + '-' + name + '.png'))
            page.screenshot(path=target, full_page=True)
            screenshots.append(target)
        def select(id):
            previous = request('/state').get('token')
            page.locator('#triage-bar').get_by_role('button', name='Findings', exact=True).click()
            entries = page.locator('.triage-finding-list button')
            if entries.count() == 0:
                entries = page.locator('.triage-drawer button')
            entries.filter(has_text=id + ' ·').first.click()
            page.wait_for_function('v=>window.sent.some(m=>m.type==="triage:rendered"&&m.issueId===v.id&&m.token!==v.previous)', arg={'id': id, 'previous': previous}, timeout=30000)
        def settle():
            previous = None
            for _ in range(540):
                value = request('/state').get('investigation')
                if value and value['phase'] != previous:
                    previous = value['phase']
                    print(json.dumps({'phase': previous, 'error': value.get('error')}), flush=True)
                if value and value['phase'] in ['ready', 'blocked', 'provider-required']:
                    return value
                page.wait_for_timeout(1000)
            raise RuntimeError('Provider did not reach its stopping condition.')

        page.goto(host['origin'])
        page.wait_for_function('() => window.hostMessages.some(m=>m.type==="triage:library")')
        select('I-01')
        page.wait_for_timeout(300)
        capture('opened')
        draft = settle()
        output.with_name(output.stem + '-draft.json').write_text(json.dumps({'extension': host['productionExtension'], 'version': host['productionVersion'], 'provider': 'controlled fixture' if args.fixture_model else args.provider, 'draft': draft}, indent=2))
        if not args.baseline:
            state = request('/state')
            first = state['lastLoad']['state']['cards'][0]
            assert first['contract'] == 'ReservationBook' and first['startLine'] == 14
            assert page.locator('[data-reading-group="start"] button.primary').inner_text() == 'Read code'
            if args.fixture_model:
                assert draft['phase'] == 'ready', draft.get('error')
                assert draft['claims'][0]['status'] == 'contradicted'
                note = next(e for e in draft['evidence'] if e['id'] == 'credit-record')
                assert note['explanationReview']['result'] == 'repaired'
            page.get_by_role('tab', name='Summary', exact=True).click()
            page.wait_for_timeout(250)
            capture('summary')
            page.locator('[data-reading-group="start"] button.primary').click()
            page.wait_for_timeout(250)
            assert abs(page.evaluate('snapshot().camera.scale') - 1) < .001
            capture('entry')
            if draft['phase'] == 'ready' and draft['evidence']:
                # Read code now starts the guided reader. Secondary evidence
                # editing/navigation remains available after leaving it.
                if page.locator('.guide-controls:visible').count():
                    page.locator('.guide-controls').get_by_role('button', name='Close walkthrough', exact=True).click()
                    page.locator('#triage-bar').get_by_role('button', name='Summary', exact=True).click()
                page.get_by_role('button', name='Read this note', exact=True).click()
                page.wait_for_timeout(400)
                note = next((item for item in draft['evidence'] if item['stance'] == 'contradicts'), draft['evidence'][0])
                card = page.locator('.card').filter(has=page.locator('.triage-inline-note[data-evidence-id="' + note['id'] + '"]')).first
                if card.count():
                    card.locator('.triage-explanation-body > summary').click()
                    card.locator('.triage-inline-note[data-evidence-id="' + note['id'] + '"] > summary').click()
                assert page.locator('.code-line .triage-inline-note').count() == 0
                capture('explanation')
                entry = page.locator('.inv-evidence-entry[data-evidence-id="' + note['id'] + '"]')
                entry.get_by_role('button', name='Open in editor', exact=True).click()
                page.wait_for_timeout(250)
                opened = request('/state')['opened'][-1]
                assert opened['file'] == note['source']['file'] and opened['selection']['startLine'] == note['source']['line'] - 1
                page.set_viewport_size({'width': 640, 'height': 800})
                page.get_by_role('tab', name='Summary', exact=True).click()
                page.locator('[data-reading-group="start"] button.primary').click()
                page.wait_for_timeout(200)
                capture('narrow')
                page.set_viewport_size({'width': 1440, 'height': 900})
            if args.fixture_model:
                select('I-02')
                multi = settle()
                assert [(c['id'], c['status']) for c in multi['claims']] == [('local-credit', 'contradicted'), ('remote-credit', 'unresolved')]
                page.get_by_role('tab', name='Statements', exact=True).click()
                page.locator('.inv-claims button[data-claim-id="remote-credit"]').click()
                page.wait_for_timeout(350)
                assert page.locator('.triage-inline-note[data-evidence-id="credit-record"]').count() == 0, 'Old path explanations remain visible.'
                capture('unresolved-route')
                select('I-03')
                page.wait_for_timeout(300)
                assert request('/state')['lastLoad']['state']['cards'][0]['startLine'] == 20
                assert page.locator('.triage-inline-note[data-evidence-id="remote-call"]').count() == 0
        state = request('/state')
        result = {'renderer': 'actual Solidity Flowboard 1.2.0', 'editorBoundary': 'editor I/O shim, not Electron',
            'version': state['productionVersion'], 'extension': state['productionExtension'],
            'provider': 'controlled fixture' if args.fixture_model else args.provider,
            'draft': draft, 'screenshots': screenshots, 'pageErrors': errors, 'hostErrors': state['errors']}
        output.with_suffix('.json').write_text(json.dumps(result, indent=2))
        assert not errors and not state['errors'], result
        print(json.dumps({'result': 'passed', 'phase': draft['phase'], 'screenshots': screenshots}), flush=True)
        page.evaluate('window.closing=true; clearInterval(window.timer)')
        page.wait_for_function('() => !window.polling')
        browser.close()
finally:
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
