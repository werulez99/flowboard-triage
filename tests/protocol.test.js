'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const p = require('../extension/protocol');
const example = require('../examples/finding.json');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-test-'));
  fs.cpSync(path.join(__dirname, '../examples/project'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('compact journal persistence preserves every value and the existing semantic ownership hash', t => {
  const root=fixture(t),value={jobs:{a:{reason:'Exact original text\nwith quotation " and Unicode \u03bb',state:'blocked'}},receipts:[{id:'one',consumed:true}],nested:{empty:[],value:null}};
  p.atomicJson(root,'.flowboard/pretty.json',value);
  const identity=p.atomicJson(root,'.flowboard/compact.json',value,{compact:true});
  const pretty=fs.readFileSync(path.join(root,'.flowboard/pretty.json'),'utf8'),compact=fs.readFileSync(path.join(root,'.flowboard/compact.json'),'utf8');
  assert.deepEqual(JSON.parse(compact),JSON.parse(pretty));assert.equal(compact,JSON.stringify(value)+'\n');
  assert.equal(identity,require('../extension/investigation-engine').hash(value));assert.ok(Buffer.byteLength(compact)<Buffer.byteLength(pretty));
  value.jobs.a.reason+=' Changed';assert.notEqual(identity,require('../extension/investigation-engine').hash(value));
});
test('valid demo resolves source and produces stable source hashes', t => {
  const root = fixture(t);
  assert.equal(p.validate(structuredClone(example)).cards.length, 2);
  const result = p.sources(root, example);
  assert.match(result[0].hash, /^[a-f0-9]{64}$/);
  assert.equal(result[0].hash, result[1].hash);
});
test('reject duplicate IDs, dangling parents and unsubstantiated reviewed verdicts', () => {
  const duplicate = structuredClone(example); duplicate.cards[1].id = duplicate.cards[0].id;
  assert.throws(() => p.validate(duplicate), /Duplicate/);
  const parent = structuredClone(example); parent.cards[0].parentId = 'missing';
  assert.throws(() => p.validate(parent), /Parent/);
  const verdict = structuredClone(example); verdict.finding.status = 'confirmed'; delete verdict.finding.evidence;
  assert.throws(() => p.validate(verdict), /requires evidence/);
});
test('reject absolute paths, foreign-platform absolute paths and source escapes', t => {
  const root = fixture(t);
  for (const file of ['/etc/example.sol', 'C:/outside/example.sol', '..\\outside.sol']) {
    const request = structuredClone(example); request.cards[0].file = file;
    assert.throws(() => p.validate(request), /relative source paths/);
  }
  const request = structuredClone(example); request.cards[0].file = '../outside.sol';
  assert.throws(() => p.sources(root, request));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-source-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const externalFile = path.join(outside, 'Other.sol'); fs.writeFileSync(externalFile, 'contract Other {}');
  try { fs.symlinkSync(externalFile, path.join(root, 'src/Escape.sol'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('File-symlink test requires Windows Developer Mode or administrator privileges.'); return; } throw error; }
  request.cards[0].file = 'src/Escape.sol';
  assert.throws(() => p.sources(root, request), /inside the workspace/);
});
test('source hash and revision guard detect stale references', t => {
  const root = fixture(t);
  const request = structuredClone(example); request.cards[0].sourceHash = '0'.repeat(64);
  assert.throws(() => p.sources(root, request), /Stale source/);
  assert.throws(() => p.checkRevision({ sourceRevision: 'abcdef0' }, { head: '123456789' }), /does not match/);
});
test('atomic output does not follow symlinked directories or files', t => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, '.flowboard'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => p.atomicJson(root, p.REQUEST, example), /Unsafe output directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('CLI submission stamps fresh IDs and source hashes; pending status is not success', t => {
  const root = fixture(t);
  const input = path.join(root, 'finding.json'); fs.writeFileSync(input, JSON.stringify(example));
  const cli = path.join(__dirname, '../cli.js');
  const submit = () => JSON.parse(execFileSync(process.execPath, [cli, 'submit', input, '--root', root], { encoding: 'utf8' }));
  const first = submit(), second = submit(); assert.notEqual(first.requestId, second.requestId);
  const request = p.readJson(path.join(root, p.REQUEST)); assert.match(request.cards[0].sourceHash, /^[a-f0-9]{64}$/);
  assert.throws(() => execFileSync(process.execPath, [cli, 'status', '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => JSON.parse(error.stdout).state === 'pending');
});
test('oversized requests are rejected before parsing', t => {
  const root = fixture(t); const file = path.join(root, 'large.json');
  fs.writeFileSync(file, ' '.repeat(p.MAX_BYTES + 1)); assert.throws(() => p.readJson(file), /at most/);
});
test('assessment notes stay plain text and label unverified judgments', () => {
  const request = structuredClone(example); request.finding.summary = '<script>never execute</script>';
  const note = p.noteText(request, { mode: 'source', success: null }, { head: null });
  assert.match(note, /not tool-verified/); assert.match(note, /<script>/); assert.match(note, /do not prove reachability/);
});
