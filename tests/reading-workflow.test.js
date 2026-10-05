'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('../scripts/workflow-host');
const { response } = require('../scripts/fixtures/reading-model-output');
const { parseReport, draftIssue } = require('../extension/report');
const engine = require('../extension/investigation-engine');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
const { relatedCode } = require('../extension/reading-context');
const { prepareInvestigation } = require('../extension/investigation');
const native = process.env.FLOWBOARD_EXTENSION_PATH;

async function client(host) {
  const request = async (route, message) => (await fetch(host.origin + route, { headers: { 'X-Workflow-Token': host.secret, 'Content-Type': 'application/json' }, ...(message ? { method: 'POST', body: JSON.stringify(message) } : {}) })).json();
  const send = message => request('/message', message);
  const wait = async predicate => {
    for (let i = 0; i < 800; i++) { const state = await request('/state'); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Reading fixture did not reach its expected state.');
  };
  await send({ type: 'triage:ready' });
  return { request, send, wait, select: async id => {
    const prior = (await request('/state')).token;
    await send({ type: 'triage:select', issueId: id, token: prior });
    const state = await wait(value => value.lastLoad?.issueId === id && value.token !== prior);
    await send({ type: 'triage:rendered', issueId: id, token: state.token }); return state.lastLoad;
  } };
}
test('whole-report retrieval distinguishes current claims from proposed edits in txt/md fields', () => {
  const report = fs.readFileSync(path.join(__dirname, '../scripts/fixtures/reading-report.md'), 'utf8');
  const parsed = parseReport(report);
  assert.equal(parsed[0].names.length, 0, 'The prose-only finding really has no function names.');
  assert.equal(parsed[0].locations.length, 0);
  assert.match(parsed[0].fields.conditions, /local route/);
  assert.equal(parsed[4].locations.length, 0, 'Proposed source edits are not current-code citations.');
  assert.equal(parsed[4].names.length, 0);
  const plain = parseReport('Issue 1: Plain report\nDescription: A claim.\nConditions: A condition.\nMitigation: Change fake().')[0];
  assert.equal(plain.fields.description, 'A claim.'); assert.equal(plain.fields.conditions, 'A condition.'); assert.equal(plain.names.length, 0);
});
test('ordinary import and selection choose the closure, keep qualified overload identity and expose the guard and shared-data context', { skip: !native }, async t => {
  const host = await start({ reading: true }); t.after(() => host.close());
  const c = await client(host), load = await c.select('I-01');
  const first = load.state.cards[0];
  assert.equal(first.contract, 'ReservationBook'); assert.equal(first.startLine, 14);
  assert.match(first.code, /_settleCredit\(key\);\s+delete holder\[key\];/);
  assert.ok(load.state.cards.every(card => card.contract !== 'Archive' && card.contract !== 'RemoteBook'), 'Other names and routes were not promoted into this local-only report.');
  assert.equal(load.investigation.readingRecommendation.source.line, 14);
  const settlement = load.state.cards.find(card => card.name === '_settleCredit'); assert.ok(settlement);
  assert.ok(load.connections.some(edge => edge.from === first.id && edge.to === settlement.id && edge.kind === 'call'));
  assert.ok(load.investigation.candidates.some(item => item.source.name === 'ReservationBook::onlyHolder' && item.source.line === 9));
  const { runner, result } = await analyze(native, host.root), catalog = new SourceCatalog(host.root, runner, result);
  const context = relatedCode(catalog, [catalog.resolveCard({ file: 'src/ReservationBook.sol', line: 14 })]);
  assert.equal(context.items.find(item => item.fn.name === 'inspectCredit').relationship, 'state-dependency');
  assert.ok(!catalog.callLinks(catalog.named('_settleCredit')[0]).some(site => site.candidates.some(fn => fn.name === 'inspectCredit')), 'Shared data does not become a call.');
  const overloaded = await c.select('I-03');
  assert.equal(overloaded.state.cards[0].contract, 'ReservationBook'); assert.equal(overloaded.state.cards[0].startLine, 20);
  assert.equal(overloaded.hints[overloaded.state.cards[0].id].identity.signature, 'finishReservation(address,uint256)');
  assert.match(overloaded.state.cards[0].code, /holder\[key\] = recipient/);
  const imported = JSON.parse(fs.readFileSync(path.join(host.root, '.flowboard/report.json')));
  assert.equal(imported.issues.find(issue => issue.id === 'I-04').request, null, 'An unqualified same-name overload must not get a guessed board.');
  assert.equal(imported.issues.find(issue => issue.id === 'I-05').request, null);
  const missingSignature = parseReport('I-06: Unavailable closure overload\nDescription: ReservationBook::finishReservation(bytes32,uint256) closes the reservation.')[0];
  const missing = draftIssue(missingSignature, host.root, runner, result, undefined, catalog);
  assert.ok(missing.warnings.some(warning => /No exact definition/.test(warning)));
  assert.ok(!(missing.request?.cards || []).some(card => card.function === 'finishReservation'), 'An unavailable typed overload cannot fall back to a different overload.');
  const oldLocation = structuredClone(imported.issues[0].request);
  oldLocation.cards = [{ id: 'old-location', file: 'src/Archive.sol', line: 5, function: 'finishReservation', mapping: { method: 'citation' } }];
  const prepared = prepareInvestigation(catalog, oldLocation, imported.issues[0]);
  assert.equal(prepared.readingRecommendation.source.file, 'src/ReservationBook.sol');
  assert.equal(prepared.readingRecommendation.source.line, 14);
  assert.ok(prepared.candidates.some(item => item.source.name === 'ReservationBook::_settleCredit'));
  assert.ok(prepared.candidates.some(item => item.source.name === 'ReservationBook::onlyHolder'));
  assert.equal(oldLocation.cards[0].file, 'src/Archive.sol', 'The recommendation does not silently change the saved report location.');
});
test('selection generates and repairs an incorrect real-code explanation, keeps the remote path unresolved, navigates exact lines and reopens', { skip: !native }, async t => {
  const inputs = [], host = await start({ reading: true, provider: 'codex', invoke: async input => { inputs.push(structuredClone(input)); return response(input); } });
  t.after(() => host.close()); const c = await client(host), load = await c.select('I-02');
  const state = await c.wait(value => value.investigation?.phase === 'blocked');
  const draft = state.investigation;
  assert.deepEqual(inputs.map(input => input.phase), ['generate', 'challenge']);
  assert.ok(inputs[0].sources.some(unit => unit.name === 'ReservationBook::onlyHolder' && unit.code.includes('holder only')));
  assert.match(inputs[1].earlierDraft.evidence.find(item => item.id === 'credit-record').explanation, /subtracts/);
  const repaired = draft.evidence.find(item => item.id === 'credit-record');
  assert.match(repaired.note, /adds that amount/); assert.equal(repaired.explanationReview.result, 'repaired');
  assert.equal(repaired.interpretationVerified, false, 'A second model pass is not independent proof.');
  assert.equal(repaired.findingId, 'I-02'); assert.equal(repaired.function.signature, '_settleCredit(uint256)');
  assert.deepEqual(draft.claims.map(claim => [claim.id, claim.status]), [['local-credit', 'contradicted'], ['remote-credit', 'unresolved']]);
  assert.equal(draft.conclusion.status, 'insufficient-evidence');
  assert.ok(inputs[0].codeGaps.some(gap => /keeper.settle/.test(gap)));
  assert.ok(!load.connections.some(edge => edge.kind === 'call' && /keeper/.test(edge.reason)), 'An interface boundary is not a proven implementation.');
  await c.send({ type: 'triage:investigationFocus', issueId: 'I-02', token: state.token, evidenceId: 'credit-record', editor: true });
  const opened = await c.wait(value => value.opened.length === 1);
  assert.equal(opened.opened[0].file, 'src/ReservationBook.sol');
  assert.deepEqual([opened.opened[0].selection.startLine, opened.opened[0].selection.endLine], [24, 26]);
  const record = engine.read(host.root, 'I-02'); assert.equal(record.evidence.find(item => item.id === 'credit-record').note, repaired.note);
  await c.request('/action', { name: 'reopen' }); const reopened = await client(host); await reopened.select('I-02');
  assert.equal(inputs.length, 2, 'Reopening the same finding/source reuses its draft without new AI calls.');
  await reopened.request('/action', { name: 'source-change' });
  const active = await reopened.request('/state');
  await reopened.send({ type: 'triage:investigationFocus', issueId: 'I-02', token: active.token, evidenceId: 'credit-record', editor: true });
  assert.equal((await reopened.request('/state')).opened.length, 1, 'Changed code cannot navigate an old evidence span as current.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(host.root, '.flowboard/findings/I-02.json'))).finding.status, 'unreviewed', 'Generated work never overwrites the researcher result.');
});
test('a challenge cannot silently omit the unresolved implementation or bless a changed note as unchanged', { skip: !native }, async t => {
  let previous, next, units;
  const host = await start({ reading: true, provider: 'codex', invoke: async input => {
    if (input.phase === 'challenge') { previous = input.earlierDraft; const value = response(input).value; value.claims = value.claims.filter(claim => claim.id !== 'remote-credit'); value.evidence = value.evidence.filter(item => item.claimId !== 'remote-credit');
      // Keep the adversarial response internally well-formed so this test
      // isolates challenge scope loss, not an unknown saved-input claim ID.
      for (const review of value.inputReviews) review.claimIds = review.claimIds.filter(id => id !== 'remote-credit');
      return { value, audit: { phase: input.phase, outcome: 'completed' } }; }
    return response(input);
  } }); t.after(() => host.close()); const c = await client(host); await c.select('I-02');
  const state = await c.wait(value => value.investigation?.phase === 'blocked');
  assert.match(state.investigation.error, /omitted statement remote-credit/);
  assert.ok(state.investigation.claims.some(claim => claim.id === 'remote-credit' && claim.status === 'unresolved'));
  units = state.investigation.sources;
  previous = engine.accept(previous, state.investigation, units);
  next = structuredClone(previous); next.evidence[0].note = 'A different explanation.';
  const checks = previous.evidence.map(item => ({ evidenceId: item.id, result: 'kept', reason: 'A test assertion.', checkedSourceIds: [item.sourceId] }));
  assert.throws(() => engine.checkExplanations({ explanationReviews: checks }, previous, next, units), /marked repaired/);
  next = structuredClone(previous); next.evidence[0].source.line += 1;
  assert.throws(() => engine.checkExplanations({ explanationReviews: checks }, previous, next, units), /marked repaired/, 'Even an identical quotation at a different occurrence cannot be called unchanged.');
});
