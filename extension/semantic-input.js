'use strict';
// Report text and saved researcher premises are data, never instructions or
// independent proof. One object feeds identity, retrieval and every AI stage.
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const strings = { type: 'array', items: { type: 'string' }, maxItems: 40 };
const reviewSchema = { type: 'array', maxItems: 44, items: object({ id: { type: 'string' },
  status: { enum: ['applied', 'not-applicable', 'unresolved'] }, reason: { type: 'string' }, evidence: strings, claimIds: strings, eventIds: strings }) };
function input(request, issue) {
  const finding = request.finding, reportText = issue?.reportText || '', premises = [];
  const saved = { summary: finding.summary || '', expectedBehavior: finding.expectedBehavior || '',
    preconditions: finding.preconditions || [] };
  for (const [field, values] of Object.entries(saved)) for (const text of Array.isArray(values) ? values : [values]) {
    if (!text) continue;
    const origin = reportText.includes(text) ? 'report' : 'researcher';
    if (field === 'preconditions' || origin === 'researcher' && reportText) premises.push({
      id: 'input-' + hash([field, text]).slice(0, 20), field, text, origin, independentlySupported: false });
  }
  return { version: 1, title: finding.title, reportText, saved, premises: [...new Map(premises.map(item => [item.id, item])).values()] };
}
function booleanCondition(text) {
  const match = String(text).match(/^\s*(?:Researcher (?:precondition|condition):\s*)?([A-Za-z_$][\w$]*)\s*(?:must be|is|==|=)\s*(true|false)\.?\s*$/i);
  return match ? { name: match[1], value: match[2].toLowerCase() } : null;
}
function validate(value) {
  if (!value || value.version !== 1 || typeof value.title !== 'string' || typeof value.reportText !== 'string' ||
    typeof value.saved?.summary !== 'string' || typeof value.saved?.expectedBehavior !== 'string' ||
    !Array.isArray(value.saved.preconditions) || value.saved.preconditions.some(item => typeof item !== 'string') ||
    !Array.isArray(value.premises) || value.premises.length > 44 || value.premises.some(item => !item ||
      typeof item.id !== 'string' || typeof item.text !== 'string' || !['summary', 'expectedBehavior', 'preconditions'].includes(item.field) ||
      !['report', 'researcher'].includes(item.origin) || item.independentlySupported !== false)) throw new Error('Invalid saved report and researcher inputs. The original record was preserved.');
  const reconstructed = input({ finding: { title: value.title, ...value.saved } }, { reportText: value.reportText });
  if (hash(value) !== hash(reconstructed)) throw new Error('Saved researcher input identities do not match their original text.');
}
function packet(value) {
  validate(value);
  // Original report paragraphs already appear once in finding.reportParagraphs.
  // Preserve their full-text identity here, not a second complete report copy.
  const { reportText, ...saved } = value;
  return { ...saved, originalReport: { sha256: hash(reportText), content: 'finding.reportParagraphs' } };
}
function problems(draft, final = true, resolved) {
  const premises = draft.semanticInput?.premises || [], reviews = draft.inputReviews || [], errors = [];
  if (draft.semanticInput) try { validate(draft.semanticInput); } catch (error) { return [error.message]; }
  const evidence = new Set((draft.evidence || []).map(item => item.id)), claims = new Map((draft.claims || []).map(item => [item.id, item]));
  const events = new Map((draft.causal?.events || []).map(item => [item.id, item]));
  if (!Array.isArray(reviews) || reviews.length > 44) return ['Saved-input checks have an invalid shape.'];
  if (new Set(reviews.map(review => review?.id)).size !== reviews.length || reviews.some(review => !premises.some(premise => premise.id === review?.id))) errors.push('Saved-input checks have unknown or repeated identities.');
  for (const premise of premises) {
    const review = reviews.find(item => item?.id === premise.id);
    if (!review || !['applied', 'not-applicable', 'unresolved'].includes(review.status) || typeof review.reason !== 'string' || !review.reason.trim() ||
      !Array.isArray(review.claimIds) || !review.claimIds.length || review.claimIds.some(id => !claims.has(id)) ||
      !Array.isArray(review.eventIds) || review.eventIds.some(id => !events.has(id)) ||
      !Array.isArray(review.evidence) || review.evidence.some(id => !evidence.has(id))) {
      errors.push(`Explain how the saved ${premise.field} applies: ${premise.text}`); continue;
    }
    if (review.status === 'unresolved') { if (final) errors.push(`The saved ${premise.field} is still unresolved: ${premise.text}`); continue; }
    if (!review.evidence.length || !review.eventIds.length) errors.push(`The saved ${premise.field} needs checked code and an affected step, not just acknowledgement.`);
    if (review.status === 'applied') {
      const condition = booleanCondition(premise.text);
      if (condition) errors.push(...require('./call-bindings').checkBooleanPremise(draft, condition, review, resolved));
    }
  }
  return errors;
}
module.exports = { input, packet, validate, hash, reviewSchema, problems };
