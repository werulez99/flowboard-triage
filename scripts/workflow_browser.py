#!/usr/bin/env python3
"""Exercise the normal report -> library -> host -> native canvas roundtrip.

This is an integration IO shim, not the Electron editor. It uses the actual
importer, source catalog, TriageBoard and pinned native renderer. No graph or
review evidence is injected into the rendered finding. External --workspace
mode is read-only and never imports, saves a review, or watches request.json.
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
    parser.add_argument('--workspace', help='Read an existing report/draft/source without modifying it.')
    parser.add_argument('--complex', action='store_true', help='Import the separate sixteen-function ordinary quotation fixture.')
    parser.add_argument('--finding')
    parser.add_argument('--width', type=int, default=1440)
    parser.add_argument('--height', type=int, default=1000)
    parser.add_argument('--theme', choices=['dark', 'light', 'high-contrast'], default='dark')
    parser.add_argument('--baseline', action='store_true', help='Capture the original workflow without asserting new draft persistence.')
    args = parser.parse_args()
    if args.workspace and args.complex:
        parser.error('Choose --workspace or --complex, not both.')
    args.finding = args.finding or ('C-01' if args.complex else 'I-01')
    repository = Path(__file__).resolve().parent.parent
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    command = ['node', str(repository / 'scripts/workflow-host.js')]
    if args.workspace:
        command += ['--workspace', args.workspace]
    if args.complex:
        command += ['--complex']
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    screenshots = []
    try:
        initial = process.stdout.readline()
        if not initial:
            raise RuntimeError(process.stderr.read())
        host = json.loads(initial)

        def request(route, payload=None):
            body = None if payload is None else json.dumps(payload).encode()
            call = urllib.request.Request(host['origin'] + route, data=body,
                                          headers={'X-Workflow-Token': host['secret'], 'Content-Type': 'application/json'})
            with urllib.request.urlopen(call, timeout=30) as response:
                return json.loads(response.read())

        with sync_playwright() as playwright:
            launch = {'headless': True}
            if os.environ.get('FLOWBOARD_CHROMIUM_PATH'):
                launch['executable_path'] = os.environ['FLOWBOARD_CHROMIUM_PATH']
            browser = playwright.chromium.launch(**launch)
            page = browser.new_page(viewport={'width': args.width, 'height': args.height})
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
              }, 50);
            ''')
            page.add_init_script('document.addEventListener("DOMContentLoaded", () => document.body.classList.add(' + json.dumps('vscode-' + args.theme) + '));')

            def capture(suffix):
                filename = output.with_name(output.stem + '-' + suffix + '.png')
                page.screenshot(path=str(filename), full_page=True)
                screenshots.append(str(filename))

            def open_finding(identifier):
                previous_token = request('/state').get('token')
                page.locator('#triage-bar').get_by_role('button', name='Findings', exact=True).click()
                entries = page.locator('.triage-finding-list button')
                if entries.count() == 0:
                    entries = page.locator('.triage-drawer button').filter(has_text=identifier + ' ·')
                else:
                    entries = entries.filter(has_text=identifier + ' ·')
                entries.first.click()
                target = {'id': identifier, 'previous': previous_token}
                page.wait_for_function('target => window.hostMessages.some(message => message.type === "triage:load" && message.issueId === target.id && message.token !== target.previous)', arg=target)
                page.wait_for_function('target => window.sent.some(message => message.type === "triage:rendered" && message.issueId === target.id && message.token !== target.previous)', arg=target)
                page.wait_for_timeout(150)

            page.goto(host['origin'])
            page.wait_for_function('() => window.hostMessages.some(message => message.type === "triage:library")')
            capture('library')
            open_finding(args.finding)
            state = request('/state')
            load = state['lastLoad']
            assert state['activeId'] == args.finding
            count = page.locator('.card').count()
            assert (count >= len(load['state']['cards']) if args.workspace else count == len(load['state']['cards'])) and count > 0, {'rendered_cards': count, 'initial_cards': len(load['state']['cards']), 'readOnly': load.get('readOnly'), 'warnings': load.get('warnings')}
            assert load['validation']['semanticVerified'] is False
            if not args.baseline:
                assert load['investigation']['semanticReview'] is False
                assert load['finding'].get('triage', {}).get('claims') or load['investigation']['claims'], 'Ordinary import should prepare report statements without manual graph or JSON work.'
            assert not errors, errors
            capture('opened')

            # The native header itself must traverse the same checked host path
            # as report/evidence links, including the original line number.
            if args.workspace:
                page.locator('[data-reading-group="start"] button.primary').click()
                page.wait_for_timeout(200)
                if page.locator('.triage-reading-location:visible').count():
                    page.locator('.triage-reading-location button').first.click()
                header = page.locator('.triage-selected-source .card-meta.meta-link').first
                referenced = header.inner_text().rsplit(':', 1)
                expected_file, expected_line = referenced[0], int(referenced[1].split('-')[0].split('–')[0])
                header.click()
            else:
                first = load['state']['cards'][0]
                expected_file, expected_line = first['file'], first['startLine']
                page.locator('.card-meta.meta-link').first.click(force=True)
            page.wait_for_function('() => window.sent.some(message => message.type === "openFile")')
            page.wait_for_timeout(150)
            state = request('/state')
            assert len(state['opened']) == 1, {'opened': state['opened'], 'logs': state['logs'], 'errors': state['errors'], 'debug': state['debug'], 'received': state['received'], 'sent': page.evaluate('window.sent.filter(message => message.type === "openFile")'), 'activeToken': state['token']}
            assert state['opened'][0]['selection']['startLine'] == expected_line - 1
            assert Path(state['opened'][0]['file']).name == Path(expected_file).name

            complex_checks = None
            if args.complex:
                assert len(load['state']['cards']) == 16
                assert len(load['state']['edges']) >= 16
                assert load['finding']['status'] == 'unreviewed'
                assert all(not claim['evidence'] and claim['state'] == 'unreviewed' for claim in load['finding']['triage']['claims'])
                assert all(edge['kind'] in ['call', 'hypothesis'] for edge in load['state']['edges']), 'Direct internal calls and possible dispatch must retain different meanings.'
                assert all('non-virtual internal' in edge['reason'] for edge in load['state']['edges'] if edge['kind'] == 'call'), 'A proven internal call is not a complete execution path.'
                initial_scale = page.evaluate('() => scale')
                assert initial_scale == 1, 'A complex map should open on readable source, not an automatic fit of every card.'
                assert page.locator('.card-code').first.evaluate('node=>parseFloat(getComputedStyle(node).fontSize)') >= 13

                def inspect_named(name):
                    page.get_by_role('tab', name='Functions', exact=True).click()
                    page.get_by_label('Search mapped functions', exact=True).fill(name)
                    page.locator('.triage-flow-item').filter(has_text='QuotationDemo::' + name).first.click()
                    assert 'QuotationDemo::' + name in page.locator('#triage-inspector').inner_text()
                    assert page.evaluate('() => scale') == 1
                    assert page.locator('#triage-inspector').get_by_role('button', name='Add code note', exact=True).is_visible()
                    assert not page.locator('.guide-controls').is_visible(), 'Raw inspection must not turn an unavailable AI review into a published guide.'

                inspect_named('_calculate')
                calculation_camera = page.evaluate('() => snapshot().camera')
                page.locator('#triage-inspector .triage-prepared-calls > summary').click()
                assert 'not as a proven route' in page.locator('#triage-inspector .triage-prepared-calls').inner_text()
                assert page.locator('#triage-inspector .triage-source-candidate').filter(has_text='_standard').count() == 1
                assert page.locator('#triage-inspector .triage-source-candidate').filter(has_text='_express').count() == 1
                page.locator('#triage-inspector .triage-source-candidate').filter(has_text='_standard').click()
                assert 'QuotationDemo::_standard' in page.locator('#triage-inspector').inner_text()
                page.get_by_role('button', name='Focus neighborhood', exact=True).click()
                assert page.locator('.card.triage-dimmed').count() > 0
                assert page.locator('.card').count() == 16, 'Branch focus must not delete surrounding source context.'
                capture('standard-neighborhood')
                page.get_by_role('button', name='Show all cards', exact=True).click()
                page.get_by_role('button', name='Back', exact=True).click()
                assert 'QuotationDemo::_calculate' in page.locator('#triage-inspector').inner_text()
                assert page.evaluate('() => snapshot().camera') == calculation_camera
                page.get_by_role('button', name='Forward', exact=True).click()
                assert 'QuotationDemo::_standard' in page.locator('#triage-inspector').inner_text()
                page.get_by_role('button', name='Back', exact=True).click()
                page.locator('#triage-inspector .triage-neighbor').filter(has_text='→ _express ·').click()
                assert 'QuotationDemo::_express' in page.locator('#triage-inspector').inner_text()
                page.get_by_role('button', name='Back', exact=True).click()
                assert 'QuotationDemo::_calculate' in page.locator('#triage-inspector').inner_text()
                page.locator('#triage-inspector .triage-neighbor').last.scroll_into_view_if_needed()
                navigation_box = page.locator('.triage-inspector-navigation').bounding_box()
                tabs_box = page.locator('.triage-tabs').bounding_box()
                assert navigation_box['y'] >= tabs_box['y'] + tabs_box['height'] - 1, 'History must not overlap wrapped panel tabs.'
                assert navigation_box['y'] + navigation_box['height'] <= args.height, 'History must remain visible while reading a long branch list.'
                capture('branch-return')
                for theme in ['dark', 'light']:
                    page.evaluate('theme => { document.body.classList.remove("vscode-dark", "vscode-light", "vscode-high-contrast"); document.body.classList.add("vscode-" + theme); }', theme)
                    assert page.evaluate('() => scale') == 1
                    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                    capture('calculation-' + theme)

                # Fit is an optional overview, not the reading mode. Selecting a
                # function afterwards must restore readable source automatically.
                page.get_by_role('button', name='All functions', exact=True).click()
                overview_scale = page.evaluate('() => scale')
                assert overview_scale < initial_scale
                capture('optional-fit-overview')
                inspect_named('_finish')
                assert page.evaluate('() => scale') == 1
                capture('readable-after-fit')

                # Reopen the actual controller and verify restored source/history.
                page.wait_for_function('() => window.sent.some(message => message.type === "triage:persist" && message.state.view?.selectedCard && message.state.cards.some(card => card.id === message.state.view.selectedCard && card.name === "_finish"))')
                request('/action', {'name': 'reopen'})
                page.reload()
                page.wait_for_function('() => window.hostMessages.some(message => message.type === "triage:library")')
                open_finding('C-01')
                assert 'QuotationDemo::_finish' in page.locator('#triage-inspector').inner_text()
                assert page.evaluate('() => scale') == 1
                assert page.locator('.card').count() == 16
                capture('complex-reopened')
                complex_checks = {'initial_scale': initial_scale, 'optional_fit_scale': overview_scale,
                                  'cards': 16, 'candidate_edges': len(load['state']['edges']), 'branch_history_returned': True,
                                  'source_focus_restored_after_fit': True, 'reopened_source_and_history': True,
                                  'themes_exercised': ['dark', 'light'], 'security_conclusion': 'none; ordinary unreviewed reading fixture'}
            elif args.workspace:
                # Observational only: original report, bounded source cards and
                # compiler-free source index. No generated semantic judgment.
                page.keyboard.press('Alt+5')
                capture('report')
                page.get_by_role('tab', name='Functions', exact=True).click()
                capture('source-map')
            else:
                assert load['finding']['status'] == 'unreviewed'
                page.keyboard.press('Alt+4')
                page.locator('#triage-field-actualBehavior').fill('The fictional helper applies a normal checked counter update.')
                page.get_by_role('tab', name='Functions', exact=True).click()
                page.locator('.triage-flow-item').last.click()
                page.locator('#triage-inspector').get_by_role('button', name='Add code note', exact=True).click()
                page.get_by_label('Inline note category', exact=True).select_option('behavior')
                page.locator('#triage-evidence-stance').select_option('context')
                page.locator('#triage-evidence-line').fill('13')
                page.locator('#triage-evidence-note').fill('The helper adds amount to counter. This normal source observation is not a bug verdict.')
                page.get_by_role('button', name='Add evidence', exact=True).click()
                page.wait_for_function('() => window.hostMessages.some(message => message.type === "triage:evidenceBound")')
                page.get_by_role('button', name='Save review', exact=True).click()
                page.wait_for_function('() => window.hostMessages.some(message => message.type === "triage:reviewSaved")')
                page.locator('.triage-evidence-reference').click()
                page.wait_for_function('() => window.hostMessages.some(message => message.type === "triage:evidenceInspected")')
                assert 'counter += amount' in page.locator('.triage-evidence-preview pre').inner_text()
                capture('evidence')
                state = request('/state')
                assert state['opened'][-1]['selection']['startLine'] == 12
                assert len(state['snapshots']['I-01']['state']['cards']) == 2

                # Ordinary finding switching: isolated drafts and source maps.
                open_finding('I-02')
                # The cited helper now includes its actual caller as context.
                second = request('/state')['lastLoad']['state']['cards']
                assert {card['name'] for card in second} == {'increment', '_add'}
                assert page.locator('.card').count() == len(second)
                assert page.locator('.triage-inline-note').count() == 0
                open_finding('I-01')
                page.keyboard.press('Alt+4')
                assert 'normal checked counter update' in page.locator('#triage-field-actualBehavior').input_value()
                assert page.locator('.triage-evidence-entry.context').count() == 1

                if not args.baseline:
                    unsaved_note = 'A researcher note in progress; not a saved finding verdict.'
                    page.locator('#triage-field-actualBehavior').fill(unsaved_note)
                    page.wait_for_function('text => window.sent.some(message => message.type === "triage:persist" && message.state.workingCopy?.patch.actualBehavior === text)', arg=unsaved_note)
                    page.once('dialog', lambda dialog: dialog.accept())
                    open_finding('I-02')
                    open_finding('I-01')
                    page.keyboard.press('Alt+4')
                    assert page.locator('#triage-field-actualBehavior').input_value() == unsaved_note
                    saved = json.loads((Path(host['root']) / '.flowboard/findings/I-01.json').read_text())
                    assert saved['finding']['actualBehavior'] != unsaved_note, 'A checkpoint must not silently commit a researcher assessment.'

                # Recreate the actual host/controller as a window reopen, not a
                # synthetic triage:load message. The persisted board is read back.
                request('/action', {'name': 'reopen'})
                page.reload()
                page.wait_for_function('() => window.hostMessages.some(message => message.type === "triage:library")')
                open_finding('I-01')
                assert page.locator('.triage-inline-note').count() == 1
                page.keyboard.press('Alt+4')
                assert (unsaved_note if not args.baseline else 'normal checked counter update') in page.locator('#triage-field-actualBehavior').input_value()
                capture('reopened')

                # A source-change notification must arrive through the controller
                # and the native header must stop opening stale original lines.
                navigation_count = len(request('/state')['opened'])
                camera_before = page.evaluate('() => snapshot().camera')
                request('/action', {'name': 'source-change'})
                page.wait_for_function('() => window.hostMessages.some(message => message.type === "triage:sourceStale")')
                assert page.evaluate('() => snapshot().camera') == camera_before, 'Freshness warnings must not move the researcher camera.'
                page.locator('.card-meta.meta-link').first.click(force=True)
                page.wait_for_timeout(150)
                assert len(request('/state')['opened']) == navigation_count
                capture('source-stale')

            assert not errors, errors
            final = request('/state')
            summary = {'mode': 'read-only existing workspace' if args.workspace else 'complex fictional imported report' if args.complex else 'fictional imported report',
                       'renderer': 'real pinned native Flowboard 1.2.0', 'host': 'actual TriageBoard with editor IO shim; not Electron',
                       'production_extension': {'path': host['productionExtension'], 'version': host['productionVersion']},
                       'finding': args.finding, 'cards': len(load['state']['cards']),
                       'viewport': {'width': args.width, 'height': args.height}, 'theme': args.theme,
                       'source_navigation': len(final['opened']), 'received_message_types': sorted({item['type'] for item in final['received']}),
                       'screenshots': screenshots, 'page_errors': errors, 'host_errors': final['errors'], 'complex_checks': complex_checks}
            output.with_suffix('.json').write_text(json.dumps(summary, indent=2) + '\n')
            print(json.dumps(summary, indent=2))
            page.evaluate('window.__workflowClosing=true; clearInterval(window.__workflowPollTimer)')
            page.wait_for_function('!window.__workflowIsPolling()')
            browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


if __name__ == '__main__':
    main()
