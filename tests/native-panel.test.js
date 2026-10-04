'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { createNativePanel, apiFacade, installSessionBridge } = require('../extension/native-panel');

test('API facade preserves lazy getters, own exports and original accessor receiver without enabling proposals', () => {
  let reads = 0;
  const original = { plain: 42, override: 'original' };
  Object.defineProperty(original, 'stable', { enumerable: true, get() { reads++; assert.equal(this, original); return this.plain; } });
  Object.defineProperty(original, 'tunnels', { enumerable: true, get() { throw new Error('CANNOT use API proposal: tunnels'); } });
  Object.freeze(original);
  const facade = apiFacade(original, { override: 'local' });
  assert.equal(reads, 0);
  assert.ok(Object.getOwnPropertyNames(facade).includes('stable'));
  assert.equal(facade.plain, 42); assert.equal(facade.override, 'local'); assert.equal(original.override, 'original');
  assert.equal(facade.stable, 42); assert.equal(reads, 1);
  assert.throws(() => facade.tunnels, /CANNOT use API proposal: tunnels/, 'The adapter does not bypass proposal checks when explicitly accessed.');
});

test('native source actions carry the originating finding session without mutating a frozen webview API', () => {
  const messages = [], api = Object.freeze({
    postMessage(message) { assert.equal(this, api); messages.push(message); },
    getState() { assert.equal(this, api); return 'retained native state'; },
    setState(value) { assert.equal(this, api); return value; }
  });
  const context = vm.createContext({ acquireVsCodeApi: () => api });
  vm.runInContext(`(${installSessionBridge.toString()})(); globalThis.wrapped = acquireVsCodeApi();`, context);
  assert.notEqual(context.wrapped, api);
  assert.equal(context.wrapped.getState(), 'retained native state');
  assert.equal(context.wrapped.setState('next'), 'next');
  context.__flowboardTriageSession = { issueId: 'A', token: 'session-A' };
  for (const type of ['openFile', 'expand', 'annotate']) context.wrapped.postMessage({ type });
  context.__flowboardTriageSession = { issueId: 'B', token: 'session-B' };
  context.wrapped.postMessage({ type: 'openFile' });
  context.wrapped.postMessage({ type: 'persist', state: {} });
  assert.deepEqual(messages.slice(0, 3).map(message => [message.issueId, message.token]), [['A', 'session-A'], ['A', 'session-A'], ['A', 'session-A']]);
  assert.equal(messages[3].token, 'session-B'); assert.equal(messages[4].token, undefined);
});

test('late optional native annotations cannot leak into a different finding', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  const upstream = path.resolve(process.env.FLOWBOARD_EXTENSION_PATH), tool = path.resolve(__dirname, '../extension');
  const messages = [], handlers = [], errors = [], uri = fsPath => ({ fsPath, toString: () => fsPath }), disposable = () => ({ dispose() {} });
  const vscode = {
    ViewColumn: { Beside: 2 }, Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { showErrorMessage: message => errors.push(message), createWebviewPanel: () => ({ visible: true, onDidDispose: disposable, dispose() {}, webview: {
      html: '', cspSource: 'fixture:', asWebviewUri: value => value.toString(), onDidReceiveMessage: handler => { handlers.push(handler); return disposable(); },
      postMessage: async message => { messages.push(message); return true; }
    } }) }
  };
  // Real extension-host namespaces contain enumerable proposal-gated getters.
  // Plain object spread reads all of them, even when the panel needs none.
  let proposalReads = 0;
  for (const [namespace, key] of [[vscode, 'unusedProposal'], [vscode.workspace, 'tunnels'], [vscode.window, 'unusedWindowProposal']]) {
    Object.defineProperty(namespace, key, { enumerable: true, get() { proposalReads++; throw new Error('CANNOT use API proposal: ' + key); } });
    Object.freeze(namespace);
  }
  let complete, fail;
  const original = Module._load;
  Module._load = function(name, parent, ...rest) {
    if (name === './aiRunner' && parent?.filename === path.join(upstream, 'out/flowboardPanel.js')) {
      return { getAnnotations: () => new Promise((resolve, reject) => { complete = resolve; fail = reject; }) };
    }
    return original.call(this, name, parent, ...rest);
  };
  t.after(() => { Module._load = original; });
  const panel = createNativePanel(vscode, { extensionUri: uri(tool), extensionPath: tool }, { extensionPath: upstream, extensionUri: uri(upstream) }, path.resolve(__dirname, '../examples/project'));
  assert.equal(proposalReads, 0, 'Creating the real upstream panel never touches unused proposal getters.');
  const nativeScript = panel.panel.webview.html.search(/<script[^>]+src="[^"]*flowboard\.js/);
  assert.ok(nativeScript > panel.panel.webview.html.indexOf('installSessionBridge'), 'The adapter runs before native acquireVsCodeApi.');
  panel.triageToken = 'finding-session-1'; panel.triageFindingId = 'fixture';
  let current = true;
  const checked = { source: { file: 'src/Demo.sol', line: 8, endLine: 10, sourceHash: 'a'.repeat(64) }, isCurrent: () => current };
  const request = () => panel.annotate('c1', 'increment', 'fictional code', null, 8, 10, checked);
  assert.throws(() => panel.annotate('c1', 'increment', 'unchecked text', null, 8, 10), /checked current source/);
  const first = request();
  panel.triageToken = 'finding-session-2';
  complete({ summary: 'Old finding annotation', items: [] }); await first;
  assert.equal(messages.length, 0);
  const second = request();
  complete({ summary: 'Current finding annotation', items: [] }); await second;
  assert.equal(messages[0].summary, 'Current finding annotation');
  assert.equal(messages[0].unverified, true); assert.equal(messages[0].provenance, 'native-model');
  assert.deepEqual(messages[0].source, checked.source);
  const lateFailure = request();
  panel.triageToken = 'finding-session-3'; fail(new Error('Old model request failed')); await lateFailure;
  assert.equal(errors.length, 0, 'A failed old native model request cannot display an error over the current finding.');
  assert.equal(messages.length, 1);
  const staleResult = request();
  panel.triageSourceStale = true; complete({ summary: 'No longer current source', items: [] }); await staleResult;
  assert.equal(messages.filter(item => item.type === 'annotations').length, 1, 'Source changes suppress in-flight annotations even within the same finding.');
  assert.equal(messages.at(-1).type, 'aiError', 'A still-visible stale card has its pending button cleared, not its source rows.');
  panel.triageSourceStale = false;
  const changedWithoutWatcher = request(); current = false;
  complete({ summary: 'Target hash no longer matches', items: [] }); await changedWithoutWatcher;
  assert.equal(messages.filter(item => item.type === 'annotations').length, 1, 'The result repeats the source check rather than relying only on watcher events.');
  current = true;
  const currentFailure = request(); fail(new Error('Fictional provider failure')); await currentFailure;
  assert.equal(messages.at(-1).type, 'aiError'); assert.match(messages.at(-1).error, /Fictional provider failure/);
  assert.equal(errors.length, 1);
  const opens = []; panel.onOpenSource(message => opens.push(message)); panel.triageFindingId = 'fixture'; panel.triageSourceStale = false;
  const source = { type: 'openFile', fsPath: path.join(tool, '../examples/project/src/Demo.sol'), startLine: 8, issueId: 'fixture', token: panel.triageToken };
  handlers[0]({ ...source, token: undefined }); handlers[0]({ ...source, token: 'finding-session-1' }); handlers[0]({ ...source, issueId: 'another' });
  assert.equal(opens.length, 0, 'Native source messages must carry the actual current finding session.');
  handlers[0](source); assert.deepEqual(opens, [source], 'Current source clicks are handed to the companion guards, never upstream openFile.');
  let companionMessages = 0;
  panel.panel.webview.onDidReceiveMessage(() => companionMessages++);
  handlers.forEach(handler => handler(source));
  assert.equal(opens.length, 2, 'A single event is forwarded once even after the companion registers its own listener.');
  assert.equal(companionMessages, 1);
  const annotationRequests = []; panel.onAnnotateSource(message => annotationRequests.push(message));
  const annotation = { ...source, type: 'annotate', id: 'c1', code: 'Untrusted webview code' };
  handlers.forEach(handler => handler(annotation));
  assert.deepEqual(annotationRequests, [annotation], 'Native annotation events go once to the checked companion handler, not directly to a provider.');
});
