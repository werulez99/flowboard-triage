'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const projection = require('../extension/event-source');
function fixture(code, line) {
  const unit = { id: 'file', name: 'Code details', contextKind: 'excerpt', complete: true, code,
    source: { file: 'src/Example.sol', sourceHash: 'a'.repeat(64), line: 1, endLine: code.split('\n').length }, readThrough: code.split('\n').length };
  const note = { id: 'note', sourceId: unit.id, source: { ...unit.source, line, endLine: line }, quote: code.split('\n')[line - 1] };
  return { sources: [unit], evidence: [note], causal: { events: [{ id: 'event', evidenceId: 'note' }] } };
}
test('callable index scans each content identity once, retains exact body, and rejects unread or ambiguous origins', () => {
  const code = 'contract Large {\n' + Array.from({ length: 120 }, (_, i) => ` function f${i}(bool accepted) external {\n  require(accepted);\n }`).join('\n') + '\n}';
  const draft = fixture(code, 360), before = projection.indexStats().builds;
  for (let i = 0; i < 120; i++) {
    const frame = projection.eventSource(draft, draft.causal.events[0]); assert.equal(frame.name, 'f119'); assert.equal(frame.source.line, 359);
    assert.ok(projection.covers(draft.evidence[0], frame, draft.evidence[0].source));
  }
  assert.equal(projection.indexStats().builds - before, 1, 'One lexical declaration index, not 120 whole-file name reparses per resolution.');
  for (const alter of [d => { d.evidence[0].source.file = 'wrong.sol'; }, d => { d.evidence[0].source.sourceHash = 'stale'; },
    d => { d.evidence[0].quote = 'different bytes'; }, d => { d.sources[0].readThrough = 359; },
    d => { d.evidence[0].source.line = 356; d.evidence[0].quote = d.sources[0].code.split('\n').slice(355, 360).join('\n'); }]) {
    const invalid = structuredClone(draft); alter(invalid);
    assert.equal(projection.eventSource(invalid, invalid.causal.events[0]).contextKind, 'excerpt');
  }
  const changed = structuredClone(draft); changed.sources[0].code += '\n// new content';
  projection.eventSource(changed, changed.causal.events[0]); assert.equal(projection.indexStats().builds - before, 2);
  for (const text of ['interface I {\n function finish(bool accepted) external;\n}', 'contract C {\n function f() external {} function g() external {}\n}']) {
    const ambiguous = fixture(text, 2); assert.equal(projection.eventSource(ambiguous, ambiguous.causal.events[0]).contextKind, 'excerpt');
  }
});
