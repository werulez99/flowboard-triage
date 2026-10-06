'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const engine = require('../extension/investigation-engine');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
const { loadCompiler } = require('../extension/compiler-context');
const experiment = require('../extension/experiment');
const native = process.env.FLOWBOARD_EXTENSION_PATH;

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-investigation-test-'));
  fs.cpSync(path.join(__dirname, '../examples/project'), root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepared = await analyze(native, root, { mode: 'source' });
  const catalog = new SourceCatalog(root, prepared.runner, prepared.result);
  const request = structuredClone(require('../examples/finding.json'));
  request.findingId = 'ordinary-reading';
  request.finding.summary = 'Review whether the ordinary increment helper subtracts the requested amount.';
  const draft = engine.create({ findingId: request.findingId, request, catalog });
  return { root, catalog, request, draft, findingId: request.findingId, current: () => true };
}
// Controlled model-output fixture: tests protocol plumbing, not AI quality and
// not a real security finding. The live-provider walkthrough is separate.
function response(input) {
  const unit = input.sources.find(unit => unit.name === 'Demo::_add');
  return {
    inputReviews: (input.semanticInput?.premises || []).map(premise => ({ id: premise.id, status: 'unresolved',
      reason: 'This controlled counter fixture does not establish the saved premise or a complete execution scenario.',
      claimIds: ['normal-counter'], eventIds: [], evidence: ['addition'] })),
    property: { text: 'Ordinary counter increments should add the input amount.', basis: 'report-assumption', evidence: [] },
    claims: [{ id: 'normal-counter', allegation: 'The helper subtracts the input.', actor: 'Any caller', entry: unit.id,
      implementation: 'Demo::_add in the supplied fictional checkout', conditions: ['The ordinary checked addition succeeds.'],
      requiredFacts: ['The operator would have to subtract instead of add.'], supportsIf: 'A subtraction operation.', contradictsIf: 'An addition assignment.',
      status: input.phase === 'challenge' ? 'contradicted' : 'unresolved', reason: 'The exact statement is addition assignment, not subtraction.', evidence: ['addition'],
      unknowns: ['No deployment context is supplied.'], nextQuestion: 'Does the report describe a different revision?' }],
    evidence: [{ id: 'addition', claimId: 'normal-counter', sourceId: unit.id, line: 13, endLine: 13,
      quote: '        counter += amount;', stance: 'contradicts', explanation: 'The += operator adds amount to counter; it contradicts subtraction for this specific helper.' }],
    explanationReviews: input.phase === 'challenge' ? [{ evidenceId: 'addition', result: 'kept', reason: 'The quoted += statement is addition, not subtraction. This check does not establish a deployment or intended specification.', checkedSourceIds: [unit.id] }] : [],
    transitions: [{ id: 'counter-update', claimId: 'normal-counter', label: 'Counter assignment', before: 'Stored counter value', after: 'Prior counter plus amount, if the checked operation succeeds', timing: 'within-transaction', conditions: ['No overflow'], evidence: ['addition'] }],
    questions: [{ id: 'entry-caller', claimId: 'normal-counter', text: 'Which caller reaches this helper?', action: 'callers', target: unit.id, why: 'A helper alone is not a reachable entry point.' }],
    conclusion: { status: 'contradicted-in-scope', text: 'The inspected fictional helper adds, not subtracts. No vulnerability verdict is made.', limitations: ['No deployed instance reviewed.'] }
  };
}

test('normal investigation advances generation, bounded source checks and challenge; drafts reopen without a human verdict', { skip: !native }, async t => {
  const context = await fixture(t), phases = [], invocations = [];
  const result = await engine.advance({ ...context, provider: 'codex', publish: async draft => phases.push(draft.phase),
    invoke: async input => {
      invocations.push(input.phase);
      const saved = engine.read(context.root, context.findingId);
      assert.equal(saved.phase, input.phase === 'generate' ? 'generating' : 'challenging', 'Draft is saved BEFORE the provider is invoked.');
      return { value: response(input), audit: { phase: input.phase, provider: 'controlled-test-fixture', outcome: 'completed' } };
    } });
  assert.deepEqual(invocations, ['generate', 'challenge']);
  // Durable acceptance checkpoints may repeat the same real stage. Preserve
  // ordering and the separate exact two-provider-request assertion above.
  assert.deepEqual(phases.filter((phase, index) => !index || phase !== phases[index - 1]), ['generating', 'checking-source', 'challenging', 'blocked']);
  assert.equal(result.publication.ready, false, 'An old partial model response is saved privately, not published as a complete guide.');
  assert.equal(result.claims[0].status, 'contradicted');
  assert.equal(result.evidence[0].quoteVerified, true);
  assert.equal(result.evidence[0].interpretationVerified, false);
  assert.equal(result.transitions[0].observed, false);
  assert.equal(result.conclusion.humanReviewed, false);
  assert.equal(result.conclusion.status, 'insufficient-evidence');
  assert.deepEqual(engine.read(context.root, context.findingId).evidence, result.evidence);
  assert.equal(result.challengeChanges[0].before, 'unresolved');
  assert.equal(result.challengeChanges[0].after, 'contradicted');
  assert.ok(result.actions.some(action => action.kind === 'callers'));
  assert.ok(result.actions.findIndex(action => action.kind === 'callers') < result.actions.findIndex(action => action.kind === 'code-completion'), 'Explicit questions take priority over generic helper completion within the same bound.');
  assert.ok(result.actions.some(action => action.acquisitionKey && action.outcome === 'context-already-available'), 'An unchanged follow-up is recorded once, then its receipt prevents identical searches.');
});
test('the normal engine applies a compact challenge while retaining the unresolved scope and exact source check', { skip: !native }, async t => {
  const context = await fixture(t), inputs = [];
  const format = require('../extension/challenge-format'), { schema } = require('../extension/semantic-provider');
  const result = await engine.advance({ ...context, provider: 'codex', publish: async () => {}, invoke: async input => {
    inputs.push(input.phase);
    let value = response(input);
    if (input.phase === 'challenge') {
      value.property.documentation = [];
      const fields = format.schemaFor(schema).properties;
      value = { mode: format.MODE, changes: Object.fromEntries(Object.keys(fields.changes.properties).map(key => [key, value[key] ?? null])),
        causal: Object.fromEntries(Object.keys(fields.causal.properties).map(key => [key, key === 'checks' ? [] : null])), explanationReviews: value.explanationReviews };
      // This intentionally old fixture has no causal explanation. It must fail
      // the complete-result check instead of inheriting an invented ready route.
    }
    return { value, audit: { phase: input.phase, provider: 'controlled-delta-fixture', outcome: 'completed' } };
  } });
  assert.equal(result.phase, 'blocked');
  assert.match(result.error, /incomplete explanation/);
  assert.equal(result.evidence[0].source.line, 13);
  assert.equal(result.claims[0].status, 'unresolved');
  assert.deepEqual(inputs, ['generate', 'challenge', 'challenge'], 'The structural repair is still bounded.');
});
test('model references must quote exact supplied source; a valid path cannot validate a fabricated interpretation', { skip: !native }, async t => {
  const context = await fixture(t), units = engine.makeContext(context.catalog, context.request).units;
  const output = response({ sources: units, phase: 'challenge' });
  output.evidence[0].quote = 'counter -= amount;';
  assert.throws(() => engine.accept(output, context.draft, units), /does not quote/);
  output.evidence[0].quote = '        counter += amount;'; output.evidence[0].line = 900;
  assert.throws(() => engine.accept(output, context.draft, units), /outside/);
  output.evidence[0].line = 13; output.claims[0].evidence = [];
  assert.equal(engine.accept(output, context.draft, units).claims[0].status, 'unresolved');
});
test('source changes and finding switches suppress late generated evidence, including saved results', { skip: !native }, async t => {
  for (const change of ['source', 'selection']) {
    const context = await fixture(t); let active = true, release;
    const phases = [];
    const job = engine.advance({ ...context, provider: 'codex', current: () => active, publish: async draft => phases.push(draft.phase),
      invoke: input => new Promise(resolve => { release = () => resolve({ value: response(input), audit: { phase: input.phase, outcome: 'completed' } }); }) });
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'source') fs.appendFileSync(path.join(context.root, 'src/Demo.sol'), '\n// Changed while reading.\n'); else active = false;
    release(); await job;
    assert.deepEqual(phases, ['generating']);
    const saved = engine.read(context.root, context.findingId);
    assert.equal(saved.evidence.length, 0);
    assert.equal(saved.runs.length, 0);
  }
});
test('provider failure preserves preparation and a partial draft; never becomes a completed pass', { skip: !native }, async t => {
  const context = await fixture(t);
  const result = await engine.advance({ ...context, provider: 'codex', publish: async () => {}, invoke: async () => { throw new Error('Authentication expired'); } });
  assert.equal(result.phase, 'blocked'); assert.match(result.error, /Authentication/);
  assert.ok(result.sources.length); assert.equal(result.evidence.length, 0);
  assert.equal(engine.read(context.root, context.findingId).phase, 'blocked');
});
test('one invalid model location gets one bounded evidence-linked repair, never host-guessed relocation', { skip: !native }, async t => {
  const context = await fixture(t), inputs = [];
  const draft = await engine.advance({ ...context, provider: 'codex', publish: async () => {}, invoke: async input => {
    inputs.push(input); const value = response(input);
    if (inputs.length === 1) value.evidence[0].quote = '        counter -= amount;';
    return { value, audit: { phase: input.phase, provider: 'controlled-test-fixture', outcome: 'completed' } };
  } });
  assert.equal(inputs.length, 3, 'At most generation, one repair and challenge.');
  assert.match(JSON.stringify(inputs[1].hostReview), /does not quote/);
  assert.equal(draft.evidence[0].quote, '        counter += amount;');
  assert.equal(draft.runs[0].resultAccepted, false);
  assert.equal(draft.phase, 'blocked', 'Repairing a location alone does not satisfy the explanation gate.');
});
test('saved investigation revisions reject competing writes and tampered source excerpts', { skip: !native }, async t => {
  const context = await fixture(t), draft = context.draft;
  draft.sources = engine.makeContext(context.catalog, context.request).units;
  draft.revision++; engine.write(context.root, draft);
  const earlier = engine.read(context.root, context.findingId), later = engine.read(context.root, context.findingId);
  later.revision++; later.phase = 'corrected'; engine.write(context.root, later);
  earlier.revision++; earlier.phase = 'blocked';
  assert.throws(() => engine.write(context.root, earlier), /another view/);
  assert.equal(engine.read(context.root, context.findingId).phase, 'corrected');
  later.sources[0].code = later.sources[0].code.replace('function', 'fallback');
  assert.throws(() => engine.validateCurrent(context.catalog, later), /does not match/);
  const packet = engine.modelSources(draft.sources);
  assert.ok(packet[0].code.startsWith('8 | '));
  assert.equal(packet[0].sourceHash, draft.sources[0].source.sourceHash, 'Each selectable source unit carries its current hash once; occurrence selectors must not guess it.');
});
test('model source packets remove only redundant call aliases and keep exact occurrence and binding evidence', () => {
  const span = { start: 10, end: 19, line: 2, endLine: 2, column: 1, endColumn: 10 };
  const call = { id: 'call-exact', span, nameSpan: span, receiverSpan: span,
    argumentSpans: [{ index: 0, name: null, expression: 'amount', span }], options: [{ name: 'value', expression: 'msg.value', span }],
    callKind: 'member', receiverExpression: 'target', sourceExpression: 'target.f{value:msg.value}(amount)', arguments: 'amount', receiver: 'target', line: 2,
    declarations: [{ file: 'src/Other.sol', line: 3 }], creationTargets: [], failure: 'propagates', internalLibrary: false,
    relationship: 'hypothesis', resolution: 'declaration-candidate', targets: [], receiverTypes: ['IOther'], implicitReceiver: false };
  const unit = { id: 'source', name: 'Example::f', source: { file: 'src/Example.sol', line: 1, endLine: 3 },
    code: 'function f() external {\n target.f{value:msg.value}(amount);\n}', relatedCalls: [call], readThrough: 0 };
  const before = JSON.stringify(unit), packet = engine.modelSources([unit])[0].relatedCalls[0];
  for (const field of ['id', 'span', 'nameSpan', 'receiverSpan', 'argumentSpans', 'options', 'receiverExpression', 'declarations', 'failure', 'resolution']) assert.deepEqual(packet[field], call[field]);
  for (const field of ['arguments', 'sourceExpression', 'receiver', 'line']) assert.equal(packet[field], undefined);
  assert.equal(JSON.stringify(unit), before, 'Canonical call/source records still retain every original field.');
});
test('imported report constants and named local helpers are read before the first model request', { skip: !native }, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flowboard-prime-report-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'src'));
  fs.writeFileSync(path.join(root,'src/DelayPolicy.sol'),`pragma solidity ^0.8.20;
contract DelayPolicy {
 uint256 public constant WAIT = 12;
 function ready(uint256 start) external pure returns (bool) {
  return end(start) > WAIT;
 }
 function end(uint256 start) internal pure returns (uint256) { return start + WAIT; }
}`);
  fs.writeFileSync(path.join(root,'report.md'),'# Findings\n\n## I-1: DelayPolicy.ready and the WAIT boundary\n\nThe report claims ready always returns false. Inspect end(start) and the WAIT constant.\n');
  await require('../extension/report').importReport(path.join(root,'report.md'),root,native);
  const store=require('../extension/store'),report=store.readReport(root),issue=report.issues[0],request=store.readDraft(root,issue.id);
  const prepared=await analyze(native,root,{mode:'source'}),catalog=new SourceCatalog(root,prepared.runner,prepared.result);
  const draft=engine.create({findingId:issue.id,request,issue,catalog});let input;
  await engine.advance({root,findingId:issue.id,request,issue,catalog,draft,provider:'codex',current:()=>true,publish:async()=>{},invoke:async value=>{
    input=value;throw Object.assign(new Error('Offline first-packet observation; no model process.'),{code:'LOCAL_READING_LIMIT'});
  }});
  assert.ok(input.sources.some(unit=>unit.contextKind==='state'&&unit.code.includes('WAIT = 12')));
  assert.ok(input.sources.some(unit=>unit.name==='DelayPolicy::end'&&unit.complete));
  assert.ok(draft.actions.some(action=>action.id.startsWith('prime-')&&action.sourceIds.length));
  assert.equal(draft.publication?.ready || false,false,'Reading the constant is not semantic acceptance.');
  const fresh=engine.create({findingId:issue.id,request,issue,catalog}), context=engine.makeContext(catalog,request,issue),doc=catalog.document('src/DelayPolicy.sol');
  const extra=context.add({name:'Code details',kind:'context',contextKind:'excerpt',file:doc.uri.fsPath,startLine:1,endLine:doc.lineCount,contract:null,calls:[],memberCalls:[],modifiers:[]},'Locally acquired complete source before generation.');
  fresh.sources=context.units; let restored;
  await engine.advance({root,findingId:issue.id,request,issue,catalog,draft:fresh,provider:'codex',persist:false,current:()=>true,publish:async()=>{},invoke:async value=>{
    restored=value;throw Object.assign(new Error('Offline capture'),{code:'LOCAL_READING_LIMIT'});
  }});
  assert.ok(restored.sources.some(unit=>unit.id===extra && unit.code.includes('contract DelayPolicy') && unit.complete),'Pre-dispatch source acquisition survives the first generation boundary.');
  assert.equal(fresh.runs.length,0); assert.equal(fresh.publication?.ready || false,false);
});
test('researcher correction invalidates only its dependent scope and predictions without validating itself', { skip: !native }, async t => {
  const context = await fixture(t), units = engine.makeContext(context.catalog, context.request).units;
  Object.assign(context.draft, engine.accept(response({ sources: units, phase: 'challenge' }), context.draft, units));
  context.draft.claims.push({ ...structuredClone(context.draft.claims[0]), id: 'another-scope' });
  engine.correct(context.draft, { claimId: 'normal-counter', field: 'conditions', value: 'Review only the ordinary public entry point.' });
  assert.equal(context.draft.claims[0].status, 'unresolved');
  assert.equal(context.draft.claims[1].status, 'contradicted');
  assert.equal(context.draft.transitions[0].needsReassessment, true);
  assert.equal(context.draft.corrections[0].origin, 'researcher');
  assert.equal(context.draft.corrections[0].independentlySupported, false);
  assert.equal(context.draft.conclusion.status, 'insufficient-evidence');
});
test('a rejected retry preserves challenge-only evidence and records a completed but rejected model response', { skip: !native }, async t => {
  const context = await fixture(t);
  const draft = await engine.advance({ ...context, provider: 'codex', publish: async () => {}, invoke: async input => ({ value: response(input), audit: { provider: 'controlled-test-fixture', phase: input.phase, outcome: 'completed' } }) });
  const extra = structuredClone(draft.sources.find(unit => unit.id === draft.evidence[0].sourceId));
  extra.id = 'challenge-only-source'; draft.sources.push(extra);
  draft.evidence[0].sourceId = extra.id; draft.claims[0].entry = extra.id;
  draft.checkpoint.stage = 'challenge'; // A retry of an interrupted check, not a no-progress completed blocker.
  draft.revision++; engine.write(context.root, draft);
  const result = await engine.advance({ ...context, draft, provider: 'codex', publish: async () => {}, invoke: async input => {
    const pending = engine.read(context.root, context.findingId);
    assert.equal(pending.sources.some(unit => unit.id === extra.id), true, 'Previous evidence remains coherent during generation.');
    const value = response(input); value.evidence[0].quote = 'fabricated statement';
    return { value, audit: { provider: 'controlled-test-fixture', phase: input.phase, outcome: 'completed' } };
  } });
  assert.equal(result.phase, 'blocked');
  const reopened = engine.read(context.root, context.findingId);
  assert.equal(reopened.evidence[0].sourceId, extra.id);
  assert.equal(reopened.runs.at(-1).outcome, 'completed');
  assert.equal(reopened.runs.at(-1).resultAccepted, false);
  const corrupted = structuredClone(reopened); corrupted.transitions[0].evidence = 'not an array';
  fs.writeFileSync(path.join(context.root, '.flowboard/investigations', context.findingId + '.json'), JSON.stringify(corrupted));
  assert.throws(() => engine.read(context.root, context.findingId), /state transition/);
  const invalidLimits = { ...reopened, readingLimits: { length: 1 } };
  fs.writeFileSync(path.join(context.root, '.flowboard/investigations', context.findingId + '.json'), JSON.stringify(invalidLimits));
  assert.throws(() => engine.read(context.root, context.findingId), /code-reading limits/);
});
test('a replacement generation checkpoint cannot orphan an earlier accepted evidence unit', { skip: !native }, async t => {
  const context = await fixture(t);
  const draft = await engine.advance({ ...context, provider:'codex', publish:async()=>{}, invoke:async input => ({ value:response(input), audit:{phase:input.phase,outcome:'completed'} }) });
  const retained = structuredClone(draft.sources.find(unit=>unit.id===draft.evidence[0].sourceId)); retained.id='older-checked-source'; draft.sources.push(retained);
  draft.evidence[0].sourceId=retained.id; draft.claims[0].entry=retained.id; draft.claims[0].needsReassessment=true;
  draft.revision++; engine.write(context.root,draft); let attempts=0;
  await engine.advance({ ...context,draft,provider:'codex',publish:async()=>{},invoke:async input=>{
    attempts++;
    const saved=engine.read(context.root,context.findingId);
    assert.ok(saved.sources.some(unit=>unit.id===retained.id)); assert.equal(saved.evidence[0].sourceId,retained.id);
    const value=response(input);value.evidence[0].quote='An intentionally rejected fixture quote';return {value,audit:{phase:input.phase,outcome:'completed'}};
  }});
  assert.equal(attempts,2);const saved=engine.read(context.root,context.findingId);
  assert.equal(saved.evidence[0].sourceId,retained.id);assert.ok(saved.sources.some(unit=>unit.id===retained.id));
});
test('existing regression classifier distinguishes no tests, lint diagnostics, setup failure and observed assertions', () => {
  assert.equal(experiment.classify('{}', 'No tests found', 0).outcome, 'no-tests-executed');
  assert.equal(experiment.classify('', 'Compiler run failed', 1).outcome, 'compilation-failure');
  const successful = JSON.stringify({ 'test/Ordinary.t.sol:Ordinary': { test_results: { 'test_increment()': { status: 'Success', kind: { Unit: { gas: 12345 } } } } } });
  const observed = experiment.classify(successful, 'error: unresolved symbol in advisory source lint', 0);
  assert.equal(observed.outcome, 'passed'); assert.equal(observed.tests[0].gas, 12345);
  assert.equal(experiment.classify(JSON.stringify({ fixture: { test_results: { 'setUp()': { status: 'Failure', reason: 'setup reverted' } } } }), '', 1).outcome, 'setup-failure');
  assert.throws(() => experiment.command({ kind: 'test-source', name: 'test_example', source: { file: '../../outside.t.sol' } }), /existing test/);
  const args = experiment.command({ kind: 'test-source', name: 'Ordinary::test_increment', source: { file: 'test/Ordinary.t.sol' } });
  assert.equal(args.at(-1), '^test_increment\\(');
  assert.ok(!args.includes('--ffi'));
});
test('compiler artifacts require every input to match and map UTF-8 byte locations without inventing external dispatch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-compiler-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'out/build-info'), { recursive: true });
  const source = '// Unicode: \u2192\ncontract Ordinary {\n function read() external {}\n}\n';
  const base = 'interface IBase {}\n';
  fs.writeFileSync(path.join(root, 'src/Ordinary.sol'), source); fs.writeFileSync(path.join(root, 'src/Base.sol'), base);
  const start = Buffer.byteLength(source.slice(0, source.indexOf('function')));
  const build = { solcVersion: 'fixture', input: { sources: { 'src/Ordinary.sol': { content: source }, 'src/Base.sol': { content: base } } }, output: { sources: {
    'src/Ordinary.sol': { id: 0, ast: { id: 1, nodeType: 'SourceUnit', src: `0:${Buffer.byteLength(source)}:0`, nodes: [{ id: 2, nodeType: 'FunctionDefinition', name: 'read', visibility: 'external', src: `${start}:27:0` }] } }
  } } };
  fs.writeFileSync(path.join(root, 'out/build-info/fixture.json'), JSON.stringify(build));
  const compiler = loadCompiler(root); assert.equal(compiler.available, true);
  assert.equal(compiler.facts('src/Ordinary.sol', 3, 'read').declaration.line, 3);
  const alias = path.join(root, 'workspace-alias');
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = loadCompiler(alias);
  assert.equal(aliased.available, true);
  assert.equal(aliased.facts('src/Ordinary.sol', 3, 'read').declaration.file, 'src/Ordinary.sol');
  assert.equal(aliased.file, 'out/build-info/fixture.json');
  fs.appendFileSync(path.join(root, 'src/Base.sol'), '// dependency changed\n');
  assert.equal(loadCompiler(root).available, false);
  assert.equal(loadCompiler(alias).available, false, 'Canonicalizing the workspace must not weaken dependency freshness.');
});
test('compiler call facts retain mutually exclusive branch conditions and do not resolve member dispatch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-branch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'out/build-info'), { recursive: true });
  const source = 'contract Ordinary {\n function choose(bool yes) external { if (yes) { add(); } else { this.read(); } }\n function add() internal {}\n function read() external {}\n}\n';
  fs.writeFileSync(path.join(root, 'src/Ordinary.sol'), source);
  const span = (text, from = 0) => `${source.indexOf(text, from)}:${text.length}:0`;
  const call = (expression, target, member = false) => ({ nodeType: 'FunctionCall', src: span(expression + '();'), expression: { nodeType: member ? 'MemberAccess' : 'Identifier', referencedDeclaration: target } });
  const branch = { nodeType: 'IfStatement', src: span('if (yes) { add(); } else { this.read(); }'), condition: { nodeType: 'Identifier', src: span('yes', source.indexOf('if')) },
    trueBody: { nodeType: 'Block', src: span('{ add(); }'), statements: [call('add', 3)] },
    falseBody: { nodeType: 'Block', src: span('{ this.read(); }'), statements: [call('this.read', 4, true)] } };
  const ast = { id: 1, nodeType: 'SourceUnit', src: `0:${source.length}:0`, nodes: [
    { id: 2, nodeType: 'FunctionDefinition', name: 'choose', visibility: 'external', src: span('function choose(bool yes) external { if (yes) { add(); } else { this.read(); } }'), body: { nodeType: 'Block', statements: [branch] } },
    { id: 3, nodeType: 'FunctionDefinition', name: 'add', visibility: 'internal', src: span('function add() internal {}') },
    { id: 4, nodeType: 'FunctionDefinition', name: 'read', visibility: 'external', src: span('function read() external {}') }
  ] };
  fs.writeFileSync(path.join(root, 'out/build-info/fixture.json'), JSON.stringify({ input: { sources: { 'src/Ordinary.sol': { content: source } } }, output: { sources: { 'src/Ordinary.sol': { id: 0, ast } } } }));
  const facts = loadCompiler(root).facts('src/Ordinary.sol', 2, 'choose');
  assert.deepEqual(facts.calls.map(call => call.relationship), ['internal-call', 'declaration-reference']);
  assert.deepEqual(facts.calls.map(call => call.conditions[0].branch), ['then', 'else']);
  assert.deepEqual(facts.calls.map(call => call.conditions[0].expression), ['yes', 'yes']);
});
