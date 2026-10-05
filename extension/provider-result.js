'use strict';
// At most one last response per finding. Private, bounded and never exposed as
// checked guidance. Durable transport results survive secondary health errors.
const p = require('./protocol');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const location = id => `.flowboard/provider-results/${p.identifier(id, 'finding ID') || id}.json`;
const MAX_BYTES = 4 * 1024 * 1024;
function save(root, findingId, value) {
  const record = { version: 1, findingId, ...value };
  const hash = digest(record);
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES - 256) throw new Error('Provider response checkpoint exceeded its private storage limit. The request receipt was retained.');
  p.atomicJson(root, location(findingId), { ...record, hash });
  return { hash, phase: value.input.phase, snapshot: digest(value.snapshot), corrections: digest(value.corrections), previous: value.previous };
}
function read(root, findingId, reference, expected) {
  if (!reference) return null;
  const record = p.readWorkspaceJson(root, location(findingId), MAX_BYTES), { hash, ...value } = record;
  if (value.version !== 1 || value.findingId !== findingId || hash !== reference.hash || hash !== digest(value)) throw new Error('The saved provider response is damaged. Its private record was preserved for recovery.');
  if (value.input?.phase !== reference.phase || digest(value.snapshot) !== reference.snapshot || digest(value.corrections) !== reference.corrections || value.previous !== reference.previous ||
    !value.result || typeof value.result !== 'object' || !value.result.audit || !value.result.value) throw new Error('The saved provider response has mismatched input references. Its original record was preserved.');
  if (!Array.isArray(value.units) || value.units.length > 40 || value.units.some(unit => !unit || typeof unit.id !== 'string' || !unit.source)) throw new Error('The saved provider response lacks its source acquisition references.');
  if (reference.phase !== expected.phase || reference.snapshot !== digest(expected.snapshot) || reference.corrections !== digest(expected.corrections) || reference.previous !== expected.previous) return null;
  return value;
}
module.exports = { save, read, digest };
