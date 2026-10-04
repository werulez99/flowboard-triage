'use strict';
// Mechanical reading preparation only. Report prose is never promoted into a
// source observation, support/contradiction entry, or an execution sequence.
const crypto = require('node:crypto');
const { search } = require('./source-search');
const review = require('./webview/review-model');
const { relatedCode, recommendation } = require('./reading-context');

function reportClaims(finding) {
  const prose = String(finding.summary || '').trim();
  const sentences = prose.split(/\n\s*\n/).filter(Boolean);
  // Never truncate an allegation into a different assertion. Long paragraphs
  // stay in the report when they cannot form a focused claim safely.
  return sentences.filter(text => text.length <= 2000).slice(0, 4).map((text, index) => ({
    id: `report-${crypto.createHash('sha256').update(index + ':' + text).digest('hex').slice(0, 12)}`,
    text, state: 'unreviewed', evidence: [], questions: [],
    conditions: '', observed: '', reason: '', consequence: ''
  }));
}
function preparedReview(finding) {
  const profile = review.create(finding.triage);
  // An existing empty profile may be an intentional researcher edit.
  if (!finding.triage) profile.claims = reportClaims(finding);
  return profile;
}
function prepareInvestigation(catalog, request, issue = null) {
  const fns = request.cards.map(card => catalog.resolveCard(card));
  const reference = (fn, line = fn.startLine) => {
    const file = catalog.relative(fn.file), doc = catalog.document(file);
    return { file, line, endLine: fn.endLine,
      sourceHash: crypto.createHash('sha256').update(doc.text).digest('hex'),
      name: `${fn.contract ? fn.contract + '::' : ''}${fn.name}` };
  };
  const contexts = request.cards.map((card, i) => {
    const fn = fns[i], ref = reference(fn, card.line);
    return { cardId: card.id, source: ref, signature: catalog.hints(fn).signature,
      citation: card.mapping?.method === 'citation' || !card.mapping,
      excerpt: catalog.document(ref.file).lines.slice(Math.max(0, card.line - 2), card.line + 2).join('\n'),
      modifiers: (fn.modifiers || []).map(modifier => ({ name: modifier.name,
        ...(modifier.file && modifier.startLine ? { source: reference(modifier) } : {}) })),
      calls: fn.kind === 'context' ? [] : catalog.callLinks(fn).slice(0, 25).map(site => ({
        expression: site.expression, source: { ...reference(fn, site.line), endLine: site.line },
        targets: site.candidates.slice(0, 8).map(target => reference(target)),
        targetCount: site.candidates.length,
        resolution: site.resolution
      })) };
  });
  const selected = new Set(fns.map(fn => catalog.key(fn)));
  // Offer alternatives even if an obsolete citation happens to land inside an
  // unrelated function. Do not open a broad map or choose a runtime target.
  const required = require('./report-targets').inspect(catalog, request.finding.title, issue?.reportText || request.finding.summary);
  const ranked = required.selected.length ? { candidates: [] } : search(catalog).rank({ title: request.finding.title,
    fields: { summary: request.finding.summary }, body: issue?.reportText || '' });
  const readingRecommendation = recommendation(catalog, request, ranked.candidates);
  const anchors = required.selected.length ? [...required.selected] : fns.filter(fn => fn.kind !== 'context');
  // A shifted report citation can leave the recommended entry outside the
  // saved map. Prepare its guards and helpers too, without rewriting that map.
  if (readingRecommendation?.source) {
    const entry = catalog.resolveCard(readingRecommendation.source);
    if (!anchors.some(fn => catalog.key(fn) === catalog.key(entry))) anchors.push(entry);
  }
  const related = relatedCode(catalog, anchors);
  const candidates = ranked.candidates.filter(candidate => !selected.has(catalog.key(candidate.fn))).map(candidate => ({
    source: reference(candidate.fn), reason: candidate.reason
  }));
  for (const item of related.items) if (!selected.has(catalog.key(item.fn)) && !candidates.some(candidate => candidate.source.file === item.source.file && candidate.source.line === item.source.line)) candidates.push({ source: item.source, reason: item.reason, relationship: item.relationship });
  const missing = [];
  if (!request.finding.reportRevision) missing.push('The report does not name a code version. Check that its quoted lines still match.');
  if (!request.finding.expectedBehavior) missing.push('Expected behavior is not yet known. Check the specification or tests.');
  missing.push(...related.gaps);
  return { version: 1, claims: preparedReview(request.finding).claims, contexts, candidates, missing,
    readingRecommendation,
    sourceMode: 'lexical', semanticReview: false,
    nextQuestion: !request.finding.reportRevision ? 'Does the report describe this version of the code?' : 'What specification or test sets the expected behavior?',
    notice: 'Report matches help find code. They do not decide whether this is a bug. Check the statements and called implementations.' };
}
module.exports = { reportClaims, preparedReview, prepareInvestigation };
