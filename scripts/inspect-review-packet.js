'use strict';
// Offline only. Capture the exact first production review packet without
// invoking a provider, reserving an allowance, or writing the target workspace.
const fs = require('node:fs'), path = require('node:path');
const engine = require('../extension/investigation-engine'), provider = require('../extension/semantic-provider');
async function main() {
  const [root, id, output] = process.argv.slice(2), native = process.env.FLOWBOARD_EXTENSION_PATH;
  if (!root || !id || !output || !native || !path.isAbsolute(root) || !path.isAbsolute(output))
    throw new Error('Usage: FLOWBOARD_EXTENSION_PATH=... node scripts/inspect-review-packet.js ABSOLUTE_IMPORTED_WORKSPACE FINDING ABSOLUTE_PRIVATE_OUTPUT');
  const repository = path.resolve(__dirname, '..'), destination = path.resolve(output);
  if (destination === repository || destination.startsWith(repository + path.sep) || destination === path.resolve(root) || destination.startsWith(path.resolve(root) + path.sep))
    throw new Error('Private diagnostic output must be outside both the tool repository and analyzed workspace.');
  if (fs.existsSync(destination)) throw new Error('Use a new output directory; existing private diagnostics are not overwritten.');
  const store = require('../extension/store'), report = store.readReport(root), issue = report.issues.find(item => item.id === id);
  if (!issue?.reportText) throw new Error('No original imported finding text with this exact identity.');
  const start = Date.now(), indexed = await require('../extension/runner-adapter').analyze(native, root, { mode: 'source', background: true });
  const catalog = new (require('../extension/source').SourceCatalog)(root, indexed.runner, indexed.result), indexedAt = Date.now();
  const coordinator = new (require('../extension/report-preparation').ReportPreparation)(root, {});
  const parsed = require('../extension/report').parseReport(report.originalReport || issue.reportText, { manifest: true });
  const entry = parsed.issues.find(item => item.id === id || item.displayId === issue.displayId && item.title === issue.title);
  if (!entry) throw new Error('The imported finding cannot be reconciled with its original report boundaries.');
  const request = coordinator.request(entry, catalog, report);
  const draft = engine.create({ findingId: id, request, issue, catalog });
  let packet;
  await engine.advance({ root, findingId: id, request, issue, catalog, draft, provider: 'codex', persist: false,
    current: () => true, publish: async () => {}, invoke: async input => {
      packet = input;
      throw Object.assign(new Error('Offline capture complete. No provider process or request was started.'), { code: 'LOCAL_READING_LIMIT' });
    } });
  if (!packet) throw new Error(draft.error || 'Source preparation produced no request packet.');
  const metrics = provider.requestMetrics(packet);
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'input.json'), JSON.stringify(packet, null, 2), { flag: 'wx', mode: 0o600 });
  const result = { mode: 'offline-production-packet', providerRequests: 0, findingId: id, reportCount: report.issues.length,
    reportHash: report.reportHash, snapshot: draft.snapshot, sourceUnits: packet.sources.length,
    indexingMs: indexedAt - start, acquisitionAndPacketMs: Date.now() - indexedAt,
    inputBytes: metrics.inputBytes, inputSections: metrics.inputSections, packetBoundBytes: metrics.requestBytes,
    inputHash: metrics.inputHash, sourcePacketHash: metrics.sourcePacketHash, instructionHash: metrics.instructionHash, schemaHash: metrics.schemaHash };
  fs.writeFileSync(path.join(destination, 'metrics.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  // Never print original report/code or private input locations to a shared log.
  console.log(JSON.stringify({ ...result, snapshot: undefined, findingId: undefined, reportHash: undefined }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
