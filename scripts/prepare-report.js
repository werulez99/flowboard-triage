'use strict';
// Same durable coordinator as extension.activate. No UI selection is needed.
// Writes only the report's .flowboard preparation/checkpoint records.
const path = require('node:path');
const { ReportPreparation } = require('../extension/report-preparation');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
async function main() {
  const args = process.argv.slice(2), root = args[0], native = process.env.FLOWBOARD_EXTENSION_PATH;
  const get = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  if (!root || !native || !path.isAbsolute(root)) throw new Error('Usage: FLOWBOARD_EXTENSION_PATH=... node scripts/prepare-report.js /absolute/project --provider codex --requests 12 [--first FINDING] [--resume]');
  let catalog, last;
  const runner = new ReportPreparation(root, {
    firstFinding: get('--first'),
    configuration: () => ({ provider: get('--provider', 'none'), requestLimit: Number(get('--requests', '12')), budget: Number(get('--budget-usd', '1')), workers: Number(get('--workers', '2')) }),
    catalog: async signal => { if (!catalog) { const result = await analyze(native, root, { mode: 'source', background: true, signal }); catalog = new SourceCatalog(root, result.runner, result.result); } return catalog; },
    changed: status => { const key = JSON.stringify([status.mode, status.counts, status.requests, status.active.map(job => [job.id, job.stage, job.progress?.event])]);
      if (key !== last) { last = key; console.log(JSON.stringify(status)); } }, log: message => console.error(message)
  });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await runner.control('pause'); await runner.loop; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  await runner.ensure({ retry: args.includes('--resume') });
  console.log(JSON.stringify({ final: runner.status() }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
