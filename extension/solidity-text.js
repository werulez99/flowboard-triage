'use strict';

// Blank comments/string contents while retaining length, line breaks and string
// delimiters. Text mentioning "foo()" is not a call. Delimiters keep string
// arguments countable by the pinned upstream call-site parser.
function lexicalCode(text) {
  const out = text.split('');
  let state = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (state === 'line') {
      if (c === '\n') state = 'code'; else out[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') { out[i] = out[++i] = ' '; state = 'code'; }
      else if (c !== '\n' && c !== '\r') out[i] = ' ';
    } else if (state === '"' || state === "'") {
      if (c === '\\') { out[i] = ' '; if (i + 1 < text.length) { i++; if (text[i] !== '\n') out[i] = ' '; } }
      else if (c === state) state = 'code';
      else if (c !== '\n' && c !== '\r') out[i] = ' ';
    } else if (c === '/' && next === '/') { out[i] = out[++i] = ' '; state = 'line'; }
    else if (c === '/' && next === '*') { out[i] = out[++i] = ' '; state = 'block'; }
    else if (c === '"' || c === "'") state = c;
  }
  return out.join('');
}
function matching(text, start, open = '(', close = ')') {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function functionParts(code, name) {
  const clean = lexicalCode(code);
  const keyword = ['constructor', 'receive', 'fallback'].includes(name) ? escaped(name) : `function\\s+${escaped(name)}`;
  const occurrences = [...clean.matchAll(new RegExp(`\\b${keyword}\\s*\\(`, 'g'))];
  if (occurrences.length !== 1) return null;
  const start = occurrences[0].index, paren = clean.indexOf('(', start), endParams = matching(clean, paren);
  if (endParams < 0) return null;
  let marker = endParams + 1;
  while (marker < clean.length && clean[marker] !== '{' && clean[marker] !== ';') marker++;
  if (marker === clean.length) return null;
  const end = clean[marker] === '{' ? matching(clean, marker, '{', '}') : marker;
  if (end < 0) return null;
  return { header: clean.slice(start, marker), rawHeader: code.slice(start, marker), bodyStart: marker + 1,
    body: clean[marker] === '{' ? clean.slice(marker + 1, end) : '',
    rawBody: clean[marker] === '{' ? code.slice(marker + 1, end) : '', clean, declaration: clean.slice(start, end + 1) };
}
function guards(parts) {
  if (!parts) return [];
  const result = [];
  for (const match of parts.body.matchAll(/\b(require|if)\s*\(/g)) {
    const start = parts.body.indexOf('(', match.index), end = matching(parts.body, start);
    if (end < 0) continue;
    result.push(`${match[1]}${parts.rawBody.slice(start, end + 1).replace(/\s+/g, ' ')}`.slice(0, 220));
    if (result.length === 5) break;
  }
  return result;
}
function stateStatements(clean, contract) {
  const result = [], open = clean.indexOf('{', contract.start);
  if (open < 0) return result;
  let depth = 0, start = open + 1;
  const add = text => { if (!/^\s*(?:function|constructor|receive|fallback|modifier|struct|enum|event|error|using|type)\b/.test(text)) result.push(text); };
  for (let i = open + 1; i < contract.end; i++) {
    if (clean[i] === '{') {
      if (depth === 0) add(clean.slice(start, i)); depth++;
    } else if (clean[i] === '}') {
      depth--; if (depth === 0) start = i + 1;
    } else if (clean[i] === ';' && depth === 0) { add(clean.slice(start, i + 1)); start = i + 1; }
  }
  return result;
}
function scanVariables(text, knownTypes, target) {
  const pattern = /\b([A-Za-z_$][\w$]*)\s+(?:(?:public|private|internal|external|constant|immutable|override|memory|storage|calldata|payable)\s+)*([A-Za-z_$][\w$]*)\s*[;=,)]/g;
  for (const match of text.matchAll(pattern)) if (knownTypes.has(match[1]) || /^(?:u?int\d*|bytes\d*|address|bool|string)$/.test(match[1])) target.set(match[2], match[1]);
}
module.exports = { lexicalCode, functionParts, guards, escaped, stateStatements, scanVariables };
