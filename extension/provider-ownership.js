'use strict';
// Local coordination records are published only after their complete metadata
// is on disk. No observer needs to guess whether an empty exclusive-create file
// belongs to a live writer. Legacy incomplete files require an ownership check.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const MAX_RECORD_BYTES = 64 * 1024;
let boot;
function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), tail = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      boot ||= fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return { pid, birth: `${boot}:${tail[19]}`, state: tail[0], parent: Number(tail[1]), group: Number(tail[2]) };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
      // A PID namespace with a different mounted /proc view cannot prove
      // death from an absent stat file. Fail finitely, retaining all owners.
      try { process.kill(pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') return null; if (probe.code !== 'EPERM') throw probe; }
      throw resourceError('This host exposes inconsistent process IDs and /proc identity. Provider ownership cannot be verified. Run preparation in a matching Linux/WSL process namespace; no owner was removed or request dispatched.');
    }
  }
  try { process.kill(pid, 0); return { pid, birth: null }; }
  catch (error) { if (error.code === 'ESRCH') return null; throw error; }
}
function ownerMetadata(owner = crypto.randomUUID()) {
  const identity = processIdentity();
  return { owner, pid: process.pid, birth: identity?.birth || null, startedAt: Date.now() };
}
function sameFile(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function snapshot(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || process.getuid && stat.uid !== process.getuid()) throw new Error('Unsafe local provider ownership record.');
    const bytes = fs.readFileSync(descriptor), text = bytes.toString('utf8'), contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!sameFile(stat, fs.fstatSync(descriptor))) return { state: 'unknown', reason: 'The provider ownership record changed while it was read.' };
    const exact = fs.fstatSync(descriptor, { bigint: true });
    const identity = Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(exact[key])]));
    let entry; try { entry = JSON.parse(text); } catch { /* Recovery below checks actual open inode holders. */ }
    return { stat, identity, contentHash, text, entry };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function valid(entry) { return entry && Number.isSafeInteger(entry.pid) && entry.pid > 0 && typeof entry.owner === 'string' && /^[\w-]{1,120}$/.test(entry.owner); }
function inodeHolders(stat) {
  // Linux/WSL can prove that a crashed pre-metadata writer no longer has this
  // inode open. An age threshold cannot prove that. Other hosts fail closed.
  if (process.platform !== 'linux') return { known: false, holders: [] };
  const holders = [];
  try {
    for (const name of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      let processStat;
      try { processStat = fs.statSync(`/proc/${name}`); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; return { known: false, holders }; }
      if (process.getuid && processStat.uid !== process.getuid()) continue;
      let descriptors;
      try { descriptors = fs.readdirSync(`/proc/${name}/fd`); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; return { known: false, holders }; }
      for (const fd of descriptors) {
        try {
          const open = fs.statSync(`/proc/${name}/fd/${fd}`);
          if (open.dev === stat.dev && open.ino === stat.ino) { holders.push(Number(name)); break; }
        } catch (error) { if (!['ENOENT', 'ESRCH', 'EBADF'].includes(error.code)) return { known: false, holders }; }
      }
    }
    return { known: true, holders };
  } catch { return { known: false, holders }; }
}
function kernelUnused(file, stat) {
  // A restricted /proc can hide descriptors of non-dumpable same-user
  // processes. Do not treat those inspection errors as absence. On Linux an
  // exclusive kernel write lease establishes that this exact inode has no
  // other open descriptors/mappings. Python is optional and used only for
  // legacy incomplete-record recovery, never for ordinary coordination.
  if (process.platform !== 'linux') return false;
  const script = 'import os,sys,fcntl,signal\n' +
    'signal.signal(signal.SIGIO, signal.SIG_IGN)\n' +
    'fd=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)\n' +
    's=os.fstat(fd)\n' +
    'if s.st_dev!=int(sys.argv[2]) or s.st_ino!=int(sys.argv[3]): sys.exit(2)\n' +
    'fcntl.fcntl(fd,fcntl.F_SETLEASE,fcntl.F_WRLCK)\n' +
    'fcntl.fcntl(fd,fcntl.F_SETLEASE,fcntl.F_UNLCK)\n' +
    'os.close(fd)\n';
  try {
    // A project-supplied PATH entry must not choose the recovery executable.
    const result = require('node:child_process').spawnSync('/usr/bin/python3', ['-I', '-S', '-c', script, file, String(stat.dev), String(stat.ino)],
      { shell: false, windowsHide: true, timeout: 750, maxBuffer: 1024, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    return !result.error && result.status === 0;
  } catch { return false; }
}
function inspect(file) {
  const value = snapshot(file); if (!value || value.state === 'unknown') return value;
  if (valid(value.entry)) {
    try {
      const current = processIdentity(value.entry.pid);
      const dead = !current || ['Z', 'X'].includes(current.state) || value.entry.birth && current.birth && value.entry.birth !== current.birth;
      return { ...value, state: dead ? 'dead' : 'live' };
    } catch { return { ...value, state: 'unknown', reason: 'The provider owner could not be checked.' }; }
  }
  const opened = inodeHolders(value.stat);
  const unused = !opened.holders.length && (opened.known || kernelUnused(file, value.stat));
  return { ...value, state: unused ? 'abandoned' : 'incomplete', holders: opened.holders,
    reason: opened.holders.length ? 'A live process still has this incomplete provider record open.' : 'The owner of this incomplete provider record cannot be established on this host.' };
}
function removeObserved(file, observed) {
  if (!observed?.stat || !observed.identity) return false;
  try {
    const current = snapshot(file);
    if (!current || !sameFile(observed.stat, current.stat) || current.contentHash !== observed.contentHash) return false;
    // Serialize recovery removers with a kernel lock whose inode is NEVER
    // unlinked. Otherwise two stale reapers can both check the old inode, then
    // the second unlink can delete a newly published live owner (ABA race).
    // Normal live-owner release below needs no helper. On unsupported hosts,
    // recovery stops explicitly instead of falling back to unsafe unlink.
    if (process.platform !== 'linux') throw resourceError('Safe provider-record recovery is unavailable on this host. No live ownership record was removed.');
    const script = 'import os,sys,json,hashlib,fcntl,stat\n' +
      'target,lock=sys.argv[1:3]\nexpected=json.load(sys.stdin)\n' +
      'guard=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)\n' +
      'g=os.fstat(guard)\n' +
      'if not stat.S_ISREG(g.st_mode) or g.st_uid!=os.getuid(): sys.exit(4)\n' +
      'try: fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)\n' +
      'except BlockingIOError: sys.exit(3)\n' +
      'try: fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW)\n' +
      'except FileNotFoundError: sys.exit(2)\n' +
      'def identity(s): return dict(dev=str(s.st_dev),ino=str(s.st_ino),size=str(s.st_size),mtimeNs=str(s.st_mtime_ns),ctimeNs=str(s.st_ctime_ns))\n' +
      's=os.fstat(fd)\n' +
      'if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or identity(s)!=expected["identity"] or s.st_size>65536: sys.exit(2)\n' +
      'data=b""\n' +
      'while True:\n chunk=os.read(fd,65537-len(data))\n if not chunk: break\n data+=chunk\n if len(data)>65536: sys.exit(2)\n' +
      'if hashlib.sha256(data).hexdigest()!=expected["hash"] or identity(os.fstat(fd))!=expected["identity"]: sys.exit(2)\n' +
      'try: current=os.stat(target,follow_symlinks=False)\n' +
      'except FileNotFoundError: sys.exit(2)\n' +
      'if identity(current)!=expected["identity"]: sys.exit(2)\n' +
      'os.unlink(target)\n';
    const result = require('node:child_process').spawnSync('/usr/bin/python3', ['-I', '-S', '-c', script, file, path.join(path.dirname(file), '.ownership-recovery.lock')],
      { shell: false, windowsHide: true, timeout: 750, maxBuffer: 1024, encoding: 'utf8',
        input: JSON.stringify({ identity: observed.identity, hash: observed.contentHash }) });
    if (!result.error && result.status === 0) return true;
    if (!result.error && result.status === 2) return false;
    throw resourceError(result.status === 3 ? 'Another process is recovering local provider ownership. No record was removed; retry when it finishes.' :
      'Safe local provider-record recovery could not be completed. Keep the ownership record and check the host recovery helper before retrying.');
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function removeOwned(file, owner) {
  const observed = snapshot(file);
  // Only this exact live owner can release directly. Recovery code never
  // deletes a live non-quarantined owner, and a replaced owner UUID cannot
  // match an old release handle. Atomic owner updates remain in this process.
  if (observed?.entry?.owner !== owner || observed.entry.pid !== process.pid) return false;
  const current = processIdentity();
  if (observed.entry.birth && current?.birth && observed.entry.birth !== current.birth) return false;
  try { fs.unlinkSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function publish(file, value, replace = false) {
  const temporary = `${file}.claim-${process.pid}-${crypto.randomUUID()}`; let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    if (replace) fs.renameSync(temporary, file);
    else fs.linkSync(temporary, file); // Atomic no-replace publication of a fully written inode.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function resourceError(message) { return Object.assign(new Error(message), { code: 'PROVIDER_RESOURCE_UNAVAILABLE', retryable: true }); }
function reap(file, observed = inspect(file)) {
  if (!observed) return null;
  if (['dead', 'abandoned'].includes(observed.state)) {
    if (removeObserved(file, observed)) return null;
    const changed = inspect(file);
    if (changed && changed.state !== 'live') throw resourceError('Provider ownership changed during recovery. No newer record was removed; retry after local recovery settles.');
    return changed;
  }
  if (observed.state === 'unknown' || observed.state === 'incomplete') throw resourceError(observed.reason || 'Provider ownership is incomplete. No request was dispatched.');
  return observed;
}
module.exports = { processIdentity, ownerMetadata, inspect, snapshot, valid, removeObserved, removeOwned, publish, reap, resourceError };
