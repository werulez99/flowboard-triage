'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const p = require('./protocol');

// VS Code/Cursor expose proposal-gated getters on API namespaces. Spreading a
// namespace eagerly reads those getters and can fail before any panel opens.
// Preserve own descriptors for upstream's __importStar, and evaluate accessors
// only when explicitly used, with their original receiver. Do not mutate the API.
function apiFacade(target, overrides) {
  const descriptors = Object.getOwnPropertyDescriptors(target);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if ('get' in descriptor || 'set' in descriptor) descriptors[key] = {
      ...descriptor, get: descriptor.get?.bind(target), set: descriptor.set?.bind(target)
    };
  }
  for (const [key, value] of Object.entries(overrides)) descriptors[key] = { value, enumerable: true, configurable: true, writable: true };
  return Object.create(Object.getPrototypeOf(target), descriptors);
}

function createNativePanel(vscode, context, upstream, root) {
  const filename = path.join(upstream.extensionPath, 'out/flowboardPanel.js');
  const nativeRequire = Module.createRequire(filename);
  const annotations = new AsyncLocalStorage();
  let native;
  const api = apiFacade(vscode, { workspace: apiFacade(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root) }] }),
    window: apiFacade(vscode.window, { createWebviewPanel: (_type, _title, column, options) => {
      const real = vscode.window.createWebviewPanel('flowboardTriageCanvas', 'Flowboard Triage', column, {
        ...options, localResourceRoots: [...options.localResourceRoots, vscode.Uri.joinPath(context.extensionUri, 'webview')]
      });
      const webview = new Proxy(real.webview, { get(target, key) {
        if (key === 'postMessage') return message => {
          // Optional upstream annotation requests can complete after the user
          // switches/reloads a finding. Never apply their old c1/c2 IDs to a
          // new board with reused expansion IDs.
          const session = annotations.getStore();
          if (session && session.token !== native?.triageToken) return Promise.resolve(false);
          return target.postMessage(message);
        };
        if (key === 'onDidReceiveMessage') return (callback, ...rest) => target.onDidReceiveMessage(message => {
          // The original singleton's untagged persistence would mix findings.
          // Our bridge sends tagged snapshots and owns per-finding storage instead.
          if (message?.type === 'persist') return;
          if (message?.type === 'openFile') {
            try { if (!p.contained(fs.realpathSync(root), fs.realpathSync(message.fsPath))) return; } catch { return; }
          }
          callback(message);
        }, ...rest);
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      }, set: (target, key, value) => Reflect.set(target, key, value) });
      return new Proxy(real, { get(target, key) {
        if (key === 'webview') return webview;
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      }, set: (target, key, value) => Reflect.set(target, key, value) });
    } }) });
  const exports = {};
  vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename })(exports,
    name => name === 'vscode' ? api : nativeRequire(name), { exports }, filename, path.dirname(filename));
  // Module-local class: upstream's singleton, installed files and saved board
  // are never replaced. The native HTML/CSS/JS and all canvas controls are reused.
  native = new exports.FlowboardPanel({ extensionUri: upstream.extensionUri,
    workspaceState: { get: () => null, update: async () => {} } });
  const annotate = native.annotate.bind(native);
  native.annotate = (...args) => annotations.run({ token: native.triageToken }, () => annotate(...args));
  const nonce = crypto.randomBytes(16).toString('hex');
  const script = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'triage.js'));
  const reader = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'report-view.js'));
  const reviewer = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'review-model.js'));
  const claims = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'claim-model.js'));
  const claimView = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'claim-view.js'));
  const inline = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'inline-review.js'));
  const style = fs.readFileSync(path.join(context.extensionPath || context.extensionUri.fsPath, 'webview/triage.css'), 'utf8');
  // Add a second nonce to the existing CSP. No unsafe scripts, CDNs or external
  // report renderers are introduced. Report text only enters textContent.
  native.panel.webview.html = native.panel.webview.html
    .replace(/(script-src[^;\"]+)/, `$1 'nonce-${nonce}'`)
    .replace('</head>', `<style>${style}</style></head>`)
    .replace('</body>', `<script nonce="${nonce}" src="${reader}"></script><script nonce="${nonce}" src="${claims}"></script><script nonce="${nonce}" src="${reviewer}"></script><script nonce="${nonce}" src="${inline}"></script><script nonce="${nonce}" src="${claimView}"></script><script nonce="${nonce}" src="${script}"></script></body>`);
  return native;
}
module.exports = { createNativePanel, apiFacade };
