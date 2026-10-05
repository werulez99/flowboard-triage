'use strict';
// Optional, offline language-semantics controls. This compiles only the public
// fictional test below and performs no RPC/fork or protocol-project operation.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const fixture = path.resolve(__dirname, '../tests/fixtures/call-semantics');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-language-semantics-'));
const locate = name => {
  if (path.isAbsolute(name) || name.includes(path.sep)) return path.resolve(name);
  const suffixes = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD').split(';')] : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) for (const suffix of suffixes) {
    const file = path.resolve(directory, name + suffix);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* inspect the next PATH entry */ }
  }
  return name;
};
const forge = locate(process.env.FLOWBOARD_FORGE_PATH || 'forge'), solc = locate(process.env.FLOWBOARD_SOLC_PATH || 'solc');
try {
  for (const executable of [forge, solc]) {
    const version = spawnSync(executable, ['--version'], { stdio: 'inherit', timeout: 10000 });
    if (version.error || version.status !== 0) throw new Error(`A local ${executable} is required. No installation or compiler download was attempted.`);
  }
  const run = spawnSync(forge, ['test', '--root', root, '--contracts', fixture, '--out', path.join(root, 'out'),
    '--cache-path', path.join(root, 'cache'), '--use', solc, '--offline', '-vv'], { stdio: 'inherit', timeout: 60000 });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
finally { fs.rmSync(root, { recursive: true, force: true }); }
