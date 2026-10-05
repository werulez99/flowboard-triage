'use strict';
// Offline only. Capture the exact first production review packet without
// invoking a provider, reserving an allowance, or writing the target workspace.
const fs = require('node:fs'), path = require('node:path');
const engine = require('../extension/investigation-engine'), provider = require('../extension/semantic-provider');
async function main() {
  const [root, id, output, mode, priorInput, priorResponse] = process.argv.slice(2), native = process.env.FLOWBOARD_EXTENSION_PATH;
  if (mode && !['--saved-challenge', '--replay-challenge'].includes(mode)) throw new Error('Choose --saved-challenge or --replay-challenge INPUT RESPONSE.');
  if (!root || !id || !output || !native || !path.isAbsolute(root) || !path.isAbsolute(output))
    throw new Error('Usage: FLOWBOARD_EXTENSION_PATH=... node scripts/inspect-review-packet.js ABSOLUTE_IMPORTED_WORKSPACE FINDING ABSOLUTE_PRIVATE_OUTPUT');
  const repository = path.resolve(__dirname, '..'), destination = path.resolve(output);
  if (destination === repository || destination.startsWith(repository + path.sep) || destination === path.resolve(root) || destination.startsWith(path.resolve(root) + path.sep))
    throw new Error('Private diagnostic output must be outside both the tool repository and analyzed workspace.');
  if (fs.existsSync(destination)) throw new Error('Use a new output directory; existing private diagnostics are not overwritten.');
  const records = () => {
    const result = {};
    const visit = folder => { for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Saved records contain an unexpected symlink.');
      if (stat.isDirectory()) visit(file); else result[path.relative(root, file)] = engine.hash(fs.readFileSync(file).toString('base64'));
    } }; visit(path.join(root, '.flowboard')); return result;
  };
  const beforeRecords = records();
  const store = require('../extension/store'), report = store.readReport(root), issue = report.issues.find(item => item.id === id);
  if (!issue?.reportText) throw new Error('No original imported finding text with this exact identity.');
  const start = Date.now(), indexed = await require('../extension/runner-adapter').analyze(native, root, { mode: 'source', background: true });
  const catalog = new (require('../extension/source').SourceCatalog)(root, indexed.runner, indexed.result), indexedAt = Date.now();
  const coordinator = new (require('../extension/report-preparation').ReportPreparation)(root, {});
  const parsed = require('../extension/report').parseReport(report.originalReport || issue.reportText, { manifest: true });
  const entry = parsed.issues.find(item => item.id === id || item.displayId === issue.displayId && item.title === issue.title);
  if (!entry) throw new Error('The imported finding cannot be reconciled with its original report boundaries.');
  const request = coordinator.request(entry, catalog, report);
  const draft = mode ? structuredClone(engine.read(root, id)) : engine.create({ findingId: id, request, issue, catalog });
  let packet, replay, retainedHashes;
  if (mode === '--replay-challenge') {
    if (!path.isAbsolute(priorInput || '') || !path.isAbsolute(priorResponse || '')) throw new Error('Exact saved request/response absolute paths are required.');
    retainedHashes = [priorInput, priorResponse].map(file => engine.hash(fs.readFileSync(file).toString('base64')));
    packet = JSON.parse(fs.readFileSync(priorInput, 'utf8'));
    const raw = JSON.parse(fs.readFileSync(priorResponse, 'utf8'));
    if (!engine.compatible(draft, catalog, request, issue) || !engine.sameSnapshot(packet.snapshot, draft.snapshot)) throw new Error('Saved response/source/input identities changed.');
    engine.validateCurrent(catalog, draft);
    replay = require('./replay-review').replayReview({ saved: draft, input: packet, response: raw.value || raw, units: draft.sources });
    if (JSON.stringify(retainedHashes) !== JSON.stringify([priorInput, priorResponse].map(file => engine.hash(fs.readFileSync(file).toString('base64'))))) throw new Error('Retained request or response changed.');
  } else if (mode) ({ packet } = await require('./saved-stage-packet').inspectSavedStage({ root, catalog, request, issue, findingId: id, saved: draft }));
  else
  await engine.advance({ root, findingId: id, request, issue, catalog, draft, provider: 'codex', persist: false,
    current: () => true, publish: async () => {}, invoke: async input => {
      packet = input;
      throw Object.assign(new Error('Offline capture complete. No provider process or request was started.'), { code: 'LOCAL_READING_LIMIT' });
    } });
  if (!packet) throw new Error(draft.error || 'Source preparation produced no request packet.');
  const metrics = provider.requestMetrics(packet);
  if (JSON.stringify(records()) !== JSON.stringify(beforeRecords)) throw new Error('Offline inspection changed saved workspace records.');
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'input.json'), JSON.stringify(packet, null, 2), { flag: 'wx', mode: 0o600 });
  if (replay) fs.writeFileSync(path.join(destination, 'replay.json'), JSON.stringify({ ...replay, retainedHashes }, null, 2), { flag: 'wx', mode: 0o600 });
  const result = { mode: replay ? 'offline-rejected-review-replay' : mode ? 'offline-saved-challenge' : 'offline-production-packet', providerRequests: 0, findingId: id, reportCount: report.issues.length,
    reportHash: report.reportHash, snapshot: draft.snapshot, sourceUnits: packet.sources.length, savedRecordsUnchanged: true, savedRecordHashes: beforeRecords,
    indexingMs: indexedAt - start, acquisitionAndPacketMs: Date.now() - indexedAt,
    inputBytes: metrics.inputBytes, inputSections: metrics.inputSections, packetBoundBytes: metrics.requestBytes,
    inputHash: metrics.inputHash, sourcePacketHash: metrics.sourcePacketHash, instructionHash: metrics.instructionHash, schemaHash: metrics.schemaHash };
  fs.writeFileSync(path.join(destination, 'metrics.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  // Never print original report/code or private input locations to a shared log.
  console.log(JSON.stringify({ ...result, snapshot: undefined, findingId: undefined, reportHash: undefined, savedRecordHashes: undefined }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
