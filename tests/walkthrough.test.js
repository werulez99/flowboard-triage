'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const walk = require('../extension/webview/walkthrough-model');
const docs = require('../extension/local-documentation');
const engine = require('../extension/investigation-engine');
const store = require('../extension/store');
const { start } = require('../scripts/workflow-host');
const { response } = require('../scripts/fixtures/reading-model-output');

// Independently read fictional ReviewQueue: line 17 applies onlyReviewer,
// line 18 writes the flag, line 19 reverts on rejection. A source reference to
// line 18 alone cannot establish a committed true value after a rejected call.
// These manually supplied interpretations are fixtures, NOT real AI results.
function fixture() {
  const code = fs.readFileSync(path.join(__dirname, '../scripts/fixtures/quality-cases/d3/project/src/ReviewQueue.sol'), 'utf8');
  const source = { file: 'src/ReviewQueue.sol', line: 17, endLine: 20, sourceHash: engine.hash(code) };
  const unit = { id: 'entry', name: 'ReviewQueue::finalize', source, code: code.split('\n').slice(16, 20).join('\n'), complete: true };
  const evidence = [17, 18, 19].map((line, i) => ({ id: `e-${i}`, findingId: 'I-01', claimId: 'c-1', sourceId: 'entry', source: { ...source, line, endLine: line },
    quote: code.split('\n')[line - 1], stance: i === 1 ? 'context' : 'contradicts', note: ['The entry applies onlyReviewer.', 'This writes the flag within the call, not its final outcome.', 'A false accepted value reverts the call, undoing its writes.'][i], explanationReview: { result: 'kept' } }));
  const report = 'Description: A rejected call leaves the flag true.\n\nConditions: accepted is false.';
  const paragraphs = walk.paragraphs(report);
  return { report, draft: { findingId: 'I-01', phase: 'ready', revision: 2, snapshot: { sourceDigest: engine.hash(code), reportHash: engine.hash(report) },
    publication: { ready: true, policy: 'checked-explanation-v3' },
    causal: { scope: 'Fictional finalize rejection only.', summary: 'Rejection rolls back the write.',
      events: evidence.map((entry, i) => ({ id: 'event-' + i, invocationId: 'finalize-call', claimId: 'c-1', evidenceId: entry.id,
        title: entry.note, what: entry.note, paragraphId: paragraphs[0].id, phrase: 'leaves the flag true' })),
      order: evidence.map((entry, i) => 'event-' + i), relationships: [] },
    property: { text: 'A reverted call must not persist its writes.', basis: 'report-assumption', evidence: [] }, sources: [unit], evidence, transitions: [],
    claims: [{ id: 'c-1', entry: 'entry', allegation: 'A rejected call leaves the flag true.', status: 'contradicted', unknowns: [] }],
    conclusion: { text: 'The guarded call reverts on rejection.', limitations: [] },
    walkthrough: { steps: evidence.map(item => ({ evidenceId: item.id, title: item.note, paragraphId: paragraphs[0].id, phrase: 'leaves the flag true' })),
      assessment: { result: 'invalid', why: 'Rejection rolls back the assignment in this implementation.', supportingEvidence: '', opposingEvidence: 'e-2' } } } };
}
test('guided reading keeps multiple exact spans in one function and counterevidence before conclusion', () => {
  const { report, draft } = fixture(), route = walk.build(draft, report);
  assert.deepEqual(route.steps.map(step => step.evidence?.source.line).filter(Boolean), [17, 18, 19]);
  assert.equal(route.steps[1].evidence.stance, 'context');
  assert.equal(route.steps[2].evidence.stance, 'contradicts');
  assert.equal(route.steps.at(-1).evidence.id, 'e-2', 'The last checked event stays beside its decisive code.');
  assert.equal(new Set(route.steps.filter(step => step.unit).map(step => step.unit.id)).size, 1);
  assert.equal(walk.assessment(draft).label, 'Appears invalid');
  assert.equal(walk.assessment(draft).contradicts.id, 'e-2');
  assert.deepEqual(draft.evidence.map(item => item.interpretationVerified), [undefined, undefined, undefined]);
});
test('report links preserve original offsets, CRLF and quotations; repeated phrases do not get guessed', () => {
  const report = '**Description**\r\nThe value is cleared. The value is cleared.\r\n\r\nExpected: retain it.';
  const paragraph = walk.paragraphs(report)[0];
  assert.equal(report.slice(paragraph.start, paragraph.end), paragraph.text);
  assert.equal(walk.reportLink(report, { paragraphId: paragraph.id, phrase: 'The value is cleared.' }).phraseStart, null);
  assert.equal(walk.reportLink(report, { paragraphId: 'missing', phrase: 'retain it' }), null);
  assert.equal(walk.reportLink(report, { paragraphId: paragraph.id, phrase: 'invented' }).text, paragraph.text);
  const { draft, report: original } = fixture();
  assert.notEqual(walk.build(draft, original).steps[0].report, null);
  assert.equal(walk.build(draft, 'Changed report').steps[0].report, null);
  draft.walkthrough.reportText = original;
  assert.equal(walk.build(draft, 'Changed report'), null, 'New walkthroughs invalidate the complete presentation when report text changes.');
});
test('the active guided function retains comments, blank lines and repeated statements at original coordinates', () => {
  const code = 'function f() {\r\n  string memory s = "// not a comment";\r\n  /* keep this\r\n     call(fake); */ counter++;\r\n\r\n  counter++; // repeat\r\n}';
  const lines = walk.originalLines(code);
  assert.deepEqual(lines.map(parts => parts.map(part => part.text).join('')), code.replaceAll('\r\n', '\n').split('\n'));
  assert.equal(lines[1].some(part => part.comment), false);
  assert.deepEqual(lines[3].map(part => [part.comment, part.text]), [[true, '     call(fake); */'], [false, ' counter++;']]);
  assert.equal(lines[5].at(-1).comment, true);
});
test('unchecked notes, changed quotes and changed hashes do not become walkthrough steps', () => {
  const { draft, report } = fixture();
  delete draft.evidence[0].explanationReview;
  draft.evidence[1].quote = 'finished[key] = false;';
  draft.evidence[2].source.sourceHash = 'b'.repeat(64);
  assert.equal(walk.build(draft, report), null, 'An incomplete route is withheld as a whole.');
  assert.equal(walk.assessment(draft, true).result, 'unavailable');
});
test('scoped contradictions and supported normal behavior do not automatically judge the whole issue', () => {
  const { draft } = fixture();
  draft.claims.push({ id: 'remote', status: 'unresolved', unknowns: ['The external implementation is unavailable.'] });
  assert.equal(walk.assessment(draft).result, 'unclear');
  assert.match(walk.assessment(draft).remaining.join(' '), /external implementation/);
  draft.claims.pop(); draft.walkthrough.assessment.result = 'valid'; draft.evidence[1].stance = 'supports';
  assert.equal(walk.assessment(draft).result, 'unclear', 'A report-assumed rule is not independently established.');
  delete draft.walkthrough;
  assert.equal(walk.assessment(draft).result, 'unclear', 'Old scoped results do not become a whole-issue verdict.');
  for (const phase of ['generating', 'blocked', 'provider-required', 'corrected']) {
    draft.phase = phase; assert.equal(walk.assessment(draft).result, 'unavailable');
  }
});
test('shared data and unresolved relationships never turn into execution arrows', () => {
  const a = { unit: { id: 'a', name: 'Local::close' } }, b = { unit: { id: 'b', name: 'Local::read' } }, cardFor = unit => unit.id;
  assert.match(walk.relationship(a, b, [{ from: 'a', to: 'b', kind: 'state-dependency' }], cardFor), /Shared data, not a call/);
  assert.match(walk.relationship(a, b, [], cardFor), /has not been established/);
  assert.match(walk.relationship(a, b, [{ from: 'b', to: 'a', kind: 'call' }], cardFor), /Local::read → Local::close/);
});
test('local rule lookup is bounded, source-hashed and excludes reports, instructions and symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-docs-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/rules.md'), 'The owner points must be retained when a record is removed.');
  fs.writeFileSync(path.join(root, 'docs/AGENTS.md'), 'owner points attacker instructions');
  fs.writeFileSync(path.join(root, 'report.md'), 'owner points alleged loss');
  fs.symlinkSync('/etc/passwd', path.join(root, 'docs/external.md'));
  const found = docs.inspect(root, 'owner points retention');
  assert.equal(found.excerpts.length, 1); assert.equal(found.excerpts[0].source.file, 'docs/rules.md');
  assert.equal(found.excerpts[0].source.sourceHash, engine.hash(found.excerpts[0].text));
  fs.appendFileSync(path.join(root, 'docs/rules.md'), '\nChanged rule.');
  assert.notEqual(docs.inspect(root, 'owner points').digest, found.digest);
});
test('saved tutorial rejects malformed positions without changing stored researcher review', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-guide-view-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { cards: [], edges: [], view: { version: 1, walkthrough: { key: 'finding:source:report:2', index: 2, mode: 'guided', opinion: true, return: null, position: null } } };
  store.writeBoard(root, 'I-01', state, 'hash');
  assert.deepEqual(store.readBoard(root, 'I-01').state, state);
  state.view.walkthrough.index = -1;
  assert.throws(() => store.writeBoard(root, 'I-01', state, 'hash'), /view checkpoint/);
});
test('ordinary selection prepares guide, completes missing helpers, keeps remote path unresolved and stops on report changes', { skip: !process.env.FLOWBOARD_EXTENSION_PATH }, async t => {
  const inputs = [], host = await start({ reading: true, provider: 'codex', invoke: async input => {
    inputs.push(structuredClone(input)); const result = response(input);
    result.value.walkthrough = { steps: result.value.evidence.map(entry => ({ evidenceId: entry.id, title: 'Inspect the recorded behavior', paragraphId: input.finding.reportParagraphs[0].id, phrase: '' })),
      assessment: { result: 'invalid', why: 'Fixture deliberately overgeneralizes the local contradiction.', supportingEvidence: '', opposingEvidence: 'credit-record' } };
    return result;
  } });
  t.after(() => host.close());
  const request = async (route, body) => (await fetch(host.origin + route, { headers: { 'X-Workflow-Token': host.secret, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })).json();
  const wait = async predicate => { for (let i = 0; i < 800; i++) { const value = await request('/state'); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Fixture timeout'); };
  await request('/message', { type: 'triage:ready' });
  await request('/message', { type: 'triage:select', issueId: 'I-02' });
  const loaded = await wait(state => state.lastLoad?.issueId === 'I-02');
  await request('/message', { type: 'triage:rendered', issueId: 'I-02', token: loaded.token });
  const ready = await wait(state => state.investigation?.phase === 'blocked');
  const route = walk.build(ready.investigation, ready.lastLoad.reportText);
  assert.equal(route, null, 'An unresolved remote route blocks publication instead of exposing a pseudo-prepared guide.');
  assert.ok(ready.investigation.evidence.some(entry => entry.id === 'credit-record'), 'Useful private work is retained.');
  assert.equal(walk.assessment(ready.investigation).result, 'unavailable');
  assert.deepEqual(inputs.map(input => input.phase), ['generate', 'challenge']);
  assert.ok(inputs[1].sources.some(item => item.name.endsWith('::_settleCredit')));
  await request('/message', { type: 'triage:investigationFocus', issueId: 'I-02', token: ready.token, evidenceId: 'credit-record', navigationId: 'step-request-1' });
  const focused = await wait(state => state.received.some(item => item.type === 'triage:investigationFocus'));
  const events = await request('/events?after=0');
  assert.ok(events.messages.some(message => message.type === 'triage:investigationFocus' && message.navigationId === 'step-request-1'));
  assert.equal(inputs.length, 2);
  const before = fs.readFileSync(path.join(host.root, '.flowboard/findings/I-02.json'), 'utf8');
  await request('/action', { name: 'report-change' });
  const changed = await request('/events?after=0');
  assert.ok(changed.messages.some(message => message.type === 'triage:sourceStale' && /report/i.test(message.reason)));
  assert.equal(fs.readFileSync(path.join(host.root, '.flowboard/findings/I-02.json'), 'utf8'), before);
  assert.equal(inputs.length, 2, 'Freshness and navigation do not create new provider calls.');
});
