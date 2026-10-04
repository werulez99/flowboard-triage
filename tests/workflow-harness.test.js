'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('../scripts/workflow-host');
const protocol = require('../extension/protocol');

test('fictional response playback preserves exact source links inside targeted repairs without rewriting quotes', () => {
  const { translateRecordedResponse } = require('../scripts/workflow-host');
  const original = { mode: 'review-patch-v1', updates: [{ path: '/evidence/e5', valueJSON: JSON.stringify({ sourceId: 'old-unit', quote: 'The string old-unit is unchanged.', line: 7 }) }],
    explanationReviews: [{ checkedSources: ['old-unit'] }] };
  const result = translateRecordedResponse(original, new Map([['old-unit', 'current-unit']]));
  assert.deepEqual(JSON.parse(result.updates[0].valueJSON), { sourceId: 'current-unit', quote: 'The string old-unit is unchanged.', line: 7 });
  assert.deepEqual(result.explanationReviews[0].checkedSources, ['current-unit']);
  assert.equal(JSON.parse(original.updates[0].valueJSON).sourceId, 'old-unit');
  assert.throws(() => translateRecordedResponse({ mode: 'review-patch-v1', updates: [{ path: '/evidence/e5', valueJSON: '{bad JSON' }] }, new Map()));
});

async function client(host) {
  const request = async (route, message) => {
    const result = await fetch(host.origin + route, { headers: { 'X-Workflow-Token': host.secret, 'Content-Type': 'application/json' },
      ...(message ? { method: 'POST', body: JSON.stringify(message) } : {}) });
    return { status: result.status, value: await result.json() };
  };
  const send = message => request('/message', message);
  const waitFor = async predicate => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const value = (await request('/state')).value;
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Integration state did not arrive.');
  };
  await send({ type: 'triage:ready' });
  return { request, send, waitFor, open: async id => {
    const prior = (await request('/state')).value.token;
    await send({ type: 'triage:select', issueId: id, token: prior });
    const state = await waitFor(value => value.lastLoad?.issueId === id && value.lastLoad.token !== prior);
    await send({ type: 'triage:rendered', issueId: id, token: state.lastLoad.token });
    return state.lastLoad;
  } };
}

test('normal importer and native controller roundtrip preserve finding-scoped snapshots', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  const host = await start();
  t.after(() => host.close());
  const { request, send, open, waitFor } = await client(host);
  const library = (await request('/state')).value.library;
  assert.deepEqual(library.map(issue => issue.id), ['I-01', 'I-02']);
  const first = await open('I-01');
  assert.equal(first.state.cards.length, 2);
  assert.equal(first.validation.semanticVerified, false);
  assert.match(first.state.cards[1].code, /counter \+= amount/);
  const source = first.state.cards[0];
  await send({ type: 'openFile', issueId: first.issueId, token: first.token, fsPath: source.fsPath, startLine: source.startLine });
  const opened = await waitFor(value => value.opened.length === 1);
  assert.equal(opened.opened[0].selection.startLine, source.startLine - 1);
  const snapshot = structuredClone(first.state);
  snapshot.cards[0].x = 417;
  snapshot.view = { version: 1, selectedCard: source.id, drawerTab: 'brief' };
  await send({ type: 'triage:persist', issueId: first.issueId, token: first.token, state: snapshot });
  await waitFor(value => value.snapshots['I-01']?.state.cards[0].x === 417);
  const second = await open('I-02');
  assert.equal((await request('/state')).value.panelTitle, 'Flowboard Triage — I-02');
  assert.deepEqual(second.state.cards.map(card => card.name).sort(), ['_add', 'increment'], 'The cited helper includes its real caller, not only the report line.');
  assert.notEqual(second.state.cards[0].id, first.state.cards[0].id);
  const current = await open('I-01');
  assert.equal((await request('/state')).value.panelTitle, 'Flowboard Triage — I-01');
  assert.equal(current.state.cards[0].x, 417);
  assert.equal(current.state.view.selectedCard, source.id);
  const count = (await request('/state')).value.opened.length;
  await send({ type: 'openFile', issueId: 'I-02', token: second.token, fsPath: source.fsPath, startLine: source.startLine });
  assert.equal((await request('/state')).value.opened.length, count, 'Old native source callbacks cannot navigate after switching.');
  await request('/action', { name: 'source-change' });
  await send({ type: 'openFile', issueId: current.issueId, token: current.token, fsPath: source.fsPath, startLine: source.startLine });
  assert.equal((await request('/state')).value.opened.length, count, 'Changed source disables stale native navigation.');
  const anonymous = await fetch(host.origin + '/state');
  assert.equal(anonymous.status, 403, 'Editor bridge state is not an unauthenticated localhost API.');
  assert.equal((await fetch(host.origin + '/assets/../../package.json')).status, 403);
});

test('normal finding selection with an unavailable inherited guard opens an honest gap, not the undefined to exception', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  const os = require('node:os'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-missing-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/Partial.sol'), 'pragma solidity ^0.8.20;\ncontract Partial is MissingBase {\n function act() external onlyMember { }\n}\n');
  const report = path.join(root, 'report.md'); fs.writeFileSync(report, '## I-01: Partial.act caller check\n**Location**: src/Partial.sol:L3\n\nCheck its unavailable inherited guard.');
  const host = await start({workspace:root,report}); t.after(() => host.close());
  const {open, request} = await client(host), loaded = await open('I-01');
  assert.equal(loaded.state.cards[0].name, 'act');
  assert.match(loaded.investigation.missing.join(' '), /onlyMember/);
  const state = (await request('/state')).value;
  assert.deepEqual(state.errors, []); assert.equal(state.panelTitle, 'Flowboard Triage — I-01');
});

test('external workspace integration mode never writes review or canvas state into the workspace', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  const fixture = await start();
  const fixtureClient = await client(fixture);
  await fixtureClient.open('I-01');
  const before = fs.readFileSync(path.join(fixture.root, '.flowboard/findings/I-01.json'), 'utf8');
  const external = await start({ workspace: fixture.root });
  t.after(async () => { await external.close(); await fixture.close(); });
  const { request, send, open, waitFor } = await client(external);
  const load = await open('I-01');
  await send({ type: 'triage:persist', issueId: load.issueId, token: load.token, state: load.state });
  await waitFor(value => value.snapshots['I-01']);
  assert.equal(fs.existsSync(path.join(fixture.root, '.flowboard/boards/I-01.json')), false);
  const forbidden = await send({ type: 'triage:save', issueId: load.issueId, token: load.token, patch: { status: 'confirmed' } });
  assert.equal(forbidden.status, 400);
  assert.match(forbidden.value.error, /Read-only workspace/);
  assert.equal((await request('/action', { name: 'source-change' })).status, 400);
  assert.equal(fs.readFileSync(path.join(fixture.root, '.flowboard/findings/I-01.json'), 'utf8'), before);
});

test('a legacy report draft without findingId retains the selected library identity', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  const host = await start();
  t.after(() => host.close());
  const relative = '.flowboard/findings/I-01.json';
  const legacy = protocol.readWorkspaceJson(host.root, relative);
  delete legacy.findingId;
  protocol.atomicJson(host.root, relative, legacy);
  const { open } = await client(host);
  const load = await open('I-01');
  assert.equal(load.issueId, 'I-01');
  assert.ok(load.state.cards.every(card => card.id.startsWith('finding:I-01:')));
});

test('normal selection invokes generation and cancels superseded work without leaking its evidence to another finding', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  // Controlled provider boundary only. Importer, selection, controller, model,
  // source checks, persistence and render acknowledgement are the real modules.
  const engine = require(path.join(process.env.FLOWBOARD_TRIAGE_EXTENSION_PATH || path.resolve(__dirname, '../extension'), 'investigation-engine'));
  const original = engine.advance, pending = [];
  const result = input => {
    const unit = input.sources[0], id = input.finding.id;
    return { value: { property: { text: 'The intended specification remains unavailable.', basis: 'unresolved', evidence: [] },
      claims: [{ id, allegation: 'Inspect the reported ordinary behavior.', actor: 'Unresolved', entry: unit.id, implementation: unit.name,
        conditions: ['No deployment assumptions established.'], requiredFacts: [], supportsIf: 'A supplied specification.', contradictsIf: 'A contrary specification.',
        status: 'unresolved', reason: 'This controlled workflow fixture makes no semantic assessment.', evidence: [], unknowns: ['Specification unavailable.'], nextQuestion: 'Obtain the intended rule.' }],
      evidence: [], transitions: [], questions: [], conclusion: { status: 'insufficient-evidence', text: 'Unresolved controlled fixture.', limitations: ['Not a real provider result.'] } },
      audit: { phase: input.phase, provider: 'controlled-test-fixture', outcome: 'completed' } };
  };
  engine.advance = options => original({ ...options, invoke: (input, config) => new Promise(resolve => pending.push({ input, signal: config.signal, release: () => resolve(result(input)) })) });
  t.after(() => { engine.advance = original; for (const job of pending) job.release(); });
  const host = await start({ provider: 'codex' }); t.after(() => host.close());
  const { open, waitFor, request } = await client(host);
  await open('I-01'); await waitFor(() => pending.length === 1);
  assert.equal(pending[0].input.finding.id, 'I-01');
  await open('I-02'); await waitFor(() => pending.length === 2);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].release(); pending[1].release();
  await waitFor(() => pending.length === 3);
  assert.equal(pending[2].input.phase, 'challenge'); assert.equal(pending[2].input.finding.id, 'I-02');
  pending[2].release();
  const completed = await waitFor(value => value.investigation?.phase === 'blocked');
  assert.equal(completed.activeId, 'I-02'); assert.equal(completed.investigation.claims[0].id, 'I-02');
  assert.equal(engine.read(host.root, 'I-01').claims.length, 0, 'Cancelled result did not overwrite its prior partial draft.');
  const events = (await request('/events')).value.messages.filter(event => event.type === 'triage:investigation' && event.draft.phase === 'blocked');
  assert.deepEqual(events.map(event => event.issueId), ['I-02']);
  assert.ok(events.every(event => !event.draft.claims.length && !event.draft.evidence.length), 'Partial generated explanations never reach another UI surface.');
  await request('/action', { name: 'reopen' });
  const reopenedClient = await client(host);
  await reopenedClient.open('I-02');
  assert.equal(pending.length, 3, 'A matching completed investigation reopens without a new provider call.');
});
