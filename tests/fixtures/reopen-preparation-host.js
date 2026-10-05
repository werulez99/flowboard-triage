'use strict';
// A fresh OS process, not another coordinator sharing its parent's catalog.
// Controlled JSON responses are test data, never a live provider evaluation.
const fs = require('node:fs'), path = require('node:path');
const { ReportPreparation } = require('../../extension/report-preparation');
const { analyze } = require('../../extension/runner-adapter');
const { SourceCatalog } = require('../../extension/source');
const engine = require('../../extension/investigation-engine');
const [root, mode = 'restore'] = process.argv.slice(2);
const calls = [];
let indexes = 0, catalog, coordinator;
async function main() {
  coordinator = new ReportPreparation(root, {
    configuration: () => ({ provider: mode === 'restore' ? 'none' : 'codex', requestLimit: 4, workers: 1 }),
    catalog: async () => { if (!catalog) { indexes++; const prepared = await analyze(process.env.FLOWBOARD_EXTENSION_PATH, root, { mode: 'source' }); catalog = new SourceCatalog(root, prepared.runner, prepared.result); } return catalog; },
    invoke: async input => {
      calls.push(input.phase);
      const value = JSON.parse(fs.readFileSync(path.join(root, '.flowboard/controlled-answer.json'), 'utf8'));
      return { value, audit: { provider: 'controlled-fresh-process-fixture', phase: input.phase, outcome: 'completed' } };
    },
    changed: () => {
      if (mode !== 'crash-after-response') return;
      const draft = engine.read(root, 'I-1');
      if (draft?.pendingResponse) process.exit(73); // Receipt/result durable; acceptance has not run.
    }
  });
  await coordinator.ensure();
  const status = coordinator.status();
  const readable = Object.keys(coordinator.state.jobs).filter(id => {
    try { return coordinator.published(engine.read(root, id)); } catch { return false; }
  });
  process.stdout.write(JSON.stringify({ pid: process.pid, indexes, calls, readable, status,
    jobs: coordinator.state.jobs, receipts: coordinator.state.resources.receipts }));
  coordinator.dispose();
}
main().catch(error => { coordinator?.dispose(); console.error(error.stack); process.exitCode = 1; });
