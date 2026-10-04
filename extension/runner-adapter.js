'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { execFile } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { membership } = require('./source-inventory');
const { projectConfigurationStamp } = require('./source');

function loadRunner(extensionPath, adapter) {
  const filename = path.join(extensionPath, 'out', 'slitherRunner.js'), exports = {};
  const helpers = '\nexports.flowboardCallSites = extractCallSites; exports.flowboardClassifyCallSites = classifyCallSites; exports.flowboardReceiverType = resolveReceiverType; exports.flowboardUsingFor = resolveUsingFor; exports.flowboardScanVarTypes = scanVarTypes; exports.flowboardContracts = parseContracts;';
  const wrapper = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8') + helpers), { filename });
  wrapper(exports, adapter || Module.createRequire(filename), { exports }, filename, path.dirname(filename));
  return exports;
}
const pendingIndexes = new Map();
const cancelled = () => Object.assign(new Error('Source indexing consumer cancelled.'), { code: 'ABORT_ERR' });
function startSourceWorker(extensionPath, root, signal) {
  return new Promise((resolve, reject) => {
    // Only the read-only source index runs here. Never move opted-in project
    // build commands into an automatic worker or pass report text as commands.
    const worker = new Worker(path.join(__dirname, 'source-worker.js'), { workerData: { extensionPath, root }, execArgv: [] });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error('Reading the project code took too long. Try a smaller workspace or check its dependencies.'));
      worker.terminate().catch(() => {});
    }, 180000);
    const abort = () => { finish(cancelled()); worker.terminate().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.once('message', message => {
      if (message.error) finish(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else finish(null, message);
    });
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error(`Code indexing stopped before returning a result (exit ${code}).`)); });
  });
}
function sourceInBackground(extensionPath, root, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  const key = JSON.stringify([extensionPath, fs.realpathSync(root), projectConfigurationStamp(root)]);
  let entry = pendingIndexes.get(key);
  if (!entry) {
    entry = { controller: new AbortController(), consumers: new Set() }; pendingIndexes.set(key, entry);
    entry.promise = startSourceWorker(extensionPath, root, entry.controller.signal).finally(() => { if (pendingIndexes.get(key) === entry) pendingIndexes.delete(key); });
  }
  return new Promise((resolve, reject) => {
    const consumer = {}, release = () => {
      signal?.removeEventListener('abort', abort); entry.consumers.delete(consumer);
      if (!entry.consumers.size && pendingIndexes.get(key) === entry) { pendingIndexes.delete(key); entry.controller.abort(); }
    };
    const abort = () => { release(); reject(cancelled()); };
    entry.consumers.add(consumer); signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(value => { release(); if (!signal?.aborted) resolve(value); }, error => { release(); reject(error); });
  });
}
// Load the pinned upstream runner with module-local adapters. Never patch global
// child_process/PATH or modify the installed upstream extension.
async function analyze(extensionPath, root, options = {}) {
  const mode = options.mode || 'source';
  if (!['source', 'slither'].includes(mode)) throw new Error('Unknown analysis mode.');
  if (mode === 'source' && options.background) {
    const indexed = await sourceInBackground(extensionPath, root, options.signal);
    return { ...indexed, runner: loadRunner(extensionPath) };
  }
  // Capture before indexing/optional compilation so a mid-analysis config
  // edit cannot be represented as if it had produced the completed result.
  const configuration = projectConfigurationStamp(root);
  const members = membership(root);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-triage-'));
  const jsonPath = path.join(temporary, 'slither-out.json');
  const diagnostics = { mode, success: null, error: null };
  const sourceStamps = new Map();
  const filename = path.join(extensionPath, 'out', 'slitherRunner.js');
  const nativeRequire = Module.createRequire(filename);
  const localRequire = name => {
    if (name === 'fs') return { ...fs, readFileSync: (file, ...rest) => {
      const contents = fs.readFileSync(file, ...rest);
      if (typeof file === 'string' && file.endsWith('.sol') && !sourceStamps.has(file)) {
        const stat = fs.statSync(file); sourceStamps.set(file, { size: stat.size, modified: stat.mtimeMs, hash: createHash('sha256').update(contents).digest('hex') });
      }
      return contents;
    } };
    if (name === 'os') return { ...os, tmpdir: () => temporary };
    if (name !== 'child_process') return nativeRequire(name);
    return { exec: (_command, config, callback) => {
      if (mode === 'source') {
        const error = Object.assign(new Error('Slither intentionally disabled in source mode'), { code: 'ENOENT' });
        callback(error, '', '');
        return;
      }
      const executable = options.slitherPath || 'slither';
      // No shell interpolation. Compilation is opt-in and may execute project
      // build configuration and create normal build/DOT artifacts in the repo.
      const args = ['.', '--print', 'call-graph', '--json', jsonPath];
      return execFile(executable, args, {
        cwd: config.cwd, maxBuffer: config.maxBuffer, timeout: options.timeout || 180000,
        env: { ...process.env, PATH: [path.join(os.homedir(), '.foundry', 'bin'), path.join(os.homedir(), '.local', 'bin'), process.env.PATH || ''].join(path.delimiter) }
      }, (error, stdout, stderr) => {
        if (error) diagnostics.error = (stderr || error.message).slice(-6000);
        callback(error, stdout, stderr);
      });
    } };
  };
  try {
    // Module-local helpers from the pinned parser preserve receiver/arity per
    // call occurrence. A flattened method-name list loses super/overload data.
    const exports = loadRunner(extensionPath, localRequire);
    const result = await exports.runSlither(root);
    if (JSON.stringify(members) !== JSON.stringify(membership(root))) throw new Error('Source files changed during indexing. Refresh the source map.');
    result.sourceStamps = sourceStamps;
    result.sourceMembership = members;
    result.projectConfigurationStamp = configuration;
    result.analysisConfiguration = { mode, slitherPath: mode === 'slither' ? options.slitherPath || 'slither' : '' };
    if (mode === 'slither') {
      try {
        const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        diagnostics.success = json.success === true && Array.isArray(json.results?.printers) && json.results.printers.some(x => x.printer === 'call-graph' || x.elements?.length);
        if (!diagnostics.success && !diagnostics.error) diagnostics.error = String(json.error || 'No successful call-graph JSON.');
      } catch (error) { diagnostics.success = false; diagnostics.error ||= error.message; }
    }
    return { runner: exports, result, diagnostics };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { analyze, sourceInBackground };
