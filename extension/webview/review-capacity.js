(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowboardCapacity = api;
})(globalThis, function() {
'use strict';
// Analytical capacity is not UI density. Every admitted shape must have room
// for all of its challenge checks and survive persistence without truncation.
const kinds = Object.freeze(['applicability', 'entry', 'conditions', 'behavior', 'settlement', 'rule', 'impact', 'counterevidence']);
const limits = Object.freeze({ claims: 8, obligations: 8 * kinds.length, events: 18, relationships: 30,
  checks: 8 * kinds.length + 18 + 30, evidence: 24, explanationReviews: 48, transitions: 12,
  questions: 8, sources: 40, steps: 18, sourceCharacters: 1024 * 1024, storageBytes: 48 * 1024 * 1024 });
function target(kind, item) { return kind === 'relationship' ? `relationship:${item.from}->${item.to}:${item.kind}` : `${kind}:${typeof item === 'string' ? item : item.id}`; }
function targets(model) {
  return [...(model.obligations || []).map(item => ({ key: target('obligation', item), legacy: item.id })),
    ...(model.events || []).map(item => ({ key: target('event', item), legacy: item.id })),
    ...(model.relationships || []).map(item => ({ key: target('relationship', item), legacy: `${item.from}->${item.to}` }))];
}
function normalizeChecks(model) {
  const known = targets(model);
  return (model.checks || []).map(check => {
    const candidates = known.filter(item => item.key === check.target || item.legacy === check.target);
    return { ...check, target: candidates.length === 1 ? candidates[0].key : check.target };
  });
}
function assertLength(value, maximum, field) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${field} exceeds the supported review capacity (${maximum}); no items were discarded.`);
}
return { POLICY: 'checked-explanation-v5', kinds, limits, target, targets, normalizeChecks, assertLength };
});
