'use strict';
const { lexicalCode, matching, functionParts, escaped } = require('./solidity-text');
const { occurrences, commaSpans, span } = require('./call-occurrences');
const execution = require('./execution-slice');
const { parts, failureClass } = require('./failure-data');
// Ignore formatting/comments, not literal contents: "a b" is not "ab".
function expression(value) {
  let out = '', quote = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) { out += c; if (c === '\\') out += value[++i] || ''; else if (c === quote) quote = null; }
    else if (c === '"' || c === "'") { quote = c; out += c; }
    else if (c === '/' && value[i + 1] === '/') { while (i < value.length && value[i] !== '\n') i++; }
    else if (c === '/' && value[i + 1] === '*') { const end = value.indexOf('*/', i + 2); i = end < 0 ? value.length : end + 1; }
    else if (!/\s/.test(c)) out += c;
  }
  return out;
}
function parameterNames(header) {
  const open = header.indexOf('('), end = matching(header, open);
  if (open < 0 || end < 0) return [];
  return parts(header.slice(open + 1, end)).map(parameterName);
}
function parameterName(text) {
  const name = lexicalCode(text).match(/\s+([A-Za-z_$][\w$]*)\s*$/)?.[1];
  return name && !['memory', 'storage', 'calldata', 'payable', 'external', 'internal', 'view', 'pure', 'constant'].includes(name) ? name : null;
}
function parameterSpans(code, name, line = 1) {
  const body = functionParts(code, name); if (!body) return [];
  return commaSpans(body.clean, body.parametersStart, body.parametersEnd).map((range, index) => {
    const declaration = code.slice(range.start, range.end), name = parameterName(declaration);
    const at = name ? range.start + lexicalCode(declaration).match(new RegExp(`\\b${escaped(name)}\\s*$`)).index : null;
    return { name, index, declaration, span: name ? span(code, at, at + name.length, line) : null,
      declarationSpan: span(code, range.start, range.end, line) };
  });
}
function boundArgument(site, parameter, header) {
  if (parameter === 'msg.value') {
    if (site.internalLibrary || site.relationship === 'call') return null;
    const value = site.options?.find(item => item.name === 'value')?.expression;
    if (value !== undefined) return value;
    if (site.callKind === 'low-level' && ['send', 'transfer'].includes(site.name)) return site.argumentSpans?.[0]?.expression ?? null;
    if (['member', 'creation'].includes(site.callKind) || site.callKind === 'low-level' && site.name !== 'delegatecall') return '0';
    return null; // Internal/delegate value comes from the unchanged frame, not a new argument.
  }
  const parameters = parameterNames(header), index = parameters.indexOf(parameter);
  if (index < 0 || typeof site.arguments !== 'string') return null;
  const raw = site.arguments.trim();
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const named = parts(raw.slice(1, -1)).map(arg => { const at = arg.indexOf(':'); return [arg.slice(0, at).trim(), arg.slice(at + 1).trim()]; });
    const declaredName = site.declarations?.length === 1 ? site.declarations[0].parameters[index] : parameter;
    return named.find(([name]) => name === declaredName)?.[1] ?? null;
  }
  const args = parts(raw);
  if (site.implicitReceiver) args.unshift(site.receiver);
  return args.length === parameters.length ? args[index] : null;
}
function unitSites(unit) {
  if (!unit?.source || typeof unit.code !== 'string') return [];
  const body = functionParts(unit.code, unit.name.split('::').at(-1));
  if (!body && unit.contextKind === 'state') return occurrences(unit.code,
    { line: unit.source.line, identity: `${unit.source.file}:${unit.source.sourceHash}` }).filter(site => site.isNew);
  if (!body) return [];
  return occurrences(unit.code, { from: body.bodyStart, to: body.bodyStart + body.body.length,
    line: unit.source.line, identity: `${unit.source.file}:${unit.source.sourceHash}` });
}
function exactSite(unit, id) {
  if (typeof id !== 'string' || !id) return null;
  const found = unitSites(unit).filter(site => site.id === id);
  const saved = (unit?.relatedCalls || []).filter(site => site.id === id);
  if (found.length !== 1 || saved.length !== 1) return null;
  const actual = found[0], stored = saved[0];
  // Model-produced IDs cannot bless stale or reassociated native metadata.
  if (stored.span?.start !== actual.span.start || stored.span?.end !== actual.span.end ||
      stored.arguments !== actual.arguments || (stored.receiverExpression || '') !== actual.receiverExpression ||
      JSON.stringify(stored.options || []) !== JSON.stringify(actual.options)) return null;
  const namedMember = actual.callKind === 'low-level' && stored.callKind === 'member' && stored.receiverTypes?.length === 1 &&
    stored.receiverTypes[0] !== 'address' && !!(stored.targets?.length || stored.declarations?.length);
  if (stored.callKind !== actual.callKind && !namedMember) return null;
  return { ...stored, ...actual, receiver: actual.receiverExpression || 'internal',
    ...(namedMember ? { callKind: 'member', failure: actual.failure === 'returns-status' ? 'propagates' : actual.failure } : {}) };
}
function covers(entry, unit, range) {
  return require('./event-source').covers(entry, unit, range);
}
function owner(unit) { return unit?.contract || unit?.name.split('::')[0]; }
function newType(value, castTypes = [], depth = 0) {
  if (depth > 16) return null;
  const clean = lexicalCode(value).trim();
  const direct = occurrences(clean).find(site => site.isNew && site.span.start === 0 && site.span.end === clean.length);
  if (direct) return direct.name;
  // Explicit type/address wrappers preserve the new object's identity. A
  // function such as choose(new Guard()) does not: only known type casts are
  // admitted by the caller below.
  const cast = /^([A-Za-z_$][\w$]*)\s*\(/.exec(clean);
  if (!cast || matching(clean, clean.indexOf('(')) !== clean.length - 1) return null;
  if (![...castTypes, 'address', 'payable'].includes(cast[1])) return null;
  return newType(clean.slice(clean.indexOf('(') + 1, -1), castTypes, depth + 1);
}
function receiverName(value) {
  let raw = expression(value);
  for (let i = 0; i < 4; i++) {
    const cast = /^(?:address|payable)\(/.exec(raw);
    if (!cast || matching(raw, raw.indexOf('(')) !== raw.length - 1) break;
    raw = raw.slice(raw.indexOf('(') + 1, -1);
  }
  return /^[A-Za-z_$][\w$]*$/.test(raw) ? raw : null;
}
function creationMatches(unit, initializer, destination, castTypes = []) {
  const type = newType(initializer, castTypes);
  if (!type || type !== owner(destination)) return false;
  // An actual indexed contract in the constructor's import closure is needed;
  // neither ABI compatibility nor a same-named project-global file suffices.
  return (unit.relatedCalls || []).some(saved => {
    const site = exactSite(unit, saved.id);
    return site?.isNew && site.name === type && (saved.creationTargets || []).length === 1 &&
      saved.creationTargets[0].file === destination.source.file && saved.creationTargets[0].sourceHash === destination.source.sourceHash;
  });
}
// A deliberately bounded declaration/write index. Identifiers are resolved to
// their enclosing lexical declaration, not counted by spelling. Unsupported
// mutations are retained as writes, never silently treated as unchanged.
function bindingWrites(parts, name, until = parts.bodyStart + parts.body.length) {
  const clean = parts.clean, root = { start: parts.bodyStart - 1, end: parts.bodyStart + parts.body.length, parent: null }, scopes = [root], stack = [root];
  for (let at = parts.bodyStart; at < until; at++) {
    if (clean[at] === '{') { const scope = { start: at, end: matching(clean, at, '{', '}'), parent: stack.at(-1) }; scopes.push(scope); stack.push(scope); }
    else if (clean[at] === '}' && stack.length > 1) stack.pop();
  }
  const scopeAt = at => scopes.filter(scope => scope.start < at && at < scope.end).at(-1) || root;
  const ancestor = (outer, inner) => { for (let scope = inner; scope; scope = scope.parent) if (scope === outer) return true; return false; };
  const declarations = [], skippedTypes = new Set(['delete', 'return', 'emit', 'revert', 'new', 'else', 'throw']);
  const pattern = new RegExp(`\\b([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)?)\\s+(?:(?:memory|storage|calldata|payable)\\s+)*(${escaped(name)})\\s*(?=[=;,)])`, 'g');
  for (const match of clean.slice(parts.bodyStart, until).matchAll(pattern)) {
    if (skippedTypes.has(match[1])) continue;
    const at = parts.bodyStart + match.index + match[0].lastIndexOf(name);
    declarations.push({ id: `local:${at}`, name, type: match[1], at, start: parts.bodyStart + match.index, scope: scopeAt(at) });
  }
  const parameter = parameterNames(parts.header).includes(name) ? { id: `parameter:${name}`, scope: root, at: -1 } : null;
  const resolve = at => declarations.filter(declaration => declaration.at <= at && ancestor(declaration.scope, scopeAt(at)))
    .sort((a, b) => b.scope.start - a.scope.start || b.at - a.at)[0] || parameter || { id: `state:${name}`, scope: root, at: -1 };
  const writes = [];
  for (const match of clean.slice(parts.bodyStart, until).matchAll(new RegExp(`\\b${escaped(name)}\\b`, 'g'))) {
    const at = parts.bodyStart + match.index, after = at + name.length, before = clean.slice(parts.bodyStart, at), tail = clean.slice(after, until);
    // obj.name is a field, not a write to the lexical variable name.
    if (/\.\s*$/.test(before)) continue;
    let operation = null, value = null, end = after;
    const direct = /^\s*(=(?!=|>)|\+=|-=|\*=|\/=|%=|\|=|&=|\^=|<<=|>>=|\+\+|--)/.exec(tail);
    if (direct) {
      operation = direct[1] === '=' ? 'assign' : 'mutation';
      end = clean.indexOf(';', after); if (end < 0 || end >= until) { operation = 'unsupported'; end = after; }
      else { end++; value = parts.rawBody.slice(after + direct[0].length - parts.bodyStart, end - 1 - parts.bodyStart).trim(); }
    } else if (/\bdelete\s*\(*\s*$/.test(before) || /(?:\+\+|--)\s*\(*\s*$/.test(before)) operation = 'mutation';
    else {
      // Any containing left-hand tuple is an assignment, including holes and
      // nested tuples. A tuple declaration resolves to its own local identity.
      for (let open = before.lastIndexOf('(') + parts.bodyStart; open >= parts.bodyStart; open = clean.lastIndexOf('(', open - 1)) {
        const close = matching(clean, open);
        if (close >= after && close < until && /^\s*=(?!=|>)/.test(clean.slice(close + 1, until))) { operation = 'tuple'; end = close + 1; break; }
      }
    }
    if (!operation) continue;
    const declaration = resolve(at), boundary = Math.max(clean.lastIndexOf(';', at - 1), clean.lastIndexOf('{', at - 1), clean.lastIndexOf('}', at - 1));
    const head = clean.slice(Math.max(parts.bodyStart, boundary + 1), at).trim();
    const declared = declarations.find(item => item.at === at);
    const straight = scopeAt(at) === root && (declared ? expression(head) === expression(declared.type) : head === '');
    writes.push({ declaration, at, end, operation, value, straight, isDeclaration: !!declared });
  }
  return { declarations, writes, active: resolve(until - 1), parameter,
    unsafe: /\bassembly\b/.test(clean.slice(parts.bodyStart, until)), root };
}
function localInstance(source, site, destination, supplied, units, evidence, missing = () => {}) {
  const name = receiverName(site.receiverExpression); if (!name) return false;
  const sourceParts = functionParts(source.code, source.name.split('::').at(-1));
  if (!sourceParts) return false;
  const checkedUnits = [...new Set(supplied.map(id => evidence.frameFor?.(id) || units.get(evidence.get(id)?.sourceId)))].filter(Boolean);
  // Straight-line local construction. Anything conditional, shadowed or
  // reassigned needs stronger evidence, not a guessed running implementation.
  const scan = bindingWrites(sourceParts, name, site.span.start), local = scan.active;
  if (scan.unsafe) return false;
  if (local.id.startsWith('local:')) {
    const writes = scan.writes.filter(write => write.declaration.id === local.id), initial = writes[0];
    return writes.length === 1 && initial.isDeclaration && initial.straight && initial.operation === 'assign' &&
      creationMatches(source, initial.value, destination, [local.type]) &&
      supplied.some(id => covers(evidence.get(id), source, span(source.code, initial.at, initial.end, source.source.line)));
  }
  if (local.id.startsWith('parameter:')) return false;
  const initialization = source.initialization;
  const validScopes = Array.isArray(initialization?.scopes) && initialization.scopes.length > 0 && initialization.scopes.every(scope => scope &&
    typeof scope.contract === 'string' && typeof scope.file === 'string' && /^[a-f0-9]{64}$/.test(scope.sourceHash || '') &&
    typeof scope.constructorAbsent === 'boolean' && Array.isArray(scope.constructors) && scope.constructors.every(reference => reference &&
      typeof reference.file === 'string' && Number.isSafeInteger(reference.line) && Number.isSafeInteger(reference.endLine) && reference.endLine >= reference.line && /^[a-f0-9]{64}$/.test(reference.sourceHash || '')));
  if (!initialization?.complete || !validScopes) { missing(initialization?.gaps?.[0] || 'The receiver initialization scope and constructor availability have not been inspected.'); return false; }
  const declarations = checkedUnits.filter(unit => unit.contextKind === 'state' &&
    initialization.scopes.some(scope => scope.contract === owner(unit) && scope.file === unit.source.file && scope.sourceHash === unit.source.sourceHash) &&
    /\bimmutable\b/.test(lexicalCode(unit.code)) && new RegExp(`\\b${escaped(name)}\\s*[;=]`).test(lexicalCode(unit.code)));
  if (declarations.length !== 1) return false;
  const declaration = declarations[0], constructors = [];
  for (const scope of initialization.scopes) {
    if (!scope.constructors?.length && scope.constructorAbsent !== true) return false;
    for (const reference of scope.constructors || []) {
      const matching = [...units.values()].filter(unit => unit.name === `${scope.contract}::constructor` &&
        unit.source.file === reference.file && unit.source.line === reference.line && unit.source.endLine === reference.endLine &&
        unit.source.sourceHash === reference.sourceHash && unit.complete && !(Number.isInteger(unit.readThrough) && unit.readThrough < unit.source.endLine));
      if (matching.length !== 1) { missing(`Available constructor code remains unread: ${scope.contract} at ${reference.file}:${reference.line}-${reference.endLine}. Inspect it before binding the immutable receiver.`); return false; }
      constructors.push(matching[0]);
    }
  }
  const declaredType = lexicalCode(declaration.code).trim().match(/^([A-Za-z_$][\w$]*)\b/)?.[1];
  // The declaration is one initialization event, not the final binding. Every
  // actual constructor scope above must also be acquired and inspected.
  const inline = lexicalCode(declaration.code).match(new RegExp(`\\b${escaped(name)}\\s*=([^;]+);`));
  let constructorWrite = null;
  // Inspect all acquired constructors, not just the model's preferred proof.
  // A local/parameter named guard never initializes the state declaration.
  for (const constructor of constructors) {
    const body = functionParts(constructor.code, 'constructor'); if (!body) continue;
    const close = matching(body.header, body.header.indexOf('('));
    const suffix = body.header.slice(close + 1).replace(/\b(?:public|internal|payable)\b/g, '').trim();
    if (suffix) return false; // Modifier/base-argument effects need a stronger scoped initialization proof.
    if ((constructor.relatedCalls || []).some(call => call.callKind !== 'creation')) return false;
    const state = bindingWrites(body, name), writes = state.writes.filter(write => write.declaration.id === `state:${name}`);
    if (state.unsafe || writes.length > 1 || constructorWrite && writes.length) return false;
    if (!writes.length) continue;
    const write = writes[0];
    if (!write.straight || write.operation !== 'assign' || !creationMatches(constructor, write.value, destination, [declaredType]) ||
      !supplied.some(id => covers(evidence.get(id), constructor, span(constructor.code, write.at, write.end, constructor.source.line)))) return false;
    constructorWrite = write;
  }
  return !!constructorWrite || !!inline && creationMatches(declaration, inline[1], destination, [declaredType]);
}
function lineOffset(unit, line) {
  return unit.code.split('\n').slice(0, line - unit.source.line).reduce((offset, text) => offset + text.length + 1, 0);
}
function parameterValue(unit, name, initial, event, evidence) {
  const body = functionParts(unit.code, unit.name.split('::').at(-1)), anchor = evidence.get(event.evidenceId);
  if (!body || !covers(anchor, unit, anchor?.source)) return { known: false, reason: 'The parameter use is not anchored to its own acquired/read function bytes.' };
  const until = lineOffset(unit, anchor.source.line), scan = bindingWrites(body, name, Math.max(body.bodyStart, until));
  if (scan.unsafe) return { known: false, reason: 'Assembly may change the invocation parameter.' };
  if (scan.active.id !== `parameter:${name}`) return { known: false, reason: 'A local declaration shadows the invocation parameter.' };
  const through = lineOffset(unit, anchor.source.endLine + 1), atAnchor = bindingWrites(body, name, Math.min(body.bodyStart + body.body.length, through));
  if (atAnchor.writes.some(write => write.declaration.id === `parameter:${name}` && write.at >= until)) return { known: false,
    reason: 'This highlighted line also writes the parameter. Separate its before/after operation with a precise checked range.' };
  const writes = scan.writes.filter(write => write.declaration.id === `parameter:${name}`);
  let value = initial;
  for (const write of writes) {
    if (!write.straight || write.operation !== 'assign' || !write.value) return { known: false, reason: 'A conditional, tuple, delete or other unsupported parameter write needs a separate checked derivation.' };
    const range = span(unit.code, write.at, write.end, unit.source.line);
    // Keep the expression source-derived. Arbitrary evaluated numbers and
    // model arithmetic are not substituted for a checked assignment.
    value = write.value;
    if (!(event.inputs?.find(input => input.name === name)?.evidence || []).some(id => covers(evidence.get(id), unit, range))) return { known: false, reason: 'The changed parameter needs evidence of its earlier assignment in this invocation.' };
  }
  return { known: true, value, writes };
}
function invocationInputs(event, body) {
  const result = [...(event.inputs || [])];
  for (const condition of event.conditions || []) {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*(?:is|==|=)\s*(true|false)\.?\s*$/i.exec(condition);
    if (match && parameterNames(body.header).includes(match[1])) result.push({ name: match[1], expression: match[2].toLowerCase(), condition: true, evidence: [event.evidenceId] });
  }
  return result;
}
function callerConstraints(event, unit) {
  const body = unit && functionParts(unit.code, unit.name.split('::').at(-1)), values = new Map();
  if (!body || !event) return values;
  for (const input of invocationInputs(event, body)) if (parameterNames(body.header).includes(input.name) && /^(true|false)$/.test(expression(input.expression))) {
    values.set(input.name, expression(input.expression));
  }
  for (const condition of event.conditions || []) {
    const range = /^(\w+) is an integer from (\d+) through (\d+)$/.exec(condition);
    if (range && parameterNames(body.header).includes(range[1]) && BigInt(range[2]) <= BigInt(range[3])) values.set(range[1], { range: [range[2], range[3]] });
  }
  return values;
}
function callTimeConstraints(event, unit, evidence) {
  const values = callerConstraints(event, unit);
  for (const [name, initial] of values) {
    const state = parameterValue(unit, name, initial, event, evidence);
    // A root input describes entry. The first displayed event may occur only
    // after a write. Never treat that entry premise as the call-time value.
    const actual = state.known ? booleanValue(state.value, new Map()) : null;
    values.set(name, actual == null ? null : String(actual));
  }
  return values;
}
function checkBooleanPremise(draft, condition, review, resolved = require('./event-source').resolver(draft)) {
  const events = draft.causal?.events || [], links = draft.causal?.relationships || [];
  const { units, evidence } = resolved;
  const errors = [], allowed = new Set(review.claimIds), name = condition.name;
  const facts = event => [...(event.inputs || []).filter(input => input.name === name).map(input => input.expression),
    ...(event.conditions || []).flatMap(text => {
      const match = new RegExp(`^\\s*${escaped(name)}\\s*(?:must be|is|==|=)\\s*(true|false)\\.?\\s*$`, 'i').exec(text);
      return match ? [match[1].toLowerCase()] : [];
    })];
  const scopes = new Map();
  for (const event of events.filter(event => review.eventIds.includes(event.id) && allowed.has(event.claimId))) {
    const anchor = evidence.get(event.evidenceId), unit = resolved.event(event);
    const body = unit && functionParts(unit.code, unit.name.split('::').at(-1));
    const parameter = body && parameterNames(body.header).includes(name);
    // Merely attaching acknowledgement to an unrelated entry/context event
    // cannot make a changed premise apply to the decisive invocation. Require
    // the named input or a condition anchored to an actual read of that name.
    const checkedCondition = body && new RegExp(`\\b${escaped(name)}\\b`).test(lexicalCode(anchor?.quote || ''));
    if (!facts(event).length || !parameter && !checkedCondition) continue;
    scopes.set(`${event.invocationId}:${unit.id}`, { unit, invocationId: event.invocationId, parameter });
  }
  if (!scopes.size) return [`The applied saved condition ${name} is ${condition.value} needs an affected step using that parameter or checked condition, not an unrelated acknowledgement.`];
  for (const { unit, invocationId, parameter } of scopes.values()) {
    const body = functionParts(unit.code, unit.name.split('::').at(-1));
    // A premise constrains this invocation's entry, not every use of a name
    // throughout the project. An exact later assignment can change the value.
    const entering = links.filter(link => ['call', 'callback'].includes(link.kind) && events.find(event => event.id === link.to)?.invocationId === invocationId);
    if (parameter && entering.length === 1) {
      const link = entering[0], from = events.find(event => event.id === link.from), source = resolved.event(from);
      const site = exactSite(source, link.callSiteId), actual = site && boundArgument(site, name, body.header);
      const initial = actual == null ? null : booleanValue(actual, callTimeConstraints(from, source, evidence));
      if (initial != null && String(initial) !== condition.value) errors.push(`Invocation ${invocationId} contradicts the applied saved condition ${name} is ${condition.value} at its own entering call.`);
    }
    for (const event of events.filter(event => allowed.has(event.claimId) && event.invocationId === invocationId && resolved.event(event)?.id === unit.id)) {
      const values = facts(event).map(value => expression(value)).filter(value => /^(true|false)$/.test(value));
      if (!values.length) continue;
      const state = parameter ? parameterValue(unit, name, condition.value, event, evidence) : { known: true, value: condition.value };
      const value = state.known ? booleanValue(state.value || '', new Map()) : null;
      if (value == null || values.some(actual => actual !== String(value))) errors.push(`Step ${event.id} contradicts the applied saved condition ${name} is ${condition.value}, or needs a checked ordered assignment in this invocation. ${state.reason || ''}`.trim());
    }
  }
  return [...new Set(errors)];
}
function validateInvocations({ events, links, units, evidence, fail, resolved }) {
  const frame = event => resolved ? resolved.event(event) : units.get(evidence.get(event?.evidenceId)?.sourceId);
  const entered = new Set(), constraints = new Map();
  const coherent = (event, input, state) => {
    if (!state.known) return false;
    if (!input.condition) return expression(input.expression) === expression(state.value || '');
    const actual = state.literal ?? booleanValue(state.value || '', new Map()), key = `${event.invocationId}:${input.name}`;
    if (actual != null) { constraints.set(key, String(actual)); return String(actual) === input.expression; }
    // A symbolic source argument may have a chosen scenario constraint. It is
    // not a new argument value, and remains a premise rather than a code fact.
    const prior = constraints.get(key); constraints.set(key, input.expression);
    return prior === undefined || prior === input.expression;
  };
  for (const entry of links.filter(link => ['call', 'callback'].includes(link.kind))) {
    const from = events.find(event => event.id === entry.from), to = events.find(event => event.id === entry.to);
    const source = frame(from), unit = frame(to);
    const site = exactSite(source, entry.callSiteId), body = unit && functionParts(unit.code, unit.name.split('::').at(-1));
    if (!site || !body || !to) continue;
    entered.add(to.invocationId);
    const entering = links.filter(link => ['call', 'callback'].includes(link.kind) && events.find(event => event.id === link.to)?.invocationId === to.invocationId);
    if (entering.length !== 1) { fail(`${to.title}: invocation ${to.invocationId} has multiple entering call occurrences. Split repeated invocations instead of sharing their inputs.`); continue; }
    for (const event of events.filter(event => event.invocationId === to.invocationId)) for (const input of invocationInputs(event, body)) {
      if (event.id === to.id && !input.condition) continue; // Entry parameters were matched to the exact call above.
      if (!parameterNames(body.header).includes(input.name) && input.name !== 'msg.value') continue;
      const initial = boundArgument(site, input.name, body.header), first = (to.inputs || []).find(item => item.name === input.name);
      const state = input.name === 'msg.value' ? { known: true, value: initial } : parameterValue(unit, input.name, initial, event, evidence);
      if (!state.writes?.length) state.literal = booleanValue(state.value || '', callTimeConstraints(from, source, evidence));
      if (initial == null || !coherent(event, input, state)) fail(`${event.title}: invocation ${to.invocationId} changes input ${input.name} without an ordered, exact source derivation from its own entering call. ${state.reason || 'Another invocation, context link or repeated call cannot supply this value.'}`);
      if (!input.condition && !state.writes?.length && !(input.evidence || []).some(id => covers(evidence.get(id), source, site.span))) fail(`${event.title}: input ${input.name} must retain the exact origin from this invocation's own entering call.`);
      if (first && !input.condition && (input.type !== first.type || input.units !== first.units)) fail(`${event.title}: invocation ${to.invocationId} changes the type or units of ${input.name}; a source assignment does not change its declaration.`);
    }
  }
  // Root invocations have no caller statement in the acquired route. Their
  // explicitly stated parameter premise still cannot silently change later.
  const initial = new Map();
  for (const event of events.filter(event => !entered.has(event.invocationId))) {
    const unit = frame(event), body = unit && functionParts(unit.code, unit.name.split('::').at(-1));
    if (!body) { if (event.effect !== 'read') fail(`${event.title}: no exact callable frame can be resolved for this executable event.`); continue; }
    for (const input of invocationInputs(event, body)) {
      if (!parameterNames(body.header).includes(input.name)) continue;
      const key = `${event.invocationId}:${input.name}`, first = initial.get(key);
      if (!first) initial.set(key, input.condition ? { expression: input.name, condition: true } : input);
      const baseline = initial.get(key), state = parameterValue(unit, input.name, baseline.expression, event, evidence);
      if (!coherent(event, input, state) || !input.condition && !baseline.condition && (input.type !== baseline.type || input.units !== baseline.units)) fail(`${event.title}: root invocation ${event.invocationId} changes its parameter premise ${input.name} without a checked source assignment.`);
    }
  }
}
function booleanValue(value, values) {
  return execution.boolean(value, values);
}
// Source effects are evaluated independently of which statements the tutorial
// chooses to display. Only exact, unique non-virtual internal helpers in the
// bounded statement subset can be summarized. Unknown effects never fall through.
function unitFailure(unit, kind, args, absolute, custom = false) {
  const body = functionParts(unit.code, unit.name.split('::').at(-1));
  return failureClass(kind, args, custom, payload => {
    if (!/^[A-Za-z_$][\w$]*$/.test(payload) || !body) return false;
    const declaration = bindingWrites(body, payload, absolute).active;
    const parameter = parameterSpans(unit.code, unit.name.split('::').at(-1)).find(item => item.name === payload);
    return declaration?.type === 'string' || declaration?.id === `parameter:${payload}` && /^string\b/.test(parameter?.declaration.trim() || '');
  });
}
function sourcePath(unit, offset, values, units, options = {}, stack = []) {
  if (stack.includes(unit.id) || stack.length >= 12) return { reachable: null, reason: 'A recursive or over-budget helper path needs a separate checked effect.' };
  const body = functionParts(unit.code, unit.name.split('::').at(-1));
  if (!body) return { reachable: null, reason: 'The complete function body is unavailable.' };
  const suffix = body.header.slice(body.parametersEnd - body.start + 1)
    .replace(/\breturns\s*\([^)]*\)|\boverride\s*(?:\([^)]*\))?/g, '')
    .replace(/\b(?:public|external|internal|private|pure|view|payable|virtual)\b/g, '').trim();
  if (suffix) return { reachable: null, reason: `The function modifier path (${suffix}) needs a checked effect before entering this body.` };
  if (offset >= body.start && offset < body.bodyStart) return { reachable: true, values: new Map(values), guards: [] };
  return execution.pathTo(unit, offset, values, { ...options,
    failureClass: (kind, args, absolute, custom) => unitFailure(unit, kind, args, absolute, custom), operation(node, current) {
    const provided = options.operation?.(node, current); if (provided) return provided;
    const sites = unitSites(unit).filter(site => site.span.start >= node.start && site.span.end <= node.end);
    const creation = sites.filter(site => site.isNew);
    if (creation.length === 1 && !creation[0].options.length && !creation[0].argumentSpans.length) {
      const exact = exactSite(unit, creation[0].id), targets = exact?.creationTargets || [];
      const text = unit.code.slice(node.start, node.end), rhs = text.slice(text.indexOf('=') + 1).replace(/;\s*$/, '').trim();
      // Only genuine type/address wrappers around this construction, not a
      // function choose(new X()). Known type names come from native metadata.
      const types = (unit.relatedCalls || []).flatMap(site => site.receiverTypes || []);
      if (targets.length === 1 && targets[0].emptyInitialization && newType(rhs, types) === creation[0].name)
        return { outcome: 'continue' };
    }
    // Nested argument evaluation is a separate effect, not the outer call's
    // argument text. Keep it unresolved until every invocation is accounted.
    if (sites.length !== 1 || node.kind === 'try') return { outcome: 'unknown', reason: 'A preceding compound or try invocation needs a checked effect and branch.' };
    const site = exactSite(unit, sites[0].id), targets = site?.targets || [];
    if (!site || site.receiverExpression || site.isNew || site.relationship !== 'call' || targets.length !== 1)
      return { outcome: 'unknown', reason: `The preceding ${sites[0].name} invocation has no unique supported local effect.` };
    const target = targets[0], matches = [...units.values()].filter(candidate => candidate.complete && !candidate.contextKind &&
      candidate.source.file === target.file && candidate.source.line === target.line && owner(candidate) === target.contract &&
      require('./report-content').functionSignature(candidate.code, candidate.name.split('::').at(-1)) === target.signature);
    if (matches.length !== 1) return { outcome: 'unknown', reason: `Read the complete local ${site.name} implementation before continuing past this invocation.` };
    const helper = matches[0], parsed = functionParts(helper.code, helper.name.split('::').at(-1));
    if (!parsed || !/\b(internal|private)\b/.test(parsed.header) || /\bvirtual\b/.test(parsed.header))
      return { outcome: 'unknown', reason: `The preceding ${helper.name} needs a checked dispatch effect; it is not a non-virtual internal helper.` };
    const bound = new Map(parameterNames(parsed.header).map(name => {
      const argument = boundArgument(site, name, parsed.header);
      return [name, current.get(argument)?.range ? current.get(argument) : booleanValue(argument, current)];
    }));
    const result = sourcePath(helper, parsed.bodyStart + parsed.body.length, bound, units, { complete: true, localWritesOnly: true, noOverflow: options.noOverflow }, [...stack, unit.id]);
    if (result.outcome === 'return' || result.reachable === true) return { outcome: 'continue' };
    return { outcome: result.outcome || 'unknown', failure: result.failure,
      reason: `${helper.name}: ${result.reason || 'The helper effect remains unresolved.'}` };
  } });
}
function failedClass(unit, event, evidence, site, callerValues = new Map(), unresolved = () => {}, units = new Map()) {
  const anchor = evidence.get(event.evidenceId); if (!unit || !covers(anchor, unit, anchor?.source)) return null;
  const code = anchor.quote, clean = lexicalCode(code), body = functionParts(unit.code, unit.name.split('::').at(-1));
  const values = new Map();
  for (const name of parameterNames(body?.header || '')) {
    const actual = boundArgument(site, name, body.header), bound = booleanValue(actual, callerValues);
    if (actual != null) values.set(name, bound == null ? null : String(bound));
  }
  const failures = [];
  for (const match of clean.matchAll(/\b(require|assert|revert)(?:\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?))?\s*\(/g)) {
    const absolute = lineOffset(unit, anchor.source.line) + match.index;
    const path = sourcePath(unit, absolute, values, units);
    if (path.reachable !== true) { unresolved(path.reason); continue; }
    const open = clean.indexOf('(', match.index), close = matching(clean, open); if (close < 0) continue;
    const args = parts(code.slice(open + 1, close));
    if (match[1] !== 'revert' && booleanValue(args[0] || '', path.values) !== false) {
      unresolved('The cited guard is not established false with the checked call-time values.'); continue;
    }
    failures.push(unitFailure(unit, match[1], args, absolute, !!match[2]));
  }
  if (!failures.length) {
    const calls = unitSites(unit).filter(call => call.span.line >= anchor.source.line && call.span.endLine <= anchor.source.endLine);
    if (calls.length === 1 && !calls[0].receiverExpression && !calls[0].isNew) {
      const reached = sourcePath(unit, calls[0].span.start, values, units);
      if (reached.reachable === true) {
        const effect = sourcePath(unit, Infinity, values, units, { complete: true, through: calls[0].span.end });
        if (effect.outcome === 'failure' && effect.failure) failures.push(effect.failure);
        else unresolved(effect.reason || 'The highlighted helper has no established failure.');
      } else unresolved(reached.reason);
    }
  }
  const known = [...new Set(failures)]; return known.length === 1 && known[0] !== 'unknown' ? known[0] : null;
}
function catchContinuation(source, clause) {
  const clean = lexicalCode(source.code.slice(clause.body.start, clause.body.end)).trim();
  if (!clean) return 'continues';
  // Do not assume calls/branches/assembly/checked arithmetic fall through.
  if (/^(?:revert\s*(?:\(|[A-Za-z_$][\w$]*\s*\()|throw\b)/.test(clean)) return 'rethrows';
  if (/^return\b/.test(clean)) return 'returns';
  if (clean.split(';').filter(value => value.trim()).every(value => /^\s*[A-Za-z_$][\w$]*\s*=\s*(?:true|false|0|0x0)\s*$/.test(value))) return 'continues';
  return 'unknown';
}
function scenarioFailure({ site, source, destination, to, events, evidence, link, fail, units }) {
  if (!site.tryContext) return site.failure;
  const context = site.tryContext;
  if (!source || !destination || !to) { fail('The failed invocation has no matching caller and callee source frame.'); return 'unknown'; }
  if (context.unsupported) { fail(`${to.title}: the exact try/catch structure could not be read.`, 'material-evidence'); return 'unknown'; }
  const failed = events.filter(event => event.invocationId === to.invocationId && event.effect === 'rolled-back');
  if (!failed.length) return 'not-applicable'; // A successful route does not establish how an unchosen failure is handled.
  const callerValues = callTimeConstraints(events.find(event => event.id === link.from), source, evidence);
  const unresolved = [];
  const classes = [...new Set(failed.map(event => failedClass(destination, event, evidence, site, callerValues, reason => unresolved.push(reason), units)).filter(Boolean))];
  if (classes.length !== 1) { fail(`${to.title}: the callee failure class is not established. ${unresolved[0] || 'Caller argument evaluation and return decoding failures are not caught callee errors.'}`, 'material-evidence'); return 'unknown'; }
  const error = classes[0], clause = context.clauses.find(item => item.kind === error) || context.clauses.find(item => item.kind === 'any');
  if (!clause) return 'propagates';
  if (!(link.evidence || []).some(id => covers(evidence.get(id), source, clause.span))) fail(`${to.title}: the matching ${clause.kind} catch and its body need an exact checked source reference.`);
  const continuation = catchContinuation(source, clause);
  if (continuation === 'rethrows') return 'propagates';
  if (continuation === 'returns') return 'caught-return';
  if (continuation !== 'continues') { fail(`${to.title}: the matching ${clause.kind} catch has no established continuing path.`, 'material-evidence'); return 'unknown'; }
  return 'caught';
}
function validateTransition({ draft, link, from, to, source, destination, units, evidence, refs, events, links, fail }) {
  if (link.kind === 'return') {
    const incoming = links.filter(candidate => ['call', 'callback'].includes(candidate.kind) && candidate.callSiteId === link.callSiteId &&
      events.find(event => event.id === candidate.from)?.invocationId === to.invocationId &&
      events.find(event => event.id === candidate.to)?.invocationId === from.invocationId);
    if (incoming.length !== 1) { fail(`${from.title}: this return has no unique earlier call to the same invocation and call site.`); return; }
    const site = exactSite(destination, link.callSiteId);
    if (!site || !link.evidence.some(id => covers(evidence.get(id), destination, site.span))) fail(`${from.title}: the return location is not linked to its exact original call.`);
    if (JSON.stringify(link.dispatch) !== JSON.stringify(incoming[0].dispatch)) fail(`${from.title}: return dispatch differs from the invocation that entered this function.`);
    const entering = events.find(event => event.id === incoming[0].to);
    const handling = site && scenarioFailure({ site, source: destination, destination: source, to: entering, events, evidence, link: incoming[0], fail, units });
    if (from.effect === 'rolled-back' && handling === 'propagates') fail(`${from.title}: an uncaught failed call propagates reversion; it cannot return normally to the caller.`);
    if (from.effect === 'rolled-back' && handling === 'caught' && site.tryContext && evidence.get(to.evidenceId)?.source.line <= site.tryContext.span.endLine) fail(`${to.title}: a handled failure continues after its matching catch, not in the try success body.`);
    if (site?.tryContext && handling === 'caught') {
      const caller = events.find(event => event.id === incoming[0].from), anchor = evidence.get(to.evidenceId);
      const values = callTimeConstraints(caller, destination, evidence);
      const error = failedClass(source, from, evidence, site, values, () => {}, units);
      const clause = site.tryContext.clauses.find(item => item.kind === error) || site.tryContext.clauses.find(item => item.kind === 'any');
      // catchContinuation accepts only straight literal writes here. Apply
      // them before evaluating a later branch/return, not the entry premise.
      for (const match of (clause ? lexicalCode(destination.code.slice(clause.body.start, clause.body.end)) : '').matchAll(/\b(\w+)\s*=\s*(true|false|0|0x0)\s*;/g)) values.set(match[1], match[2]);
      const start = lineOffset(destination, anchor?.source.line);
      const path = sourcePath(destination, start + destination.code.slice(start).search(/\S/), values, units, { after: site.tryContext.span.end });
      if (path.reachable !== true) fail(`${to.title}: cannot establish the caller continuation after the handled failure. ${path.reason}`, 'material-evidence');
    }
    if (from.effect === 'rolled-back' && handling === 'caught-return') {
      const caller = events.find(event => event.id === incoming[0].from);
      const error = failedClass(source, from, evidence, site, callTimeConstraints(caller, destination, evidence), () => {}, units);
      const clause = site.tryContext.clauses.find(item => item.kind === error) || site.tryContext.clauses.find(item => item.kind === 'any');
      const anchor = evidence.get(to.evidenceId), statement = clause && destination.code.slice(clause.body.start, clause.body.end).trim();
      if (!clause || to.effect !== 'return' ||
          !covers(anchor, destination, clause.span) || !/^return\s+[^;]+;\s*$/.test(statement))
        fail(`${to.title}: this handled failure must follow the exact matching catch's caller return, not the statement after try.`, 'material-evidence');
    }
    return;
  }
  const site = exactSite(source, link.callSiteId), destinationParts = destination && functionParts(destination.code, destination.name.split('::').at(-1));
  if (!site || from.callSiteId !== link.callSiteId) { fail(`${from.title}: anchor this handoff and event to one exact current call-site ID. Name or line matches cannot identify an invocation.`); return; }
  const anchor = from.anchor || evidence.get(from.evidenceId);
  const path = sourcePath(source, site.span.start, callerConstraints(from, source), units,
    { noOverflow: (from.conditions || []).some(condition => /\bdo not overflow\.?$/.test(condition)) });
  if (path.reachable !== true) fail(`${from.title}: cannot establish the path to this exact call. ${path.reason}`, 'material-evidence');
  if (!covers(anchor, source, site.span) || anchor.source.line !== site.span.line || anchor.source.endLine !== site.span.endLine) fail(`${from.title}: its checked code must cover exactly this call's lines, not another call or a whole function.`);
  if (from.invocationId === to.invocationId) fail(`${from.title}: entering another function needs a distinct invocation, even when internal msg.sender is unchanged.`);
  const dispatch = link.dispatch;
  if (!dispatch || !refs(dispatch.evidence) || dispatch.implementation !== destination?.id || !link.evidence.every(id => refs([id]))) {
    fail(`${from.title}: the running receiver and implementation need checked dispatch evidence.`); return;
  }
  if (dispatch.evidence.some(id => !link.evidence.includes(id))) fail(`${from.title}: fresh handoff checks must include every receiver/implementation premise, not only the call quotation.`);
  const expectedReceiver = site.receiverExpression || (site.isNew ? `new ${site.name}` : 'internal');
  if (dispatch.receiver !== expectedReceiver) fail(`${from.title}: dispatch receiver does not match this exact call expression.`);
  const handling = scenarioFailure({ site, source, destination, to, events, evidence, link, fail, units });
  if (destinationParts) {
    const actual = callTimeConstraints(from, source, evidence);
    const entryValues = new Map(parameterNames(destinationParts.header).map(name => [name, booleanValue(boundArgument(site, name, destinationParts.header), actual)]));
    const anchor = evidence.get(to.evidenceId), start = lineOffset(destination, anchor?.source.line);
    const first = sourcePath(destination, start + destination.code.slice(start).search(/\S/), entryValues, units);
    if (first.reachable !== true) fail(`${to.title}: cannot establish the path to the displayed callee operation. ${first.reason}`, 'material-evidence');
  }
  if (dispatch.failure !== handling) fail(`${from.title}: the call's failure handling is ${handling}, not ${dispatch.failure}.`);
  const destinationSignature = destinationParts && require('./report-content').functionSignature(destinationParts.header, destination.name.split('::').at(-1));
  const candidates = site.targets || [], matchesCandidate = candidates.some(target => target.file === destination?.source.file && target.line === destination?.source.line &&
    target.contract === owner(destination) && target.signature === destinationSignature);
  const header = destinationParts?.header || '', contract = owner(source), targetContract = owner(destination);
  const internal = dispatch.kind === 'internal' || dispatch.kind === 'internal-library';
  if (!destinationParts || destination.contextKind) fail(`${to.title}: a callable concrete function body is required, not a declaration or interface.`);
  if (dispatch.kind === 'internal') {
    if (site.recv && site.recv !== 'super' || site.isNew || site.relationship !== 'call' || !matchesCandidate || /\bexternal\b|\bvirtual\b/.test(header)) fail(`${from.title}: no unique checked non-virtual internal target matches this call.`);
  } else if (dispatch.kind === 'internal-library') {
    if (!matchesCandidate || !site.internalLibrary || !/\b(internal|private)\b/.test(header)) fail(`${from.title}: the library implementation or internal calling convention is not established.`);
  } else if (dispatch.kind === 'self') {
    if (site.receiverExpression !== 'this' || !matchesCandidate || contract !== targetContract || /\bvirtual\b/.test(header)) fail(`${from.title}: this self-call has no checked concrete implementation.`);
  } else if (dispatch.kind === 'constructor') {
    if (!site.isNew || destination.name.split('::').at(-1) !== 'constructor' || !matchesCandidate ||
      site.creationTargets?.length !== 1 || site.creationTargets[0].file !== destination.source.file) fail(`${from.title}: this creation expression does not establish the constructor implementation.`);
  } else if (dispatch.kind === 'local-instance') {
    let missingInitialization = '';
    if (!localInstance(source, site, destination, dispatch.evidence, units, evidence, reason => { missingInitialization = reason; })) fail(missingInitialization || `${from.title}: the exact receiver needs an unambiguous checked local construction and immutable or unchanged local binding. A static interface candidate is not running dispatch.`, missingInitialization ? 'local-reading' : 'structural');
    if (site.callKind !== 'low-level') {
      const signature = require('./report-content').functionSignature(header, destination.name.split('::').at(-1));
      const signatures = [...new Set((site.declarations || []).map(item => item.signature).filter(Boolean))];
      const direct = matchesCandidate && candidates.length === 1;
      if (site.name.split('::').at(-1) !== destination.name.split('::').at(-1) || !direct && (signatures.length !== 1 || signatures[0] !== signature)) fail(`${from.title}: the static call signature and concrete implementation do not have a checked compatible selector.`);
    }
  } else if (dispatch.kind === 'observed-external') {
    // Researcher assertions and local document quotations are not authenticated
    // deployment observations. Do not accept a provider-created checked flag.
    fail(`${from.title}: observed external dispatch requires independently verified deployment/code identity; the current source-only input cannot authenticate it. Supply chain/block/address, implementation identity and a verified observation through a supported evidence capability.`, 'capability');
  } else fail(`${from.title}: this runtime implementation remains unresolved; source candidates are not dispatch evidence.`, 'material-evidence');
  const context = internal ? 'same' : site.isNew ? 'creation' : site.callKind === 'low-level' && site.name === 'delegatecall' ? 'delegatecall' : site.callKind === 'low-level' && site.name === 'staticcall' ? 'staticcall' : 'call';
  if (dispatch.context !== context) fail(`${from.title}: execution context must be ${context} for this checked call.`);
  if (context === 'same' || context === 'delegatecall') {
    if (to.receiver !== from.receiver || to.caller !== from.caller) fail(`${to.title}: internal/delegate execution preserves the caller frame's execution address and EVM msg.sender.`);
  } else {
    if (to.caller !== from.receiver) fail(`${to.title}: the callee's EVM msg.sender must be the calling execution address, not the initiating actor.`);
    if (context !== 'creation' && to.receiver !== (site.receiverExpression === 'this' ? from.receiver : site.receiverExpression)) fail(`${to.title}: the callee execution address must match the checked receiver expression.`);
  }
  if (site.callKind === 'low-level') {
    // Only the unambiguous empty-calldata receive route is structurally
    // supported here. Selector/fallback/proxy decoding needs separate facts.
    if (!['call', 'send', 'transfer'].includes(site.name) || site.name === 'call' && !['""', "''", 'hex""', "hex''"].includes(expression(site.arguments)) ||
      destination.name.split('::').at(-1) !== 'receive') fail(`${from.title}: low-level selector/fallback dispatch has not been established for this exact calldata.`);
  }
  for (const input of to.inputs || []) {
    if (destinationParts && !parameterNames(destinationParts.header).includes(input.name) && input.name !== 'msg.value') fail(`${to.title}: ${input.name} is not a parameter of this function.`);
    if (!(input.evidence || []).some(id => covers(evidence.get(id), source, site.span))) fail(`${to.title}: input ${input.name} has no exact caller-side origin at this handoff.`);
    const actual = destinationParts && boundArgument(site, input.name, destinationParts.header);
    if (actual === null || actual === undefined || expression(actual) !== expression(input.expression)) fail(`${to.title}: input ${input.name} does not match its actual argument position at this exact call.`);
  }
  if (!(to.inputs || []).length && destinationParts && parameterNames(destinationParts.header).length && !/^No material parameters:/i.test(link.binding || '')) fail(`${to.title}: name the material input bindings, or justify why no parameter affects this statement.`);
  const failed = events.some(event => event.invocationId === to.invocationId && event.effect === 'rolled-back');
  if (failed && handling === 'propagates' && events.some(event => event.invocationId === from.invocationId && event.effect === 'committed')) fail(`${from.title}: an uncaught callee failure rolls back this caller; the same scenario cannot display a committed caller effect.`);
  if (failed && handling === 'caught-return' && events.some(event => event.invocationId === from.invocationId &&
      evidence.get(event.evidenceId)?.source.line > site.tryContext.span.endLine && ['committed', 'intermediate', 'return'].includes(event.effect)))
    fail(`${from.title}: the matching catch returns from this invocation; operations after try cannot execute on that path.`);
}
module.exports = { parts, expression, parameterNames, parameterSpans, boundArgument, unitSites, exactSite, validateTransition, validateInvocations, checkBooleanPremise };
