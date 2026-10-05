'use strict';
const { lexicalCode } = require('./solidity-text');

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

// Classify the payload only AFTER the caller establishes reachability and
// failure. Empty data is not Error(string). An unknown expression/overload
// remains unknown; a matching quotation alone establishes neither fact.
function failureClass(kind, args, custom = false, stringType = () => false) {
  if (kind === 'assert') return args.length === 1 ? 'Panic' : 'unknown';
  if (kind === 'revert' && custom) return 'custom';
  if (!['require', 'revert'].includes(kind)) return 'unknown';
  const index = kind === 'require' ? 1 : 0;
  if (args.length < index || args.length > index + 1) return 'unknown';
  const payload = args[index];
  if (payload === undefined) return 'empty';
  const literal = /^(?:unicode)?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(payload.trim());
  return literal || stringType(payload.trim()) ? 'Error' : 'unknown';
}
module.exports = { parts, failureClass };
