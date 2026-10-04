#!/usr/bin/env python3
"""Capture real-provider reading quality; never grade reasoning by JSON/keywords.

Uses the normal importer, selection, generation and challenge in the actual
controller/native renderer, with editor IO shimmed. It does not load the oracle.
Each case gets a fresh temporary project; saved private findings are untouched.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright


def run_case(case, output, provider, recording=None):
    repo = Path(__file__).resolve().parent.parent
    target = output / case
    target.mkdir(parents=True, exist_ok=False)
    record = {'case': case, 'provider': provider, 'reasoningReview': 'not graded by harness',
              'boundary': 'Actual product and native renderer; editor I/O shim, not a Cursor window.',
              'fixtureHashes': {str(f.relative_to(repo)): hashlib.sha256(f.read_bytes()).hexdigest()
                                for f in sorted((repo / 'scripts/fixtures/quality-cases' / case).rglob('*')) if f.is_file()}}
    command = ['node', str(repo / 'scripts/workflow-host.js'), '--quality-case', case, '--provider', provider]
    if recording:
        command += ['--quality-recording', recording]
        record['reopenedRecording'] = recording
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        initial = process.stdout.readline()
        if not initial:
            raise RuntimeError(process.stderr.read())
        host = json.loads(initial)
        record.update(extension=host['productionExtension'], version=host['productionVersion'])

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
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            page_errors = []
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            page.expose_function('__qualitySend', lambda message: request('/message', message))
            page.expose_function('__qualityPoll', lambda cursor: request('/events?after=' + str(cursor)))
            page.add_init_script('''
              window.sent=[]; window.hostMessages=[];
              window.acquireVsCodeApi=()=>({postMessage(m){if(!window.closing){window.sent.push(m);return window.__qualitySend(m);}}});
              let cursor=0; window.polling=false;
              window.timer=setInterval(async()=>{if(window.polling||window.closing)return;window.polling=true;
                try{let batch=await window.__qualityPoll(cursor);cursor=batch.cursor;
                  for(let m of batch.messages){window.hostMessages.push(m);window.dispatchEvent(new MessageEvent('message',{data:m}));}
                }finally{window.polling=false;}},100);
            ''')
            page.goto(host['origin'])
            page.wait_for_function('() => window.hostMessages.some(m=>m.type==="triage:library")')
            def select():
                page.locator('#triage-bar').get_by_role('button', name='Findings', exact=True).click()
                entries = page.locator('.triage-finding-list button')
                if entries.count() == 0:
                    entries = page.locator('.triage-drawer button')
                entries.filter(has_text='I-01 ·').first.click()
            select()
            page.wait_for_function('() => window.sent.some(m=>m.type==="triage:rendered"&&m.issueId==="I-01")', timeout=90000)
            record['initial'] = request('/state')['lastLoad']
            page.screenshot(path=str(target / 'opened.png'))
            deadline, last_phase = time.monotonic() + 600, None
            while time.monotonic() < deadline:
                state = request('/state')
                draft = state.get('investigation')
                phase = (draft or {}).get('phase')
                if phase != last_phase:
                    last_phase = phase
                    print(json.dumps({'case': case, 'phase': phase, 'at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}), flush=True)
                if phase in ['ready', 'blocked', 'provider-required']:
                    break
                page.wait_for_timeout(1000)
            else:
                record['runError'] = 'Harness timeout; no quality conclusion.'
            state = request('/state')
            record.update(draft=state.get('investigation'), providerCalls=state['providerCalls'], hostErrors=state['errors'])
            # Preserve actual results before attempting optional UI navigation.
            (target / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
            page.get_by_role('tab', name='Statements', exact=True).click()
            page.wait_for_timeout(300)
            page.screenshot(path=str(target / 'statements.png'))
            record['visibleText'] = page.locator('.triage-drawer').inner_text()
            if record.get('draft', {}).get('phase') == 'ready':
                buttons = page.locator('.triage-drawer').get_by_role('button', name='Read code', exact=True)
                if buttons.count():
                    buttons.first.click()
                    page.wait_for_timeout(350)
                    page.screenshot(path=str(target / 'code.png'))
                declarations = {unit['id'] for unit in record['draft']['sources'] if unit.get('contextKind') == 'state'}
                note = next((item for item in record['draft']['evidence'] if item['sourceId'] in declarations), None)
                if note:
                    page.locator('.inv-claims button[data-claim-id="' + note['claimId'] + '"]').click()
                    entry = page.locator('.inv-evidence-entry[data-evidence-id="' + note['id'] + '"]')
                    entry.get_by_role('button').first.click()
                    page.wait_for_timeout(300)
                    card = page.locator('.card').filter(has=page.locator('.triage-inline-note[data-evidence-id="' + note['id'] + '"]')).first
                    card.locator('.triage-explanation-body > summary').click()
                    card.locator('.triage-inline-note[data-evidence-id="' + note['id'] + '"] > summary').click()
                    assert page.locator('.code-line .triage-inline-note').count() == 0
                    page.screenshot(path=str(target / 'declaration.png'))
                    entry.get_by_role('button', name='Open in editor', exact=True).click()
                    page.wait_for_timeout(200)
                    opened = request('/state')['opened'][-1]
                    assert opened['file'] == note['source']['file']
                    assert opened['selection']['startLine'] == note['source']['line'] - 1
                    record['declarationNavigation'] = opened
                    page.wait_for_timeout(600)  # Let the normal canvas autosave complete.
                before_runs = len(request('/state')['providerCalls'])
                before_draft = request('/state')['investigation']
                request('/action', {'name': 'reopen'})
                page.reload()
                page.wait_for_function('() => window.hostMessages.some(m=>m.type==="triage:library")')
                select()
                page.wait_for_function('() => window.sent.some(m=>m.type==="triage:rendered"&&m.issueId==="I-01")', timeout=90000)
                page.wait_for_timeout(500)
                reopened = request('/state')
                record['reopen'] = {'noNewProviderCalls': len(reopened['providerCalls']) == before_runs,
                                    'sameClaims': reopened['investigation']['claims'] == before_draft['claims'],
                                    'manualFindingStatus': reopened['lastLoad']['finding']['status']}
                if note:
                    restored = next(card for card in reopened['lastLoad']['state']['cards']
                                    if card.get('kind') == 'context' and card.get('startLine') == note['source']['line'])
                    assert not restored.get('notFound') and note['quote'] in restored['code']
                    record['reopen']['declarationRestored'] = True
                    page.screenshot(path=str(target / 'reopened.png'))
            record['pageErrors'] = page_errors
            page.evaluate('window.closing=true; clearInterval(window.timer)')
            page.wait_for_function('() => !window.polling')
            browser.close()
    except Exception as error:
        record['runError'] = str(error)
    finally:
        (target / 'result.json').write_text(json.dumps(record, indent=2) + '\n')
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    print(json.dumps({'case': case, 'phase': record.get('draft', {}).get('phase'), 'error': record.get('runError'),
                      'review': 'Actual explanation still requires independent source review.'}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cases', nargs='+', required=True, choices=['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'h1', 'h2', 'h3'])
    parser.add_argument('--output', required=True)
    parser.add_argument('--provider', default='codex', choices=['none', 'codex', 'claude'])
    parser.add_argument('--reopen-recording', help='Reopen one saved real result on the identical fictional case, without new AI calls.')
    args = parser.parse_args()
    if args.reopen_recording and (len(args.cases) != 1 or args.provider != 'none'):
        parser.error('Reopening a recording requires one case and --provider none.')
    for case in args.cases:
        run_case(case, Path(args.output), args.provider, args.reopen_recording)


if __name__ == '__main__':
    main()
