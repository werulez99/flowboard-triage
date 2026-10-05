'use strict';
// Small source-preserving statement parser for checked boolean paths. It is
// not a symbolic executor. Unknown branches, loops, assembly and side effects
// cannot be used to prove a selected failure. Offsets remain original UTF-16.
const { lexicalCode, matching, functionParts } = require('./solidity-text');
const cache = new WeakMap();
function boolean(value, values, depth = 0) {
  if (depth > 16 || value == null) return null;
  let text = lexicalCode(String(value)).replace(/\s+/g, '');
  while (text.startsWith('(') && matching(text, 0) === text.length - 1) text = text.slice(1, -1);
  if (text === 'true' || text === 'false') return text === 'true';
  if (/^[\w$]+$/.test(text) && values.has(text)) return boolean(values.get(text), new Map(), depth + 1);
  if (text.startsWith('!') && !text.startsWith('!=')) { const inner = boolean(text.slice(1), values, depth + 1); return inner == null ? null : !inner; }
  return null;
}
function parse(unit) {
  const hit = cache.get(unit); if (hit?.code === unit.code) return hit;
  const body = functionParts(unit.code, unit.name.split('::').at(-1));
  if (!body) return null;
  const clean = body.clean, end = body.bodyStart + body.body.length;
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
function pathTo(unit, offset, initial) {
  const tree = parse(unit); if (!tree) return { reachable: null, reason: 'Function structure unavailable.' };
  const values = new Map(initial), guards = [];
  const unknown = reason => ({ reachable: null, reason, values, guards });
  function walk(nodes) {
    for (const node of nodes) {
      if (offset < node.start) return unknown('The selected statement is not in the parsed path.');
      const contains = node.start <= offset && offset < node.end;
      if (node.kind === 'if') {
        const choice = boolean(node.condition, values);
        if (choice == null) return unknown('The enclosing or preceding branch condition is not established at this statement.');
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
      if (contains) return { reachable: node.kind === 'simple' ? true : null, values, guards,
        ...(node.kind === 'unknown' ? { reason: 'This structured statement is outside the supported failure-path subset.' } : {}) };
      const text = unit.code.slice(node.start, node.end), clean = lexicalCode(text).trim();
      if (node.kind === 'unknown') return unknown('A preceding structured operation needs a checked path before this statement.');
      if (/^(?:return|revert|throw)\b/.test(clean)) return { reachable: false, values, guards, reason: 'An earlier statement terminates this path.' };
      const assignment = /^(?:(bool|string)\s+(?:memory\s+)?|)([A-Za-z_$][\w$]*)\s*=(?!=)([^;]+);$/.exec(clean);
      if (assignment) {
        const value = boolean(assignment[3], values); values.set(assignment[2], value == null ? null : String(value)); continue;
      }
      const guard = /^(?:require|assert)\s*\(/.exec(clean);
      if (guard) {
        const open = clean.indexOf('('), close = matching(clean, open), first = clean.slice(open + 1, close).split(',')[0];
        const value = boolean(first, values);
        if (value === false) return { reachable: false, values, guards, reason: 'An earlier guard rejects this path.' };
        if (value == null) return unknown('An earlier guard has not been established for this path.');
      } else if (/\bassembly\b|\b(?:delete|break|continue)\b|\+\+|--|[+*/%&|^]=/.test(clean)) return unknown('A preceding mutation or control operation needs a checked derivation.');
    }
    return null;
  }
  return walk(tree.nodes) || unknown('The selected statement is outside this function body.');
}
module.exports = { parse, pathTo, boolean };
