'use strict';
// Produce the actual native-backed HTML and a harmless source model for browser
// tests. No editor/account credentials and no real engagement data are used.
const path = require('node:path');
const { createNativePanel } = require('../extension/native-panel');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
const { layoutGraph } = require('../extension/graph');
async function main() {
  const upstreamPath = process.env.FLOWBOARD_EXTENSION_PATH;
  if (!upstreamPath) throw new Error('Set FLOWBOARD_EXTENSION_PATH for the real native renderer fixture.');
  const origin = process.argv[2];
  const root = path.resolve(__dirname, '../examples/project');
  const tool = path.resolve(__dirname, '../extension');
  const uri = file => ({ fsPath: file, toString: () => file });
  const disposable = () => ({ dispose() {} });
  let html = '';
  const vscode = { ViewColumn: { Beside: 2 }, Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { createWebviewPanel: () => ({ visible: true, onDidDispose: disposable, dispose() {}, webview: {
      get html() { return html; }, set html(value) { html = value; }, cspSource: origin,
      asWebviewUri: value => `${origin}/${value.fsPath.startsWith(tool) ? 'tool' : 'native'}/${path.basename(value.fsPath)}`,
      onDidReceiveMessage: disposable, postMessage: async () => true
    } }) } };
  createNativePanel(vscode, { extensionUri: uri(tool), extensionPath: tool }, { extensionPath: upstreamPath, extensionUri: uri(upstreamPath) }, root);
  const { runner, result } = await analyze(upstreamPath, root, { mode: 'source' });
  const catalog = new SourceCatalog(root, runner, result);
  const draft = require('../examples/finding.json');
  const prefix = 'finding:I-01:';
  const fns = draft.cards.map(card => catalog.resolveCard(card));
  const cards = fns.map((fn, i) => ({ ...fn, id: prefix + draft.cards[i].id, code: catalog.code(fn), fsPath: fn.file, file: path.basename(fn.file), notFound: false }));
  const edges = [{ from: prefix + 'entry', to: prefix + 'update', kind: 'call', reason: 'Direct internal source call in the fictional fixture.' }];
  layoutGraph(cards, edges);
  const message = { type: 'triage:load', issueId: 'I-01', token: 'browser-demo-1', fingerprint: 'demo',
    finding: draft.finding, state: { cards, edges, notes: [], camera: { scale: 1, panX: 0, panY: 0 } }, connections: edges,
    library: [{ id: 'I-01', title: draft.finding.title, severity: 'Info', status: 'unreviewed', mapped: true, files: ['src/Demo.sol'], anchors: draft.cards.map(card => ({ file: card.file, line: card.line, function: card.function })) },
      { id: 'I-02', title: 'A different source context', severity: 'Info', status: 'unreviewed', mapped: true, files: ['src/Demo.sol'], anchors: [{ file: 'src/Demo.sol', line: 12, function: '_add' }] }],
    reportText: ['## Fictional review — normal counter update', '', '**Severity**: Informational', '', '**Description**:',
      'The public `increment(amount)` operation invokes an internal helper to update the stored counter. This is a reading fixture, not a vulnerability claim.', '',
      '**Source references**:', 'Inspect `src/Demo.sol:8` and `src/Demo.sol:12` in the current checkout.', '',
      '**Normal source behavior**:', '1. Read the public entry function and its input.', '2. Inspect the internal update and compare it with the intended behavior.', '',
      '```solidity', 'increment(amount);', '// Inspect the normal internal update, not an attack.', '```', '',
      '**Review questions**:', '- Does the current source match the report revision?', '- Is the claimed behavior a bug or an intended design?', '',
      '| Anchor | Role |', '| --- | --- |', '| increment | Public entry |', '| _add | Internal state update |', '',
      '**Untrusted report content**:', '<img src=x onerror="window.reportInjected=true">', '[Example](javascript:window.reportInjected=true)',
      '> A source call is not proof that a reported bug is valid.'].join('\n'), unresolved: [], warnings: [],
    validation: { cards: 2, sourceCalls: 1, downgradedCalls: 0, semanticVerified: false },
    hints: Object.fromEntries(fns.map((fn, i) => [cards[i].id, { ...catalog.hints(fn), description: draft.cards[i].description, mapping: { method: i ? 'source-neighbor' : 'description', confidence: 'low' } }])),
    git: { head: '0123456789abcdef', dirty: false }, diagnostics: { mode: 'source' } };
  process.stdout.write(JSON.stringify({ html, message }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
