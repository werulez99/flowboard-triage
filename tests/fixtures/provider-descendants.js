'use strict';
// Harmless local transport fixture: no model, network, protocol or filesystem
// access. A descendant deliberately keeps inherited output pipes open.
const { spawn } = require('node:child_process');
const mode = process.argv[2] || 'inherited';
if (mode === 'worker' || mode === 'worker-ignore-term') {
  if (mode === 'worker-ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [__filename, mode === 'ignore-term' ? 'worker-ignore-term' : 'worker'],
    { detached: ['escaped-pipes', 'escaped-closed'].includes(mode), stdio: mode === 'escaped-closed' ? 'ignore' : ['ignore', 1, 2] });
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fictional-process-tree', fixtureChildPid: child.pid }) + '\n');
  process.stdin.resume();
  if (mode === 'launcher-exits') setTimeout(() => process.exit(0), 20);
}
