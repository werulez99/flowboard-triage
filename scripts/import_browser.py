#!/usr/bin/env python3
"""Actual native renderer import-list regression; editor/file picker IO is simulated.

Uses only the repository's fictional report. No provider or private source.
The registered Import Report command is separately tested in extension-session.test.js.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import urllib.request
from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(['node', str(Path(__file__).with_name('workflow-host.js')), '--defer-mapping'],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        initial = process.stdout.readline()
        if not initial:
            raise RuntimeError(process.stderr.read())
        host = json.loads(initial)

        def request(route, payload=None):
            call = urllib.request.Request(host['origin'] + route,
                data=None if payload is None else json.dumps(payload).encode(),
                headers={'X-Workflow-Token': host['secret'], 'Content-Type': 'application/json'})
            with urllib.request.urlopen(call, timeout=30) as response:
                return json.loads(response.read())

        with sync_playwright() as playwright:
            launch = {'headless': True}
            if os.environ.get('FLOWBOARD_CHROMIUM_PATH'):
                launch['executable_path'] = os.environ['FLOWBOARD_CHROMIUM_PATH']
            browser = playwright.chromium.launch(**launch)
            page = browser.new_page(viewport={'width': 1280, 'height': 800})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.expose_function('__send', lambda message: request('/message', message))
            page.expose_function('__poll', lambda cursor: request('/events?after=' + str(cursor)))
            page.add_init_script('''
                window.acquireVsCodeApi = () => ({ postMessage: message => window.__send(message) });
                let cursor = 0, busy = false;
                window.importPoll = setInterval(async () => {
                  if (busy) return; busy = true;
                  try {
                    const batch = await window.__poll(cursor); cursor = batch.cursor;
                    for (const message of batch.messages) window.dispatchEvent(new MessageEvent('message', {data: message}));
                  } finally { busy = false; }
                }, 50);
                document.addEventListener('DOMContentLoaded', () => document.body.classList.add('vscode-dark'));
            ''')
            page.goto(host['origin'])
            hint = page.get_by_text('Choose a finding to prepare its code and walkthrough. Your saved reviews are kept.', exact=True)
            hint.wait_for()
            assert all(issue['mappingPending'] for issue in request('/state')['library'])
            assert page.locator('.card').count() == 0
            page.screenshot(path=str(output / 'import-list.png'))
            page.locator('.triage-drawer button').filter(has_text='I-01 ·').first.click()
            page.wait_for_function('() => document.querySelectorAll(".card").length > 0')
            assert request('/state')['activeId'] == 'I-01'
            page.locator('#triage-bar').get_by_role('button', name='Summary', exact=True).click()
            # Open Findings / import completion must reveal the list even when
            # a different drawer was already open. It must not reset the board.
            request('/action', {'name': 'library'})
            page.wait_for_function('() => document.querySelector(".triage-drawer").dataset.tab === "findings"')
            hint.wait_for()
            assert request('/state')['activeId'] == 'I-01'
            assert not request('/state')['providerCalls']
            page.screenshot(path=str(output / 'reopened-list.png'))
            assert not errors, errors
            assert not request('/state')['errors'], request('/state')['errors']
            page.evaluate('clearInterval(window.importPoll)')
            browser.close()
        print(json.dumps({'renderer': 'native Flowboard', 'editorIO': 'simulated', 'version': host['productionVersion'],
                          'checks': ['deferred list visible', 'selection maps code', 'library returns from another tab', 'no provider calls', 'no renderer errors']}))
    finally:
        process.terminate()
        process.communicate(timeout=15)


if __name__ == '__main__':
    main()
