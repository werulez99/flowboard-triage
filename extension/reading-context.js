'use strict';
const crypto = require('node:crypto');
const { lexicalCode, stateStatements, scanVariables, escaped } = require('./solidity-text');
function reference(catalog, fn) {
  return { file: catalog.relative(fn.file), line: fn.startLine, endLine: fn.endLine,
    sourceHash: crypto.createHash('sha256').update(catalog.document(catalog.relative(fn.file)).text).digest('hex'),
    name: `${fn.contract ? fn.contract + '::' : ''}${fn.name}`, signature: catalog.hints(fn).identity.signature };
}
function sharedNames(catalog, fn) {
  catalog.scopeFor(fn);
  if (!catalog.readingStateNames) catalog.readingStateNames = new Map();
  const key = `${fn.file}:${fn.contract}`;
  if (!catalog.readingStateNames.has(key)) {
    const code = lexicalCode(catalog.document(catalog.relative(fn.file)).text), contracts = catalog.runner.flowboardContracts(code).filter(item => item.name === fn.contract);
    const names = contracts.flatMap(contract => stateStatements(code, contract).filter(statement => !/\b(constant|immutable)\b/.test(statement)).flatMap(statement => [...statement.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:=|;)/g)].map(match => match[1])));
    catalog.readingStateNames.set(key, [...new Set(names)]);
  }
  const parts = catalog.anatomy(fn), locals = new Map(); if (!parts) return [];
  scanVariables(parts.declaration, catalog.knownTypes, locals);
  return catalog.readingStateNames.get(key).filter(name => !locals.has(name) && new RegExp(`\\b${escaped(name)}\\b`).test(parts.body));
}
// Small source neighborhood, not a synthesized execution/attack sequence.
// Extra code remains available behind the existing related-functions control.
function relatedCode(catalog, anchors) {
  const items = new Map(), gaps = new Set(), initial = new Set(anchors.map(fn => catalog.key(fn)));
  const add = (fn, reason, relationship, from) => {
    if (!fn || !catalog.anatomy(fn)) return;
    const key = catalog.key(fn);
    if (!items.has(key)) items.set(key, { fn, reason, relationship, from, source: reference(catalog, fn) });
  };
  for (const fn of anchors) add(fn, 'Report-related code. Check the statement against the complete function.', 'report');
  for (let depth = 0, layer = anchors; depth < 2; depth++) {
    const next = [];
    for (const fn of layer) {
      const resolved = catalog.resolveCard({ file: catalog.relative(fn.file), line: fn.startLine, function: fn.name });
      for (const modifier of resolved.modifiers || []) {
        if (typeof modifier.file !== 'string' || !Number.isSafeInteger(modifier.startLine)) {
          gaps.add(`The ${modifier.name} guard on ${fn.contract}::${fn.name} has no resolved declaration. Check its inherited implementation.`); continue;
        }
        const def = catalog.modifierAt(catalog.relative(modifier.file), modifier.startLine, modifier.name);
        if (def && catalog.anatomy(def)) add(def, `${fn.contract}::${fn.name} applies ${modifier.name}. Check this guard before judging who can use the function.`, 'guard', catalog.key(fn));
        else gaps.add(`The ${modifier.name} guard on ${fn.contract}::${fn.name} could not be read.`);
      }
      for (const site of catalog.callLinks(fn)) {
        if (site.resolution !== 'direct-internal') gaps.add(`${catalog.relative(fn.file)}:${site.line}: ${site.expression}${site.receiverTypes?.length ? ' (declared ' + site.receiverTypes.join(' or ') + ')' : ''} ${site.candidates.length > 1 ? 'has several possible implementations' : 'has no established running implementation'}.`);
        // Alternatives remain listed on the calling context, but recursively
        // following every interface implementation creates unrelated routes.
        if (site.candidates.length > 1) continue;
        for (const target of site.candidates) {
          if (!items.has(catalog.key(target))) next.push(target);
          add(target, `${fn.contract}::${fn.name} includes ${site.expression} at L${site.line}. ${site.relationship === 'call' ? 'Read this helper before interpreting the later statements.' : 'Possible implementation only; check the receiver and branch.'}`, site.relationship, catalog.key(fn));
        }
      }
    }
    layer = next;
    if (items.size > 80) { gaps.add('The two-step code neighborhood is large. More called code remains outside automatic preparation.'); break; }
  }
  const inspected = [...items.values()].filter(item => item.fn.kind !== 'modifier' && anchors.some(anchor => anchor.file === item.fn.file && anchor.contract === item.fn.contract));
  const imported = new Set();
  catalog.relevantDefinitions([], anchors[0]?.file);
  for (const fn of anchors) for (const file of catalog.importContext.files(fn.file)) imported.add(file);
  for (const fn of catalog.functions) {
    if (initial.has(catalog.key(fn)) || /(?:^|\/)(?:test|tests|script|scripts|mocks)\//.test(catalog.relative(fn.file)) || /(?:^|\/)(?:lib|node_modules)\//.test(catalog.relative(fn.file)) && !imported.has(fn.file)) continue;
    const call = anchors.some(anchor => catalog.code(fn).includes(anchor.name)) && catalog.callLinks(fn).find(site => site.candidates.length === 1 && initial.has(catalog.key(site.candidates[0])));
    if (call) add(fn, `${fn.contract}::${fn.name} includes ${call.expression} at L${call.line}. Check this caller's conditions.`, call.relationship, catalog.key(call.candidates[0]));
    if (!call && imported.has(fn.file)) for (const anchor of anchors) {
      const bases = new Set(), visit = name => { for (const base of catalog.result.contractBases.get(name) || []) if (!bases.has(base)) { bases.add(base); visit(base); } }; visit(anchor.contract);
      if (!bases.has(fn.contract) || !catalog.code(fn).includes(anchor.name) || !['public', 'external'].includes(catalog.hints(fn).visibility)) continue;
      const site = catalog.callLinks(fn).find(site => site.expression.replace(/\(.*$/, '').split('.').pop() === anchor.name);
      if (site) add(fn, `${fn.contract}::${fn.name} invokes the virtual ${anchor.name} hook in an imported base. Check the derived override and caller guard; this is not a deployed-instance proof.`, 'hypothesis', catalog.key(anchor));
    }
    const same = inspected.filter(item => item.fn.contract === fn.contract && item.fn.file === fn.file);
    if (!same.length) continue;
    const names = sharedNames(catalog, fn), shared = same.map(item => ({ item, names: sharedNames(catalog, item.fn).filter(name => names.includes(name)) })).find(item => item.names.length);
    if (shared) add(fn, `Also uses ${shared.names.join(', ')} in ${fn.contract}. Check whether it preserves or changes the reported data; this is not a call from the selected function.`, 'state-dependency', catalog.key(shared.item.fn));
  }
  return { items: [...items.values()], gaps: [...gaps] };
}
function recommendation(catalog, request, ranked = []) {
  const main = request.cards.filter(card => card.kind !== 'context').map(card => ({ card, fn: catalog.resolveCard(card) }));
  if (!main.length) return null;
  let choice = main.find(item => item.card.mapping?.method !== 'source-neighbor') || main[0];
  if (request.finding.status === 'unreviewed' && choice.card.mapping?.method === 'citation') {
    const named = main.find(item => item.card.mapping?.method === 'symbol');
    if (named && catalog.key(named.fn) !== catalog.key(choice.fn)) choice = named;
  }
  // A real old citation can now land in an unrelated function. Offer the
  // stronger report-related candidate without modifying the saved map/review.
  if (request.finding.status === 'unreviewed' && !['symbol', 'reviewer'].includes(choice.card.mapping?.method) && ranked.length && !ranked.some(item => catalog.key(item.fn) === catalog.key(choice.fn))) {
    choice = { fn: ranked[0].fn, card: { id: null, mapping: { method: 'description' } }, shifted: true };
  }
  const hints = catalog.hints(choice.fn);
  if (['internal', 'private'].includes(hints.visibility)) {
    const caller = main.find(item => ['external', 'public'].includes(catalog.hints(item.fn).visibility) && catalog.callLinks(item.fn).some(site => site.relationship === 'call' && site.candidates.some(target => catalog.key(target) === catalog.key(choice.fn))));
    if (caller) choice = caller;
  }
  const fn = choice.fn, site = catalog.callLinks(fn).find(item => item.relationship === 'call');
  return { cardId: choice.card.id, source: reference(catalog, fn),
    reason: choice.shifted ? `The report’s first location may have shifted. Start with ${fn.contract}::${catalog.hints(fn).identity.signature}, a related code candidate, and check it against the report.` : site ? `Start with ${fn.contract}::${catalog.hints(fn).identity.signature}: it contains the call to ${site.candidates[0].name}. Check that helper before judging this operation.` :
      `Start with ${fn.contract}::${catalog.hints(fn).identity.signature}: ${!choice.card.mapping || choice.card.mapping.method === 'citation' ? 'the report points here; first check that the citation matches its claim.' : 'related code was found; check its conditions against the report.'}` };
}
module.exports = { reference, relatedCode, recommendation, sharedNames };
