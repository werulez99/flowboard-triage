'use strict';
const crypto = require('node:crypto');
const { lexicalCode, matching } = require('./solidity-text');

// This is a bounded lexical occurrence index, not a Solidity type checker.
// Native/compiler lookup resolves candidate declarations separately. Never
// pair a candidate's receiver with a later occurrence of the same method.
const nonCalls = new Set(['if', 'while', 'for', 'switch', 'catch', 'returns', 'return', 'function', 'modifier', 'unchecked', 'assembly']);
function previous(text, at) { while (at >= 0 && /\s/.test(text[at])) at--; return at; }
function backward(text, end, open, close) {
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (text[i] === close) depth++;
    else if (text[i] === open && --depth === 0) return i;
  }
  return -1;
}
function expressionStart(clean, end, depth = 0) {
  if (depth > 128) return -1;
  let at = previous(clean, end), start = at;
  if (at < 0) return -1;
  if (clean[at] === ')' || clean[at] === ']') {
    const open = clean[at] === ')' ? '(' : '[', close = clean[at];
    start = backward(clean, at, open, close);
    if (start < 0) return -1;
    const preceding = previous(clean, start - 1);
    if (preceding >= 0 && /[\w$\]\)]/.test(clean[preceding])) {
      const nested = expressionStart(clean, preceding, depth + 1);
      if (nested >= 0) start = nested;
    }
  } else {
    if (!/[\w$]/.test(clean[at])) return -1;
    while (at >= 0 && /[\w$]/.test(clean[at])) at--;
    start = at + 1;
  }
  const dot = previous(clean, start - 1);
  if (clean[dot] === '.') {
    const earlier = expressionStart(clean, dot - 1, depth + 1);
    if (earlier >= 0) start = earlier;
  }
  return start;
}
function commaSpans(clean, from, to) {
  const spans = []; let start = from, depth = 0;
  const add = end => {
    let first = start, last = end;
    while (first < last && /\s/.test(clean[first])) first++;
    while (last > first && /\s/.test(clean[last - 1])) last--;
    if (first < last) spans.push({ start: first, end: last });
  };
  for (let i = from; i < to; i++) {
    if ('([{'.includes(clean[i])) depth++;
    else if (')]}'.includes(clean[i])) depth--;
    else if (clean[i] === ',' && !depth) { add(i); start = i + 1; }
  }
  add(to); return spans;
}
function span(text, start, end, line = 1) {
  const before = text.slice(0, start), through = text.slice(0, end);
  return { start, end, line: line + before.split('\n').length - 1,
    endLine: line + through.split('\n').length - 1,
    column: start - (text.lastIndexOf('\n', start - 1) + 1),
    endColumn: end - (text.lastIndexOf('\n', end - 1) + 1) };
}
function occurrences(text, options = {}) {
  const clean = lexicalCode(text), result = [], line = options.line || 1;
  const from = options.from || 0, to = options.to ?? text.length;
  const range = (start, end) => span(text, start, end, line);
  const named = (entry, index) => {
    const raw = clean.slice(entry.start, entry.end), colon = raw.indexOf(':');
    const name = colon >= 0 && /^\s*[A-Za-z_$][\w$]*\s*$/.test(raw.slice(0, colon)) ? raw.slice(0, colon).trim() : null;
    let start = name ? entry.start + colon + 1 : entry.start;
    while (start < entry.end && /\s/.test(clean[start])) start++;
    return { name, index, expression: text.slice(start, entry.end), span: range(start, entry.end) };
  };
  for (const match of clean.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const name = match[1], methodStart = match.index;
    if (methodStart < from || methodStart >= to || nonCalls.has(name)) continue;
    let at = methodStart + name.length;
    while (/\s/.test(clean[at] || '') && at < to) at++;
    let callOptions = [];
    if (clean[at] === '{') {
      const close = matching(clean, at, '{', '}');
      if (close < 0) continue;
      callOptions = commaSpans(clean, at + 1, close).map(named);
      // A function/control body followed by grouping is not a call-options
      // list. Restrict this syntax to the actual Solidity option names.
      if (!callOptions.length || callOptions.some(item => !['value', 'gas', 'salt'].includes(item.name))) continue;
      at = close + 1; while (/\s/.test(clean[at] || '') && at < to) at++;
    }
    if (clean[at] !== '(') continue;
    const close = matching(clean, at); if (close < 0 || close >= to) continue;
    const before = previous(clean, methodStart - 1);
    let start = methodStart, recv = null, recvChain, receiverExpression = '', receiverSpan = null;
    if (clean[before] === '.') {
      const receiverEnd = previous(clean, before - 1) + 1, receiverStart = expressionStart(clean, receiverEnd - 1);
      if (receiverStart < 0) continue;
      start = receiverStart; receiverExpression = text.slice(start, receiverEnd).trim(); receiverSpan = range(receiverStart, receiverEnd);
      const simple = clean.slice(start, receiverEnd).trim();
      if (/^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(simple)) {
        const chain = simple.split(/\s*\.\s*/); recv = chain.at(-1); if (chain.length > 1) recvChain = chain;
      } else recv = simple.match(/^([A-Za-z_$][\w$]*)/)?.[1] || '';
    }
    const prefix = clean.slice(0, start), newMatch = /\bnew\s+$/.exec(prefix);
    const isNew = !!newMatch; if (newMatch) start = newMatch.index;
    let argumentFrom = at + 1, argumentTo = close;
    while (/\s/.test(clean[argumentFrom] || '') && argumentFrom < argumentTo) argumentFrom++;
    while (/\s/.test(clean[argumentTo - 1] || '') && argumentTo > argumentFrom) argumentTo--;
    const namedArguments = clean[argumentFrom] === '{' && matching(clean, argumentFrom, '{', '}') === argumentTo - 1;
    const argumentSpans = commaSpans(clean, argumentFrom + (namedArguments ? 1 : 0), argumentTo - (namedArguments ? 1 : 0))
      .map((entry, index) => namedArguments ? named(entry, index) : { name: null, index, expression: text.slice(entry.start, entry.end), span: range(entry.start, entry.end) });
    const sourceSpan = range(start, close + 1);
    const id = 'call-' + crypto.createHash('sha256').update(JSON.stringify([options.identity || '', line, start, close + 1, text.slice(start, close + 1)])).digest('hex').slice(0, 20);
    const failure = /\btry\s*$/.test(clean.slice(0, start)) && /\bcatch\b/.test(clean.slice(close + 1, to)) ? 'caught' :
      recv && ['call', 'staticcall', 'delegatecall', 'send'].includes(name) ? 'returns-status' : 'propagates';
    result.push({ id, name, recv, recvChain, isNew, argCount: argumentSpans.length, failure,
      receiverExpression, receiverSpan, arguments: text.slice(at + 1, close), argumentSpans, options: callOptions,
      span: sourceSpan, nameSpan: range(methodStart, methodStart + name.length),
      callKind: isNew ? 'creation' : ['call', 'staticcall', 'delegatecall', 'send', 'transfer'].includes(name) && recv ? 'low-level' : recv ? 'member' : 'internal',
      sourceExpression: text.slice(start, close + 1) });
  }
  return result;
}
module.exports = { occurrences, span, commaSpans };
