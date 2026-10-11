'use strict';
// Harmless local transport fixture: no model, network, protocol or filesystem
// access. A descendant deliberately keeps inherited output pipes open.
const { spawn } = require('node:child_process');
const requestedMode = process.argv[2] || 'inherited', complete=requestedMode.startsWith('completed-');
const mode = complete ? requestedMode.slice('completed-'.length) : requestedMode;
if (mode === 'worker' || mode === 'worker-ignore-term') {
  if (mode === 'worker-ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [__filename, mode === 'ignore-term' ? 'worker-ignore-term' : 'worker'],
    { detached: ['escaped-pipes', 'escaped-closed'].includes(mode), stdio: mode === 'escaped-closed' ? 'ignore' : ['ignore', 1, 2] });
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fictional-process-tree', fixtureChildPid: child.pid }) + '\n');
  if(complete)process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"fixture":"received but no host approval"}'}})+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\n');
  process.stdin.resume();
  if (mode === 'launcher-exits') setTimeout(() => process.exit(0), 20);
}
