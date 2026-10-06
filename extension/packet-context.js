'use strict';
// Lossless source metadata interning. Text/IDs/ranges and the accepted semantic
// object are never summarized. Every reference resolves INSIDE this request.
const VERSION = 'source-context-v1';
const fields = ['initialization', 'relatedCalls', 'parameterSpans', 'structure'];
function compact(input) {
  if (input.sourceContextFormat) return input;
  const counts = new Map();
  const count = value => {
    if (!value || typeof value !== 'object') return;
    const key = JSON.stringify(value);
    if (Buffer.byteLength(key) >= 160) counts.set(key, (counts.get(key) || 0) + 1);
    for (const item of Object.values(value)) count(item);
  };
  for (const unit of input.sources || []) for (const key of fields) count(unit[key]);
  const table = {}, ids = new Map();
  const encode = value => {
    if (!value || typeof value !== 'object') return value;
    const key = JSON.stringify(value);
    if (counts.get(key) > 1) {
      if (!ids.has(key)) {
        const id = `metadata-${ids.size + 1}`; ids.set(key, id);
        table[id] = children(value);
      }
      return { sourceMetadataRef: ids.get(key) };
    }
    return children(value);
  };
  const children = value => Array.isArray(value) ? value.map(encode) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  const sources = (input.sources || []).map(unit => ({ ...unit, ...Object.fromEntries(fields.filter(key => key in unit).map(key => [key, encode(unit[key])])) }));
  if (!ids.size) return input;
  const packed = { ...input, sources, sourceContextFormat: VERSION, sourceMetadata: table };
  return Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(input)) ? packed : input;
}
function expand(input) {
  if (!input.sourceContextFormat) return input;
  if (input.sourceContextFormat !== VERSION || !input.sourceMetadata) throw new Error('Unsupported source metadata representation.');
  const decode = (value, visiting = new Set()) => {
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, 'sourceMetadataRef')) {
      const id = value.sourceMetadataRef;
      if (Object.keys(value).length !== 1 || !Object.hasOwn(input.sourceMetadata, id) || visiting.has(id)) throw new Error('Unresolved or cyclic source metadata reference.');
      return decode(input.sourceMetadata[id], new Set([...visiting, id]));
    }
    return Array.isArray(value) ? value.map(item => decode(item, visiting)) : Object.fromEntries(Object.entries(value).map(([key,item]) => [key,decode(item,visiting)]));
  };
  const { sourceContextFormat, sourceMetadata, ...result } = input;
  result.sources = input.sources.map(unit => ({ ...unit, ...Object.fromEntries(fields.filter(key => key in unit).map(key => [key,decode(unit[key])])) }));
  return result;
}
const instruction = 'source-context-v1 is lossless metadata sharing. In source initialization, relatedCalls, parameterSpans or structure, an object {sourceMetadataRef: ID} means the exact value at sourceMetadata[ID] in THIS request (references may nest). Expand it before interpreting the field. The table contains the full values, not unavailable host lookups. Source IDs, quotes, occurrences, candidates and semantic earlierDraft remain unchanged. This is not review or proof of runtime dispatch.';
module.exports = { VERSION, compact, expand, instruction };
