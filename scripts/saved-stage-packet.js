'use strict';
// Offline developer inspection only. No report owner, migration, reservation,
// model transport or workspace writes. The caller provides an already indexed
// current catalog and the original imported issue/researcher request.
const engine = require('../extension/investigation-engine');
const format = require('../extension/challenge-format');
const provider = require('../extension/semantic-provider');
async function inspectSavedStage({ root, catalog, request, issue, findingId, saved = engine.read(root, findingId) }) {
  if (!saved || !['challenge', 'complete'].includes(saved.checkpoint?.stage) || !saved.runs.some(run => run.resultAccepted) || saved.pendingResponse)
    throw new Error('A saved accepted generation/challenge checkpoint is required; generation is not authorized.');
  const draft = structuredClone(saved), original = JSON.stringify(saved);
  if (!engine.compatible(draft, catalog, request, issue) || !engine.sameSnapshot(draft.snapshot, engine.snapshot(catalog, request, issue)))
    throw new Error('The saved stage no longer matches the current material snapshot. Inspect the changed inputs before dispatch.');
  engine.validateCurrent(catalog, draft);
  const canonical = format.earlier(draft, provider.schema);
  const earlier = draft.bindingPlan ? require('../extension/source-bindings').wire(canonical, draft.bindingPlan) : canonical;
  let packet;
  await engine.advance({ root, catalog, request, issue, findingId, draft, provider: 'codex', persist: false,
    current: () => true, publish: async () => {}, invoke: async input => {
      if (input.phase !== 'challenge') throw new Error('Refusing offline generation: saved-stage resume was not selected.');
      packet = structuredClone(input);
      throw Object.assign(new Error('Offline saved challenge captured; no dispatch.'), { code: 'LOCAL_READING_LIMIT' });
    } });
  if (!packet || packet.phase !== 'challenge') throw new Error(draft.error || 'No saved challenge packet could be reconstructed.');
  if (JSON.stringify(packet.earlierDraft) !== JSON.stringify(earlier) || JSON.stringify(saved) !== original)
    throw new Error('Offline resume changed the earlier semantic object.');
  return { packet, metrics: provider.measureRequest(packet), earlierHash: engine.hash(earlier), preparation: draft };
}
module.exports = { inspectSavedStage };
