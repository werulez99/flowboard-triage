'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const ownership = require('../extension/provider-ownership');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await pause(10);
  assert.ok(check(), 'The controlled process must reach its requested race boundary.');
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const done = once(child, 'exit'); child.kill('SIGKILL'); await done;
}
test('a delayed stale reaper cannot delete a live owner published by another recovery process', { skip: process.platform !== 'linux', timeout: 12000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-reaper-race-')), file = path.join(root, 'codex-0.json'), barrier = path.join(root, 'barrier');
  const children = [];
  t.after(async () => { for (const child of children) await stop(child); fs.rmSync(root, { recursive: true, force: true }); });
  const crashed = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-owner.js'), 'metadata-held', file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(crashed); await once(crashed, 'message'); await stop(crashed);
  assert.equal(ownership.inspect(file).state, 'dead');
  const start = mode => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-reaper.js'), mode, file, barrier], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child); const messages = []; let errors = '';
    child.on('message', message => messages.push(message)); child.stderr.on('data', chunk => { errors += chunk; });
    return { child, messages, errors: () => errors };
  };
  const first = start('paused-reaper'); await until(() => fs.existsSync(barrier + '.ready'));
  const second = start('takeover'); await until(() => second.messages.length > 0);
  const ended = once(first.child, 'exit'); fs.writeFileSync(barrier + '.release', 'continue');
  const [code] = await ended; assert.equal(code, 0, first.errors());
  await until(() => second.messages.some(message => message.state === 'acquired'));
  const acquired = second.messages.find(message => message.state === 'acquired');
  const current = ownership.snapshot(file);
  assert.equal(current?.entry?.owner, acquired.owner, 'A stale unlink must never remove the newly acquired live record.');
  assert.equal(ownership.inspect(file).state, 'live');
  assert.ok(second.messages.some(message => message.state === 'busy'), 'Recovery must serialize before the destructive boundary.');
});
test('a crashed recovery helper releases its kernel mutex without deleting the original record or requiring stale-lock removal', { skip: process.platform !== 'linux', timeout: 12000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-reaper-crash-')), file = path.join(root, 'codex-0.json'), barrier = path.join(root, 'barrier'), children = [];
  t.after(async () => { for (const child of children) await stop(child); fs.rmSync(root, { recursive: true, force: true }); });
  const crashed = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-owner.js'), 'metadata-held', file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(crashed); await once(crashed, 'message'); await stop(crashed);
  const original = fs.readFileSync(file, 'utf8');
  const first = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-reaper.js'), 'paused-reaper', file, barrier], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(first); await until(() => fs.existsSync(barrier + '.ready'));
  const helperPid = Number(fs.readFileSync(barrier + '.ready', 'utf8'));
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 1 && helperPid !== process.pid && helperPid !== first.pid);
  const finished = once(first, 'exit'); process.kill(helperPid, 'SIGKILL'); const [status] = await finished;
  assert.notEqual(status, 0); assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(root, '.ownership-recovery.lock')), true, 'The permanent sentinel inode is intentionally retained.');
  const second = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-reaper.js'), 'takeover', file, barrier], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(second); const [result] = await once(second, 'message');
  assert.equal(result.state, 'acquired'); assert.equal(ownership.snapshot(file).entry.owner, result.owner);
});
test('abandoned malformed bytes are compared exactly during recovery rather than re-encoded as UTF-8', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-reaper-bytes-')), file = path.join(root, 'codex-0.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, Buffer.from([0xFF, 0xC3, 0x00]));
  assert.equal(ownership.inspect(file).state, 'abandoned'); assert.equal(ownership.reap(file), null); assert.equal(fs.existsSync(file), false);
});
test('normal atomic acquisition, health updates and current-owner release need no recovery subprocess', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-reaper-normal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const children = require('node:child_process'), original = children.spawnSync; let calls = 0;
  try {
    children.spawnSync = () => { calls++; throw new Error('A normal ownership path must not execute the recovery helper.'); };
    const release = await require('../extension/provider-slots').acquire('codex', null, { directory: root }); release.markDispatching(); release();
    const health = require('../extension/provider-health'); health.check('codex', { directory: root });
    await health.record('codex', { outcome: 'completed', requestId: 'controlled-normal-owner' }, { directory: root });
    assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(root, '.ownership-recovery.lock')), false);
  } finally { children.spawnSync = original; }
});
