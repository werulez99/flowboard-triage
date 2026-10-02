// Line mapping mirrors pinned Solidity Flowboard 1.2.0's MIT stripComments
// semantics (Zurab Anchabadze; see THIRD_PARTY_NOTICES). Never infer coordinates
// by searching repeated source statements in the rendered DOM.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowboardInline = api;
})(globalThis, function() {
  'use strict';
  function lineMap(code, startLine, rendered) {
    if (typeof code !== 'string' || !Number.isSafeInteger(startLine) || startLine < 1) return null;
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
    return clean.join('\n') === rendered ? numbers : null;
  }
  const categories = { behavior: 'Behavior', claim: 'Reported concern', impact: 'Consequence', guard: 'Counterevidence / guard', question: 'Open question' };
  function category(item) { return item.category || (item.stance === 'supports' ? 'claim' : item.stance === 'contradicts' ? 'guard' : 'behavior'); }
  function forSource(evidence, hint) {
    return (evidence || []).filter(item => item.source && !item.needsReview && item.source.sourceHash &&
      item.source.sourceHash === hint.sourceHash && item.source.file === hint.file && item.source.line >= hint.line && item.source.line <= hint.endLine);
  }
  function placement(item, hints) {
    if (item.needsReview) return 'Historical evidence — re-review before placing on current code.';
    if (!item.source) return 'Reference-only evidence — no source line to display.';
    if (!item.source.sourceHash) return 'Unbound source — inspect and bind before displaying inline.';
    const sameFile = hints.filter(hint => hint.file === item.source.file);
    if (!sameFile.length) return 'Source file is not on the visible map.';
    if (!sameFile.some(hint => hint.sourceHash === item.source.sourceHash)) return 'Source hash differs from the visible map — re-review required.';
    if (!sameFile.some(hint => forSource([item], hint).length)) return 'Source line is outside the functions currently on the map.';
    return null;
  }
  // A reading outline of supplied fields, not inferred execution or exploit steps.
  function story(finding) {
    const blocks = [];
    if (finding.summary) blocks.push({ label: 'Reported claim', text: finding.summary });
    for (const text of (finding.preconditions || []).slice(0, 6)) blocks.push({ label: 'Stated condition', text });
    if (finding.expectedBehavior) blocks.push({ label: 'Intended rule · review notes', text: finding.expectedBehavior });
    if (finding.actualBehavior) blocks.push({ label: 'Source behavior · review notes', text: finding.actualBehavior });
    if (finding.impact) blocks.push({ label: 'Stated consequence · requires review', text: finding.impact });
    for (const text of (finding.openQuestions || []).slice(0, 6)) blocks.push({ label: 'Unresolved', text });
    return blocks;
  }
  return { lineMap, categories, category, forSource, placement, story };
});
