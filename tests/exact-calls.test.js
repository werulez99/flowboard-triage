'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { analyze } = require('../extension/runner-adapter');
const { SourceCatalog } = require('../extension/source');
const native = process.env.FLOWBOARD_EXTENSION_PATH;
const policy = require('../extension/guide-policy'), capacity = require('../extension/review-capacity');
const bindings = require('../extension/call-bindings');
function callDraft(body = '    finish(true);\n    finish(false);') {
  const source = { file: 'src/Guard.sol', line: 1, endLine: 3, sourceHash: 'a'.repeat(64) };
  const caller = { id: 'caller', name: 'Guard::enter', complete: true, source, code: `function enter() external {\n${body}\n}` };
  caller.source.endLine = caller.code.split('\n').length;
  const destination = { id: 'callee', name: 'Guard::finish', complete: true,
    source: { ...source, line: 10, endLine: 12 }, code: 'function finish(bool accepted) internal {\n    require(accepted, "rejected");\n}' };
  caller.relatedCalls = bindings.unitSites(caller).map(site => ({ ...site, line: site.span.line,
    receiver: 'internal', relationship: 'call', targets: [{ file: source.file, line: 10, contract: 'Guard', signature: 'finish(bool)' }] }));
  const evidence = [{ id: 'call', claimId: 'c1', sourceId: 'caller', source: { ...caller.source, line: 2, endLine: 2 }, quote: body.split('\n')[0], stance: 'context', note: 'Call the checked guard.', explanationReview: { result: 'kept' } },
    { id: 'guard', claimId: 'c1', sourceId: 'callee', source: { ...destination.source, line: 11, endLine: 11 }, quote: '    require(accepted, "rejected");', stance: 'contradicts', note: 'The false branch reverts.', explanationReview: { result: 'kept' } }];
  const event = { claimId: 'c1', transaction: 'tx1', callSiteId: '', actor: 'Owner', caller: 'Owner', receiver: 'Guard', inputs: [], changes: [], conditions: [], phase: 'guard', paragraphId: '', phrase: '', role: 'Check rejection', what: 'Inspect the guard.', why: 'A rejected call cannot commit.', effect: 'condition' };
  const events = [{ ...event, id: 'entry', invocationId: 'entry1', evidenceId: 'call', callSiteId: caller.relatedCalls[0].id, title: 'Pass the value', effect: 'intermediate' },
    { ...event, id: 'finish', invocationId: 'finish1', evidenceId: 'guard', title: 'Check the value', effect: 'rolled-back', inputs: [{ name: 'accepted', expression: 'false', type: 'bool', units: 'boolean', origin: 'The exact highlighted call.', evidence: ['call', 'guard'] }] }];
  const obligations = capacity.kinds.map(kind => ({ id: kind, claimId: 'c1', kind, question: `Check ${kind}`, state: 'established', reason: 'Source-derived fixture: false always reverts.', evidence: ['call', 'guard'], documentation: [] }));
  const draft = { findingId: 'synthetic-occurrence-check', phase: 'ready', revision: 1, snapshot: { policy: policy.POLICY },
    sources: [caller, destination], evidence, claims: [{ id: 'c1', status: 'contradicted', unknowns: [] }], actions: [],
    property: { text: 'Rejected calls do not commit.', basis: 'report-assumption', evidence: [] }, conclusion: { limitations: [] },
    walkthrough: { assessment: { result: 'invalid', why: 'The false branch is rejected.', supportingEvidence: '', opposingEvidence: 'guard' } },
    causal: { scope: 'The checked internal invocation only.', summary: 'Inspect the rejection condition.', outcome: 'refuted', obligations, events,
      relationships: [{ from: 'entry', to: 'finish', kind: 'call', callSiteId: caller.relatedCalls[0].id,
        dispatch: { kind: 'internal', receiver: 'internal', implementation: 'callee', evidence: ['call', 'guard'], context: 'same', failure: 'propagates' },
        binding: 'false -> accepted', explanation: 'Pass the exact checked value.', evidence: ['call', 'guard'] }], order: ['entry', 'finish'], checks: [] } };
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key, reason: 'Deterministic structural fixture, not a real model result.', evidence: ['call', 'guard'], documentation: [] }));
  return draft;
}

test('gate cannot borrow the second call argument for the first highlighted occurrence', () => {
  const draft = callDraft();
  assert.equal(policy.gate(draft).ready, false, 'The first highlighted finish(true) does not pass false.');
  assert.match(policy.gate(draft).problems.join('\n'), /actual argument position/);
  const control = callDraft('    finish(false);\n    finish(true);');
  assert.equal(policy.gate(control).ready, true, policy.gate(control).problems.join('\n'));
  const single = callDraft('    finish(true);');
  assert.equal(policy.gate(single).ready, false, 'Removing the second occurrence does not change the rejection.');
});

async function sourceFixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-exact-calls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/Calls.sol'), source);
  const { runner, result } = await analyze(native, root);
  return new SourceCatalog(root, runner, result);
}
async function fixture(t, body) {
  const catalog = await sourceFixture(t, `pragma solidity ^0.8.20;
contract A {
 function foo(uint256 value) external payable returns (uint256) { return value; }
}
contract B {
 function foo(uint256 value) external returns (uint256) { return value; }
}
contract Calls {
 A a;
 B b;
 function enter(address target, uint256 x, uint256 y) external payable {
${body}
 }
}
`);
  const fn = catalog.named('enter')[0];
  return { catalog, fn, links: catalog.callLinks(fn), code: catalog.code(fn) };
}

test('native integration retains low-level calls with value options', { skip: !native }, async t => {
  const { links } = await fixture(t, '  target.call("");\n  target.call{value: msg.value}("");');
  assert.equal(links.length, 2, 'Both source occurrences are calls, including the value-option call.');
  assert.deepEqual(links.map(site => site.receiver), ['target', 'target']);
  assert.deepEqual(links.map(site => site.arguments), ['""', '""']);
  assert.deepEqual(links.map(site => site.argCount), [1, 1]);
  assert.deepEqual(links.map(site => site.argumentSpans[0].expression), ['""', '""']);
});

test('literal arguments retain their count and original exact spans without becoming syntax', { skip: !native }, async t => {
  const source = `pragma solidity ^0.8.20;
contract LiteralCalls {
 function read(string memory label, bytes memory data) internal pure {}
 function enter() external pure {
  read("x", hex"4142");
  read(/* before */ "comma, fake() and \\"quote\\"", /* after */ "");
  read({label: unicode"café 🧪", data: hex""});
 }
}`;
  const catalog = await sourceFixture(t, source), fn = catalog.named('enter')[0], code = catalog.code(fn), sites = catalog.callLinks(fn);
  assert.equal(sites.length, 3, 'Quoted fake() is not an extra call.');
  assert.deepEqual(sites.map(site => site.argCount), [2, 2, 2]);
  assert.deepEqual(sites[0].argumentSpans.map(argument => argument.expression), ['"x"', 'hex"4142"']);
  assert.deepEqual(sites[2].argumentSpans.map(argument => [argument.name, argument.expression]), [['label', 'unicode"café 🧪"'], ['data', 'hex""']]);
  for (const site of sites) for (const argument of site.argumentSpans) assert.equal(code.slice(argument.span.start, argument.span.end), argument.expression);
});

test('occurrence spans preserve same-line, nested, named arguments, gas/value options and creation salt', { skip: !native }, async t => {
  const { catalog, fn, links, code } = await fixture(t, '  a.foo{value: msg.value, gas: 50000}(x); b.foo(y);\n  a.foo({value: b.foo(y)});\n  A created = new A{salt: bytes32(x)}();');
  assert.equal(links.length, 5);
  assert.deepEqual(links.slice(0, 2).map(site => [site.receiver, site.arguments]), [['a', 'x'], ['b', 'y']]);
  assert.equal(links[0].line, links[1].line);
  assert.ok(links[0].span.end < links[1].span.start);
  assert.equal(new Set(links.map(site => site.id)).size, links.length);
  assert.deepEqual(links[0].options.map(item => [item.name, item.expression]), [['value', 'msg.value'], ['gas', '50000']]);
  assert.equal(links[2].argumentSpans[0].name, 'value');
  assert.equal(links[2].argumentSpans[0].expression, 'b.foo(y)');
  assert.equal(links[3].receiver, 'b'); assert.equal(links[3].arguments, 'y');
  assert.equal(links[4].callKind, 'creation'); assert.equal(links[4].options[0].name, 'salt');
  assert.equal(links[4].options[0].expression, 'bytes32(x)');
  assert.equal(links[4].creationTargets.length, 1);
  for (const site of links) {
    assert.equal(code.slice(site.span.start, site.span.end), site.sourceExpression);
    for (const argument of [...site.argumentSpans, ...site.options]) assert.equal(code.slice(argument.span.start, argument.span.end), argument.expression);
    assert.equal(site.span.column, site.span.start - (code.lastIndexOf('\n', site.span.start - 1) + 1));
  }
  // Structural compiler control (not a Ready claim): candidate selection is
  // explicit; the publication controls separately prove/reject receiver/path.
  const binding = require('../extension/source-bindings'), caller = unit(catalog, fn, 'caller');
  for (const [index, receiver] of ['A', 'B'].entries()) {
    const destination = unit(catalog, catalog.named('foo').find(fn => fn.contract === receiver), 'callee');
    const value = { bindingFormat: binding.VERSION, evidence: [{ id: 'from', sourceId: 'caller' }, { id: 'to', sourceId: 'callee' }],
      causal: { entryBindings: [{ id: 'entry', callerEventId: 'call', calleeEventId: 'enter', sourceId: 'caller', sourceHash: caller.source.sourceHash,
        callSiteId: links[index].id, implementationSourceId: 'callee', kind: 'local-instance', context: 'call', failure: 'not-applicable', evidence: [] }],
      events: [{ id: 'call', invocationId: 'root', transaction: 'tx', evidenceId: 'from', inputs: [] },
        { id: 'enter', invocationId: 'foo', transaction: 'tx', evidenceId: 'to', inputs: [{ entryBindingId: 'entry', parameterIndex: 0, units: 'unknown', origin: 'Unproved semantic control', evidence: [] }] }],
      relationships: [{ from: 'call', to: 'enter', kind: 'call', entryBindingId: 'entry' }] } };
    const compiled = binding.compile(value, [caller, destination]);
    assert.equal(compiled.causal.events[1].inputs[0].expression, index ? 'y' : 'x');
    assert.equal(compiled.causal.relationships[0].dispatch.receiver, index ? 'b' : 'a');
    assert.deepEqual(compiled.causal.events[0].anchor.occurrence, links[index].span);
  }
});

test('same-line calls and stale occurrence metadata cannot substitute for the selected event', () => {
  const draft = callDraft('    finish(true); finish(false);'), sites = draft.sources[0].relatedCalls;
  assert.equal(policy.gate(draft).ready, false);
  draft.causal.events[0].callSiteId = draft.causal.relationships[0].callSiteId = sites[1].id;
  assert.equal(policy.gate(draft).ready, true, policy.gate(draft).problems.join('\n'));
  sites[1].arguments = 'true';
  assert.match(policy.gate(draft).problems.join('\n'), /exact current call-site/);
});

test('target file and line alone cannot replace the actual function identity or overload', () => {
  const draft = callDraft('    finish(false);');
  assert.equal(policy.gate(draft).ready, true);
  draft.sources[1].name = 'Guard::different';
  draft.sources[1].code = draft.sources[1].code.replace('finish(', 'different(');
  assert.match(policy.gate(draft).problems.join('\n'), /no unique checked non-virtual internal target/);
});

test('internal helpers preserve EVM caller and execution context and cannot commit after an uncaught failure', () => {
  const draft = callDraft('    finish(false);');
  assert.equal(policy.gate(draft).ready, true);
  draft.causal.events[1].caller = 'Guard';
  assert.match(policy.gate(draft).problems.join('\n'), /preserves.*msg.sender/);
  draft.causal.events[1].caller = 'Owner'; draft.causal.events[0].effect = 'committed';
  assert.match(policy.gate(draft).problems.join('\n'), /uncaught callee failure/);
});

test('return handoffs refer to the entering occurrence and cannot reverse a propagating revert', () => {
  const draft = callDraft('    finish(false);'), call = draft.causal.relationships[0];
  const from = draft.causal.events[1], entry = draft.causal.events[0];
  draft.causal.events.push({ ...entry, id: 'back', title: 'Back in the original invocation', effect: 'return', callSiteId: '' });
  draft.causal.order.push('back');
  draft.causal.relationships.push({ ...structuredClone(call), from: from.id, to: 'back', kind: 'return', explanation: 'Return to the exact caller invocation.' });
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key, reason: 'A return is matched to one preceding call occurrence and frame.', evidence: ['call', 'guard'], documentation: [] }));
  assert.match(policy.gate(draft).problems.join('\n'), /uncaught failed call.*cannot return normally/);
  // The independently read control passes true, so require succeeds and the
  // helper returns to its original invocation. Recompute exact identities.
  draft.sources[0].code = draft.sources[0].code.replace('finish(false)', 'finish(true)');
  draft.sources[0].relatedCalls = bindings.unitSites(draft.sources[0]).map(site => ({ ...site, line: site.span.line,
    receiver: 'internal', relationship: 'call', targets: [{ file: 'src/Guard.sol', line: 10, contract: 'Guard', signature: 'finish(bool)' }] }));
  const id = draft.sources[0].relatedCalls[0].id;
  draft.evidence[0].quote = '    finish(true);';
  from.effect = 'return'; from.inputs[0].expression = 'true';
  draft.evidence[1].note = 'The guard allows accepted=true, contradicting an unconditional-revert allegation.';
  draft.claims[0].allegation = 'Every invocation of finish reverts.';
  draft.walkthrough.assessment.why = 'The inspected true input satisfies the guard; the function then returns.';
  entry.callSiteId = id; for (const link of draft.causal.relationships) link.callSiteId = id;
  assert.equal(policy.gate(draft).ready, true, policy.gate(draft).problems.join('\n'));
  draft.causal.relationships[1].callSiteId = 'unknown-occurrence';
  assert.match(policy.gate(draft).problems.join('\n'), /no unique earlier call/);
  draft.causal.relationships[1].callSiteId = call.callSiteId;
  draft.causal.events[2].invocationId = 'some-other-entry';
  assert.match(policy.gate(draft).problems.join('\n'), /no unique earlier call/);
});

test('legacy call explanations cannot gain current readiness without exact occurrence and dispatch review', () => {
  const draft = callDraft('    finish(false);');
  draft.snapshot.policy = 'checked-explanation-v4';
  delete draft.causal.relationships[0].callSiteId; delete draft.causal.relationships[0].dispatch;
  delete draft.causal.events[0].callSiteId;
  assert.equal(policy.gate(draft).ready, false);
  draft.publication = { ready: true, policy: 'checked-explanation-v4', digest: policy.digest(draft) };
  assert.equal(policy.expose(draft).causal, undefined);
  assert.equal(draft.evidence[0].note, 'Call the checked guard.', 'The old note is preserved privately, not erased or relabeled checked.');
});

test('parameter spans identify declaration names rather than repeated body text or unnamed type modifiers', () => {
  const code = '// accepted is not the parameter here\nfunction inspect(\n    uint256 accepted,\n    bytes calldata,\n    address payable receiver\n) external { accepted; receiver; }';
  const spans = bindings.parameterSpans(code, 'inspect', 30);
  assert.deepEqual(spans.map(item => item.name), ['accepted', null, 'receiver']);
  assert.deepEqual(spans.filter(item => item.name).map(item => [item.span.line, code.slice(item.span.start, item.span.end)]), [[32, 'accepted'], [34, 'receiver']]);
  assert.equal(spans[1].span, null); assert.equal(spans[1].declaration, 'bytes calldata');
});

test('Ether call value is not inferred from an ordinary token transfer argument', () => {
  const typed = { name: 'transfer', callKind: 'member', argumentSpans: [{ expression: 'recipient' }, { expression: 'amount' }], options: [] };
  assert.equal(bindings.boundArgument(typed, 'msg.value', 'function transfer(address recipient, uint256 amount) external'), '0');
  const lowLevel = { name: 'transfer', callKind: 'low-level', argumentSpans: [{ expression: 'amount' }], options: [] };
  assert.equal(bindings.boundArgument(lowLevel, 'msg.value', 'receive() external payable'), 'amount');
  assert.equal(bindings.boundArgument({ ...lowLevel, name: 'call', options: [{ name: 'value', expression: 'requestValue' }] }, 'msg.value', ''), 'requestValue');
  assert.equal(bindings.boundArgument({ ...lowLevel, name: 'delegatecall' }, 'msg.value', ''), null);
  assert.equal(bindings.boundArgument({ ...typed, internalLibrary: true }, 'msg.value', ''), null);
});

function unit(catalog, fn, id) {
  const hint = catalog.hints(fn);
  return { id, name: `${fn.contract}::${fn.name}`, contract: fn.contract, complete: true,
    ...(fn.kind === 'context' ? { contextKind: 'state' } : {}), code: catalog.code(fn),
    initialization: catalog.initialization(fn),
    source: { file: hint.file, line: hint.line, endLine: hint.endLine, sourceHash: hint.sourceHash },
    relatedCalls: catalog.callLinks(fn).map(site => ({ ...site, candidates: undefined,
      targets: site.candidates.map(target => ({ file: catalog.relative(target.file), line: target.startLine,
        contract: target.contract, signature: catalog.hints(target).identity.signature })) })) };
}
function note(unit, id, line, stance = 'context') {
  return { id, claimId: 'c1', sourceId: unit.id, source: { ...unit.source, line, endLine: line },
    quote: unit.code.split('\n')[line - unit.source.line], stance, note: 'Read this exact fixture statement.', explanationReview: { result: 'kept' } };
}
async function dispatchFixture(t, options = {}) {
  const catalog = await sourceFixture(t, `pragma solidity ^0.8.20;
interface IGuard { function finish(bool declaredName) external; }
contract Guard {
 function finish(bool accepted) external {
  require(accepted, "rejected");
 }
 receive() external payable {
  revert("rejected");
 }
}
contract Caller {
 IGuard ${options.mutable ? '' : 'immutable '}guard${options.inline ? ' = IGuard(address(new Guard()))' : ''};
 constructor() {
  ${options.inline ? '// No constructor assignment: initialization is in the declaration.' : 'guard = IGuard(address(new Guard()));'}
 }
 function enter() external {
  ${options.lowLevel ? 'address(guard).call("");' : options.named ? 'guard.finish({declaredName: false});' : options.caught ? 'try guard.finish(false) { } catch { }' : 'guard.finish(false);'}
 }
}
`);
  const caller = unit(catalog, catalog.named('enter')[0], 'caller'), callee = unit(catalog, catalog.named(options.lowLevel ? 'receive' : 'finish')[0], 'callee');
  const constructor = unit(catalog, catalog.named('constructor')[0], 'constructor');
  const declaration = unit(catalog, catalog.stateDeclarations('src/Calls.sol', 'Caller')[0], 'declaration');
  const draft = callDraft('    finish(false);'), call = caller.relatedCalls.find(site => options.lowLevel ? site.callKind === 'low-level' : site.name.endsWith('::finish'));
  draft.sources = [caller, callee, constructor, declaration];
  draft.evidence = [note(caller, 'call', call.line), note(callee, 'guard', callee.source.line + 1, 'contradicts'),
    note(constructor, 'construction', constructor.source.line + 1), note(declaration, 'immutable', declaration.source.line)];
  const ids = draft.evidence.map(item => item.id);
  draft.causal.events[0].callSiteId = call.id; draft.causal.events[0].receiver = 'Caller';
  draft.causal.events[1].receiver = call.receiverExpression; draft.causal.events[1].caller = 'Caller';
  if (options.lowLevel) draft.causal.events[1].inputs = [];
  const link = draft.causal.relationships[0];
  link.callSiteId = call.id; link.evidence = ids;
  link.dispatch = { kind: 'local-instance', receiver: call.receiverExpression, implementation: callee.id, evidence: ids, context: 'call', failure: options.caught ? 'caught' : call.failure };
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key, reason: 'Independently read fixture: immutable is constructed with exactly this new Guard implementation.', evidence: ids, documentation: [] }));
  return { draft, catalog, call };
}

test('a checked immutable construction establishes an ABI-compatible implementation absent from static candidates', { skip: !native }, async t => {
  const { draft, call } = await dispatchFixture(t);
  assert.equal(call.targets.length, 0, 'Guard does not explicitly implement IGuard; static candidates do not establish it.');
  assert.deepEqual(call.declarations[0].signature, 'finish(bool)');
  const result = policy.gate(draft);
  assert.equal(result.ready, true, result.problems.join('\n'));
  const fullEvidence = draft.causal.relationships[0].evidence;
  draft.causal.relationships[0].evidence = ['call', 'guard'];
  assert.match(policy.gate(draft).problems.join('\n'), /every receiver\/implementation premise/);
  draft.causal.relationships[0].evidence = fullEvidence;
  draft.causal.relationships[0].dispatch.evidence = ['call', 'guard'];
  assert.match(policy.gate(draft).problems.join('\n'), /checked local construction/);
});

test('unknown or mutable receiver bindings and incompatible selectors remain unresolved', { skip: !native }, async t => {
  const mutable = await dispatchFixture(t, { mutable: true });
  assert.match(policy.gate(mutable.draft).problems.join('\n'), /checked local construction/);
  const known = await dispatchFixture(t);
  known.call.declarations[0].signature = 'finish(uint256)';
  assert.match(policy.gate(known.draft).problems.join('\n'), /compatible selector/);
  const unresolved = await dispatchFixture(t);
  unresolved.draft.causal.relationships[0].dispatch.kind = 'unresolved';
  assert.match(policy.gate(unresolved.draft).problems.join('\n'), /implementation remains unresolved/);
  unresolved.draft.causal.relationships[0].dispatch.kind = 'observed-external';
  assert.ok(policy.gate(unresolved.draft).details.some(problem => problem.kind === 'capability' && /verified deployment\/code identity/.test(problem.reason)),
    'A missing external observation is not mislabeled as a model-reference repair.');
});

test('an inline immutable construction is checked as a binding, not an executed declaration frame', { skip: !native }, async t => {
  const { draft } = await dispatchFixture(t, { inline: true });
  const declaration = draft.sources.find(unit => unit.id === 'declaration');
  assert.equal(declaration.contextKind, 'state');
  assert.equal(declaration.relatedCalls.length, 1); assert.equal(declaration.relatedCalls[0].callKind, 'creation');
  draft.causal.relationships[0].dispatch.evidence = ['call', 'guard', 'immutable'];
  assert.equal(policy.gate(draft).ready, true, policy.gate(draft).problems.join('\n'));
  declaration.relatedCalls[0].creationTargets = [];
  assert.match(policy.gate(draft).problems.join('\n'), /checked local construction/);
});

test('named arguments bind interface names to concrete parameter positions without text guessing', { skip: !native }, async t => {
  const { draft, call } = await dispatchFixture(t, { named: true });
  assert.equal(call.argumentSpans[0].name, 'declaredName');
  assert.equal(draft.causal.events[1].inputs[0].name, 'accepted');
  assert.equal(policy.gate(draft).ready, true, policy.gate(draft).problems.join('\n'));
});

test('known empty-calldata receive and caught failures keep execution context and rollback scope explicit', { skip: !native }, async t => {
  const receive = await dispatchFixture(t, { lowLevel: true });
  receive.draft.causal.events[0].effect = 'committed';
  assert.equal(receive.call.failure, 'returns-status');
  assert.equal(policy.gate(receive.draft).ready, true, policy.gate(receive.draft).problems.join('\n'));
  receive.draft.causal.relationships[0].dispatch.evidence = ['call', 'guard'];
  assert.match(policy.gate(receive.draft).problems.join('\n'), /checked local construction/);
  const caught = await dispatchFixture(t, { caught: true });
  caught.draft.causal.events[0].effect = 'committed';
  assert.equal(caught.call.failure, 'try-catch', 'Static syntax does not establish which failure a catch actually handles.');
  assert.equal(policy.gate(caught.draft).ready, true, policy.gate(caught.draft).problems.join('\n'));
  caught.draft.causal.relationships[0].dispatch.failure = 'propagates';
  assert.match(policy.gate(caught.draft).problems.join('\n'), /failure handling is caught/);
});

test('a callback still needs exact receiver dispatch, caller identity and the same transaction', { skip: !native }, async t => {
  const { draft } = await dispatchFixture(t), link = draft.causal.relationships[0];
  link.kind = 'callback';
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key, reason: 'A callback is the same exact checked EVM call, not an inferred graph neighbor.', evidence: draft.evidence.map(item => item.id), documentation: [] }));
  assert.equal(policy.gate(draft).ready, true, policy.gate(draft).problems.join('\n'));
  draft.causal.events[1].caller = 'Owner';
  assert.match(policy.gate(draft).problems.join('\n'), /callee's EVM msg.sender/);
  draft.causal.events[1].caller = 'Caller'; draft.causal.events[1].transaction = 'later';
  assert.match(policy.gate(draft).problems.join('\n'), /across transactions/);
});

test('casts, strings and comments do not become call obligations; fallback bodies remain available', { skip: !native }, async t => {
  const catalog = await sourceFixture(t, `pragma solidity ^0.8.20;
contract Words {
 fallback() external payable {
  // ghost.foo{value: 1}(false);
  string memory note = "fake.bar(true)";
  address target = address(uint160(123));
  target.call{gas: 25000}("");
 }
}
`), fn = catalog.named('fallback')[0];
  assert.ok(fn); assert.match(catalog.code(fn), /ghost.foo/);
  const calls = catalog.callLinks(fn);
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, 'target');
  assert.equal(calls[0].options[0].name, 'gas'); assert.equal(calls[0].options[0].expression, '25000');
  assert.equal(catalog.resolveCard({ file: 'src/Calls.sol', line: fn.startLine, function: 'fallback' }).name, 'fallback');
});

test('a contract method named call is not an address low-level call', { skip: !native }, async t => {
  const catalog = await sourceFixture(t, `pragma solidity ^0.8.20;
contract Named {
 function call(uint256 value) external { require(value > 0); }
}
contract Caller {
 Named target;
 function enter() external { target.call(1); }
}
`), fn = catalog.named('enter')[0], [site] = catalog.callLinks(fn);
  assert.equal(site.callKind, 'member'); assert.equal(site.failure, 'propagates');
  const stored = unit(catalog, fn, 'caller');
  assert.equal(bindings.exactSite(stored, site.id).callKind, 'member');
});

module.exports = { callDraft, dispatchFixture };

// These intentionally incorrect controlled responses exercise the production
// location/challenge/publication path. A model agreeing with itself must not
// override independently read Solidity semantics.
function checkedPipeline(draft, selectors = false) {
  const engine = require('../extension/investigation-engine');
  const output = {
    property: draft.property,
    claims: draft.claims.map(claim => ({ ...claim, allegation: 'The described invocation rejects the request.',
      actor: 'Caller', entry: 'caller', implementation: 'The supplied local fixture only.',
      conditions: ['Only the explicitly described source invocation.'], reason: 'Check exact source semantics.',
      evidence: draft.evidence.map(item => item.id), requiredFacts: [], supportsIf: '', contradictsIf: '', nextQuestion: '' })),
    evidence: draft.evidence.map(item => ({ ...item, line: item.source.line, endLine: item.source.endLine, explanation: item.note })),
    transitions: [], questions: [], conclusion: { status: draft.causal.outcome === 'supported' ? 'supported-in-scope' : 'contradicted-in-scope', text: 'Controlled source interpretation.', limitations: [] },
    walkthrough: draft.walkthrough, causal: draft.causal, inputReviews: draft.inputReviews || [],
    explanationReviews: draft.evidence.map(item => ({ evidenceId: item.id, result: 'kept',
      reason: 'Controlled response covers the cited function; host semantic checks must still reject a false explanation.',
      checkedSourceIds: draft.sources.map(unit => unit.id) }))
  };
  const base = { ...draft, corrections: [], experiments: [] };
  const first = engine.accept(output, base, draft.sources);
  let reviewed = output;
  if (selectors) {
    const binding = require('../extension/source-bindings'), format = require('../extension/challenge-format'), schema = require('../extension/semantic-provider').schema;
    const plan = { entries: [], links: [], inputs: [] };
    for (const link of draft.causal.relationships.filter(link => ['call', 'callback'].includes(link.kind))) {
      const from = draft.causal.events.find(event => event.id === link.from), to = draft.causal.events.find(event => event.id === link.to);
      const source = draft.sources.find(unit => unit.id === draft.evidence.find(note => note.id === from.evidenceId).sourceId);
      const destination = draft.sources.find(unit => unit.id === link.dispatch.implementation), id = `entry-${to.invocationId}`;
      plan.entries.push({ id, callerEventId: from.id, calleeEventId: to.id, sourceId: source.id, sourceHash: source.source.sourceHash,
        callSiteId: link.callSiteId, implementationSourceId: destination.id, kind: link.dispatch.kind, context: link.dispatch.context,
        failure: link.dispatch.failure, evidence: link.dispatch.evidence });
      for (const related of draft.causal.relationships.filter(item => item === link || item.kind === 'return' && item.callSiteId === link.callSiteId && draft.causal.events.find(event => event.id === item.from).invocationId === to.invocationId))
        plan.links.push({ key: `${related.from}->${related.to}:${related.kind}`, entryBindingId: id });
      for (const [index, input] of to.inputs.entries()) plan.inputs.push({ eventId: to.id, index, entryBindingId: id,
        parameterIndex: bindings.parameterSpans(destination.code, destination.name.split('::').at(-1)).findIndex(p => p.name === input.name) });
    }
    reviewed = binding.wire(format.earlier({ ...base, ...first }, schema), plan);
    reviewed.explanationReviews = output.explanationReviews;
    assert.ok(format.valid(reviewed, binding.schema(schema)));
    if (typeof selectors === 'function') selectors(reviewed);
  }
  const checked = engine.checkExplanations(reviewed, first, engine.accept(reviewed, base, draft.sources), draft.sources);
  const accepted = { ...base, ...checked };
  accepted.publication = policy.gate(accepted); accepted.publication.digest = policy.digest(accepted);
  return { accepted, gate: accepted.publication, exposed: policy.expose(accepted) };
}

test('native selected IDs compile one entry and matching return, retaining full semantic rejection controls', { skip: !native }, async t => {
  for (const [name, options, ready] of [
    ['handled-string', { catches: 'catch Error(string memory) {}' }, true],
    ['catch-return', { catches: 'catch Error(string memory) { return false; }', returns: true, catchReturn: true }, true],
    ['unmatched-panic', { catches: 'catch Panic(uint256) {}' }, false],
    ['empty-payload', { helper: 'function reject() internal pure { require(false); }', guard: 'reject();\n  require(accepted, "rejected");', failureNeedle: 'reject();', catches: 'catch Error(string memory) {}' }, false],
    ['unreachable', { entryParameter: 'bool flag', entrySetup: 'if (!flag) return false;', returns: true, catches: 'catch Error(string memory) {}' }, false],
    ['shadowed', { shadow: true }, false],
    ['input-drift', { drift: true }, false],
    ['propagates', { continues: false }, true]
  ]) await t.test(name, async t => {
    const { draft } = await semanticFixture(t, options), result = checkedPipeline(draft, true);
    assert.equal(result.gate.ready, ready, result.gate.problems.join('\n'));
    assert.equal(!!result.exposed.causal, ready);
    assert.ok(result.accepted.bindingPlan.entries.length);
    assert.equal(result.accepted.causal.events[0].anchor.source.line, draft.causal.events[0].callSiteId && draft.sources[0].relatedCalls.find(site => site.id === draft.causal.events[0].callSiteId).span.line);
    const returned = result.accepted.causal.relationships.find(link => link.kind === 'return');
    if (returned) assert.deepEqual(returned.dispatch, result.accepted.causal.relationships[0].dispatch);
    const tampered = structuredClone(result.accepted); tampered.causal.events[0].anchor.source.line++;
    assert.equal(policy.gate(tampered).ready, false);
    assert.equal(draft.evidence[0].source.line, result.accepted.evidence[0].source.line, 'The analytical note is never moved.');
  });
});
test('source selectors reject stale identities before publication and preserve reviewed replay without mutation', { skip: !native }, async t => {
  const { draft } = await semanticFixture(t, { catches: 'catch Error(string memory) {}' });
  for (const [field, value] of [['sourceId', 'missing'], ['sourceHash', 'stale'], ['callSiteId', 'neighbor'], ['implementationSourceId', 'absent']])
    assert.throws(() => checkedPipeline(draft, wire => { wire.causal.entryBindings[0][field] = value; }), error => error.code === 'BINDING_SOURCE_STALE', field);
  assert.throws(() => checkedPipeline(draft, wire => { wire.causal.events[1].inputs[0].parameterIndex = 99; }), error => error.code === 'BINDING_PARAMETER');
  const result = checkedPipeline(draft, true), binding = require('../extension/source-bindings'), format = require('../extension/challenge-format'), schema = require('../extension/semantic-provider').schema;
  assert.throws(() => binding.compile({ bindingFormat: 'unknown' }, draft.sources), error => error.code === 'BINDING_VERSION');
  assert.throws(() => require('../extension/investigation-engine').accept({ bindingFormat: 'unknown' }, draft, draft.sources), error => error.code === 'BINDING_VERSION');
  const future = structuredClone(result.accepted); future.bindingPlan.version = 'unknown'; assert.ok(binding.integrity(future).length);
  const earlier = binding.wire(format.earlier(result.accepted, schema), result.accepted.bindingPlan);
  const input = { phase: 'challenge', bindingFormat: binding.VERSION, earlierDraft: earlier,
    sources: draft.sources.map(unit => ({ id: unit.id, file: unit.source.file, line: unit.source.line, endLine: unit.source.endLine,
      code: unit.code.split('\n').map((line, index) => `${unit.source.line + index} | ${line}`).join('\n') })) };
  const response = structuredClone(earlier); response.explanationReviews = result.accepted.explanationReviews.map(({ evidenceId, result, reason, checkedSourceIds }) => ({ evidenceId, result, reason, checkedSourceIds }));
  const replay = require('../scripts/replay-review').replayReview({ saved: result.accepted, input, response, units: draft.sources });
  assert.equal(replay.fullSchema, true, JSON.stringify(replay.errors)); assert.deepEqual(replay.errors, []); assert.equal(replay.gate.ready, true, JSON.stringify(replay.gate.problems)); assert.equal(replay.inputsUnchanged, true);
});
async function semanticFixture(t, options = {}) {
  const local = options.local !== undefined;
  const source = `pragma solidity ^0.8.20;
interface IGuard { function finish(bool accepted) external; }
contract Other { function finish(bool accepted) external {} }
contract Guard {
 error Rejected();
 ${options.state || ''}
 function finish(bool accepted) external {
  ${options.reassign ? (typeof options.reassign === 'string' ? options.reassign : 'accepted = false;') + '\n  ' : ''}${options.guard || 'require(accepted, "rejected");'}
 }
 ${options.helper || ''}
}
contract ${options.inherited ? 'Base' : 'Caller'}${options.unavailableBase ? ' is MissingBase' : ''} {
 IGuard immutable guard${options.shadow ? ' = IGuard(address(new Other()))' : ''};
 ${options.inherited ? '' : 'bool completed;'}
 constructor(${options.shadow ? 'IGuard guard' : ''}) {
  guard = IGuard(address(new Guard()));
 }
 ${options.inherited ? '}\ncontract Caller is Base {\n bool completed;' : ''}
 function enter(${options.entryParameter || (options.unknown ? 'bool unknown' : '')}) external ${options.returns ? 'returns (bool)' : ''}{
  ${options.entrySetup ? options.entrySetup + '\n  ' : ''}${local ? 'IGuard guard = IGuard(address(new Guard()));\n  ' + options.local + '\n  ' : ''}${options.catches !== undefined ? `try guard.finish(${options.argument || (options.unknown ? 'unknown' : 'false')}) {} ` + options.catches : `guard.finish(${options.drift ? 'true' : 'false'});`}
  ${options.drift ? 'guard.finish(false);' : ''}
  ${options.continuationSetup || ''}
  completed = true;
  ${options.returns ? 'return true;' : ''}
 }
}`;
  const catalog = await sourceFixture(t, source);
  const caller = unit(catalog, catalog.named('enter')[0], 'caller');
  const callee = unit(catalog, catalog.named('finish').find(fn => fn.contract === 'Guard'), 'callee');
  const constructor = unit(catalog, catalog.named('constructor')[0], 'constructor');
  const declaration = unit(catalog, catalog.stateDeclarations('src/Calls.sol', options.inherited ? 'Base' : 'Caller').find(fn => /\bguard\b/.test(catalog.code(fn))), 'declaration');
  const call = caller.relatedCalls.find(site => site.name.endsWith('::finish'));
  const draft = callDraft('    finish(false);');
  draft.sources = [caller, callee, constructor, declaration];
  if (options.helper) draft.sources.push(unit(catalog, catalog.named('reject')[0], 'helper'));
  const lineOf = (unit, text) => unit.source.line + unit.code.split('\n').findIndex(line => line.includes(text));
  draft.evidence = [note(caller, 'call', call.line), note(callee, 'guard', lineOf(callee, options.failureNeedle || options.guard || 'require('), 'contradicts'),
    note(constructor, 'construction', lineOf(constructor, 'guard =')), note(declaration, 'immutable', declaration.source.line),
    note(caller, 'continuation', lineOf(caller, 'completed ='))];
  if (local) draft.evidence.push(note(caller, 'local-binding', lineOf(caller, 'IGuard guard =')));
  if (options.reassign) draft.evidence.push(note(callee, 'assignment', lineOf(callee, typeof options.reassign === 'string' ? options.reassign : 'accepted = false')));
  if (options.entrySetup) draft.evidence.push(note(caller, 'entry-assignment', lineOf(caller, options.entrySetup)));
  if (options.helper) draft.evidence.push(note(draft.sources.at(-1), 'helper-effect', draft.sources.at(-1).source.line));
  const ids = draft.evidence.map(item => item.id), [entry, finish] = draft.causal.events;
  entry.callSiteId = call.id; entry.receiver = 'Caller';
  finish.receiver = 'guard'; finish.caller = 'Caller';
  if (options.unknown) finish.inputs[0].expression = 'unknown';
  if (options.argument) finish.inputs[0].expression = options.argument;
  if (options.entryParameter) entry.inputs = [{ name: 'flag', expression: options.entryValue || 'false', type: 'bool', units: 'boolean', origin: 'The displayed call-time input; the external entry premise may be changed by earlier source.', evidence: ['call', 'entry-assignment'] }];
  if (options.success) finish.effect = 'condition';
  if (options.drift) {
    finish.effect = 'condition'; finish.inputs[0].expression = 'true';
    draft.causal.events.push({ ...structuredClone(finish), id: 'later-check', title: 'Reject inside the same invocation',
      effect: 'rolled-back', inputs: [{ ...finish.inputs[0], expression: 'false', evidence: options.reassign ? ['call', 'guard', 'assignment'] : ['call', 'guard'] }] });
    draft.causal.order.push('later-check');
    draft.causal.relationships.push({ from: 'finish', to: 'later-check', kind: 'branch', callSiteId: '',
      dispatch: { kind: 'not-applicable', receiver: '', implementation: '', evidence: [], context: 'none', failure: 'not-applicable' },
      binding: 'Inspect the same invocation.', explanation: 'Read the next condition.', evidence: ids });
  }
  const link = draft.causal.relationships[0]; link.callSiteId = call.id; link.evidence = ids;
  link.dispatch = { kind: 'local-instance', receiver: 'guard', implementation: 'callee', evidence: ids, context: 'call', failure: options.success ? 'not-applicable' : options.catchReturn ? 'caught-return' : options.continues === false ? 'propagates' : options.catches !== undefined ? 'caught' : call.failure };
  if (options.catches !== undefined && options.continues !== false) {
    draft.causal.events.push({ ...entry, inputs: [], id: 'after-catch', title: 'Commit after the handled failure', evidenceId: 'continuation', callSiteId: '', effect: 'committed' });
    draft.causal.order.push('after-catch');
    draft.causal.relationships.push({ ...structuredClone(link), from: 'finish', to: 'after-catch', kind: 'return', explanation: 'Continue after handling the callee failure.' });
    if (options.catchReturn) {
      draft.evidence.find(item => item.id === 'continuation').source = { ...draft.evidence.find(item => item.id === 'call').source };
      draft.evidence.find(item => item.id === 'continuation').quote = draft.evidence.find(item => item.id === 'call').quote;
      Object.assign(draft.causal.events.at(-1), { effect: 'return', title: 'The matching catch returns false from the caller' });
    }
  }
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key,
    reason: 'Controlled challenge claims complete coverage; deterministic Solidity checks must independently agree.', evidence: ids, documentation: [] }));
  return { draft, catalog, call, result: checkedPipeline(draft) };
}

function savedBoolean(draft, value, eventIds) {
  draft.semanticInput = require('../extension/semantic-input').input({ finding: {
    title: 'Inspect the fixture guard', preconditions: [`accepted is ${value}`]
  } }, { reportText: 'Inspect the fixture guard.' });
  draft.inputReviews = [{ id: draft.semanticInput.premises[0].id, status: 'applied',
    reason: 'Controlled saved-input review; actual scope and values still need independent source checks.',
    claimIds: ['c1'], eventIds, evidence: draft.evidence.map(item => item.id) }];
}
test('a saved condition cannot be acknowledged at an unrelated event while retaining the old contrary explanation', { skip: !native }, async t => {
  const { draft, result } = await semanticFixture(t);
  assert.equal(result.gate.ready, true, result.gate.problems.join('\n'));
  savedBoolean(draft, true, ['entry']);
  assert.throws(() => checkedPipeline(draft), /applied saved condition accepted is true needs an affected step/);
  draft.inputReviews[0].eventIds = ['finish'];
  assert.throws(() => checkedPipeline(draft), /contradicts the applied saved condition/);
  savedBoolean(draft, false, ['finish']);
  const consistent = checkedPipeline(draft);
  assert.equal(consistent.gate.ready, true, consistent.gate.problems.join('\n'));
  assert.ok(consistent.exposed.causal);
});

test('saved conditions cover dependent invocation steps while allowing a checked later parameter assignment', { skip: !native }, async t => {
  for (const reassign of [false, true]) {
    const { draft } = await semanticFixture(t, { drift: true, reassign });
    const callee = draft.sources.find(unit => unit.id === 'callee');
    draft.evidence.push(note(callee, 'parameter-entry', callee.source.line));
    draft.causal.events.find(event => event.id === 'finish').evidenceId = 'parameter-entry';
    const ids = draft.evidence.map(item => item.id);
    draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key,
      reason: 'Entry passes true. Only an actual cited assignment can later replace it.', evidence: ids, documentation: [] }));
    savedBoolean(draft, true, ['finish']);
    if (!reassign) assert.throws(() => checkedPipeline(draft), /Step later-check contradicts the applied saved condition/);
    else {
      const consistent = checkedPipeline(draft);
      assert.equal(consistent.gate.ready, true, consistent.gate.problems.join('\n'));
      assert.ok(consistent.exposed.causal, 'A precondition is not a promise that a mutable parameter can never change.');
    }
  }
});

test('current-source validation rebuilds saved initialization metadata instead of trusting constructor absence', { skip: !native }, async t => {
  const { draft, catalog } = await dispatchFixture(t, { inline: true });
  const engine = require('../extension/investigation-engine');
  draft.snapshot.documentation = require('../extension/workspace-snapshot').validate(catalog).documentation.digest;
  engine.validateCurrent(catalog, draft);
  draft.sources = draft.sources.filter(unit => unit.id !== 'constructor');
  draft.evidence = draft.evidence.filter(item => item.id !== 'construction');
  const removeConstruction = value => Array.isArray(value) ? value.filter(item => item !== 'construction').map(removeConstruction) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, removeConstruction(item)])) : value;
  draft.causal = removeConstruction(draft.causal);
  assert.match(policy.gate(draft).problems.join('\n'), /Available constructor code remains unread/);
  const caller = draft.sources.find(unit => unit.id === 'caller');
  const canonical = structuredClone(caller.initialization);
  caller.initialization.scopes.forEach(scope => { scope.constructors = []; scope.constructorAbsent = true; });
  assert.throws(() => engine.validateCurrent(catalog, draft), /receiver initialization metadata/);
  caller.initialization = canonical;
  caller.initialization.scopes[0].sourceHash = 'b'.repeat(64);
  assert.throws(() => engine.validateCurrent(catalog, draft), /receiver initialization metadata/);
});

test('production acceptance rejects overwritten or shadowed local receiver proofs', { skip: !native }, async t => {
  for (const [name, options] of [
    ['tuple assignment changes local receiver', { local: '(guard,) = (IGuard(address(new Other())), 1);' }],
    ['delete clears local receiver', { local: 'delete guard;' }],
    ['constructor parameter shadows the immutable', { shadow: true }]
  ]) await t.test(name, async t => {
    const { result } = await semanticFixture(t, options);
    assert.equal(result.gate.ready, false, 'The current exact quote and an agreeing challenge cannot certify the wrong receiver.');
    assert.equal(result.exposed.causal, undefined);
    assert.match(result.gate.problems.join('\n'), /binding|construction|receiver/);
  });
  for (const options of [{ local: '' }, {}]) {
    const { result } = await semanticFixture(t, options);
    assert.equal(result.gate.ready, true, result.gate.problems.join('\n'));
  }
});

test('production acceptance checks typed catches and a continuing matching catch body', { skip: !native }, async t => {
  for (const catches of ['catch Panic(uint256) {}', 'catch Error(string memory) { revert("again"); }']) await t.test(catches, async t => {
    const { result } = await semanticFixture(t, { catches });
    assert.equal(result.gate.ready, false, 'Error(string) must match a continuing catch; a mere catch keyword proves neither.');
    assert.equal(result.exposed.causal, undefined);
  });
  for (const catches of ['catch Error(string memory) {}', 'catch Panic(uint256) {} catch {}']) {
    const { result } = await semanticFixture(t, { catches });
    assert.equal(result.gate.ready, true, result.gate.problems.join('\n'));
  }
});

test('conditional custom errors need a reachable source path, not a matching error class', { skip: !native }, async t => {
  const bad = await semanticFixture(t, { guard: 'if (accepted) {\n   revert Rejected();\n  }', failureNeedle: 'revert Rejected', catches: 'catch {}' });
  assert.equal(bad.result.gate.ready, false, 'accepted=false cannot execute the nested custom revert.');
  assert.equal(bad.result.exposed.causal, undefined);
  const good = await semanticFixture(t, { guard: 'revert Rejected();', catches: 'catch {}' });
  assert.equal(good.result.gate.ready, true, good.result.gate.problems.join('\n'));
  const chosen = await semanticFixture(t, { guard: 'if (!accepted) {\n   revert Rejected();\n  }', failureNeedle: 'revert Rejected', catches: 'catch {}' });
  assert.equal(chosen.result.gate.ready, true, chosen.result.gate.problems.join('\n'));
  const unknown = await semanticFixture(t, { unknown: true, guard: 'if (accepted) {\n   revert Rejected();\n  }', failureNeedle: 'revert Rejected', catches: 'catch {}' });
  assert.equal(unknown.result.gate.ready, false);
});
test('the first displayed root call uses preceding assignments instead of its entry premise', { skip: !native }, async t => {
  const { result } = await semanticFixture(t, { entryParameter: 'bool flag', entrySetup: 'flag = true;', argument: 'flag',
    catches: 'catch Error(string memory) {}', returns: true });
  assert.equal(result.gate.ready, false, 'The explicit flag=true write defeats the claimed require failure.');
  assert.equal(result.exposed.causal, undefined);
  const success = await semanticFixture(t, { entryParameter: 'bool flag', entrySetup: 'flag = true;', argument: 'flag',
    entryValue: 'true', success: true, catches: 'catch Error(string memory) {}', returns: true });
  assert.equal(success.result.gate.ready, true, success.result.gate.problems.join('\n'));
});
test('a displayed call must be reachable past the earlier caller return', { skip: !native }, async t => {
  for (const flag of ['false', 'true']) {
    const { result } = await semanticFixture(t, { entryParameter: 'bool flag', entryValue: flag,
      entrySetup: 'if (!flag) return false;', catches: 'catch Error(string memory) {}', returns: true });
    assert.equal(result.gate.ready, flag === 'true', result.gate.problems.join('\n') || 'A false flag returns before the call.');
    assert.equal(!!result.exposed.causal, flag === 'true');
  }
});
test('earlier internal helper effects cannot be skipped to select a later failure', { skip: !native }, async t => {
  for (const [body, ready] of [['assert(false);', false], ['assert(true);', true], ['return;', true]]) {
    const { result } = await semanticFixture(t, { guard: 'reject();\n  require(accepted, "rejected");', failureNeedle: 'require(',
      helper: `function reject() internal pure { ${body} }`, catches: 'catch Error(string memory) {}' });
    assert.equal(result.gate.ready, ready, result.gate.problems.join('\n') || `The preceding helper executes ${body}`);
    assert.equal(!!result.exposed.causal, ready);
  }
  for (const [catches, ready] of [['catch Panic(uint256) {}', true], ['catch Error(string memory) {}', false]]) {
    const { result } = await semanticFixture(t, { guard: 'reject();\n  require(accepted, "rejected");', failureNeedle: 'reject();',
      helper: 'function reject() internal pure { assert(false); }', catches });
    assert.equal(result.gate.ready, ready, result.gate.problems.join('\n'));
  }
});
test('helper failure data must match the actual catch, just as direct failures do', { skip: !native }, async t => {
  for (const body of ['require(false);', 'revert();', 'require(false, "rejected");', 'revert("rejected");', 'assert(false);', 'revert Rejected();', 'string memory reason = "rejected"; require(false, reason);']) {
    for (const catches of ['catch Error(string memory) {}', 'catch {}']) {
      const expected = catches === 'catch {}' || body.includes('"rejected"');
      const { result } = await semanticFixture(t, { guard:'reject();\n  require(accepted, "rejected");', failureNeedle:'reject();',
        helper:`function reject() internal pure { ${body} }`, catches });
      assert.equal(result.gate.ready, expected, `${body} / ${catches}: ${result.gate.problems.join('; ')}`);
      assert.equal(!!result.exposed.causal, expected);
    }
  }
  const direct = await semanticFixture(t, { guard:'require(false);', catches:'catch Error(string memory) {}' });
  assert.equal(direct.result.gate.ready, false); assert.equal(!!direct.result.exposed.causal, false);
  for (const body of ['require(false);', 'revert();']) {
    const propagation = await semanticFixture(t, { guard:'reject();\n  require(accepted, "rejected");', failureNeedle:'reject();',
      helper:`function reject() internal pure { ${body} }`, catches:'catch Error(string memory) {}', continues:false });
    assert.equal(propagation.result.gate.ready, true, propagation.result.gate.problems.join('; '));
    assert.ok(propagation.result.exposed.causal, 'The correct propagation route remains publishable without a fabricated later commit.');
  }
  const unresolved = await semanticFixture(t, { guard:'reject();\n  require(accepted, "rejected");', failureNeedle:'reject();',
    helper:'function reject() internal pure { require(false, string.concat("a", "b")); }', catches:'catch Error(string memory) {}' });
  assert.equal(unresolved.result.gate.ready, false, 'An unsupported payload operation is not defaulted to Error.');
});
test('sealed v8 helper guides are locally rechecked, preserving valid catches and withholding the old empty/Error mistake', { skip: !native }, async t => {
  const engine = require('../extension/investigation-engine');
  for (const catches of ['catch Error(string memory) {}', 'catch {}']) {
    const f = await semanticFixture(t, { guard:'reject();\n  require(accepted, "rejected");', failureNeedle:'reject();',
      helper:'function reject() internal pure { require(false); }', catches });
    const request = { finding:{ title:'Check a helper failure', summary:'Inspect whether the handled failure permits continuation.' } };
    const issue = { reportText:request.finding.summary };
    const saved = f.result.accepted, causal = structuredClone(saved.causal);
    saved.snapshot = { ...engine.snapshot(f.catalog, request, issue), policy:'checked-explanation-v8' };
    saved.semanticInput = require('../extension/semantic-input').input(request, issue);
    saved.publication = { ...saved.publication, ready:true, policy:'checked-explanation-v8' };
    saved.publication.digest = policy.digest(saved);
    const migrated = engine.migrateChecked(saved, f.catalog, request, issue);
    assert.equal(migrated, catches === 'catch {}');
    assert.deepEqual(saved.causal, causal, 'Local review never edits the paid causal explanation.');
    assert.equal(!!policy.expose(saved).causal, catches === 'catch {}');
  }
});
test('local helper arguments, unavailable effects, and caller continuation are checked independently of display order', { skip: !native }, async t => {
  for (const [argument, ready] of [['false', false], ['true', true]]) {
    const { result } = await semanticFixture(t, { guard: `reject(${argument});\n  require(accepted, "rejected");`, failureNeedle: 'require(',
      helper: 'function reject(bool ok) internal pure { assert(ok); }', catches: 'catch Error(string memory) {}' });
    assert.equal(result.gate.ready, ready, result.gate.problems.join('\n'));
  }
  const missing = await semanticFixture(t, { guard: 'reject();\n  require(accepted, "rejected");', failureNeedle: 'require(',
    helper: 'function reject() internal pure { assert(true); }', catches: 'catch Error(string memory) {}' });
  missing.draft.sources = missing.draft.sources.filter(unit => unit.id !== 'helper');
  missing.draft.evidence = missing.draft.evidence.filter(item => item.id !== 'helper-effect');
  assert.equal(policy.gate(missing.draft).ready, false, 'An unread helper is not affirmative fallthrough.');
  for (const flag of ['false', 'true']) {
    const { result } = await semanticFixture(t, { entryParameter: 'bool flag', entryValue: flag, entrySetup: 'if (false) return false;',
      continuationSetup: 'if (!flag) return false;', catches: 'catch Error(string memory) {}', returns: true });
    assert.equal(result.gate.ready, flag === 'true', result.gate.problems.join('\n'));
  }
});
test('a supported bookkeeping report keeps the caller, false parameter and committed write in its checked explanation', { skip: !native }, async t => {
  const { draft } = await semanticFixture(t, { state:'bool public recorded;', guard:'recorded = true;', success:true,
    catches:'catch Error(string memory) {}', returns:true });
  draft.documentation = { excerpts:[{ id:'rule', text:'Record a request only when its accepted input is true.', file:'docs/recording.md', line:1, endLine:1 }] };
  draft.property = { text:'Only an accepted request may be recorded.', basis:'local-documentation', evidence:[], documentation:['rule'] };
  draft.claims[0].status='supported'; draft.causal.outcome='supported';
  draft.walkthrough.assessment={result:'valid',why:'The local recording rule requires true. The function records the supplied false request instead.',supportingEvidence:'guard',opposingEvidence:''};
  const write=draft.evidence.find(item=>item.id==='guard');write.stance='supports';write.note='recorded becomes true without testing accepted. This violates the supplied local recording rule for this false request.';
  const event=draft.causal.events.find(item=>item.id==='finish');
  Object.assign(event,{title:'Record despite the false input',what:write.note,why:'The caller supplies false, but the function writes true.',effect:'committed',
    changes:[{name:'recorded',before:'false in this scenario',operation:'assign true',after:'true on this successful path',units:'boolean',evidence:['guard']}]});
  const result=checkedPipeline(draft);
  assert.equal(result.gate.ready,true,result.gate.problems.join('\n'));assert.ok(result.exposed.causal);
  assert.equal(result.exposed.causal.events[1].inputs[0].expression,'false');
  assert.equal(result.exposed.causal.events[1].changes[0].after,'true on this successful path');
});
test('root input literals survive entry checks without being replaced by their parameter name', { skip: !native }, async t => {
  const { draft } = await semanticFixture(t);
  const finish = draft.causal.events.find(event => event.id === 'finish');
  // A report may start at the external function itself. No caller in the
  // reading route does not erase the explicitly chosen entry input.
  finish.inputs[0].evidence = ['guard'];
  const later = { ...structuredClone(finish), id: 'outcome', title: 'The invocation reverts' };
  draft.causal.events = [finish, later]; draft.causal.order = ['finish', 'outcome'];
  draft.causal.relationships = [{ from: 'finish', to: 'outcome', kind: 'branch',
    explanation: 'The failed guard ends this invocation.', binding: '', evidence: ['guard'], callSiteId: '',
    dispatch: { kind: 'not-applicable', receiver: '', implementation: '', evidence: [], context: 'none', failure: 'not-applicable' } }];
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key,
    reason: 'Checked complete local guard with an unchanged false input.', evidence: draft.evidence.map(item => item.id), documentation: [] }));
  let result = checkedPipeline(draft);
  assert.equal(result.gate.ready, true, result.gate.problems.join('\n'));
  assert.ok(result.exposed.causal);
  later.inputs[0].expression = 'true';
  result = checkedPipeline(draft);
  assert.equal(result.gate.ready, false, 'The same invocation cannot silently change the root input later.');
  assert.equal(result.exposed.causal, undefined);
});
test('a matching catch may return from the caller but cannot reach the later committed write', { skip: !native }, async t => {
  const good = await semanticFixture(t, { catches: 'catch Error(string memory) { return false; }', catchReturn: true, returns: true });
  assert.equal(good.result.gate.ready, true, good.result.gate.problems.join('\n'));
  assert.ok(good.result.exposed.causal);
  const bad = await semanticFixture(t, { catches: 'catch Error(string memory) { return false; }', returns: true });
  assert.equal(bad.result.gate.ready, false);
  assert.equal(bad.result.exposed.causal, undefined);
});
test('a declared string require reason uses Error(string) without knowing the message contents', { skip: !native }, async t => {
  const options = { guard: 'string memory reason = "rejected";\n  require(accepted, reason);', failureNeedle: 'require(accepted' };
  const good = await semanticFixture(t, { ...options, catches: 'catch Error(string memory) {}' });
  assert.equal(good.result.gate.ready, true, good.result.gate.problems.join('\n'));
  const bad = await semanticFixture(t, { ...options, catches: 'catch Panic(uint256) {}' });
  assert.equal(bad.result.gate.ready, false);
});
test('production acceptance conserves invocation inputs unless checked source changes them', { skip: !native }, async t => {
  const drift = await semanticFixture(t, { drift: true });
  assert.equal(drift.result.gate.ready, false, 'The first finish(true) invocation cannot borrow false from the second call.');
  assert.equal(drift.result.exposed.causal, undefined);
  const reassigned = await semanticFixture(t, { drift: true, reassign: true });
  assert.equal(reassigned.result.gate.ready, true, reassigned.result.gate.problems.join('\n'));
});

test('receiver writes are scoped; complex or assembly mutation cannot certify dispatch', { skip: !native }, async t => {
  for (const local of ['delete (guard);', 'if (block.timestamp > 0) { guard = IGuard(address(new Other())); }',
    'assembly { guard := 0 }']) {
    const { result } = await semanticFixture(t, { local });
    assert.equal(result.gate.ready, false, local);
    assert.equal(result.exposed.causal, undefined);
  }
  const nested = await semanticFixture(t, { local: '{ IGuard guard = IGuard(address(new Other())); delete guard; }' });
  assert.equal(nested.result.gate.ready, true, 'An out-of-scope shadow is not a write to the original local declaration. ' + nested.result.gate.problems.join('\n'));
});

test('matching failure class and continuing catch are source-derived, not catch-label agreement', { skip: !native }, async t => {
  for (const options of [
    { catches: 'catch Panic(uint256) {}', continues: false },
    { catches: 'catch Error(string memory) { revert("again"); }', continues: false },
    { catches: 'catch Panic(uint256) {}', guard: 'assert(accepted);' },
    { catches: 'catch (bytes memory) {}', guard: 'revert();' }
  ]) {
    const { result } = await semanticFixture(t, options);
    assert.equal(result.gate.ready, true, JSON.stringify(options) + ': ' + result.gate.problems.join('\n'));
  }
  for (const options of [
    { catches: 'catch Error(string memory) {}', guard: 'assert(accepted);' },
    { catches: 'catch {}', unknown: true },
    { catches: 'catch {}', guard: 'return;' },
    { catches: 'catch Error(string memory) { return; }' },
    { catches: 'catch Error(string memory) { if (block.timestamp > 0) revert("again"); }' }
  ]) {
    const { result } = await semanticFixture(t, options);
    assert.equal(result.gate.ready, false, JSON.stringify(options));
    assert.equal(result.exposed.causal, undefined);
  }
});

test('invocation input checks reject borrowed branches, units and unsupported or uncited mutations', { skip: !native }, async t => {
  for (const reassign of ['(accepted,) = (false, 1);', 'delete accepted;', 'if (block.timestamp > 0) { accepted = false; }']) {
    const { result } = await semanticFixture(t, { drift: true, reassign });
    assert.equal(result.gate.ready, false, reassign);
  }
  const fixture = await semanticFixture(t, { drift: true, reassign: true });
  fixture.draft.causal.events[2].inputs[0].evidence = ['call', 'guard'];
  assert.equal(checkedPipeline(fixture.draft).gate.ready, false, 'The assignment exists but its explanation still needs the exact source evidence.');
  fixture.draft.causal.events[2].inputs[0].evidence.push('assignment');
  fixture.draft.causal.events[2].inputs[0].units = 'wei';
  assert.equal(checkedPipeline(fixture.draft).gate.ready, false, 'A boolean parameter does not silently become wei.');
  const drift = await semanticFixture(t, { drift: true });
  for (const kind of ['context', 'data', 'branch']) {
    drift.draft.causal.relationships[1].kind = kind;
    drift.draft.causal.checks = capacity.targets(drift.draft.causal).map(item => ({ target: item.key,
      reason: 'A contextual edge does not supply another invocation input.', evidence: drift.draft.evidence.map(item => item.id), documentation: [] }));
    assert.equal(checkedPipeline(drift.draft).gate.ready, false, kind);
  }
  drift.draft.causal.events[2].inputs = [];
  drift.draft.causal.events[2].conditions = ['accepted is false'];
  assert.equal(checkedPipeline(drift.draft).gate.ready, false, 'A condition string cannot silently substitute the other invocation input either.');
});

test('try context retains only the matching clauses, exact bodies and no fake catch invocations', { skip: !native }, async t => {
  const { catalog, call } = await semanticFixture(t, { catches: 'catch Panic(uint256 code) {} catch Error(string memory reason) { completed = false; }' });
  const source = catalog.code(catalog.named('enter')[0]);
  assert.equal(call.failure, 'try-catch');
  assert.deepEqual(call.tryContext.clauses.map(clause => clause.kind), ['Panic', 'Error']);
  assert.equal(source.slice(call.tryContext.clauses[1].body.start, call.tryContext.clauses[1].body.end).trim(), 'completed = false;');
  assert.ok(!catalog.callLinks(catalog.named('enter')[0]).some(site => /(?:^|::)(Panic|Error)$/.test(site.name)));
});

test('immutable proof requires every actual constructor scope, including inherited initialization', { skip: !native }, async t => {
  const inherited = await semanticFixture(t, { inherited: true });
  assert.equal(inherited.result.gate.ready, true, inherited.result.gate.problems.join('\n'));
  const metadata = inherited.draft.sources[0].initialization;
  assert.deepEqual(metadata.scopes.map(scope => [scope.contract, scope.constructorAbsent]), [['Caller', true], ['Base', false]]);
  const { draft } = await dispatchFixture(t, { inline: true });
  assert.equal(checkedPipeline(draft).gate.ready, true);
  const remove = sourceId => {
    const removed = new Set(draft.evidence.filter(item => item.sourceId === sourceId).map(item => item.id));
    draft.sources = draft.sources.filter(unit => unit.id !== sourceId);
    draft.evidence = draft.evidence.filter(item => !removed.has(item.id));
    for (const item of [...draft.causal.obligations, ...draft.causal.relationships, ...draft.causal.checks]) item.evidence = item.evidence.filter(id => !removed.has(id));
    for (const link of draft.causal.relationships) link.dispatch.evidence = link.dispatch.evidence.filter(id => !removed.has(id));
  };
  remove('constructor');
  const missing = checkedPipeline(draft);
  assert.equal(missing.gate.ready, false, 'An inline new is not proof that an unread constructor cannot change the immutable.');
  assert.ok(missing.gate.details.some(problem => problem.kind === 'local-reading' && /constructor code remains unread/.test(problem.reason)));
  assert.equal(missing.exposed.causal, undefined);
  const unread = await semanticFixture(t);
  const constructor = unread.draft.sources.find(unit => unit.id === 'constructor'); constructor.readThrough = constructor.source.line - 1;
  assert.equal(checkedPipeline(unread.draft).gate.ready, false);
  const absentBase = await semanticFixture(t, { unavailableBase: true });
  assert.equal(absentBase.result.gate.ready, false);
  assert.match(absentBase.result.gate.problems.join('\n'), /base MissingBase is unavailable/);
});

test('automatic local completion acquires immutable initialization before the challenge', { skip: !native }, async t => {
  const { catalog } = await semanticFixture(t, { inherited: true }), engine = require('../extension/investigation-engine');
  const fn = catalog.named('enter')[0];
  const request = { findingId: 'constructor-context', finding: { title: 'Caller.enter permission check', summary: 'Read the called guard and its initialized receiver.' },
    cards: [{ file: 'src/Calls.sol', line: fn.startLine, function: 'enter' }] };
  const context = engine.makeContext(catalog, request), entry = context.units.find(unit => unit.name === 'Caller::enter');
  const action = context.complete({ claims: [{ entry: entry.id }], evidence: [] });
  assert.ok(context.units.some(unit => unit.name === 'Base::guard (state)'));
  const constructor = context.units.find(unit => unit.name === 'Base::constructor');
  assert.ok(constructor && constructor.code.includes('new Guard()'));
  assert.ok(action.sourceIds.includes(constructor.id), 'Relevant constructor is acquired before another model request.');
  assert.ok(context.units.find(unit => unit.id === entry.id).initialization.scopes.some(scope => scope.contract === 'Caller' && scope.constructorAbsent));
});

test('symbolic argument constraints propagate without rewriting the exact caller expression', { skip: !native }, async t => {
  const { draft } = await semanticFixture(t, { unknown: true, catches: 'catch Error(string memory) {}' });
  draft.causal.events[0].conditions = ['unknown is false'];
  draft.causal.events[1].conditions = ['accepted is false'];
  const result = checkedPipeline(draft);
  assert.equal(result.gate.ready, true, result.gate.problems.join('\n'));
  assert.equal(result.accepted.causal.events[1].inputs[0].expression, 'unknown', 'Scenario constraints do not rewrite the original call argument.');
  draft.causal.events[1].conditions = ['accepted is true'];
  assert.equal(checkedPipeline(draft).gate.ready, false, 'A known caller constraint cannot flip at the callee boundary.');
});

test('later parameter notes retain their own call origin even when another call uses the same value', { skip: !native }, async t => {
  const { draft } = await semanticFixture(t, { drift: true });
  const caller = draft.sources.find(unit => unit.id === 'caller');
  const second = caller.relatedCalls.filter(site => site.name.endsWith('::finish'))[1];
  draft.evidence.push(note(caller, 'other-call', second.line));
  draft.causal.events[2].inputs[0].expression = 'true';
  draft.causal.events[2].inputs[0].evidence = ['guard', 'other-call'];
  draft.causal.events[2].effect = 'condition';
  draft.causal.checks = capacity.targets(draft.causal).map(item => ({ target: item.key, reason: 'Independently check the supplied source origin.', evidence: draft.evidence.map(item => item.id), documentation: [] }));
  const result = checkedPipeline(draft);
  assert.equal(result.gate.ready, false);
  assert.match(result.gate.problems.join('\n'), /retain the exact origin/);
});

test('optioned and ordinary calls never combine receiver, arguments or occurrence', { skip: !native }, async t => {
  const { links } = await fixture(t, '  a.foo{value: msg.value}(x);\n  b.foo(y);');
  assert.equal(links.length, 2, 'No optioned occurrence may disappear.');
  assert.equal(links[0].receiver, 'a'); assert.equal(links[0].arguments, 'x');
  assert.equal(links[0].candidates[0].contract, 'A');
  assert.equal(links[1].receiver, 'b'); assert.equal(links[1].arguments, 'y');
  assert.equal(links[1].candidates[0].contract, 'B');
  assert.notEqual(links[0].line, links[1].line);
});
