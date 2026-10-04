'use strict';
const { lexicalCode, matching } = require('./solidity-text');
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
  return parts(header.slice(open + 1, end)).map(param => param.match(/\s+([A-Za-z_$][\w$]*)\s*$/)?.[1] || null);
}
function boundArgument(site, parameter, header) {
  const parameters = parameterNames(header), index = parameters.indexOf(parameter);
  if (index < 0 || typeof site.arguments !== 'string') return null;
  const raw = site.arguments.trim();
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const named = parts(raw.slice(1, -1)).map(arg => { const at = arg.indexOf(':'); return [arg.slice(0, at).trim(), arg.slice(at + 1).trim()]; });
    return named.find(([name]) => name === parameter)?.[1] ?? null;
  }
  const args = parts(raw);
  if (site.implicitReceiver) args.unshift(site.receiver);
  return args.length === parameters.length ? args[index] : null;
}
module.exports = { parts, expression, parameterNames, boundArgument };
