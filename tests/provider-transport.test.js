'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream'), { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const provider = require('../extension/semantic-provider'), slots = require('../extension/provider-slots'), health = require('../extension/provider-health');
const text = '// café source; \u0431\u044a\u043b\u0433\u0430\u0440\u0441\u043a\u0438; 🧪; 日本語';
const input = { phase: 'generate', finding: { title: 'fictional-transport-check', reportParagraphs: [{ text }] }, sources: [{ code: text }], documentation: [], earlierDraft: { value: 'unchanged' } };
const usage = { input_tokens: 11, output_tokens: 7 };
function wire(value = { text }, mode = 'codex') {
  return Buffer.from(mode === 'codex' ? [ { type: 'thread.started', thread_id: 'fictional-thread' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }, { type: 'turn.completed', usage } ].map(JSON.stringify).join('\n') :
    JSON.stringify({ structured_output: value, usage, total_cost_usd: 0, modelUsage: { 'fixture-not-a-model': {} } }));
}
function fakeProcess({ stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), code = 0, hanging = false, everyByte = false, chunks, inspect } = {}) {
  return (executable, args, options) => {
    inspect?.({ executable, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.stdin.resume(); child.pid = process.pid;
    let closed = false;
    const close = result => { if (!closed) { closed = true; child.emit('close', result); } };
    child.kill = () => { queueMicrotask(() => close(null)); return true; };
    child.stdin.on('finish', () => queueMicrotask(() => {
      child.emit('spawn');
      const emit = (stream, bytes) => { if (everyByte) for (const byte of bytes) stream.write(Buffer.from([byte])); else stream.write(bytes); };
      if (chunks) for (const chunk of chunks) child.stdout.write(chunk); else emit(child.stdout, stdout);
      emit(child.stderr, stderr);
      if (!hanging) close(code);
    }));
    return child;
  };
}
function directory(t) { const result = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-provider-test-')); t.after(() => fs.rmSync(result, { recursive: true, force: true })); return result; }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('the whole request includes metadata, instructions and schema and is bounded before spawning', async () => {
  const measured = provider.requestMetrics(input);
  assert.equal(measured.requestBytes, measured.inputBytes + measured.inputSections.instructions + measured.inputSections.schema + 128);
  assert.match(measured.instructionHash, /^[a-f0-9]{64}$/); assert.match(measured.schemaHash, /^[a-f0-9]{64}$/);
  let spawned = false;
  assert.throws(() => provider.runCodex({ ...input, metadata: 'x'.repeat(provider.MAX_REQUEST_BYTES) }, { spawn: () => { spawned = true; } }), { code: 'LOCAL_PACKET_LIMIT' });
  assert.equal(spawned, false);
});
test('both production CLI adapters preserve every UTF-8 byte boundary and exact JSON content', async () => {
  for (const mode of ['codex', 'claude']) {
    const response = wire({ text }, mode), run = mode === 'codex' ? provider.runCodex : provider.runClaude;
    const result = await run(input, { spawn: fakeProcess({ stdout: response, everyByte: true }), requestId: 'reservation-17',
      capacity: { queuedAt: '2026-01-01T00:00:00.000Z', acquiredAt: '2026-01-01T00:00:00.020Z', waitMs: 20 } });
    assert.equal(result.value.text, text); assert.equal(result.audit.stdoutBytes, response.length); assert.equal(result.audit.requestId, 'reservation-17');
    assert.equal(result.audit.queueWaitMs, 20); assert.equal(result.audit.hostAcceptedAt, null, 'Parsed JSON is not a host-validated explanation.');
    assert.ok(result.audit.processStartedAt && result.audit.firstProviderEventAt && result.audit.firstSubstantiveContentAt && result.audit.finalStructuredContentAt && result.audit.processExitedAt);
    assert.deepEqual(result.audit.usage, usage); assert.equal(result.audit.outcome, 'completed');
    assert.ok(!JSON.stringify(result.audit).includes(text), 'Audit must not contain source, report text or generated commentary.');
  }
});
test('actual fake child CLI exercises stdin, JSON lines, UTF-8 and process exit through each unchanged adapter boundary', async () => {
  for (const mode of ['codex', 'claude']) {
    let original;
    const run = mode === 'codex' ? provider.runCodex : provider.runClaude;
    const result = await run(input, { spawn: (executable, args, settings) => {
      original = { executable, args, settings };
      return spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-cli.js'), mode], settings);
    } });
    assert.equal(result.value.text, '// café source; \u0431\u044a\u043b\u0433\u0430\u0440\u0441\u043a\u0438 🧪'); assert.equal(result.audit.exitCode, 0);
    assert.equal(original.settings.shell, false); assert.equal(original.executable, mode);
    assert.equal(result.audit.effectiveConfiguration.tools, false); assert.equal(result.audit.effectiveConfiguration.requestedModel, null);
    if (mode === 'codex') { assert.ok(original.args.includes('--ignore-user-config')); assert.ok(original.args.includes('model_reasoning_effort="medium"')); assert.ok(!fs.existsSync(original.settings.cwd)); }
    else assert.ok(original.args.includes('--max-budget-usd'));
  }
});
test('explicit schema diagnostic shares the real isolated Codex transport without changing the review schema or sending source', async () => {
  const reviewSchemaBefore = JSON.stringify(provider.schema); let normalArgs, probeArgs, probeDirectory, probeSchema, stdin = '';
  const normalize = args => args.map((value, index) => args[index - 1] === '--output-schema' ? '<schema file>' : value);
  await provider.runCodex(input, { spawn: fakeProcess({ stdout: wire(), inspect: ({ args }) => { normalArgs = normalize(args); } }) });
  const result = await provider.runSchemaProbe({ requestId: 'controlled-probe-only', spawn: (executable, args, settings) => {
    assert.equal(executable, 'codex'); assert.equal(settings.shell, false);
    probeArgs = normalize(args); probeDirectory = settings.cwd;
    probeSchema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/provider-cli.js'), 'probe'], settings), end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (value, ...other) => { stdin = String(value); return end(value, ...other); }; return child;
  } });
  assert.deepEqual(result.value, { ok: true }); assert.deepEqual(probeArgs, normalArgs);
  assert.deepEqual(probeSchema, { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false });
  assert.equal(JSON.stringify(provider.schema), reviewSchemaBefore); assert.ok(provider.schema.properties.claims);
  assert.ok(stdin.includes('Return exactly {"ok":true}')); assert.ok(!stdin.includes(input.finding.title)); assert.ok(!stdin.includes(text));
  assert.equal(result.audit.phase, 'schema-probe'); assert.equal(result.audit.diagnostic, 'schema-probe');
  assert.equal(result.audit.requestId, 'controlled-probe-only'); assert.equal(result.audit.inputSections.source, 0); assert.equal(result.audit.inputSections.report, 0);
  assert.equal(result.audit.effectiveConfiguration.tools, false); assert.equal(result.audit.effectiveConfiguration.reasoningEffort, 'medium');
  assert.equal(result.audit.deadline.milliseconds, 240000); assert.equal(result.audit.hostAcceptedAt, null);
  assert.equal(result.audit.teardown.confirmed, true); assert.equal(fs.existsSync(probeDirectory), false);
});
test('schema diagnostics reject unexpected values and forbidden tool actions without presenting a review result', async () => {
  for (const value of [{ ok: false }, { ok: true, ignored: true }, ['ok'], null]) {
    await assert.rejects(provider.runSchemaProbe({ spawn: fakeProcess({ stdout: wire(value) }) }), error =>
      error.code === 'PROVIDER_DIAGNOSTIC_RESPONSE' && error.audit.failureKind === 'diagnostic-response' && error.audit.diagnostic === 'schema-probe');
  }
  const action = Buffer.from(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }) + '\n');
  await assert.rejects(provider.runSchemaProbe({ spawn: fakeProcess({ stdout: action }) }), error =>
    error.audit.failureKind === 'unsafe-action' && error.audit.diagnostic === 'schema-probe' && error.audit.teardown.confirmed);
});
test('Codex JSON-line boundaries and accented/emoji strings survive every possible two-chunk split', async () => {
  const bytes = wire();
  for (let boundary = 1; boundary < bytes.length; boundary++) {
    const result = await provider.runCodex(input, { spawn: fakeProcess({ chunks: [bytes.subarray(0, boundary), bytes.subarray(boundary)] }) });
    assert.equal(result.value.text, text, `byte boundary ${boundary}`);
  }
});
test('stderr is incrementally decoded on both adapters and byte-accounted without becoming a fake source result', async () => {
  for (const run of [provider.runCodex, provider.runClaude]) {
    const stderr = Buffer.from('Fixture failure: café, \u0433\u0440\u0435\u0448\u043a\u0430 🧪');
    await assert.rejects(run(input, { spawn: fakeProcess({ stderr, everyByte: true, code: 1 }) }), error => {
      assert.equal(error.audit.diagnostics.stderr.messageHash, createHash('sha256').update(stderr).digest('hex'));
      assert.ok(!error.message.includes('café')); assert.equal(error.audit.stderrBytes, stderr.length); assert.equal(error.audit.failureKind, 'provider-exit');
      assert.equal(error.audit.firstSubstantiveContentAt, null); return true;
    });
  }
});
test('limits count actual stdout and stderr bytes, not decoded characters', async () => {
  for (const [mode, run] of [['codex', provider.runCodex], ['claude', provider.runClaude]]) {
    const bytes = wire({ text: 'é'.repeat(40) }, mode), limit = bytes.toString().length + 1;
    assert.ok(bytes.length > limit);
    await assert.rejects(run(input, { outputLimitBytes: limit, spawn: fakeProcess({ stdout: bytes, everyByte: true }) }), error => error.code === 'PROVIDER_OUTPUT_LIMIT' && error.audit.stdoutBytes === limit + 1);
    await assert.rejects(run(input, { outputLimitBytes: 3, spawn: fakeProcess({ stderr: Buffer.from('éé'), everyByte: true }) }), error => error.audit.stderrBytes === 4 && error.audit.failureKind === 'output-limit');
  }
});
test('incomplete UTF-8, malformed structured output and non-text actions have distinct safe failures', async () => {
  await assert.rejects(provider.runCodex(input, { spawn: fakeProcess({ stdout: Buffer.from([0xC3]) }) }), error => error.audit.failureKind === 'transport');
  const events = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{not json' } }) + '\n' + JSON.stringify({ type: 'turn.completed', usage }));
  await assert.rejects(provider.runCodex(input, { spawn: fakeProcess({ stdout: events }) }), error => error.audit.failureKind === 'parse' && error.audit.finalStructuredContentAt === null);
  const nonText = Buffer.from(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'not executed by this fixture' } }));
  await assert.rejects(provider.runCodex(input, { spawn: fakeProcess({ stdout: nonText }) }), error => error.audit.failureKind === 'unsafe-action' && error.audit.toolEvents === 1);
});
test('a live process/event without substantive content records a deadline, not fake semantic progress', async () => {
  const events = [], out = Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 'not-a-result' }) + '\n');
  await assert.rejects(provider.runCodex(input, { timeoutMs: 20, spawn: fakeProcess({ stdout: out, hanging: true }), onProgress: event => events.push(event) }), error => {
    assert.equal(error.code, 'PROVIDER_TIMEOUT'); assert.equal(error.audit.failureKind, 'timeout'); assert.ok(error.audit.firstProviderEventAt);
    assert.equal(error.audit.firstSubstantiveContentAt, null); assert.equal(error.audit.finalStructuredContentAt, null);
    assert.equal(error.audit.diagnostics.timeoutContext, 'silent-deadline'); assert.equal(error.audit.diagnostics.reportedErrors, 0);
    assert.equal(error.audit.stdoutBytes, out.length); assert.ok(error.audit.timings.wallMs >= 15); return true;
  });
  assert.ok(events.length >= 2); assert.ok(events.every(event => event.useful === false));
});
test('a terminal provider failure ends a still-live process without waiting for the full deadline', async () => {
  const events = Buffer.from(JSON.stringify({ type: 'turn.failed', error: { message: 'Controlled unavailable provider.' } }) + '\n');
  await assert.rejects(provider.runCodex(input, { timeoutMs: 3000, spawn: fakeProcess({ stdout: events, hanging: true }) }), error => {
    assert.equal(error.audit.failureKind, 'provider-exit'); assert.match(error.message, /Codex reported an error/);
    assert.ok(error.audit.durationMs < 1000); assert.equal(error.audit.finalReceived, false); return true;
  });
});
test('a reported connection error followed by a stall survives the deadline as safe diagnostics', async () => {
  const privateText = 'PRIVATE source f("sensitive"); Bearer sk-do-not-persist-this';
  const events = [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'error', retryable: true,
    error: { code: 'connection_error', message: `Reconnecting after a connection failure. ${privateText}` } }, { type: 'turn.started' }];
  await assert.rejects(provider.runCodex(input, { timeoutMs: 20,
    spawn: fakeProcess({ stdout: Buffer.from(events.map(JSON.stringify).join('\n') + '\n'), stderr: Buffer.from(`network timeout ${privateText}`), hanging: true }) }), error => {
    assert.equal(error.audit.failureKind, 'timeout');
    const diagnostic = error.audit.diagnostics;
    assert.equal(diagnostic.timeoutContext, 'provider-reported-error'); assert.equal(diagnostic.reportedErrors, 1);
    assert.equal(diagnostic.lastReportedError.category, 'connection'); assert.equal(diagnostic.lastReportedError.code, 'connection_error');
    assert.equal(diagnostic.lastReportedError.retrying, true);
    assert.deepEqual(diagnostic.events.map(event => event.type), events.map(event => event.type));
    assert.ok(diagnostic.events.every(event => event.at && Number.isFinite(event.elapsedMs)));
    assert.equal(diagnostic.stderr.category, 'connection'); assert.ok(diagnostic.stderr.messageHash);
    assert.ok(!JSON.stringify({ audit: error.audit, message: error.message }).includes(privateText));
    assert.match(error.message, /reported a connection problem/); return true;
  });
});
test('a reconnecting provider error does not reject a later completed result', async () => {
  const retry = JSON.stringify({ type: 'error', message: 'Reconnecting after connection loss', code: 'stream_disconnected' }) + '\n';
  const result = await provider.runCodex(input, { spawn: fakeProcess({ stdout: Buffer.concat([Buffer.from(retry), wire(), Buffer.from('\n')]) }) });
  assert.equal(result.value.text, text); assert.equal(result.audit.outcome, 'completed');
  assert.equal(result.audit.diagnostics.reportedErrors, 1); assert.equal(result.audit.diagnostics.lastReportedError.retrying, true);
});
test('disabled code-mode host notice is classified without rejecting a successful text-only response', async () => {
  const message = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
  const notice = JSON.stringify({ type: 'item.completed', item: { type: 'error', message } }) + '\n';
  const result = await provider.runCodex(input, { spawn: fakeProcess({ stdout: Buffer.concat([Buffer.from(notice), wire(), Buffer.from('\n')]) }) });
  assert.equal(result.value.text, text); assert.equal(result.audit.outcome, 'completed'); assert.equal(result.audit.failureKind, null);
  assert.equal(result.audit.diagnostics.lastReportedError.category, 'disabled-tool-host');
  assert.equal(result.audit.diagnostics.lastReportedError.terminal, false); assert.equal(result.audit.toolEvents, 0);
  assert.ok(!JSON.stringify(result.audit).includes(message), 'A safe diagnostic category must not store raw CLI messages.');
});
test('an error item retains its item kind and safe cause when no terminal event arrives', async () => {
  const event = { type: 'item.completed', item: { type: 'error', code: 'invalid_api_key', message: 'Authentication failed: secret credential value' } };
  await assert.rejects(provider.runCodex(input, { timeoutMs: 20, spawn: fakeProcess({ stdout: Buffer.from(JSON.stringify(event) + '\n'), hanging: true }) }), error => {
    assert.equal(error.audit.diagnostics.events[0].itemKind, 'error');
    assert.equal(error.audit.diagnostics.lastReportedError.category, 'authentication');
    assert.equal(error.audit.diagnostics.timeoutContext, 'provider-reported-error');
    assert.ok(!JSON.stringify({ message: error.message, audit: error.audit }).includes('secret credential')); return true;
  });
});
test('terminal turn failure preserves the specific safe cause instead of a preceding retry notice', async () => {
  const rows = [{ type: 'error', message: 'Reconnecting', code: 'stream_disconnected' },
    { type: 'turn.failed', error: { code: 'context_length_exceeded', message: 'Context length exceeded: PRIVATE report text and sk-sensitive-value' } }];
  await assert.rejects(provider.runCodex(input, { timeoutMs: 3000, spawn: fakeProcess({ stdout: Buffer.from(rows.map(JSON.stringify).join('\n') + '\n'), hanging: true }) }), error => {
    assert.equal(error.audit.failureKind, 'provider-exit'); assert.ok(error.audit.durationMs < 1000);
    assert.equal(error.audit.diagnostics.lastReportedError.code, 'context_length_exceeded');
    assert.equal(error.audit.diagnostics.lastReportedError.category, 'context-limit');
    assert.equal(error.audit.diagnostics.lastReportedError.terminal, true);
    assert.ok(!JSON.stringify({ audit: error.audit, message: error.message }).includes('PRIVATE report')); return true;
  });
});
test('provider timelines are bounded and do not copy arbitrary event identifiers, codes or message text', async () => {
  const rows = Array.from({ length: 90 }, (_, index) => ({ type: 'warning', message: `PRIVATE warning ${index}` }));
  rows.push({ type: 'PRIVATE_EVENT', code: 'PRIVATE_CODE', message: 'PRIVATE message' });
  const output = Buffer.concat([Buffer.from(rows.map(JSON.stringify).join('\n') + '\n'), wire(), Buffer.from('\n')]);
  const result = await provider.runCodex(input, { spawn: fakeProcess({ stdout: output }) });
  assert.equal(result.audit.diagnostics.events.length, 64); assert.equal(result.audit.diagnostics.droppedEvents, rows.length + 3 - 64);
  assert.equal(result.audit.diagnostics.events[0].type, 'warning');
  assert.equal(result.audit.diagnostics.events.at(-1).type, 'turn.completed');
  assert.ok(result.audit.diagnostics.events.some(event => event.type === 'other'));
  assert.ok(!JSON.stringify(result.audit).includes('PRIVATE'));
});
test('cancellation before dispatch and during transport is distinct from a provider failure', async () => {
  const controller = new AbortController(); controller.abort(); let spawned = false;
  await assert.rejects(provider.runCodex(input, { signal: controller.signal, spawn: () => { spawned = true; } }), error => error.code === 'INVESTIGATION_SUPERSEDED');
  assert.equal(spawned, false);
  const live = new AbortController(), request = provider.runCodex(input, { signal: live.signal, spawn: fakeProcess({ hanging: true }) });
  live.abort(); await assert.rejects(request, error => error.audit.failureKind === 'cancelled' && error.audit.cancellationReason === 'investigation-context-changed');
});
test('request metrics include instructions/schema separately and distinguish payload sections without copying their text', () => {
  const metrics = provider.requestMetrics(input), { instructions, schema, ...sections } = metrics.inputSections;
  assert.equal(Object.values(sections).reduce((sum, size) => sum + size, 0), Buffer.byteLength(JSON.stringify(input)));
  assert.equal(instructions, Buffer.byteLength(metrics.system)); assert.equal(schema, Buffer.byteLength(metrics.encodedSchema));
  assert.ok(sections.report && sections.source && sections.previousDraft && sections.metadata && sections.envelope);
  const second = provider.requestMetrics({ ...input, finding: { title: 'Another statement using the same code' } });
  assert.equal(metrics.sourcePacketHash, second.sourcePacketHash); assert.notEqual(metrics.inputHash, second.inputHash);
});
test('capacity waits fairly across the old short test threshold then continues once without a manual resume', async t => {
  const root = directory(t), first = await slots.acquire('codex', null, { directory: root }), second = await slots.acquire('codex', null, { directory: root });
  t.after(() => { first(); second(); }); const events = [], order = [];
  const a = slots.acquire('codex', null, { directory: root, pollMs: 5, onProgress: event => events.push(event) }).then(release => { order.push('a'); return release; });
  await pause(5);
  const b = slots.acquire('codex', null, { directory: root, pollMs: 5 }).then(release => { order.push('b'); return release; });
  await pause(160); assert.deepEqual(order, []); assert.equal(events[0].event, 'provider.capacity.waiting');
  first(); const releaseA = await a; assert.deepEqual(order, ['a']); assert.ok(releaseA.capacity.waitMs >= 150);
  releaseA(); const releaseB = await b; releaseB(); second();
  assert.deepEqual(order, ['a', 'b']); assert.equal(events.filter(event => event.event === 'provider.capacity.acquired').length, 1);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('capacity cancellation removes its ticket and explicit expiry remains a retryable no-request state', async t => {
  const root = directory(t), one = await slots.acquire('claude', null, { directory: root }), two = await slots.acquire('claude', null, { directory: root });
  t.after(() => { one(); two(); });
  const controller = new AbortController(), request = slots.acquire('claude', controller.signal, { directory: root, pollMs: 5 });
  controller.abort(); await assert.rejects(request, error => error.code === 'INVESTIGATION_SUPERSEDED');
  await assert.rejects(slots.acquire('claude', null, { directory: root, timeoutMs: 20, pollMs: 5 }), error => error.code === 'PROVIDER_CAPACITY' && error.retryable);
  assert.equal(fs.readdirSync(root).length, 2); one(); two();
});
test('shared health stops repeated equivalent transport failures, not source/schema outcomes or one timeout', async t => {
  const directoryPath = directory(t), options = { directory: directoryPath }, at = new Date().toISOString();
  await health.record('codex', { outcome: 'failed', failureKind: 'parse', requestId: 'invalid-json' }, options);
  await health.record('codex', { outcome: 'failed', failureKind: 'cancelled', requestId: 'cancelled' }, options);
  assert.equal(health.check('codex', options).failures.length, 0);
  await health.record('codex', { outcome: 'failed', failureKind: 'timeout', requestId: 'request-a', finishedAt: at }, options);
  assert.equal(health.check('codex', options).open, false);
  await health.record('codex', { outcome: 'failed', failureKind: 'timeout', requestId: 'request-b', finishedAt: at }, options);
  assert.throws(() => health.check('codex', options), error => error.code === 'PROVIDER_HEALTH_OPEN' && error.providerHealth.reason === 'timeout');
  assert.equal(health.check('claude', options).open, false, 'Separate providers do not inherit the same transport stop.');
  await health.record('codex', { outcome: 'completed', requestId: 'late-peer', finishedAt: at }, options);
  assert.equal(health.status('codex', options).open, true, 'A late successful peer cannot silently restart queued paid work.');
  await health.reset('codex', options); assert.equal(health.check('codex', options).open, false);
});
test('simultaneous health receipts are serialized and do not lose a failure or count a receipt twice', async t => {
  const options = { directory: directory(t) }, at = new Date().toISOString();
  const receipts = ['a', 'b'].map(requestId => ({ requestId, outcome: 'failed', failureKind: 'timeout', finishedAt: at }));
  await Promise.all(receipts.map(audit => health.record('codex', audit, options)));
  assert.equal(health.status('codex', options).failures.length, 2); assert.equal(health.status('codex', options).open, true);
  await health.record('codex', receipts[1], options); assert.equal(health.status('codex', options).failures.length, 2);
});
