'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Explicit files work across Node versions and Windows shells. A directory
// argument is no longer discovered as a test suite by newer Node releases.
const files = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(root, 'tests', name));
if (!files.length) throw new Error('No test files found.');
// Process-ownership tests inspect live /proc state and intentionally short
// deadlines. Run files sequentially by default so unrelated indexing/browser
// work in other test files cannot consume those bounds. Explicit overrides
// remain available for stress investigation, not the canonical CI result.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
