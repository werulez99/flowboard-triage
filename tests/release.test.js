'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publicFiles } = require('../scripts/release-files');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-release-'));
  fs.mkdirSync(path.join(root, 'extension'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('public release is English and excludes local translations, handoffs and runtime data', () => {
  const files = publicFiles(path.resolve(__dirname, '..')).map(item => item.relative);
  assert.ok(files.includes('LICENSE')); assert.ok(files.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(files.includes('extension/webview/inline-review.js'));
  assert.ok(!files.some(name => /README\.bg|HANDOFF|^dist\/|^vendor\/|\.flowboard/.test(name)));
});
test('release refuses credential-like data without printing its contents', t => {
  const root = fixture(t), token = 'gh' + 'p_' + 'x'.repeat(36);
  fs.writeFileSync(path.join(root, 'extension/settings.json'), JSON.stringify({ token }));
  assert.throws(() => publicFiles(root, ['extension']), error => /Possible credential/.test(error.message) && !error.message.includes(token));
});
test('release rejects private paths and non-English authored content', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'extension/.env'), 'PRIVATE_SETTING=value');
  assert.throws(() => publicFiles(root, ['extension']), /Non-public/);
  fs.unlinkSync(path.join(root, 'extension/.env'));
  fs.writeFileSync(path.join(root, 'extension/message.js'), '\u041f\u0440\u0438\u0432\u0435\u0442');
  assert.throws(() => publicFiles(root, ['extension']), /English/);
});
test('release refuses symlinks instead of copying files outside the public tree', t => {
  const root = fixture(t);
  const target = path.join(root, 'local.txt'); fs.writeFileSync(target, 'Local only');
  try { fs.symlinkSync(target, path.join(root, 'extension/link.txt'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symlink permission unavailable'); return; } throw error; }
  assert.throws(() => publicFiles(root, ['extension']), /symlink/);
});
