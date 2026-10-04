// Line mapping mirrors pinned Solidity Flowboard 1.2.0's MIT stripComments
// semantics (Zurab Anchabadze; see THIRD_PARTY_NOTICES). Never infer coordinates
// by searching repeated source statements in the rendered DOM.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowboardInline = api;
})(globalThis, function() {
  'use strict';
  function sourceLines(code, startLine) {
    const clean = [], numbers = []; let block = false;
    for (const [offset, line] of code.split('\n').entries()) {
      let out = '', comment = false, quote = '', i = 0;
      while (i < line.length) {
        const c = line[i], n = line[i + 1];
        if (block) { comment = true; if (c === '*' && n === '/') { block = false; i += 2; } else i++; continue; }
        if (quote) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === quote) quote = ''; i++; continue; }
        if (c === '/' && n === '/') { comment = true; break; }
        if (c === '/' && n === '*') { block = true; comment = true; i += 2; continue; }
        if (c === '"' || c === "'") quote = c;
        out += c; i++;
      }
      out = out.replace(/\s+$/, '');
      if (!out.trim() && comment && line.trim()) continue;
      clean.push(out); numbers.push(startLine + offset);
    }
    return { code: clean.join('\n'), numbers };
  }
  function cleanCode(code) {
    if (typeof code !== 'string') throw new Error('Source code must be text.');
    return sourceLines(code, 1).code;
  }
  function lineMap(code, startLine, rendered) {
    if (typeof code !== 'string' || !Number.isSafeInteger(startLine) || startLine < 1) return null;
    const result = sourceLines(code, startLine);
    return result.code === rendered ? result.numbers : null;
  }
  const categories = { behavior: 'What this code does', claim: 'Why it matters to the report', impact: 'Impact', guard: 'Why the report may be incorrect', question: 'Still unclear' };
  function category(item) { return item.category || (item.stance === 'supports' ? 'claim' : item.stance === 'contradicts' ? 'guard' : 'behavior'); }
  function forSource(evidence, hint) {
    return (evidence || []).filter(item => item.source && !item.needsReview && item.source.sourceHash &&
      item.source.sourceHash === hint.sourceHash && item.source.file === hint.file && item.source.line >= hint.line && (item.source.endLine || item.source.line) <= hint.endLine);
  }
  function placement(item, hints) {
    if (item.needsReview) return 'Code has changed. Check this note again.';
    if (!item.source) return 'This note links to a reference, not a code line.';
    if (!item.source.sourceHash) return 'This code location has not been checked yet.';
    const sameFile = hints.filter(hint => hint.file === item.source.file);
    if (!sameFile.length) return 'This file is not on the board.';
    if (!sameFile.some(hint => hint.sourceHash === item.source.sourceHash)) return 'Code has changed. Check this note again.';
    if (!sameFile.some(hint => forSource([item], hint).length)) return 'These lines are outside the functions on the board.';
    return null;
  }
  // A reading outline of supplied fields, not inferred execution or exploit steps.
  function story(finding) {
    const blocks = [];
    if (finding.summary) blocks.push({ label: 'Reported claim', text: finding.summary });
    for (const text of (finding.preconditions || []).slice(0, 6)) blocks.push({ label: 'Stated condition', text });
    if (finding.expectedBehavior) blocks.push({ label: 'Expected behavior', text: finding.expectedBehavior });
    if (finding.actualBehavior) blocks.push({ label: 'What the code does', text: finding.actualBehavior });
    if (finding.impact) blocks.push({ label: 'Reported impact', text: finding.impact });
    for (const text of (finding.openQuestions || []).slice(0, 6)) blocks.push({ label: 'Still unclear', text });
    return blocks;
  }
  return { lineMap, cleanCode, categories, category, forSource, placement, story };
});
