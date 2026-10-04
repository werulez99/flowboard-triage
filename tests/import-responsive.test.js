'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { importReport } = require('../extension/report');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
const store = require('../extension/store');
const native = process.env.FLOWBOARD_EXTENSION_PATH;

test('deferred import reads only the report, saves full text and never needs a code index', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-report-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = path.join(root, 'report.txt');
  const body = '**Severity**: Medium\n\nA report statement without any local code.\n\n**Mitigation**: A proposed change, not evidence.';
  fs.writeFileSync(report, `## M-01: Original title\n${body}\n`);
  // Invalid runner path deliberately makes any attempted indexing fail.
  const first = await importReport(report, root, '/does-not-exist/runner', { deferMapping: true });
  assert.equal(first.issues[0].reportText, body);
  assert.equal(first.issues[0].mappingPending, true);
  assert.equal(store.readReport(root).issues[0].draftError, undefined);
  assert.equal(fs.existsSync(path.join(root, '.flowboard/findings')), false);
  const unchanged = fs.readFileSync(path.join(root, '.flowboard/report.json'), 'utf8');
  fs.writeFileSync(report, 'No recognized headings.');
  await assert.rejects(importReport(report, root, '', { deferMapping: true }), /No findings/);
  assert.equal(fs.readFileSync(path.join(root, '.flowboard/report.json'), 'utf8'), unchanged);
});

test('background source indexing leaves the host responsive and returns the same source relationships', { skip: !native }, async () => {
  const root = path.resolve(__dirname, '../examples/project');
  let ticks = 0; const interval = setInterval(() => ticks++, 1);
  let background;
  try { background = await analyze(native, root, { mode: 'source', background: true, slitherPath: '/never/compile' }); }
  finally { clearInterval(interval); }
  assert.ok(ticks > 0, 'The extension host services events while the worker reads code.');
  const direct = await analyze(native, root, { mode: 'source' });
  assert.deepEqual(background.result, direct.result, 'Structured cloning retains all parser Maps, Sets and shared definition identities.');
  const catalog = new SourceCatalog(root, background.runner, background.result);
  const increment = catalog.named('increment')[0];
  assert.ok(increment);
  assert.ok(catalog.callLinks(increment).some(link => link.candidates.length === 1 && link.candidates[0].name === '_add'));
  catalog.assertFresh();
  await assert.rejects(analyze('/does-not-exist/runner', root, { mode: 'source', background: true }), /ENOENT/);
});
