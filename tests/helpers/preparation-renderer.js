'use strict';
// Execute production status rendering, not a duplicate status formatter.
module.exports = function render(reportPreparation, active) {
  const source = require('node:fs').readFileSync(require.resolve('../../extension/webview/triage.js'), 'utf8');
  const node = (tag, cls, text = '') => ({ tag, text, children: [], disabled: false, scrollTop: 0, classList: { toggle() {} },
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, setAttribute() {}, querySelectorAll() { return []; } });
  const surface = node('div'), context = { active, reportPreparation, report: '', element: node, button: text => node('button', '', text),
    preparationLabel: s => s, guideAvailability: null, preparing: null, guideIntent: 'waiting', preparationState: null, investigationDraft: null,
    sourceStale: false, preparationExpanded: true, preparationSurface: surface, issueIdentifier: () => active,
    FlowboardWalkthrough: { build: () => null }, document: { body: { classList: { toggle() {} } } } };
  require('node:vm').runInNewContext(source.slice(source.indexOf('  const preparationJob'), source.indexOf('  const readyDraft')) + '\n' +
    source.slice(source.indexOf('  function preparationContent'), source.indexOf('  function guideReveal')) + '\nrenderPreparation();', context);
  const flat = n => [n, ...n.children.flatMap(flat)], nodes = flat(surface);
  return { text: nodes.map(n => n.text).join('\n'), buttons: nodes.filter(n => n.tag === 'button') };
};
