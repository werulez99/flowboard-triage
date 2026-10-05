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
  const { links, code } = await fixture(t, '  a.foo{value: msg.value, gas: 50000}(x); b.foo(y);\n  a.foo({value: b.foo(y)});\n  A created = new A{salt: bytes32(x)}();');
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
  link.dispatch = { kind: 'local-instance', receiver: call.receiverExpression, implementation: callee.id, evidence: ids, context: 'call', failure: call.failure };
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
  assert.ok(policy.gate(unresolved.draft).details.some(problem => problem.kind === 'material-evidence' && /verified deployment\/code identity/.test(problem.reason)),
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
  assert.equal(caught.call.failure, 'caught');
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

test('optioned and ordinary calls never combine receiver, arguments or occurrence', { skip: !native }, async t => {
  const { links } = await fixture(t, '  a.foo{value: msg.value}(x);\n  b.foo(y);');
  assert.equal(links.length, 2, 'No optioned occurrence may disappear.');
  assert.equal(links[0].receiver, 'a'); assert.equal(links[0].arguments, 'x');
  assert.equal(links[0].candidates[0].contract, 'A');
  assert.equal(links[1].receiver, 'b'); assert.equal(links[1].arguments, 'y');
  assert.equal(links[1].candidates[0].contract, 'B');
  assert.notEqual(links[0].line, links[1].line);
});
