// Display-only policy. Stored states, evidence targets and source coordinates
// are never changed to make a reading view look more certain.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowboardReading = api;
})(globalThis, function() {
  'use strict';
  const issueLabels = { unreviewed: 'Not checked', 'insufficient-evidence': 'Needs more checking', confirmed: 'Confirmed bug', invalid: 'Not a bug', 'design-decision': 'By design', 'already-fixed': 'Already fixed' };
  const statementLabels = { unreviewed: 'Not checked', supported: 'Supported in this case', contradicted: 'Contradicted in this case', mixed: 'Mixed evidence', unresolved: 'Needs more checking', 'needs-context': 'Needs more checking' };
  const otherLabels = { supports: 'Supports', contradicts: 'Against', context: 'Context', unknown: 'Not known', report: 'Report', specification: 'Specification', test: 'Test', assumption: 'Assumption', 'source-observation': 'Read in code', 'source-inference': 'Interpretation of code', 'report-claim': 'Report statement', 'open-question': 'Open question', 'test-reference': 'Test reference' };
  const issue = value => issueLabels[value] || value || 'Not checked';
  const statement = value => statementLabels[value] || value || 'Not checked';
  const label = value => otherLabels[value] || issueLabels[value] || statementLabels[value] || String(value || '').replaceAll('-', ' ');
  function issueId(finding, library = [], active) { return library.find(item => item.id === active)?.displayId || finding.displayId || finding.findingId || active || 'this issue'; }
  function relation(stance, target, id) { return `${stance === 'supports' ? 'Supports' : stance === 'contradicts' ? 'Against' : 'Context for'} ${target} ${id}`; }
  function relationships(entry, id, claims = []) {
    if (entry.origin === 'model-interpretation') {
      const claim = claims.find(item => item.id === entry.claimId);
      return entry.claimId ? [{ label: relation(entry.stance, 'statement', entry.claimId), text: claim?.allegation || claim?.text || '', claimId: entry.claimId, stance: entry.stance }] : [];
    }
    const result = [{ label: relation(entry.stance, 'issue', id), text: '', stance: entry.stance }];
    for (const claim of claims) for (const link of claim.evidence || []) {
      if (link.evidenceId === entry.id) result.push({ label: relation(link.stance, 'statement', claim.id), text: claim.text, reason: link.reason, claimId: claim.id, stance: link.stance });
    }
    return result;
  }
  function current(entry, hint) {
    const source = entry?.source, end = source?.endLine ?? source?.line;
    return !!(source && hint && !entry.needsReview && source.sourceHash && source.sourceHash === hint.sourceHash && source.file === hint.file && Number.isInteger(source.line) && Number.isInteger(end) && source.line >= hint.line && end >= source.line && end <= hint.endLine);
  }
  function start(cards, hints, evidence, stale = false, recommendation = null) {
    if (stale) return { kind: 'changed', message: 'Code has changed. Refresh it before checking these notes.' };
    if (recommendation?.source) {
      const card = cards.find(card => current({ source: recommendation.source }, hints[card.id]));
      if (card) {
        const entry = (evidence || []).find(item => !['report-claim', 'open-question'].includes(item.basis) && current(item, hints[card.id]) && (!recommendation.claimId || item.claimId === recommendation.claimId));
        return { kind: entry ? 'note' : 'related', cardId: card.id, entry, claimId: recommendation.claimId, message: recommendation.reason };
      }
      return { kind: recommendation.sourceId ? 'investigation' : 'context', source: recommendation.source, sourceId: recommendation.sourceId, claimId: recommendation.claimId, message: recommendation.reason };
    }
    for (const entry of evidence || []) {
      if (['report-claim', 'open-question'].includes(entry.basis)) continue;
      const card = cards.find(card => current(entry, hints[card.id]));
      if (card) return { kind: 'note', cardId: card.id, entry, message: 'Read the linked code note, then check its explanation against the code.' };
    }
    const card = cards.find(card => hints[card.id]?.file && !card.data?.notFound);
    if (card) return { kind: 'related', cardId: card.id, message: hints[card.id].mapping?.method === 'citation' ? 'Begin at the report’s code location. Check that it still matches the report.' : 'Related code is ready. Check that this function matches the report.' };
    return { kind: 'missing', message: 'No matching code was found. Read the report and check that the right repository is open.' };
  }
  return { issue, statement, label, issueId, relation, relationships, current, start };
});
