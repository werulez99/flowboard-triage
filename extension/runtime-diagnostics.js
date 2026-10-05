'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const processOwner = require('./provider-process');
// execFile does not forward detached on every supported Node version. Use a
// real detached spawn so escalation owns the group it actually signals.
function versionChild(executable, args, options, done) {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', bytes = 0, reported = false;
  const complete = (error, value) => { if (!reported) { reported = true; done(error, value); } };
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > options.maxBuffer) complete(new Error('Version output limit')); else stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > options.maxBuffer) complete(new Error('Version output limit')); });
  child.on('error', error => complete(error)); child.on('close', code => complete(code === 0 ? null : new Error('Version process failed'), stdout));
  return child;
}
function versionProbe(executable, run) {
  return new Promise(resolve => {
    let child, lifecycle, ended = false, closed = false, stopping = false, force, deadline, poll;
    const finish = value => { if (ended) return; ended = true; clearTimeout(timer); clearTimeout(force); clearTimeout(deadline); clearInterval(poll); resolve(value); };
    const confirm = () => { const cleanup = lifecycle?.status(closed, true); if (closed && cleanup?.confirmed) { finish({ cleanup, unavailable: true }); return true; } return false; };
    const stop = () => {
      if (ended || stopping) return; stopping = true; lifecycle?.signal('SIGTERM');
      poll = setInterval(confirm, 25);
      force = setTimeout(() => lifecycle?.signal('SIGKILL'), 150);
      deadline = setTimeout(() => {
        const cleanup = lifecycle?.status(closed, true) || { confirmed: !child?.pid, reason: 'No process was started.' };
        child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref?.();
        finish({ unavailable: true, cleanup });
      }, 650);
      confirm();
    };
    const timer = setTimeout(stop, 2000);
    try {
      child = run(executable, ['--version'], { timeout: 2000, maxBuffer: 4096, windowsHide: true, shell: false, detached: process.platform !== 'win32' }, (error, stdout) => {
        closed = !child || child.exitCode !== null || child.signalCode !== null;
        if (stopping) { confirm(); return; }
        if (lifecycle && (!closed || !lifecycle.status(true, false).confirmed)) { stop(); return; }
        finish({ error: !!error, stdout, cleanup: lifecycle?.status(true, false) });
      });
      if (child) { lifecycle = processOwner.create(child, process.platform !== 'win32'); child.on('close', () => { closed = true; if (stopping) confirm(); }); }
    } catch { finish({ unavailable: true, cleanup: { confirmed: true, reason: 'Version query did not start.' } }); }
  });
}
// Doctor is explicit, local diagnostics, never a model request or a queue action.
async function providerIdentity(provider, executable, trusted, receipts = [], run = versionChild) {
  const result = { provider, configuredExecutable: executable || (['codex', 'claude'].includes(provider) ? provider : null),
    resolvedExecutable: null, version: null, observedModel: null, observedModels: [], modelObservation: null };
  if (!['codex', 'claude'].includes(provider)) return result;
  const models = item => [...new Set([item?.audit?.effectiveConfiguration?.observedModel,
    ...(Array.isArray(item?.audit?.effectiveConfiguration?.observedModels) ? item.audit.effectiveConfiguration.observedModels : [])].filter(value => typeof value === 'string' && value.trim()))];
  const prior = (Array.isArray(receipts) ? receipts : []).filter(item => item?.audit?.provider === `${provider}-cli` &&
    item.audit.effectiveConfiguration?.executable === result.configuredExecutable)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))
    .find(item => models(item).length);
  if (prior) {
    result.observedModels = models(prior);
    result.observedModel = typeof prior.audit.effectiveConfiguration.observedModel === 'string' ? prior.audit.effectiveConfiguration.observedModel : null;
    result.modelObservation = { requestId: prior.id || prior.audit.requestId, at: prior.finishedAt,
      scope: 'Last matching saved transport observation, not the current CLI default or an editor setting.' };
  }
  if (!trusted) { result.versionStatus = 'Not probed in an untrusted workspace.'; return result; }
  const command = result.configuredExecutable;
  if (!path.isAbsolute(command) && command !== provider) { result.versionStatus = 'Configured executable must be an absolute path without arguments.'; return result; }
  const candidates = path.isAbsolute(command) ? [command] : (process.env.PATH || '').split(path.delimiter)
    .flatMap(folder => [command, ...(process.platform === 'win32' ? ['.exe', '.cmd'].map(suffix => command + suffix) : [])].map(name => path.join(folder, name)));
  result.resolvedExecutable = candidates.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } }) || null;
  if (!result.resolvedExecutable) { result.versionStatus = 'Executable not found on this extension host.'; return result; }
  const probe = await versionProbe(result.resolvedExecutable, run);
  {
    // Do not copy arbitrary stdout/stderr from a configured wrapper into logs.
    const version = String(probe.stdout || '').trim();
    if (!probe.error && !probe.unavailable && /^(?:codex-cli\s+)?\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?:\s+\(Claude Code\))?$/.test(version)) result.version = version;
    else result.versionStatus = 'Local version query unavailable or unrecognized; no model request was made.';
    if (probe.cleanup) result.versionCleanup = probe.cleanup;
  }
  return result;
}
module.exports = { providerIdentity };
