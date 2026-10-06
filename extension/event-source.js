'use strict';
// A reviewed whole-file quotation may select one complete function. This is
// an exact display projection, never a new note, call, execution proof or check.
const { lexicalCode, functionParts, matching } = require('./solidity-text');
function eventSource(draft, event) {
  const note = draft.evidence.find(item => item.id === event.evidenceId), unit = draft.sources.find(item => item.id === note?.sourceId);
  if (!unit || unit.contextKind !== 'excerpt' || !unit.complete) return unit;
  const clean = lexicalCode(unit.code), candidates = [];
  for (const match of clean.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const parts = functionParts(unit.code, match[1]);
    if (!parts || parts.start !== match.index || clean[parts.bodyStart - 1] !== '{') continue;
    const end = matching(clean, parts.bodyStart - 1, '{', '}');
    const line = unit.source.line + unit.code.slice(0, parts.start).split('\n').length - 1;
    const endLine = unit.source.line + unit.code.slice(0, end).split('\n').length - 1;
    if (note.source.line < line || note.source.endLine > endLine) continue;
    // Same-line adjacent definitions cannot be separated by a line-only note.
    const lineStart = clean.lastIndexOf('\n', parts.start - 1) + 1;
    if (clean.slice(lineStart, parts.start).trim()) continue;
    const after = clean.indexOf('\n', end + 1);
    if (clean.slice(end + 1, after < 0 ? clean.length : after).trim()) continue;
    candidates.push({ ...unit, id: `${unit.id}:function:${line}`, name: match[1], signature: '', contract: null,
      contextKind: undefined, source: { ...unit.source, line, endLine }, declarationEndLine: endLine,
      code: unit.code.split('\n').slice(line - unit.source.line, endLine - unit.source.line + 1).join('\n'),
      relatedCalls: [], parameterSpans: [], initialization: null, structure: null, projectedFrom: unit.id });
  }
  if (candidates.length !== 1) return unit;
  const projected = candidates[0];
  // Reuse an already supplied exact function identity, so another quotation
  // of this same function does not create a different invocation frame.
  const known = draft.sources.find(item => !item.contextKind && item.complete && item.source.file === projected.source.file &&
    item.source.sourceHash === projected.source.sourceHash && item.source.line === projected.source.line &&
    item.source.endLine === projected.source.endLine && item.code === projected.code);
  return known ? { ...known, projectedFrom: unit.id } : projected;
}
function units(draft) { return [...new Map((draft.causal?.events || []).map(event => { const unit = eventSource(draft, event); return [unit?.id, unit]; })).values()].filter(Boolean); }
function projections(draft) { return Object.fromEntries((draft.causal?.events || []).map(event => [event.id, eventSource(draft, event)]).filter(([, unit]) => unit?.projectedFrom)); }
module.exports = { eventSource, units, projections };
