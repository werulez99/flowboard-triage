'use strict';
const fs = require('node:fs'), path = require('node:path');
const { execFile } = require('node:child_process');
// Doctor is explicit, local diagnostics, never a model request or a queue action.
async function providerIdentity(provider, executable, trusted, receipts = [], run = execFile) {
  const result = { provider, configuredExecutable: executable || (['codex', 'claude'].includes(provider) ? provider : null),
    resolvedExecutable: null, version: null, observedModel: null, modelObservation: null };
  if (!['codex', 'claude'].includes(provider)) return result;
  const prior = receipts.filter(item => item.audit?.provider === `${provider}-cli` &&
    item.audit.effectiveConfiguration?.executable === result.configuredExecutable)
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))
    .find(item => item.audit.effectiveConfiguration.observedModel);
  if (prior) {
    result.observedModel = prior.audit.effectiveConfiguration.observedModel;
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
  await new Promise(resolve => run(result.resolvedExecutable, ['--version'], { timeout: 2000, maxBuffer: 4096, windowsHide: true, shell: false }, (error, stdout) => {
    // Do not copy arbitrary stdout/stderr from a configured wrapper into logs.
    const version = String(stdout || '').trim();
    if (!error && /^(?:codex-cli\s+)?\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?:\s+\(Claude Code\))?$/.test(version)) result.version = version;
    else result.versionStatus = 'Local version query unavailable or unrecognized; no model request was made.';
    resolve();
  }));
  return result;
}
module.exports = { providerIdentity };
