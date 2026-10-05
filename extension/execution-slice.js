'use strict';
// Small source-preserving statement parser for checked boolean paths. It is
// not a symbolic executor. Unknown branches, loops, assembly and side effects
// cannot be used to prove a selected failure. Offsets remain original UTF-16.
const { lexicalCode, matching, functionParts } = require('./solidity-text');
const { occurrences } = require('./call-occurrences');
const cache = new WeakMap();
function boolean(value, values, depth = 0) {
  if (depth > 16 || value == null) return null;
  let text = lexicalCode(String(value)).replace(/\s+/g, '');
  while (text.startsWith('(') && matching(text, 0) === text.length - 1) text = text.slice(1, -1);
  if (text === 'true' || text === 'false') return text === 'true';
  for (const op of ['||', '&&']) {
    let depth = 0;
    for (let at = 0; at < text.length - 1; at++) {
      if (text[at] === '(') depth++; else if (text[at] === ')') depth--;
      if (!depth && text.slice(at, at + 2) === op) {
        const left = boolean(text.slice(0, at), values, depth + 1), right = boolean(text.slice(at + 2), values, depth + 1);
        return op === '&&' ? left === false || right === false ? false : left === true && right === true ? true : null :
          left === true || right === true ? true : left === false && right === false ? false : null;
      }
    }
  }
  const comparison = /^(\w+)(>=|<=|>|<)(\d+)$/.exec(text);
  if (comparison && values.get(comparison[1])?.range) {
    const [low, high] = values.get(comparison[1]).range.map(BigInt), n = BigInt(comparison[3]);
    return comparison[2] === '>=' ? low >= n ? true : high < n ? false : null :
      comparison[2] === '<=' ? high <= n ? true : low > n ? false : null :
      comparison[2] === '>' ? low > n ? true : high <= n ? false : null : low < n ? true : high >= n ? false : null;
  }
  if (/^[\w$]+$/.test(text) && values.has(text)) return boolean(values.get(text), new Map(), depth + 1);
  if (text.startsWith('!') && !text.startsWith('!=')) { const inner = boolean(text.slice(1), values, depth + 1); return inner == null ? null : !inner; }
  return null;
}
function parse(unit) {
  const hit = cache.get(unit); if (hit?.code === unit.code) return hit;
  const body = functionParts(unit.code, unit.name.split('::').at(-1));
  if (!body) return null;
  const clean = body.clean, end = body.bodyStart + body.body.length;
  const tries = occurrences(unit.code, { from: body.bodyStart, to: end }).filter(site => site.tryContext && !site.tryContext.unsupported);
  const skip = at => { while (at < end && /\s/.test(clean[at])) at++; return at; };
  function statement(at, depth = 0) {
    at = skip(at); if (depth > 80) return { kind: 'unknown', start: at, end };
    if (clean[at] === '{') {
      const close = matching(clean, at, '{', '}');
      if (close < 0) return { kind: 'unknown', start: at, end };
      return { kind: 'block', start: at, end: close + 1, children: sequence(at + 1, close, depth + 1) };
    }
    if (/^if\b/.test(clean.slice(at))) {
      const open = skip(at + 2), close = clean[open] === '(' ? matching(clean, open) : -1;
      if (close < 0) return { kind: 'unknown', start: at, end };
      const yes = statement(close + 1, depth + 1), next = skip(yes.end);
      const no = /^else\b/.test(clean.slice(next)) ? statement(next + 4, depth + 1) : null;
      return { kind: 'if', start: at, end: no?.end || yes.end, condition: unit.code.slice(open + 1, close), yes, no };
    }
    if (/^try\b/.test(clean.slice(at))) {
      const site = tries.find(item => item.tryContext.span.start === at);
      if (site) return { kind: 'try', start: at, end: site.tryContext.span.end,
        headerEnd: site.span.end, site };
    }
    // Other structured statements are recognized but not interpreted here.
    // A target in a try header can still use prior straight-line assignments;
    // catch routing is checked separately against the exact call occurrence.
    let cursor = at;
    while (cursor < end) {
      if (clean[cursor] === '(' || clean[cursor] === '[') {
        const close = matching(clean, cursor, clean[cursor], clean[cursor] === '(' ? ')' : ']');
        if (close < 0) break; cursor = close + 1; continue;
      }
      if (clean[cursor] === '{') {
        const close = matching(clean, cursor, '{', '}');
        return { kind: 'unknown', start: at, end: close < 0 ? end : close + 1 };
      }
      if (clean[cursor] === ';') return { kind: 'simple', start: at, end: cursor + 1 };
      cursor++;
    }
    return { kind: 'unknown', start: at, end };
  }
  function sequence(start, stop, depth = 0) {
    const nodes = []; let cursor = skip(start);
    while (cursor < stop) { const node = statement(cursor, depth); nodes.push(node); if (node.end <= cursor) break; cursor = skip(node.end); }
    return nodes;
  }
  const result = { code: unit.code, body, nodes: sequence(body.bodyStart, end) }; cache.set(unit, result); return result;
}
function pathTo(unit, offset, initial, options = {}) {
  const tree = parse(unit); if (!tree) return { reachable: null, reason: 'Function structure unavailable.' };
  const values = new Map(initial), guards = [], locals = new Set();
  const unknown = reason => ({ reachable: null, reason, values, guards });
  const stopped = (reason, outcome, failure) => ({ reachable: false, reason, outcome, failure, values, guards });
  function operation(node) {
    const result = options.operation?.(node, values);
    if (!result || result.outcome === 'unknown') return unknown(result?.reason || 'A preceding invocation needs its exact implementation and a checked effect before this statement.');
    if (result.outcome !== 'continue') return stopped(result.reason, result.outcome, result.failure);
    return null;
  }
  function walk(nodes) {
    for (const node of nodes) {
      if (options.through != null && node.start > options.through) break;
      if (options.after != null && node.end <= options.after) continue;
      if (offset < node.start) return unknown('The selected statement is not in the parsed path.');
      const contains = node.start <= offset && offset < node.end;
      if (node.kind === 'if') {
        if (contains && offset < node.yes.start) return { reachable: true, values, guards };
        const choice = boolean(node.condition, values);
        if (choice == null) {
          if (contains) return unknown('The enclosing branch condition is not established at this statement.');
          // Both branches must independently continue. A return/failure in
          // either branch is not dismissed because its condition is unknown.
          const before = new Map(values), yes = walk([node.yes]);
          if (yes) return unknown('A possible preceding branch terminates or has an unresolved effect.');
          const afterYes = new Map(values); values.clear(); for (const [key, value] of before) values.set(key, value);
          const no = node.no && walk([node.no]);
          if (no) return unknown('A possible preceding branch terminates or has an unresolved effect.');
          for (const key of new Set([...values.keys(), ...afterYes.keys()])) if (JSON.stringify(values.get(key)) !== JSON.stringify(afterYes.get(key))) values.set(key, null);
          continue;
        }
        guards.push({ start: node.start, end: node.yes.start, expression: node.condition, value: choice });
        const selected = choice ? node.yes : node.no;
        if (contains && (!selected || !(selected.start <= offset && offset < selected.end))) return { reachable: false, values, guards, reason: 'The checked condition chooses the other branch.' };
        if (selected) { const result = walk([selected]); if (result) return result; }
        continue;
      }
      if (node.kind === 'block') {
        // Block-local declarations have a different identity; do not infer a
        // binding across that scope without the declaration/write checker.
        const text = lexicalCode(unit.code.slice(node.start + 1, node.end - 1));
        if (/\b(?:bool|string|u?int\d*|address)\s+(?:memory\s+)?\w+/.test(text)) return unknown('A nested local declaration needs a scoped value proof.');
        const result = walk(node.children); if (result) return result; continue;
      }
      if (node.kind === 'try') {
        // Entering the header is not entering either the success or catch
        // body. Prior statements still have to reach this exact occurrence.
        if (contains && offset < node.headerEnd) return { reachable: true, values, guards };
        const result = operation(node); if (result) return result;
        if (contains) return unknown('The selected try/catch body needs its checked branch destination.');
        continue;
      }
      if (contains) return { reachable: node.kind === 'simple' ? true : null, values, guards,
        ...(node.kind === 'unknown' ? { reason: 'This structured statement is outside the supported failure-path subset.' } : {}) };
      const text = unit.code.slice(node.start, node.end), clean = lexicalCode(text).trim();
      if (node.kind === 'unknown') return unknown('A preceding structured operation needs a checked path before this statement.');
      if (/^(?:revert|throw)\b/.test(clean)) return stopped('An earlier failure terminates this path.', 'failure', /^revert\s+\w/.test(clean) ? 'custom' : 'Error');
      // Do not let assignment syntax hide an invocation in its RHS. The
      // operation resolver must account for it before values can advance.
      const calls = occurrences(text).filter(site => !['require', 'assert'].includes(site.name));
      if (calls.length) { const result = operation(node); if (result) return result; }
      if (/^return\b/.test(clean)) return stopped('An earlier return terminates this function path.', 'return');
      const assignment = /^(?:([A-Za-z_$][\w$]*)\s+(?:memory\s+)?|)([A-Za-z_$][\w$]*)\s*=(?!=)([^;]+);$/.exec(clean);
      if (assignment) {
        if (assignment[1]) locals.add(assignment[2]);
        if (options.localWritesOnly && !assignment[1] && !locals.has(assignment[2]) && !initial.has(assignment[2])) return unknown('The helper may change shared state; its caller-side effect needs a checked derivation.');
        const value = boolean(assignment[3], values); values.set(assignment[2], value == null ? null : String(value)); continue;
      }
      const deletion = /^delete\s+([A-Za-z_$][\w$]*)\s*;$/.exec(clean);
      if (deletion && locals.has(deletion[1])) { values.set(deletion[1], null); continue; }
      // This is an explicit successful arithmetic scenario, not a proof that
      // arbitrary deployed values cannot overflow. No numeric result is
      // invented, and its unknown value cannot establish a later guard.
      const arithmetic = /^(\w+)\s*\+=\s*(\w+)\s*;$/.exec(clean);
      if (arithmetic && options.noOverflow) { values.set(arithmetic[1], null); continue; }
      const guard = /^(?:require|assert)\s*\(/.exec(clean);
      if (guard) {
        const open = clean.indexOf('('), close = matching(clean, open), first = clean.slice(open + 1, close).split(',')[0];
        const value = boolean(first, values);
        if (value === false) return stopped('An earlier guard rejects this path.', 'failure', /^assert\b/.test(clean) ? 'Panic' : 'Error');
        if (value == null) return unknown('An earlier guard has not been established for this path.');
      } else if (/\bassembly\b|\b(?:delete|break|continue)\b|\+\+|--|[+*/%&|^]=/.test(clean)) return unknown('A preceding mutation or control operation needs a checked derivation.');
      else if (!calls.length && clean !== ';') return unknown('A preceding statement has no established effect in the supported source-path subset.');
    }
    return null;
  }
  return walk(tree.nodes) || (options.complete ? { reachable: true, outcome: 'continue', values, guards } : unknown('The selected statement is outside this function body.'));
}
module.exports = { parse, pathTo, boolean };
