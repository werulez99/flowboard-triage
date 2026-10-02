'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Explicit files work across Node versions and Windows shells. A directory
// argument is no longer discovered as a test suite by newer Node releases.
const files = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(root, 'tests', name));
if (!files.length) throw new Error('No test files found.');
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
