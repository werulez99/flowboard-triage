'use strict';
// At most one last response per finding. Private, bounded and never exposed as
// checked guidance. Durable transport results survive secondary health errors.
const p = require('./protocol');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const location = id => `.flowboard/provider-results/${p.identifier(id, 'finding ID') || id}.json`;
const MAX_BYTES = 4 * 1024 * 1024;
const capacity = require('./review-capacity');
function save(root, findingId, value, { retain = false } = {}) {
  capacity.assertLength(value.units, capacity.limits.sources, 'Checkpoint source acquisition references');
  const record = { version: 1, findingId, ...value };
  const hash = digest(record);
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES - 256) throw new Error('Provider response checkpoint exceeded its private storage limit. Terminal request accounting is separate from response retention.');
  p.atomicJson(root, location(findingId), { ...record, hash });
  // A superseded response is audit history, not the next draft's pending
  // answer. Keep it beyond the next ordinary last-response checkpoint.
  const archive = retain ? `.flowboard/recovery/provider-result-${p.identifier(findingId, 'finding ID') || findingId}-${hash}.json` : null;
  const reference = { hash, phase: value.input.phase, snapshot: digest(value.snapshot), corrections: digest(value.corrections), previous: value.previous };
  if (archive) try { p.atomicJson(root, archive, { ...record, hash }); }
  catch (error) { error.retainedResponse = reference; error.storageBoundary = 'immutable-archive'; throw error; }
  return { ...reference, ...(archive ? { archive } : {}) };
}
function read(root, findingId, reference, expected) {
  if (!reference) return null;
  const archive = `.flowboard/recovery/provider-result-${p.identifier(findingId, 'finding ID') || findingId}-${reference.hash}.json`;
  if (reference.archive && reference.archive !== archive) throw new Error('Invalid retained response archive identity.');
  const record = p.readWorkspaceJson(root, reference.archive || location(findingId), MAX_BYTES), { hash, ...value } = record;
  if (value.version !== 1 || value.findingId !== findingId || hash !== reference.hash || hash !== digest(value)) throw new Error('The saved provider response is damaged. Its private record was preserved for recovery.');
  if (value.input?.phase !== reference.phase || digest(value.snapshot) !== reference.snapshot || digest(value.corrections) !== reference.corrections || value.previous !== reference.previous ||
    !value.result || typeof value.result !== 'object' || !value.result.audit || !value.result.value) throw new Error('The saved provider response has mismatched input references. Its original record was preserved.');
  if (!Array.isArray(value.units) || value.units.length > capacity.limits.sources || value.units.some(unit => !unit || typeof unit.id !== 'string' || !unit.source)) throw new Error('The saved provider response lacks its source acquisition references.');
  if (reference.phase !== expected.phase || reference.snapshot !== digest(expected.snapshot) || reference.corrections !== digest(expected.corrections) || reference.previous !== expected.previous) return null;
  return value;
}
function retain(root,findingId,reference,expected) {
  const value=read(root,findingId,reference,expected);
  if(!value)throw new Error('The received proposal no longer matches its original context.');
  const archive=`.flowboard/recovery/provider-result-${p.identifier(findingId,'finding ID')||findingId}-${reference.hash}.json`;
  let existing;try{existing=p.readWorkspaceJson(root,archive,MAX_BYTES);}catch(error){if(error.code!=='ENOENT')throw error;}
  const record={...value,hash:reference.hash};
  if(existing&&digest(existing)!==digest(record))throw new Error('Immutable response archive differs; no overwrite is permitted.');
  if(!existing)p.atomicJson(root,archive,record);
  return {...reference,archive};
}
// Archival only: retain the hash-checked original context, not approval for a
// changed context. Useful before recording new material execution evidence.
function retainOriginal(root,findingId,reference){
  const record=p.readWorkspaceJson(root,reference.archive||location(findingId),MAX_BYTES);
  return retain(root,findingId,reference,{phase:record.input?.phase,snapshot:record.snapshot,corrections:record.corrections,previous:record.previous});
}
function recover(root,findingId,reservation,expected) {
  if(!reservation?.id)throw new Error('Owned original reservation is required for receipt recovery.');
  const record=p.readWorkspaceJson(root,location(findingId),MAX_BYTES);
  const reference={hash:record.hash,phase:record.input?.phase,snapshot:digest(record.snapshot),corrections:digest(record.corrections),previous:record.previous};
  const value=read(root,findingId,reference,expected);
  if(!value||value.result.audit.requestId!==reservation.id||value.input.phase!==reservation.phase||
     value.input.reviewPurpose!==reservation.reviewPurpose||value.result.audit.teardown?.confirmed===false||
     value.reservation&&digest(value.reservation)!==digest(reservation))throw new Error('Retained response does not match the owned reservation/context or confirmed cleanup.');
  return {reference,value};
}
module.exports = { save, read, retain, retainOriginal, recover, digest };
