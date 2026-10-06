'use strict';
// Pure local diagnosis. No coordinator, transport, migration or persistence.
// An assembled invalid response remains diagnostic data, never an accepted draft.
const engine = require('../extension/investigation-engine'), format = require('../extension/challenge-format');
const provider = require('../extension/semantic-provider'), scope = require('../extension/review-scope'), policy = require('../extension/guide-policy');
function replayReview({ saved, input, response, units }) {
  const originals = JSON.stringify({ saved, input, response, units });
  const binding = require('../extension/source-bindings');
  const schema = input.bindingFormat === binding.VERSION ? binding.schema(provider.schema) : provider.schema;
  const canonical = format.earlier(saved, provider.schema), earlier = saved.bindingPlan ? binding.wire(canonical, saved.bindingPlan) : canonical;
  if (input.phase !== 'challenge' || !format.valid(input.earlierDraft, schema)) throw new Error('Exact saved challenge input and full earlier object are required.');
  if (JSON.stringify(earlier) !== JSON.stringify(input.earlierDraft))
    throw new Error('Saved accepted checkpoint is not the exact earlierDraft used by this response.');
  const previous = structuredClone(saved), inspectedUnits = structuredClone(units), errors = [], result = { diagnosticOnly: true, providerRequests: 0, writes: 0,
    baseHash: engine.hash(input.earlierDraft), responseHash: engine.hash(response), fullSchema: false, accepted: false };
  let assembled, candidate;
  try {
    for (const supplied of input.sources) {
      const unit = inspectedUnits.find(unit => unit.id === supplied.id);
      if (!unit || unit.source.file !== supplied.file || supplied.line < unit.source.line || supplied.endLine > unit.source.endLine ||
          supplied.code !== unit.code.split('\n').slice(supplied.line - unit.source.line, supplied.endLine - unit.source.line + 1).map((line, index) => `${supplied.line + index} | ${line}`).join('\n'))
        throw new Error(`Saved request source ${supplied.id} does not match its canonical exact range.`);
      // Reflect only source actually present in this saved paid request.
      if (supplied.line <= (unit.readThrough || unit.source.line - 1) + 1) unit.readThrough = Math.max(unit.readThrough || 0, supplied.endLine);
    }
    assembled = response.mode === format.PATCH ? format.assemblePatch(response, input.earlierDraft, schema) :
      input.checkOnly ? format.checked(response, input.earlierDraft, schema) : response.mode ? format.expand(response, input.earlierDraft, schema) : structuredClone(response);
    result.fullSchema = format.valid(assembled, schema);
    if (!result.fullSchema) throw new Error('The assembled review does not satisfy the full generation schema.');
    errors.push(...scope.problems(previous, assembled));
    candidate = engine.accept(assembled, previous, inspectedUnits);
    try { engine.checkExplanations(assembled, previous, candidate, inspectedUnits); }
    catch (error) { errors.push(...(error.validationProblems || [{ code: 'REVIEW_VALIDATION', message: error.message }])); }
    // Publication gate is diagnostic only even if it reports ready: no phase,
    // seal, journal or accepted object is returned by this route.
    result.gate = policy.gate({ ...previous, ...candidate, sources: inspectedUnits });
    result.gateBoundary = errors.length ? 'Rejected review: fresh attestations were not installed. Unchecked-reference gate failures may be downstream consequences, not independent model errors.' : 'Full assembled review with current host checks; still diagnostic only.';
    result.claims = candidate.claims.map(({ id, status, unknowns, nextQuestion }) => ({ id, status, unknowns, nextQuestion }));
  } catch (error) { errors.push(...(error.validationProblems || [{ code: 'REVIEW_ASSEMBLY_OR_SOURCE', message: error.message }])); }
  result.errors = [...new Map(errors.map(item => [[item.code, item.evidenceId, item.message].join(':'), item])).values()];
  result.scopeManifest = scope.manifest(previous);
  if (JSON.stringify({ saved, input, response, units }) !== originals) throw new Error('Replay mutated its private inputs.');
  result.inputsUnchanged = true;
  return result;
}
module.exports = { replayReview };
