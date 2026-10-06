'use strict';
// Versioned wire selectors -> existing checked causal model. This compiler
// supplies syntax, never receiver proof, values, reachability or review checks.
const calls = require('./call-bindings');
const { functionParts } = require('./solidity-text');
const VERSION = 'source-bindings-v1';
const str = { type: 'string' }, strings = { type: 'array', items: str };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const capability = { authenticatedExternalDispatch: false, sourceConditionalReasoning: true,
  supportedDispatch: ['internal', 'internal-library', 'self', 'constructor', 'local-instance'],
  limitation: 'Candidate definitions are not runtime dispatch. Observed external/proxy identity is not authenticated by this source-only input. A material deployed identity needs versioned independently verified evidence; a complete source-conditional argument does not require an irrelevant deployment observation.' };
function schema(full) {
  const copy = structuredClone(full), causal = copy.properties.causal;
  copy.properties.bindingFormat = { enum: [VERSION] }; copy.required.push('bindingFormat');
  causal.properties.entryBindings = { type: 'array', maxItems: causal.properties.relationships.maxItems, items: object({
    id: str, callerEventId: str, calleeEventId: str, sourceId: str, sourceHash: str, callSiteId: str, implementationSourceId: str,
    kind: { enum: capability.supportedDispatch }, context: { enum: ['same', 'call', 'delegatecall', 'staticcall', 'creation'] },
    failure: { enum: ['propagates', 'caught', 'caught-return', 'returns-status', 'not-applicable'] }, evidence: strings }) };
  causal.required.push('entryBindings');
  const event = causal.properties.events.items, link = causal.properties.relationships.items;
  delete event.properties.callSiteId; event.required = event.required.filter(key => key !== 'callSiteId');
  event.properties.inputs.items = { anyOf: [event.properties.inputs.items, object({ entryBindingId: str, parameterIndex: { type: 'integer' }, units: str, origin: str, evidence: strings })] };
  delete link.properties.callSiteId; delete link.properties.dispatch;
  link.required = link.required.filter(key => !['callSiteId', 'dispatch'].includes(key));
  link.properties.entryBindingId = str; link.required.push('entryBindingId');
  return copy;
}
function failure(code, target, message) { return Object.assign(new Error(message), { code, validationProblems: [{ code, target, message }] }); }
const key = link => `${link.from}->${link.to}:${link.kind}`;
function compile(value, units) {
  if (value?.bindingFormat === undefined) return value; // legacy paid responses remain replayable
  if (value.bindingFormat !== VERSION) throw failure('BINDING_VERSION', '', 'This source-binding representation is not supported.');
  const result = structuredClone(value), model = result.causal, entries = model.entryBindings;
  const plan = { version: VERSION, entries: structuredClone(entries), links: [], inputs: [] };
  const byId = new Map(), invocations = new Set(), callers = new Set();
  for (const entry of entries) {
    const source = units.find(unit => unit.id === entry.sourceId), destination = units.find(unit => unit.id === entry.implementationSourceId);
    const from = model.events.find(event => event.id === entry.callerEventId), to = model.events.find(event => event.id === entry.calleeEventId);
    const site = calls.exactSite(source, entry.callSiteId);
    if (!entry.id || byId.has(entry.id) || !from || !to || callers.has(from.id) || invocations.has(to.invocationId))
      throw failure('BINDING_IDENTITY', entry.id, 'One unique entering binding and call event are required per callee invocation.');
    if (!source || source.source.sourceHash !== entry.sourceHash || !site || !destination)
      throw failure('BINDING_SOURCE_STALE', entry.id, 'The selected source/hash, occurrence or implementation ID is unavailable or stale.');
    if (result.evidence.find(note => note.id === from.evidenceId)?.sourceId !== source.id || result.evidence.find(note => note.id === to.evidenceId)?.sourceId !== destination.id)
      throw failure('BINDING_FRAME', entry.id, 'Selected call/callee IDs must belong to these events. Do not move a note or invocation to a neighboring function.');
    const header = functionParts(destination.code, destination.name.split('::').at(-1))?.header;
    if (!header) throw failure('BINDING_CAPABILITY', entry.id, 'A supplied concrete function is required. An interface or absent runtime implementation cannot be compiled into dispatch.');
    const dispatch = { kind: entry.kind, receiver: site.receiverExpression || (site.isNew ? `new ${site.name}` : 'internal'),
      implementation: destination.id, evidence: entry.evidence, context: entry.context, failure: entry.failure };
    const anchor = { sourceId: source.id, source: { ...source.source, line: site.span.line, endLine: site.span.endLine },
      quote: source.code.split('\n').slice(site.span.line - source.source.line, site.span.endLine - source.source.line + 1).join('\n'), occurrence: structuredClone(site.span) };
    from.callSiteId = site.id; from.anchor = anchor;
    byId.set(entry.id, { entry, from, to, source, destination, site, header, dispatch }); invocations.add(to.invocationId); callers.add(from.id);
  }
  for (const event of model.events) {
    event.callSiteId ||= '';
    event.inputs = event.inputs.map((input, index) => {
      if (!Object.hasOwn(input, 'entryBindingId')) return input;
      const binding = byId.get(input.entryBindingId), parameter = binding && calls.parameterSpans(binding.destination.code, binding.destination.name.split('::').at(-1), binding.destination.source.line)[input.parameterIndex];
      if (!binding || event.id !== binding.to.id || !parameter?.name) throw failure('BINDING_PARAMETER', event.id, 'Parameter selectors apply only at their matching callee entry. Later values need source-grounded assignments, not an entry-value shortcut.');
      const expression = calls.boundArgument(binding.site, parameter.name, binding.header);
      if (expression == null) throw failure('BINDING_PARAMETER', event.id, 'The selected argument position is ambiguous or unsupported.');
      plan.inputs.push({ eventId: event.id, index, entryBindingId: input.entryBindingId, parameterIndex: input.parameterIndex });
      return { name: parameter.name, expression, type: parameter.declaration.slice(0, parameter.declaration.lastIndexOf(parameter.name)).trim(), units: input.units, origin: input.origin, evidence: input.evidence };
    });
  }
  const used = new Set();
  for (const link of model.relationships) {
    const id = link.entryBindingId, binding = byId.get(id), runtime = ['call', 'callback', 'return'].includes(link.kind);
    if (!runtime) {
      if (id) throw failure('BINDING_RELATIONSHIP', key(link), 'Non-execution relationships cannot borrow a runtime binding.');
      link.callSiteId = ''; link.dispatch = { kind: 'not-applicable', receiver: '', implementation: '', evidence: [], context: 'none', failure: 'not-applicable' };
    } else {
      if (!binding) throw failure('BINDING_RELATIONSHIP', key(link), 'Call/return needs its unique entering binding ID.');
      const from = model.events.find(event => event.id === link.from), to = model.events.find(event => event.id === link.to);
      if (link.kind === 'return' ? from?.invocationId !== binding.to.invocationId || to?.invocationId !== binding.from.invocationId : link.from !== binding.from.id || link.to !== binding.to.id || used.has(id))
        throw failure('BINDING_RELATIONSHIP', key(link), 'This handoff does not match the selected entering invocation.');
      if (from.transaction !== to.transaction || from.transaction !== binding.from.transaction)
        throw failure('BINDING_TRANSACTION', key(link), 'An invocation binding cannot join separate transactions.');
      if (link.kind !== 'return') used.add(id);
      link.callSiteId = binding.site.id; link.dispatch = structuredClone(binding.dispatch);
    }
    plan.links.push({ key: key(link), entryBindingId: id }); delete link.entryBindingId;
  }
  if (used.size !== byId.size) throw failure('BINDING_RELATIONSHIP', '', 'Every entry binding needs its actual entering call relationship.');
  delete model.entryBindings; delete result.bindingFormat; result.bindingPlan = plan;
  return result;
}
function wire(canonical, plan) {
  const result = structuredClone(canonical); result.bindingFormat = VERSION;
  result.causal.entryBindings = structuredClone(plan?.entries || []);
  for (const event of result.causal.events) {
    delete event.callSiteId; delete event.anchor;
    for (const selected of plan?.inputs || []) if (selected.eventId === event.id && event.inputs[selected.index]) {
      const { units, origin, evidence } = event.inputs[selected.index];
      event.inputs[selected.index] = { entryBindingId: selected.entryBindingId, parameterIndex: selected.parameterIndex, units, origin, evidence };
    }
  }
  for (const link of result.causal.relationships) {
    link.entryBindingId = plan?.links.find(item => item.key === key(link))?.entryBindingId || '';
    delete link.callSiteId; delete link.dispatch;
  }
  return result;
}
function integrity(draft) {
  if (!draft.bindingPlan) return [];
  try {
    if (draft.bindingPlan.version !== VERSION) throw new Error('The saved source-binding representation is not supported.');
    const actual = draft.causal, rebuilt = compile(wire({ causal: actual, evidence: draft.evidence }, draft.bindingPlan), draft.sources).causal;
    for (let i = 0; i < actual.events.length; i++) for (const field of ['callSiteId', 'anchor', 'inputs'])
      if (JSON.stringify(actual.events[i][field]) !== JSON.stringify(rebuilt.events[i][field])) throw new Error(`Stored derived ${field} changed for ${actual.events[i].id}.`);
    for (let i = 0; i < actual.relationships.length; i++) for (const field of ['callSiteId', 'dispatch'])
      if (JSON.stringify(actual.relationships[i][field]) !== JSON.stringify(rebuilt.relationships[i][field])) throw new Error(`Stored derived ${field} changed for ${key(actual.relationships[i])}.`);
    return [];
  } catch (error) { return [error.message]; }
}
function derived(draft) {
  return { version: VERSION,
    events: draft.causal.events.filter(event => event.anchor || draft.bindingPlan.inputs.some(input => input.eventId === event.id)).map(event => ({ id: event.id,
      ...(event.anchor ? { callSiteId: event.callSiteId, anchor: event.anchor } : {}),
      inputs: draft.bindingPlan.inputs.filter(input => input.eventId === event.id).map(input => ({ index: input.index, ...event.inputs[input.index] })) })),
    entries: draft.bindingPlan.entries.map(entry => ({ id: entry.id, dispatch: draft.causal.relationships.find(link => link.from === entry.callerEventId && link.to === entry.calleeEventId)?.dispatch })) };
}
const instruction = `source-bindings-v1 replaces copied structural call data. Select ONE causal.entryBindings record per callee invocation using exact callerEventId, calleeEventId, sourceId/sourceHash, callSiteId and implementationSourceId. kind/context/failure and evidence remain substantive assertions, not parser proof. Runtime relationships reference entryBindingId; a return reuses the SAME entry binding and supplies its actual continuation through its destination event and explanation. Non-runtime relationships use entryBindingId="". The host derives call-site spans/quotes and receiver spelling without modifying the evidence note's broader claim-scoped quotation. At the callee ENTRY, material parameter inputs should select entryBindingId and zero-based parameterIndex plus reviewed units/origin/evidence; the host derives parameter name/type and exact caller expression. Later modified values use ordinary inputs with cited assignments. Do not infer a literal value from an expression or change EVM caller labels at an internal helper. All reachability, meaning, value constraints, receiver proof, conditions, failure behavior, state and impact still need source-grounded review. assembledEarlier is the fully compiled argument the challenge MUST inspect, not a second editable answer. Never fabricate check attestations from compiled locations. Authenticated observed-external dispatch is unavailable in this source-only contract; keep materially missing observations explicit, without inventing deployment prerequisites for source-conditional claims.`;
module.exports = { VERSION, capability, schema, compile, wire, integrity, derived, instruction: instruction + '\nassembledEarlier contains only host-derived fields keyed to earlierDraft event/entry IDs. Together they are the FULL assembled causal argument: inspect all semantic fields in earlierDraft and these exact anchors/arguments/dispatch fields. No repeated prose or code copy is needed.' };
