'use strict';
// Controlled cross-process recovery race. Timing hooks only; no provider or
// network. The same production ownership functions perform both removals.
const fs = require('node:fs'), children = require('node:child_process');
const ownership = require('../../extension/provider-ownership');
const [mode, file, barrier] = process.argv.slice(2);
if (mode === 'paused-reaper') {
  const unlink = fs.unlinkSync, spawn = children.spawnSync;
  fs.unlinkSync = target => {
    if (target === file) {
      fs.writeFileSync(barrier + '.ready', 'before-unlink');
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(barrier + '.release') && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      if (!fs.existsSync(barrier + '.release')) throw new Error('Controlled race barrier timed out.');
    }
    return unlink(target);
  };
  // The repaired implementation uses one kernel-serialized conditional
  // removal. Pause inside that critical section, at the same unlink boundary.
  children.spawnSync = (executable, args, options) => {
    const copy = [...args], scriptIndex = copy.indexOf('-c') + 1;
    if (scriptIndex && copy[scriptIndex]?.includes('os.unlink(target)')) {
      copy[scriptIndex] = copy[scriptIndex].replace('os.unlink(target)',
        'import time\nopen(sys.argv[3]+".ready","w").write(str(os.getpid()))\n' +
        'deadline=time.monotonic()+5\n' +
        'while not os.path.exists(sys.argv[3]+".release") and time.monotonic()<deadline: time.sleep(0.01)\n' +
        'if not os.path.exists(sys.argv[3]+".release"): sys.exit(9)\n' +
        'os.unlink(target)');
      copy.push(barrier);
      return spawn(executable, copy, { ...options, timeout: 6000 });
    }
    return spawn(executable, args, options);
  };
  const observed = ownership.inspect(file);
  const removed = ownership.removeObserved(file, observed);
  process.send?.({ state: 'finished', removed });
} else if (mode === 'takeover') {
  const metadata = ownership.ownerMetadata(), deadline = Date.now() + 5000;
  let announced = false;
  const attempt = () => {
    try {
      const prior = ownership.reap(file);
      if (prior) throw Object.assign(new Error('Another owner remains.'), { code: 'PROVIDER_RESOURCE_UNAVAILABLE' });
      ownership.publish(file, metadata);
      process.send?.({ state: 'acquired', owner: metadata.owner, pid: process.pid });
      setInterval(() => {}, 1000);
    } catch (error) {
      if (!['PROVIDER_RESOURCE_UNAVAILABLE', 'EEXIST'].includes(error.code) || Date.now() >= deadline) throw error;
      if (!announced) { announced = true; process.send?.({ state: 'busy' }); }
      setTimeout(attempt, 15);
    }
  };
  attempt();
} else throw new Error('Unknown controlled reaper mode.');
