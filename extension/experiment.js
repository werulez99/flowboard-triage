'use strict';
// Execute an EXISTING, explicitly selected local regression test. No generated
// code, model-authored command, arbitrary arguments or automatic exploit tests.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
function command(unit) {
  const name = unit?.name?.split('::').pop();
  if (unit?.kind !== 'test-source' || !/^test[\w$]*$/.test(name || '') || !/^(?:test|tests)\/[\w./-]+\.t\.sol$/.test(unit.source.file) || unit.source.file.split('/').includes('..')) throw new Error('Only an indexed, existing test function can be selected.');
  return ['test', '--offline', '--json', '--match-path', unit.source.file, '--match-test', `^${name.replace(/\$/g, '\\$')}\\(`];
}
function classify(stdout, stderr, code) {
  const output = stdout + '\n' + stderr;
  let json;
  try { json = JSON.parse(stdout); } catch { /* compile/runtime diagnostic */ }
  const tests = [];
  if (json && typeof json === 'object') for (const [suite, value] of Object.entries(json)) for (const [name, result] of Object.entries(value?.test_results || {})) {
    tests.push({ suite, name, status: result.status, reason: String(result.reason || '').slice(0, 1000), gas: result.kind?.Unit?.gas ?? result.kind?.gas ?? result.gas ?? null,
      logs: Array.isArray(result.decoded_logs) ? result.decoded_logs.slice(0, 20).map(line => String(line).slice(0, 500)) : [] });
  }
  let outcome;
  if (!tests.length && /Compiler run failed|compilation failed|Error \(\d+\)|error:.*(?:unresolved|failed to resolve|solc)/i.test(output)) outcome = 'compilation-failure';
  else if (!tests.length) outcome = /No tests found|no tests match/i.test(output) || code === 0 ? 'no-tests-executed' : 'tool-failure';
  else if (tests.some(test => /setUp/.test(test.name))) outcome = 'setup-failure';
  else if (tests.every(test => test.status === 'Skipped')) outcome = 'skipped';
  else if (tests.every(test => test.status === 'Success') && code === 0) outcome = 'passed';
  else outcome = 'test-failed';
  return { outcome, exitCode: code, tests, diagnostic: output.slice(-12000),
    interpretation: outcome === 'passed' ? 'Existing test assertions passed in their setup. Inspect assertions and any conditional skipping; this is not a finding-level verdict.' : 'No property violation is inferred from a tool, compilation, setup, skipped, or assertion failure. Inspect the diagnostic and test source.' };
}
function run(unit, { root, snapshot, claimId, signal, timeoutMs = 240000, executable = 'forge' }) {
  const args = command(unit), startedAt = new Date().toISOString();
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORK_CHAINS: 'none', LOCAL_SHAPES: 'A', FOUNDRY_FFI: 'false', FOUNDRY_ETH_RPC_URL: '', ETH_RPC_URL: '' } });
    let stdout = '', stderr = '', stopped = null, done = false, force;
    const stop = reason => { stopped ||= reason; child.kill('SIGTERM'); force ||= setTimeout(() => child.kill('SIGKILL'), 2000); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const cancel = () => stop('cancelled'); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const finish = code => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', cancel);
      const result = classify(stdout, stderr, code); if (stopped) result.outcome = stopped;
      resolve({ id: `experiment-${crypto.randomUUID()}`, claimId: claimId || null, sourceId: unit.id, source: unit.source,
        origin: 'executed-observation', snapshot, command: ['forge', ...args],
        environment: { FORK_CHAINS: 'none', LOCAL_SHAPES: 'A', FOUNDRY_FFI: 'false' },
        startedAt, finishedAt: new Date().toISOString(), ...result,
        limits: ['Uses the repository test framework and its setup/mocks; not a sandbox.', 'Offline prevents compiler downloads, not arbitrary network use by test code.', 'Passing a conditionally skipped branch is not coverage; inspect the test modifier and assertions.'] });
    };
    child.on('error', error => { stderr += error.message; finish(null); });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) stop('output-limit'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 100000) stop('output-limit'); });
    child.on('close', finish);
  });
}
module.exports = { command, classify, run };
