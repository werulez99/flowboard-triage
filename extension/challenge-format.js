'use strict';
// Reduce repeated model output, not review obligations. An unchanged field is
// retained verbatim; every note and causal target still needs a fresh check.
const MODE = 'review-delta-v1';
const scope = require('./review-scope');
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
// A first challenge checks the argument without asking for a second copy of
// the entire causal model. A disagreement takes the existing bounded repair
// path. This is a smaller response contract, not a weaker publication gate.
function checkSchema(full) {
  return object({ result: { enum: ['kept', 'repair'] }, problems: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    ...(full.properties.inputReviews ? { inputReviews: full.properties.inputReviews } : {}),
    explanationReviews: full.properties.explanationReviews,
    checks: full.properties.causal.properties.checks });
}
function checked(value, previous, full) {
  if (full.properties.inputReviews && !previous.inputReviews?.length && value?.inputReviews === undefined) value = { ...value, inputReviews: [] };
  if (!valid(value, checkSchema(full))) throw new Error('The explanation check returned incomplete checks.');
  if (value.result !== 'kept' || value.problems.length) throw Object.assign(new Error(value.problems.join('\n') || 'The reasoning check requested a specific repair.'), { reviewProblems: value.problems });
  const result = structuredClone(previous);
  result.explanationReviews = value.explanationReviews;
  if (full.properties.inputReviews) result.inputReviews = value.inputReviews;
  result.causal.checks = value.checks;
  return result;
}
const checkInstruction = `This request is a CHECK, not a rewrite. The response schema below supersedes the output-shape instructions above. Read the whole supplied argument and relevant code, including new dependencies. Return result=kept ONLY when earlierDraft can be retained EXACTLY. Explain every evidence entry with result=kept and every causal target (events, obligations, relationships) with fresh evidence-grounded checks. One concrete sentence per check. If a note, condition, unresolved question, argument or outcome needs changing, return result=repair with precise problems and affected IDs; do not silently approve it. An honest incomplete argument may be kept with its blockers intact, but cannot become a published guide. Do not generate a replacement tutorial, repeat quotes or invent new evidence in this checking response. Location matching and model agreement alone do not establish truth.`;
const PATCH = 'review-patch-v1';
function patchSchema(full) {
  return object({ mode: { enum: [PATCH] }, updates: { type: 'array', maxItems: 80,
    items: object({ path: { type: 'string' }, valueJSON: { type: 'string' } }) },
    ...(full.properties.inputReviews ? { inputReviews: full.properties.inputReviews } : {}),
    explanationReviews: full.properties.explanationReviews, checks: full.properties.causal.properties.checks });
}
function apply(value, previous, full) {
  const result = assemblePatch(value, previous, full);
  scope.assert(previous, result);
  return result;
}
// Diagnostic assembly alone is NOT a validated review. Ordinary ingestion
// always uses apply(), including the immutable-scope check after assembly.
function assemblePatch(value, previous, full) {
  if (full.properties.inputReviews && !previous.inputReviews?.length && value?.inputReviews === undefined) value = { ...value, inputReviews: [] };
  if (!valid(value, patchSchema(full))) throw new Error('The targeted repair has an invalid shape.');
  const result = structuredClone(previous), touched = new Set();
  for (const update of value.updates) {
    const keys = update.path.split('/').slice(1);
    if (!update.path.startsWith('/') || !keys.length || keys.length > 5 || keys.some(key => !key || ['__proto__','constructor','prototype'].includes(key)) || touched.has(update.path) || update.valueJSON.length > 64000) throw new Error('The targeted repair has an unsafe or repeated field.');
    if (['explanationReviews', 'inputReviews'].includes(keys[0]) || keys.join('/') === 'causal/checks') throw new Error('Fresh checks cannot be patched or inherited.');
    touched.add(update.path);
    let target = result, shape = full;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i], last = i === keys.length - 1;
      if (shape.type === 'array') {
        if (shape.items.type !== 'object' || !shape.items.properties.id) throw new Error('Replace this array as a whole; its items have no stable IDs.');
        const index = target.findIndex(item => item.id === key);
        if (last) {
          const replacement = JSON.parse(update.valueJSON);
          if (replacement === null) { if (index < 0) throw new Error('The removed item does not exist.'); target.splice(index, 1); }
          else { if (replacement.id !== key || !valid(replacement, shape.items)) throw new Error('The repaired item has an invalid identity or field.');
            if (index < 0) target.push(replacement); else target[index] = replacement; }
        } else { if (index < 0) throw new Error('The repaired item does not exist.'); target = target[index]; shape = shape.items; }
      } else if (shape.type === 'object' && Object.hasOwn(shape.properties, key)) {
        if (last) { const replacement = JSON.parse(update.valueJSON), field = shape.properties[key];
          if (!valid(replacement, field)) throw new Error(`The repaired value does not match its field at ${update.path}.${field.enum ? ' Allowed values: ' + field.enum.join(', ') + '.' : ''}`);
          target[key] = replacement; }
        else { target = target[key]; shape = shape.properties[key]; }
      } else throw new Error('The targeted repair points outside the review schema.');
    }
  }
  result.explanationReviews = value.explanationReviews; result.causal.checks = value.checks;
  if (full.properties.inputReviews) result.inputReviews = value.inputReviews;
  if (!valid(result, full)) throw new Error('The targeted repair left an incomplete review.');
  return result;
}
const patchInstruction = `Return review-patch-v1. This response shape supersedes the earlier full-review/delta instructions. Repair only affected fields of earlierDraft. updates use slash paths: /claims/c1/reason, /evidence/e1/explanation, /causal/obligations/obligation-id/state, /causal/summary, /conclusion/limitations, /walkthrough/assessment/why. Array objects with an id are addressed by that stable ID, never an index. To add/replace an entire item use /evidence/new-id with its complete schema object. To remove it use valueJSON="null"; do not drop a material claim. Arrays without id fields (relationships, strings) are replaced as a whole. valueJSON is the JSON-encoded new field value (a string needs JSON quotes). Unchanged fields are retained exactly. Do not repeat their contents. Check all affected dependencies against source; if a premise remains unavailable keep its blocker. Include fresh explanationReviews for every old/new/removed note and checks for every retained causal event, obligation and relationship. Each check explains the concrete evidence, not merely location validity. Never patch checks to inherit older approval. The host validates the assembled full schema, exact source spans, claim coverage and publication obligations after applying these edits.`;
function schemaFor(full) {
  return object({ mode: { enum: [MODE] },
    changes: object(Object.fromEntries(Object.entries(full.properties).filter(([key]) => !['causal', 'explanationReviews'].includes(key)).map(([key, schema]) => [key, nullable(schema)]))),
    causal: object(Object.fromEntries(Object.entries(full.properties.causal.properties).map(([key, schema]) => [key, key === 'checks' ? schema : nullable(schema)]))),
    explanationReviews: full.properties.explanationReviews });
}
function pick(value, schema) {
  if (!value || typeof value !== 'object') return value;
  if (schema.type === 'array') return value.map(item => pick(item, schema.items));
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties).filter(([key]) => Object.hasOwn(value, key)).map(([key, child]) => [key, pick(value[key], child)]));
  return value;
}
function earlier(draft, schema) {
  const value = pick(draft, schema);
  if (schema.properties.inputReviews) value.inputReviews ||= [];
  value.evidence = draft.evidence.map(item => pick({ ...item, line: item.source.line, endLine: item.source.endLine, explanation: item.note }, schema.properties.evidence.items));
  const status = draft.conclusion.scopedStatus || draft.conclusion.status;
  value.conclusion.status = schema.properties.conclusion.properties.status.enum.includes(status) ? status : 'insufficient-evidence';
  value.explanationReviews = [];
  return value;
}
function valid(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(option => valid(value, option));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string' && (typeof value !== 'string' || schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (schema.type === 'integer' && !Number.isSafeInteger(value)) return false;
  if (schema.type === 'array') return Array.isArray(value) && (!schema.maxItems || value.length <= schema.maxItems) && value.every(item => valid(item, schema.items));
  if (schema.type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value) &&
    schema.required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => Object.hasOwn(schema.properties, key)) &&
    Object.entries(schema.properties).every(([key, child]) => !Object.hasOwn(value, key) || valid(value[key], child));
  return true;
}
function expand(value, previous, fullSchema) {
  if (fullSchema.properties.inputReviews && !previous?.inputReviews?.length && value?.changes && value.changes.inputReviews === undefined) value = { ...value, changes: { ...value.changes, inputReviews: null } };
  if (!valid(value, schemaFor(fullSchema)) || !previous || !Array.isArray(previous.evidence)) throw new Error('The second pass returned an incomplete review update. The earlier draft was preserved.');
  if (previous.inputReviews?.length && value.changes.inputReviews === null) throw new Error('The challenge must freshly review saved researcher premises.');
  const result = structuredClone(previous);
  for (const [key, change] of Object.entries(value.changes)) if (change !== null) result[key] = structuredClone(change);
  result.causal ||= {};
  for (const [key, change] of Object.entries(value.causal)) if (change !== null) result.causal[key] = structuredClone(change);
  // Checks can never be inherited from a previous pass or lost through null.
  result.explanationReviews = structuredClone(value.explanationReviews);
  if (!valid(result, fullSchema)) throw new Error('The second pass left an incomplete explanation. Required fields still need checking.');
  scope.assert(previous, result);
  return result;
}
const instruction = `During challenge return review-delta-v1 using the supplied schema. earlierDraft is the exact earlier result in the same field format. In changes and causal, null means preserve that field EXACTLY, not remove it or consider it automatically checked. Replace an array as a whole when it changes; [] deliberately clears it. Supply fresh causal.checks for EVERY event, obligation and relationship, plus explanationReviews for EVERY retained/removed/new evidence ID. Never return null for these checks. Review the actual new code before keeping an earlier statement. Changes to a premise require all dependent claims, events, evidence, questions and assessment to be reconsidered. Preserve real blockers. Do not repeat unchanged quotes, conditions and event data merely to acknowledge reading them. Keep each review reason to one concrete sentence with its evidence links. This response format saves copying, not any required reasoning or source check.`;
module.exports = { MODE, schemaFor, earlier, expand, instruction: instruction + '\n' + scope.instruction,
  checkSchema, checked, checkInstruction: checkInstruction + '\n' + scope.instruction, PATCH, patchSchema, apply, assemblePatch,
  patchInstruction: patchInstruction + '\n' + scope.instruction, valid };
