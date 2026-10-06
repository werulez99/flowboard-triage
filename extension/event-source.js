'use strict';
// Analytical notes remain immutable. Callable frames are exact, ephemeral
// projections of acquired/read bytes, shared by semantics and native display.
const { lexicalCode, functionPartsAt, matching } = require('./solidity-text');
const crypto = require('node:crypto');
const indexes = new Map(), origins = new WeakMap();
let indexBuilds = 0;
function index(code) {
  const key = crypto.createHash('sha256').update(code).digest('hex');
  if (indexes.has(key)) return indexes.get(key);
  const clean = lexicalCode(code), result = [], lines = code.split('\n');
  const lineAt = offset => code.slice(0, offset).split('\n').length - 1;
  const contracts = [...clean.matchAll(/\b(?:contract|interface|library)\s+(\w+)[^{;]*\{/g)].map(match => {
    const open = clean.indexOf('{', match.index); return { name: match[1], start: open, end: matching(clean, open, '{', '}') };
  });
  for (const match of clean.matchAll(/\b(?:(function|modifier)\s+([A-Za-z_$][\w$]*)|(constructor|receive|fallback))\s*\(/g)) {
    const parts = functionPartsAt(code, match.index, clean);
    if (!parts || clean[parts.bodyStart - 1] !== '{') continue;
    const end = matching(clean, parts.bodyStart - 1, '{', '}'), line = lineAt(parts.start), endLine = lineAt(end);
    const lineStart = clean.lastIndexOf('\n', parts.start - 1) + 1, after = clean.indexOf('\n', end + 1);
    if (clean.slice(lineStart, parts.start).trim() || clean.slice(end + 1, after < 0 ? clean.length : after).trim()) continue;
    const owner = contracts.filter(c => c.start < parts.start && c.end > end);
    result.push({ name: match[2] || match[3], line, endLine, code: lines.slice(line, endLine + 1).join('\n'),
      signature: require('./report-content').functionSignature(parts.header, match[2] || match[3]), contract: owner.length === 1 ? owner[0].name : null });
  }
  indexBuilds++; if (indexes.size >= 32) indexes.delete(indexes.keys().next().value);
  indexes.set(key, result); return result;
}
function sameFile(a, b) { return !!a && !!b && a.file === b.file && a.sourceHash === b.sourceHash; }
function contains(outer, inner) {
  return outer?.complete && inner?.complete && sameFile(outer.source, inner.source) && outer.source.line <= inner.source.line && outer.source.endLine >= inner.source.endLine &&
    outer.code.split('\n').slice(inner.source.line - outer.source.line, inner.source.endLine - outer.source.line + 1).join('\n') === inner.code;
}
function read(unit, end) { return !Number.isInteger(unit.readThrough) || unit.readThrough >= end; }
function covers(note, frame, range) {
  if (!note || !frame || !range || !sameFile(note.source, frame.source) || note.source.line > range.line || note.source.endLine < range.endLine) return false;
  const origin = origins.get(frame)?.get(note.sourceId) || (note.sourceId === frame.id ? frame : null);
  if (!origin || (!contains(origin, frame) && origin.id !== frame.id) || !read(origin, Math.max(note.source.endLine, range.endLine))) return false;
  return note.source.line >= origin.source.line && note.source.endLine <= origin.source.endLine &&
    origin.code.split('\n').slice(note.source.line - origin.source.line, note.source.endLine - origin.source.line + 1).join('\n') === note.quote;
}
function resolver(draft) {
  const sourceMap = new Map((draft.sources || []).map(unit => [unit.id, unit])), evidence = new Map((draft.evidence || []).map(note => [note.id, note]));
  const frames = new Map(), resolved = new Map();
  const attach = unit => {
    if (!frames.has(unit.id)) { const frame = { ...unit }; origins.set(frame, sourceMap); frames.set(unit.id, frame); }
    return frames.get(unit.id);
  };
  const noteFrame = id => {
    if (resolved.has(id)) return resolved.get(id);
    const note = evidence.get(id), unit = sourceMap.get(note?.sourceId);
    let frame = unit && attach(unit);
    if (unit?.contextKind === 'excerpt' && unit.complete && covers(note, frame, note.source)) {
      const candidates = index(unit.code).filter(fn => note.source.line >= unit.source.line + fn.line && note.source.endLine <= unit.source.line + fn.endLine);
      if (candidates.length === 1) {
        const fn = candidates[0], projected = { ...unit, ...fn, id: `${unit.id}:function:${unit.source.line + fn.line}`,
          contextKind: undefined, source: { ...unit.source, line: unit.source.line + fn.line, endLine: unit.source.line + fn.endLine },
          declarationEndLine: unit.source.line + fn.endLine, projectedFrom: unit.id,
          // Syntax alone is not a dispatch/initialization proof. Reuse exact
          // supplied parser metadata; otherwise material calls remain blocked.
          relatedCalls: undefined, parameterSpans: undefined, initialization: undefined, structure: undefined };
        if (read(unit, projected.source.endLine)) {
          const known = [...sourceMap.values()].filter(other => !other.contextKind && contains(unit, other) && other.source.line === projected.source.line && other.source.endLine === projected.source.endLine && other.code === projected.code);
          if (known.length <= 1) {
            frame = { ...attach(known.length ? known[0] : projected), projectedFrom: unit.id }; origins.set(frame, sourceMap);
          }
        }
      }
    }
    resolved.set(id, frame); return frame;
  };
  const event = item => item && noteFrame(item.evidenceId);
  for (const id of evidence.keys()) noteFrame(id);
  // Proof consumers may cite a constructor/helper without making it a visible
  // execution event. Resolve those notes through the identical origin bridge.
  Object.defineProperty(evidence, 'frameFor', { value: noteFrame });
  return { event, units: new Map([...sourceMap].map(([id, unit]) => [id, attach(unit)]).concat([...frames])), evidence };
}
function eventSource(draft, event) { return resolver(draft).event(event); }
function units(draft) { const r = resolver(draft); return [...new Map((draft.causal?.events || []).map(event => { const unit = r.event(event); return [unit?.id, unit]; })).values()].filter(Boolean); }
function projections(draft) { const r = resolver(draft); return Object.fromEntries((draft.causal?.events || []).map(event => [event.id, r.event(event)]).filter(([, unit]) => unit?.projectedFrom)); }
module.exports = { eventSource, units, projections, resolver, covers, indexStats: () => ({ builds: indexBuilds, retained: indexes.size }) };
