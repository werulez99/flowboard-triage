'use strict';
const { lexicalCode, matching, functionParts, escaped } = require('./solidity-text');
const { occurrences, commaSpans, span } = require('./call-occurrences');
function parts(value) {
  const clean = lexicalCode(value), result = []; let start = 0, depth = 0;
  for (let i = 0; i < clean.length; i++) {
    if ('([{'.includes(clean[i])) depth++;
    else if (')]}'.includes(clean[i])) depth--;
    else if (clean[i] === ',' && depth === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
  }
  if (value.slice(start).trim()) result.push(value.slice(start).trim());
  return result;
}
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
  return entry?.sourceId === unit?.id && entry.source?.line <= range.line && entry.source?.endLine >= range.endLine;
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
function localInstance(source, site, destination, supplied, units, evidence) {
  const name = receiverName(site.receiverExpression); if (!name) return false;
  const sourceParts = functionParts(source.code, source.name.split('::').at(-1));
  if (!sourceParts) return false;
  const checkedUnits = [...new Set(supplied.map(id => evidence.get(id)?.sourceId))].map(id => units.get(id)).filter(Boolean);
  // Straight-line local construction. Anything conditional, shadowed or
  // reassigned needs stronger evidence, not a guessed running implementation.
  const prefix = sourceParts.rawBody.slice(0, site.span.start - sourceParts.bodyStart);
  const cleanPrefix = lexicalCode(prefix);
  const local = new RegExp(`(?:^|[;}])\\s*([A-Za-z_$][\\w$]*)\\s+${escaped(name)}\\s*=([^;]+);`, 'g');
  for (const match of prefix.matchAll(local)) {
    const position = match.index + match[0].indexOf(match[1]);
    const depth = [...cleanPrefix.slice(0, position)].reduce((n, ch) => n + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
    const assignments = [...cleanPrefix.matchAll(new RegExp(`\\b${escaped(name)}\\s*=(?!=)`, 'g'))];
    if (!depth && assignments.length === 1 && creationMatches(source, match[2].trim(), destination, [match[1]]) &&
        supplied.some(id => covers(evidence.get(id), source, { line: source.source.line + source.code.slice(0, sourceParts.bodyStart + position).split('\n').length - 1,
          endLine: source.source.line + source.code.slice(0, sourceParts.bodyStart + match.index + match[0].length).split('\n').length - 1 }))) return true;
  }
  if (parameterNames(sourceParts.rawHeader).includes(name) || new RegExp(`\\b[A-Za-z_$][\\w$]*\\s+${escaped(name)}\\s*[;=]`).test(sourceParts.body)) return false;
  const declaration = checkedUnits.find(unit => unit.contextKind === 'state' && owner(unit) === owner(source) && unit.source.file === source.source.file &&
    /\bimmutable\b/.test(lexicalCode(unit.code)) && new RegExp(`\\b${escaped(name)}\\s*[;=]`).test(lexicalCode(unit.code)));
  if (!declaration) return false;
  const declaredType = lexicalCode(declaration.code).trim().match(/^([A-Za-z_$][\w$]*)\b/)?.[1];
  // Immutable initialization directly in a declaration has no assignment
  // ordering ambiguity, but its exact creation target still must be known.
  const inline = lexicalCode(declaration.code).match(new RegExp(`\\b${escaped(name)}\\s*=([^;]+);`));
  if (inline && creationMatches(declaration, inline[1], destination, [declaredType])) return true;
  for (const constructor of checkedUnits.filter(unit => unit.name === `${owner(source)}::constructor` && unit.source.file === source.source.file)) {
    const body = functionParts(constructor.code, 'constructor'); if (!body) continue;
    const assignments = [...body.body.matchAll(new RegExp(`\\b${escaped(name)}\\s*=(?!=)`, 'g'))];
    if (assignments.length !== 1) continue;
    const statement = new RegExp(`(?:^|[;}])\\s*${escaped(name)}\\s*=([^;]+);`, 'g');
    for (const match of body.rawBody.matchAll(statement)) {
      const at = match.index + match[0].indexOf(name), depth = [...body.body.slice(0, at)].reduce((n, ch) => n + (ch === '{' ? 1 : ch === '}' ? -1 : 0), 0);
      if (!depth && creationMatches(constructor, match[1].trim(), destination, [declaredType]) && supplied.some(id => covers(evidence.get(id), constructor,
        { line: constructor.source.line + constructor.code.slice(0, body.bodyStart + at).split('\n').length - 1,
          endLine: constructor.source.line + constructor.code.slice(0, body.bodyStart + match.index + match[0].length).split('\n').length - 1 }))) return true;
    }
  }
  return false;
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
    if (from.effect === 'rolled-back' && incoming[0].dispatch?.failure === 'propagates') fail(`${from.title}: an uncaught failed call propagates reversion; it cannot return normally to the caller.`);
    return;
  }
  const site = exactSite(source, link.callSiteId), destinationParts = destination && functionParts(destination.code, destination.name.split('::').at(-1));
  if (!site || from.callSiteId !== link.callSiteId) { fail(`${from.title}: anchor this handoff and event to one exact current call-site ID. Name or line matches cannot identify an invocation.`); return; }
  const anchor = evidence.get(from.evidenceId);
  if (anchor?.sourceId !== source.id || anchor.source.line !== site.span.line || anchor.source.endLine !== site.span.endLine) fail(`${from.title}: its checked code must cover exactly this call's lines, not another call or a whole function.`);
  if (from.invocationId === to.invocationId) fail(`${from.title}: entering another function needs a distinct invocation, even when internal msg.sender is unchanged.`);
  const dispatch = link.dispatch;
  if (!dispatch || !refs(dispatch.evidence) || dispatch.implementation !== destination?.id || !link.evidence.every(id => refs([id]))) {
    fail(`${from.title}: the running receiver and implementation need checked dispatch evidence.`); return;
  }
  if (dispatch.evidence.some(id => !link.evidence.includes(id))) fail(`${from.title}: fresh handoff checks must include every receiver/implementation premise, not only the call quotation.`);
  const expectedReceiver = site.receiverExpression || (site.isNew ? `new ${site.name}` : 'internal');
  if (dispatch.receiver !== expectedReceiver) fail(`${from.title}: dispatch receiver does not match this exact call expression.`);
  if (dispatch.failure !== site.failure) fail(`${from.title}: the call's failure handling is ${site.failure}, not ${dispatch.failure}.`);
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
    if (!localInstance(source, site, destination, dispatch.evidence, units, evidence)) fail(`${from.title}: the exact receiver needs an unambiguous checked local construction and immutable or unchanged local binding. A static interface candidate is not running dispatch.`);
    if (site.callKind !== 'low-level') {
      const signature = require('./report-content').functionSignature(header, destination.name.split('::').at(-1));
      const signatures = [...new Set((site.declarations || []).map(item => item.signature).filter(Boolean))];
      const direct = matchesCandidate && candidates.length === 1;
      if (site.name.split('::').at(-1) !== destination.name.split('::').at(-1) || !direct && (signatures.length !== 1 || signatures[0] !== signature)) fail(`${from.title}: the static call signature and concrete implementation do not have a checked compatible selector.`);
    }
  } else if (dispatch.kind === 'observed-external') {
    // Researcher assertions and local document quotations are not authenticated
    // deployment observations. Do not accept a provider-created checked flag.
    fail(`${from.title}: observed external dispatch requires independently verified deployment/code identity; the current source-only input cannot establish it.`, 'material-evidence');
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
  if (failed && site.failure === 'propagates' && events.some(event => event.invocationId === from.invocationId && event.effect === 'committed')) fail(`${from.title}: an uncaught callee failure rolls back this caller; the same scenario cannot display a committed caller effect.`);
}
module.exports = { parts, expression, parameterNames, parameterSpans, boundArgument, unitSites, exactSite, validateTransition };
