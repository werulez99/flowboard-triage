'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { createNativePanel, apiFacade } = require('../extension/native-panel');

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

test('late optional native annotations cannot leak into a different finding', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  const upstream = path.resolve(process.env.FLOWBOARD_EXTENSION_PATH), tool = path.resolve(__dirname, '../extension');
  const messages = [], uri = fsPath => ({ fsPath, toString: () => fsPath }), disposable = () => ({ dispose() {} });
  const vscode = {
    ViewColumn: { Beside: 2 }, Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { showErrorMessage() {}, createWebviewPanel: () => ({ visible: true, onDidDispose: disposable, dispose() {}, webview: {
      html: '', cspSource: 'fixture:', asWebviewUri: value => value.toString(), onDidReceiveMessage: disposable,
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
  let complete;
  const original = Module._load;
  Module._load = function(name, parent, ...rest) {
    if (name === './aiRunner' && parent?.filename === path.join(upstream, 'out/flowboardPanel.js')) {
      return { getAnnotations: () => new Promise(resolve => { complete = resolve; }) };
    }
    return original.call(this, name, parent, ...rest);
  };
  t.after(() => { Module._load = original; });
  const panel = createNativePanel(vscode, { extensionUri: uri(tool), extensionPath: tool }, { extensionPath: upstream, extensionUri: uri(upstream) }, path.resolve(__dirname, '../examples/project'));
  assert.equal(proposalReads, 0, 'Creating the real upstream panel never touches unused proposal getters.');
  panel.triageToken = 'finding-session-1';
  const first = panel.annotate('c1', 'increment', 'fictional code', null, 8, 10);
  panel.triageToken = 'finding-session-2';
  complete({ summary: 'Old finding annotation', items: [] }); await first;
  assert.equal(messages.length, 0);
  const second = panel.annotate('c1', 'increment', 'fictional code', null, 8, 10);
  complete({ summary: 'Current finding annotation', items: [] }); await second;
  assert.equal(messages[0].summary, 'Current finding annotation');
});
