'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { importReport } = require('../extension/report'), { ReportPreparation } = require('../extension/report-preparation');
const { analyze } = require('../extension/runner-adapter'), { SourceCatalog } = require('../extension/source');
const engine = require('../extension/investigation-engine');
const native = process.env.FLOWBOARD_EXTENSION_PATH;
for (const name of ['time', 'lifecycle', 'accounting','scenarios']) test(`ordinary ${name} teaching packet and accepted projection`, { skip: !native }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-teaching-')), base = path.join(__dirname, '../scripts/fixtures/teaching-preparation', name);
  fs.cpSync(path.join(base, 'project'), root, { recursive: true });
  await importReport(path.join(base, 'report.md'), root, native, { deferMapping: true });
  const result = await analyze(native, root, { mode: 'source' }), catalog = new SourceCatalog(root, result.runner, result.result), packets = [];
  const runner = new ReportPreparation(root, { configuration: () => ({ provider: 'codex', requestLimit: 6 }), catalog: async () => catalog,
    invoke: async input => { packets.push(input); return { value: require('../scripts/fixtures/teaching-output').response(input, name), audit: { phase: input.phase, outcome: 'completed', provider: 'fixed-local-control' } }; } });
  t.after(async () => { runner.dispose(); await runner.loop; fs.rmSync(root, { recursive: true, force: true }); });
  await runner.ensure(); const draft = engine.read(root, 'I-1');
  assert.ok(runner.published(draft), JSON.stringify({ error: draft?.error, publication: draft?.publication, sources: packets[0]?.sources.map(s => [s.name,s.line,s.endLine]) }));
  assert.deepEqual(packets.map(p => p.phase), ['generate', 'challenge']);
  const metrics = packets.map(p => require('../extension/semantic-provider').requestMetrics(p));
  assert.ok(metrics.every(m => m.system.includes('TEACHING CONTRACT')));
  assert.ok(packets[1].earlierDraft.causal.events.length);
  const exposed = require('../extension/guide-policy').expose(draft), route = require('../extension/webview/walkthrough-model').build(exposed, exposed.walkthrough.reportText);
  assert.ok(route?.teaching.mechanism && route.teaching.rule && route.teaching.conclusion);
  if(name==='scenarios'){
    const walk=require('../extension/webview/walkthrough-model'),first=walk.teaching(exposed,route.steps,0),second=walk.teaching(exposed,route.steps,1);
    assert.equal(first.actor,'User');assert.equal(second.actor,'Keeper');assert.deepEqual(first.conditions,['approved == false']);assert.deepEqual(second.conditions,['paused == true']);
    assert.equal(walk.transition(route.steps[0],route.steps[1]).label,'Alternative scenario');
    assert.equal(exposed.property.basis,'source-contract');assert.deepEqual(exposed.property.evidence,['withdrawal-guard','rebalance-guard']);assert.equal(second.basis,'Source-linked rule');
  }
  const changed = structuredClone(draft); changed.causal.summary = 'A new unreviewed teaching premise.';
  assert.ok(!require('../extension/guide-policy').expose(changed).causal, 'Displayed factual projections remain inside the accepted digest, not an unchecked metadata channel.');
  const before = packets.length; await runner.ensure(); assert.equal(packets.length, before);
  t.diagnostic(JSON.stringify({ name, inputBytes: metrics.map(m => m.inputBytes), requestBytes: metrics.map(m => m.requestBytes), events: route.steps.length, externalRequests: 0 }));
  if (name === 'accounting') {
    const file = path.join(root, 'src/QuoteBook.sol'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('product / 100', 'product / 10'));
    assert.throws(() => require('../extension/workspace-snapshot').validate(catalog, { force: true }), /chang|stale|match/i);
    const fresh = await analyze(native, root, { mode: 'source' }), next = new SourceCatalog(root, fresh.runner, fresh.result);
    const { report, entries } = require('../extension/report-preparation').reconcile(root), request = runner.request(entries[0], next, report);
    assert.ok(engine.makeContext(next, request, runner.issue(entries[0])).units.some(unit => unit.code.includes('product / 10')));
    assert.equal(packets.length, before, 'Changed-source packet inspection invokes no model.');
  }
});
