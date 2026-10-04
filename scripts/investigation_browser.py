#!/usr/bin/env python3
"""Real controller/provider/renderer with an explicit editor-I/O shim.

No supplied graph or model answer. Selection is through the finding library.
--record-investigation writes only the generated investigation draft; existing
report drafts and manual judgments remain protected by workflow-host.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace')
    parser.add_argument('--finding', default='I-01')
    parser.add_argument('--provider', choices=['none', 'claude', 'codex'], default='none')
    parser.add_argument('--record-investigation', action='store_true')
    parser.add_argument('--run-test', help='Select an already-discovered existing regression by its exact function name.')
    parser.add_argument('--output', required=True)
    parser.add_argument('--retry', action='store_true')
    parser.add_argument('--correction', help='Apply a conditions correction through the normal UI, then verify reassessment and persistence.')
    args = parser.parse_args()
    repository = Path(__file__).resolve().parent.parent
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    command = ['node', str(repository / 'scripts/workflow-host.js'), '--provider', args.provider]
    if args.workspace:
        command += ['--workspace', args.workspace]
    if args.record_investigation:
        command.append('--record-investigation')
    if args.run_test:
        command.append('--allow-existing-regression')
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    screenshots = []
    try:
        initial = process.stdout.readline()
        if not initial:
            raise RuntimeError(process.stderr.read())
        host = json.loads(initial)

        def request(route, payload=None):
            body = None if payload is None else json.dumps(payload).encode()
            call = urllib.request.Request(host['origin'] + route, data=body, headers={
                'X-Workflow-Token': host['secret'], 'Content-Type': 'application/json'})
            with urllib.request.urlopen(call, timeout=60) as response:
                return json.loads(response.read())

        with sync_playwright() as playwright:
            launch = {'headless': True}
            if os.environ.get('FLOWBOARD_CHROMIUM_PATH'):
                launch['executable_path'] = os.environ['FLOWBOARD_CHROMIUM_PATH']
            browser = playwright.chromium.launch(**launch)
            page = browser.new_page(viewport={'width': 1440, 'height': 900})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.expose_function('__workflowSend', lambda message: request('/message', message))
            page.expose_function('__workflowPoll', lambda cursor: request('/events?after=' + str(cursor)))
            page.add_init_script('''
              window.sent = []; window.hostMessages = [];
              window.acquireVsCodeApi = () => Object.freeze({
                postMessage(message) { if (window.__workflowClosing) return; window.sent.push(message); return window.__workflowSend(message); }
              });
              let cursor = 0, polling = false;
              window.__workflowIsPolling = () => polling;
              window.__workflowPollTimer = setInterval(async () => {
                if (polling) return; polling = true;
                try {
                  const batch = await window.__workflowPoll(cursor); cursor = batch.cursor;
                  for (const message of batch.messages) {
                    window.hostMessages.push(message);
                    window.dispatchEvent(new MessageEvent('message', {data: message}));
                  }
                } finally { polling = false; }
              }, 75);
            ''')

            def capture(name):
                filename = output.with_name(output.stem + '-' + name + '.png')
                page.screenshot(path=str(filename), full_page=True)
                screenshots.append(str(filename))

            def select():
                previous = request('/state').get('token')
                page.locator('#triage-bar').get_by_role('button', name='Findings', exact=True).click()
                entries = page.locator('.triage-finding-list button')
                if entries.count() == 0:
                    entries = page.locator('.triage-drawer button')
                entries.filter(has_text=args.finding + ' ·').first.click()
                page.wait_for_function('target => window.sent.some(m => m.type === "triage:rendered" && m.issueId === target.id && m.token !== target.prior)', arg={'id': args.finding, 'prior': previous}, timeout=120000)
                page.get_by_role('tab', name='Statements', exact=True).click()

            def settled():
                deadline, previous = time.monotonic() + 540, None
                while time.monotonic() < deadline:
                    page.wait_for_timeout(1000)
                    draft = request('/state').get('investigation')
                    if draft and draft['phase'] != previous:
                        previous = draft['phase']
                        print(json.dumps({'phase': previous, 'claims': len(draft['claims']), 'runs': len(draft['runs']), 'error': draft.get('error')}), flush=True)
                    if draft and draft['phase'] in ['ready', 'blocked', 'provider-required']:
                        return draft
                raise RuntimeError('Investigation did not reach a bounded stopping state.')

            page.goto(host['origin'])
            page.wait_for_function('() => window.hostMessages.some(m => m.type === "triage:library")')
            capture('library')
            select()
            capture('preparing')
            if args.retry:
                page.get_by_role('button', name='Retry code review', exact=True).click()
                page.wait_for_timeout(300)
            camera = page.evaluate('snapshot().camera')
            draft = settled()
            assert page.evaluate('snapshot().camera') == camera, 'Background analysis moved the camera.'
            capture('claims')
            if draft['claims']:
                page.locator('.inv-claims button').first.click()
                page.wait_for_timeout(500)
                first = page.locator('.inv-evidence-entry button').first
                if first.count():
                    first.click()
                    page.wait_for_timeout(500)
                capture('source-evidence')
                entry = page.locator('.inv-evidence-entry').first
                if entry.count():
                    entry.get_by_role('button', name='Open in editor', exact=True).click()
                    page.wait_for_timeout(250)
                    assert request('/state')['opened'], 'Evidence did not reach editor navigation.'
                states = page.get_by_text('State changes for this case', exact=True)
                if states.count():
                    states.click()
                    page.wait_for_timeout(150)
                    capture('transitions')
            if args.run_test:
                prior_experiments = len(draft['experiments'])
                page.locator('.inv-workbench > details').filter(has=page.locator('summary').filter(has_text='Existing checks and observations')).locator(':scope > summary').click()
                row = page.locator('.inv-test').filter(has_text='::' + args.run_test)
                assert row.count() == 1, 'The ordinary workflow did not discover this existing test.'
                row.get_by_role('button', name='Run existing regression…', exact=True).click()
                page.wait_for_timeout(400)
                if args.correction:
                    deadline = time.monotonic() + 270
                    while time.monotonic() < deadline:
                        page.wait_for_timeout(500)
                        draft = request('/state')['investigation']
                        if len(draft['experiments']) > prior_experiments:
                            break
                    else:
                        raise RuntimeError('The selected existing regression did not finish.')
                else:
                    draft = settled()
                capture('executed-check')
                assert draft['experiments'], 'Existing test execution was not recorded.'
            if args.correction:
                page.get_by_text('Correct this review', exact=True).click()
                page.get_by_label('Correct investigation field', exact=True).select_option('conditions')
                page.get_by_label('Investigation correction', exact=True).fill(args.correction)
                page.get_by_role('button', name='Save correction and reassess', exact=True).click()
                page.wait_for_timeout(1200)
                intermediate = request('/state')['investigation']
                assert intermediate['corrections'], 'The researcher correction was not saved.'
                assert any(claim.get('needsReassessment') for claim in intermediate['claims']), 'Dependent claim was not reopened before generation.'
                capture('corrected-premise')
                draft = settled()
                capture('reassessed')
                assert draft['corrections'][-1]['value'] == args.correction
                assert draft['corrections'][-1]['independentlySupported'] is False
            before = request('/state')
            if draft['phase'] == 'ready':
                page.locator('#triage-bar').get_by_role('button', name='Summary', exact=True).click()
                page.locator('[data-reading-group="start"] button.primary').click()
                page.wait_for_timeout(400)
                if page.locator('.guide-controls:visible').count():
                    capture('walkthrough')
                    page.locator('.guide-controls').get_by_role('button', name='Close walkthrough', exact=True).click()
                    page.locator('#triage-bar').get_by_role('button', name='Summary', exact=True).click()
                    page.get_by_role('tab', name='Statements', exact=True).click()
            reopen_verified = not args.workspace or args.record_investigation
            reopened = draft
            if reopen_verified:
                request('/action', {'name': 'reopen'})
                page.reload()
                page.wait_for_function('() => window.hostMessages.some(m => m.type === "triage:library")')
                select()
                reopened = settled()
                assert reopened['snapshot'] == draft['snapshot']
                assert reopened['evidence'] == draft['evidence'], 'Reopen lost generated evidence.'
                assert reopened['experiments'] == draft['experiments'], 'Reopen lost observed checks.'
            capture('reopened')
            theme_contrast = {}
            for theme in ['vscode-dark', 'vscode-high-contrast', 'vscode-light']:
                page.evaluate('theme => { document.body.classList.remove("vscode-dark", "vscode-light", "vscode-high-contrast"); document.body.classList.add(theme); }', theme)
                contrast = page.evaluate('''() => {
                  const luminance = color => color.match(/[\\d.]+/g).slice(0,3).map(Number).map(x => x/255).map(x => x <= .04045 ? x/12.92 : ((x+.055)/1.055)**2.4).reduce((sum, x, i) => sum + x * [.2126,.7152,.0722][i], 0);
                  const result = {};
                  for (const selector of ['.inv-navigation', '.inv-status', '.inv-claims button[aria-pressed="true"]']) {
                    const node = document.querySelector(selector); if (!node) continue;
                    const style = getComputedStyle(node), a = luminance(style.color), b = luminance(style.backgroundColor);
                    result[selector] = (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
                  }
                  return result;
                }''')
                assert all(value >= 4.5 for value in contrast.values()), f'Unreadable investigation theme {theme}: {contrast}'
                theme_contrast[theme] = contrast
                if theme == 'vscode-light':
                    capture('light')
            page.set_viewport_size({'width': 1050, 'height': 768})
            capture('laptop')
            state = request('/state')
            result = {'hostBoundary': 'Actual extension controller/native webview with editor I/O shim, not a full Cursor window.',
                      'extension': host['productionExtension'], 'version': host['productionVersion'],
                      'finding': args.finding, 'draft': reopened, 'opened': before['opened'],
                      'pageErrors': errors, 'hostErrors': state['errors'], 'screenshots': screenshots,
                      'backgroundCameraPreserved': True, 'reopened': reopen_verified, 'themeContrast': theme_contrast}
            output.write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps({'result': str(output), 'phase': reopened['phase'], 'pageErrors': errors, 'hostErrors': state['errors']}), flush=True)
            assert not errors, errors
            assert not state['errors'], state['errors']
            page.evaluate('window.__workflowClosing=true; clearInterval(window.__workflowPollTimer)')
            page.wait_for_function('!window.__workflowIsPolling()')
            browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == '__main__':
    main()
