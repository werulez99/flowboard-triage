'use strict';
const fs = require('node:fs');
const { processIdentity } = require('./provider-ownership');
function processGroup(record) {
  const pid = record?.pid, group = record?.processGroup;
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(group) || pid <= 1 || group !== pid || group === process.pid || record.platform !== process.platform)
    return { confirmed: false, reason: 'The provider process group identity is unavailable.' };
  try {
    const current = processIdentity(pid);
    if (current && record.birth && current.birth && record.birth !== current.birth)
      return { confirmed: false, reason: 'The process ID now belongs to a different process; it was not signalled.' };
    try { process.kill(-group, 0); }
    catch (error) { if (error.code === 'ESRCH') return { confirmed: true, reason: 'The owned process group has ended.' }; throw error; }
    if (process.platform === 'linux') {
      const members = [];
      for (const name of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        let entry;
        try { entry = processIdentity(Number(name)); }
        catch { return { confirmed: false, reason: 'The owned process group could not be fully inspected.' }; }
        if (entry?.group === group && !['Z', 'X'].includes(entry.state)) members.push({ pid: entry.pid, birth: entry.birth });
      }
      // Reparented zombies cannot issue requests or retain open pipe handles.
      if (!members.length) return { confirmed: true, reason: 'No executing process remains in the owned group.' };
      return { confirmed: false, reason: 'An owned provider process is still running.', members };
    }
    return { confirmed: false, reason: 'The owned provider process group is still present.' };
  } catch { return { confirmed: false, reason: 'Provider process termination could not be established on this host.' }; }
}
function create(child, detached) {
  const pid = child?.pid, simulated = pid === process.pid;
  let birth = null;
  try { birth = !simulated && pid ? processIdentity(pid)?.birth || null : null; } catch { /* Unknown ownership stays conservative. */ }
  const group = detached && Number.isSafeInteger(pid) && pid > 1 && !simulated ? pid : null;
  const record = { pid: Number.isSafeInteger(pid) ? pid : null, processGroup: group, birth, platform: process.platform,
    strategy: group ? 'owned-process-group' : simulated ? 'controlled-process-fixture' : 'direct-process' };
  return {
    record,
    signal(signal) {
      if (group) {
        // Never signal a recycled process ID or another process's group.
        let current; try { current = processIdentity(pid); } catch { return false; }
        if (current && birth && current.birth && current.birth !== birth) return false;
        try { process.kill(-group, signal); return true; } catch (error) { return error.code === 'ESRCH'; }
      }
      try { return !!child?.kill(signal); } catch { return false; }
    },
    status(closed, stopping) {
      if (!pid) return { confirmed: true, reason: 'No provider process was started.' };
      if (group) return processGroup(record);
      if (simulated && closed) return { confirmed: true, reason: 'The controlled test process closed.' };
      if (!stopping && closed) return { confirmed: true, treeVerified: false, reason: 'Normal provider completion and streams closed; process-tree inspection is unavailable on this host.' };
      return { confirmed: false, reason: 'The child process ended or was signalled, but descendant termination cannot be verified on this host.' };
    }
  };
}
module.exports = { create, processGroup };
