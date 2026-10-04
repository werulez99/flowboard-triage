'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

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

// Run before the pinned native script acquires its API. The native API object
// can be frozen, so wrap it instead of mutating postMessage in the webview.
// Only native source actions need tags; native persistence is intentionally
// handled by the companion's own finding-scoped bridge.
function installSessionBridge() {
  const acquire = globalThis.acquireVsCodeApi;
  globalThis.acquireVsCodeApi = function(...args) {
    const api = Reflect.apply(acquire, this, args), descriptors = Object.getOwnPropertyDescriptors(api);
    for (const key of Reflect.ownKeys(descriptors)) {
      const value = descriptors[key];
      if (typeof value.value === 'function') value.value = value.value.bind(api);
      if (value.get) value.get = value.get.bind(api);
      if (value.set) value.set = value.set.bind(api);
    }
    descriptors.postMessage = { enumerable: true, configurable: true, value(message) {
      if (['openFile', 'expand', 'annotate'].includes(message?.type)) {
        const session = globalThis.__flowboardTriageSession;
        message = { ...message, issueId: session?.issueId, token: session?.token };
      }
      return api.postMessage(message);
    } };
    return Object.create(Object.getPrototypeOf(api), descriptors);
  };
}

function createNativePanel(vscode, context, upstream, root) {
  const filename = path.join(upstream.extensionPath, 'out/flowboardPanel.js');
  const nativeRequire = Module.createRequire(filename);
  const annotations = new AsyncLocalStorage();
  let native, openSource, annotateSource;
  const matchingSession = session => session.token === native?.triageToken && session.issueId === native?.triageFindingId;
  const annotationCurrent = session => {
    if (!matchingSession(session) || native?.triageSourceStale) return false;
    try { return session.isCurrent() === true; } catch { return false; }
  };
  const api = apiFacade(vscode, { workspace: apiFacade(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root) }] }),
    window: apiFacade(vscode.window, {
      showErrorMessage: (...args) => {
        const session = annotations.getStore();
        if (session && !annotationCurrent(session)) return Promise.resolve(undefined);
        return vscode.window.showErrorMessage(...args);
      },
      createWebviewPanel: (_type, _title, column, options) => {
      const real = vscode.window.createWebviewPanel('flowboardTriageCanvas', 'Flowboard Triage', column, {
        ...options, localResourceRoots: [...options.localResourceRoots, vscode.Uri.joinPath(context.extensionUri, 'webview')]
      });
      const webview = new Proxy(real.webview, { get(target, key) {
        if (key === 'postMessage') return message => {
          // Optional upstream annotation requests can complete after the user
          // switches/reloads a finding. Never apply their old c1/c2 IDs to a
          // new board with reused expansion IDs.
          const session = annotations.getStore();
          if (session) {
            if (!matchingSession(session)) return Promise.resolve(false);
            if (!annotationCurrent(session)) {
              // The original card may still be visible after a source edit.
              // Clear only its pending indicator, never apply the stale output.
              return target.postMessage({ type: 'aiError', kind: 'annotate', id: session.id, name: session.name,
                issueId: session.issueId, token: session.token,
                error: 'Source changed while this optional explanation was running. Its output was not applied; refresh the investigation first.' });
            }
            message = { ...message, issueId: session.issueId, token: session.token,
              provenance: 'native-model', unverified: true, source: session.source };
          }
          return target.postMessage(message);
        };
        if (key === 'onDidReceiveMessage') return (callback, ...rest) => {
          // The pinned constructor registers its listener before `native` is
          // assigned. The companion later registers another listener on this
          // same webview; intercepting both would open each source twice.
          const upstreamListener = !native;
          return target.onDidReceiveMessage(message => {
          if (!upstreamListener) { callback(message); return; }
          // The original singleton's untagged persistence would mix findings.
          // Our bridge sends tagged snapshots and owns per-finding storage instead.
          if (message?.type === 'persist') return;
          if (['openFile', 'expand', 'annotate'].includes(message?.type)) {
            if (!message.token || message.token !== native?.triageToken || message.issueId !== native?.triageFindingId) return;
            if (message.type === 'openFile') { openSource?.(message); return; }
            if (message.type === 'annotate') { annotateSource?.(message); return; }
          }
          callback(message);
          }, ...rest);
        };
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
  native.onOpenSource = callback => { openSource = callback; };
  native.onAnnotateSource = callback => { annotateSource = callback; };
  const annotate = native.annotate.bind(native);
  native.annotate = (id, name, code, fsPath, startLine, endLine, checked) => {
    // Only the companion's catalog-bound handler may start optional model work.
    // Webview-supplied code and locations are never provider input.
    if (!checked?.source || typeof checked.isCurrent !== 'function') throw new Error('Optional explanations require a checked current source card.');
    const session = { token: native.triageToken, issueId: native.triageFindingId, id, name,
      source: checked.source, isCurrent: checked.isCurrent };
    if (!annotationCurrent(session)) throw new Error('Source is no longer current. Refresh the investigation before requesting an explanation.');
    return annotations.run(session, () => annotate(id, name, code, fsPath, startLine, endLine));
  };
  const nonce = crypto.randomBytes(16).toString('hex');
  const script = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'triage.js'));
  const reader = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'report-view.js'));
  const reviewer = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'review-model.js'));
  const claims = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'claim-model.js'));
  const claimView = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'claim-view.js'));
  const inline = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'inline-review.js'));
  const investigationView = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'investigation-view.js'));
  const reading = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'reading-model.js'));
  const walkthrough = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'walkthrough-model.js'));
  const capacity = native.panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'webview', 'review-capacity.js'));
  const style = fs.readFileSync(path.join(context.extensionPath || context.extensionUri.fsPath, 'webview/triage.css'), 'utf8');
  // Add a second nonce to the existing CSP. No unsafe scripts, CDNs or external
  // report renderers are introduced. Report text only enters textContent.
  native.panel.webview.html = native.panel.webview.html
    .replace(/(script-src[^;\"]+)/, `$1 'nonce-${nonce}'`)
    .replace(/<script\b/, `<script nonce="${nonce}">(${installSessionBridge.toString()})();</script><script`)
    .replace('</head>', `<style>${style}</style></head>`)
    .replace('</body>', `<script nonce="${nonce}" src="${reader}"></script><script nonce="${nonce}" src="${reading}"></script><script nonce="${nonce}" src="${capacity}"></script><script nonce="${nonce}" src="${walkthrough}"></script><script nonce="${nonce}" src="${claims}"></script><script nonce="${nonce}" src="${reviewer}"></script><script nonce="${nonce}" src="${inline}"></script><script nonce="${nonce}" src="${claimView}"></script><script nonce="${nonce}" src="${investigationView}"></script><script nonce="${nonce}" src="${script}"></script></body>`);
  return native;
}
module.exports = { createNativePanel, apiFacade, installSessionBridge };
