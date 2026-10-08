'use strict';
// Controlled reference answers only. Production never chooses a dispatch from
// an existing label or converts an unreviewed legacy response into a new review.
function encode(output, input) {
  input = require('../../extension/packet-context').expand(input);
  const bindings = require('../../extension/source-bindings');
  if (input.bindingFormat !== bindings.VERSION) return output;
  output = structuredClone(output); delete output.walkthrough.steps; output.inputReviews ||= [];
  const plan = { entries: [], links: [], inputs: [] };
  for (const link of output.causal.relationships.filter(item => ['call', 'callback'].includes(item.kind))) {
    const from = output.causal.events.find(event => event.id === link.from), to = output.causal.events.find(event => event.id === link.to);
    const source = input.sources.find(unit => unit.id === output.evidence.find(note => note.id === from.evidenceId).sourceId);
    const destination = input.sources.find(unit => unit.id === link.dispatch.implementation), id = `entry-${to.invocationId}`;
    plan.entries.push({ id, callerEventId: from.id, calleeEventId: to.id, sourceId: source.id, sourceHash: source.sourceHash,
      callSiteId: link.callSiteId, implementationSourceId: destination.id, kind: link.dispatch.kind, context: link.dispatch.context,
      failure: link.dispatch.failure, evidence: link.dispatch.evidence });
    for (const related of output.causal.relationships.filter(item => item === link || item.kind === 'return' && item.callSiteId === link.callSiteId && output.causal.events.find(event => event.id === item.from).invocationId === to.invocationId))
      plan.links.push({ key: `${related.from}->${related.to}:${related.kind}`, entryBindingId: id });
    for (const [index, item] of to.inputs.entries()) plan.inputs.push({ eventId: to.id, index, entryBindingId: id,
      parameterIndex: destination.parameterSpans.findIndex(parameter => parameter.name === item.name) });
  }
  return bindings.wire(output, plan);
}
module.exports = { encode };
