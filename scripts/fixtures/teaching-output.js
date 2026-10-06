'use strict';
// Fixed defensive interpretations of the source-first-reference.md controls.
// Production never branches on these names. No external request or execution.
const capacity = require('../../extension/review-capacity');
function response(input, name) {
  const spec = {
    time: { contract: 'DeadlineWindow', functions: ['schedule', 'ready'], outcome: 'supported',
      rule: 'The documented integer-clock rule stores startedAt + duration as an absolute deadline.',
      summary: 'Scheduling is meant to wait for a duration after the supplied start. The stored duration lacks the start origin, so comparing it as an absolute deadline can report readiness too early.',
      conditions: ['startedAt is positive and at most 1000000', 'duration is positive and at most 1000', 'ready is read after a successful schedule', 'duration <= clock < startedAt + duration'],
      conclusion: 'Within the supplied clock model, readiness is true in the stated interval while the documented rule requires false. The comparisons agree outside that interval; this source does not establish financial loss or deployed clock settings.',
      notes: [['write', 'schedule', 'deadline = duration;', 'The completed schedule stores only duration. A relative length and an absolute deadline have different origins even though both use clock units.'],
        ['read', 'ready', 'return clock >= deadline;', 'A later read compares the supplied clock with duration, not startedAt + duration. Under duration <= clock < startedAt + duration the actual comparison is true and the documented one is false.']] },
    lifecycle: { contract: 'CheckpointBook', functions: ['update', 'readSnapshot'], outcome: 'refuted',
      rule: 'The report expects an inactive update to preserve the prior snapshot and checkpoint.',
      summary: 'The snapshot is a retained value, not an automatically refreshed measurement. Returning before an assignment preserves that value; it does not clear it.',
      conditions: ['active is false', 'the prior snapshot S is nonzero', 'the prior checkpoint is C'],
      conclusion: 'The inactive invocation preserves (S, C), and a later read still returns S rather than the alleged zero. An active update is a different branch; this refutes zeroing, not every possible requirement for freshness.',
      notes: [['skip', 'update', 'return;', 'The inactive branch returns before the snapshot assignment and checkpoint increment. Neither stored value is written.'],
        ['read', 'readSnapshot', 'return snapshot;', 'A subsequent read yields the same prior S. The omitted write has no source line: the early return explains why the later update sites were skipped.']] },
    accounting: { contract: 'QuoteBook', functions: ['quote'], outcome: 'refuted',
      rule: 'The reported intended quote multiplies units by rate before truncating at scale 100.',
      summary: 'This quote combines the two inputs before rounding. Integer division discards the remainder once, after multiplication, rather than discarding subscale units before applying the rate.',
      conditions: ['units and rate are unsigned and at most 10000', 'units * rate >= 100', 'units is below 100'],
      conclusion: 'The actual quote is floor(units * rate / 100), not floor(units / 100) * rate. Subscale units need not give zero when the product reaches 100; products below 100 legitimately do, and this source does not establish a separate rounding-up entitlement.',
      notes: [['product', 'quote', 'uint256 product = units * rate;', 'The guarded inputs are multiplied first. Their bounded product is at most 100000000, so overflow does not explain the report’s divide-first allegation.'],
        ['divide', 'quote', 'return product / 100;', 'The same product is divided by 100 using integer truncation. For q = floor(units * rate / 100), 100*q <= units*rate < 100*(q+1); the report’s early truncation is a different operation order.']] }
  }[name];
  if (!spec) throw Error('Unknown controlled source route');
  const units = Object.fromEntries(spec.functions.map(fn => [fn, input.sources.find(u => u.name === `${spec.contract}::${fn}`)]));
  if (Object.values(units).some(u => !u?.complete)) throw Error('A required complete function is missing from the ordinary packet');
  const evidence = [], events = [];
  const lines = u => u.code.split('\n').map(row => { const m = row.match(/^(\d+) \| (.*)$/); return m && { line: +m[1], text: m[2] }; }).filter(Boolean);
  for (const [id, fn, expression, note] of spec.notes) {
    const u = units[fn], matched = lines(u).filter(row => row.text.trim() === expression);
    if (matched.length !== 1) throw Error('The exact controlled occurrence is absent or ambiguous');
    evidence.push({ id, claimId: 'c1', sourceId: u.id, line: matched[0].line, endLine: matched[0].line, quote: matched[0].text, stance: spec.outcome === 'supported' ? 'supports' : 'contradicts', explanation: note });
    events.push({ id, invocationId: fn + '-1', transaction: name === 'accounting' ? 'tx1' : 'tx' + (events.length + 1), phase: id === 'write' ? 'write' : 'read', claimId: 'c1', evidenceId: id, callSiteId: '', title: ({ write: 'Store a duration without its origin', skip: 'Return without clearing the snapshot', read: 'Read the retained value', product: 'Multiply the same bounded inputs', divide: 'Truncate once, after multiplication' })[id],
      role: spec.summary, actor: 'Caller of the modeled source function', caller: 'msg.sender', receiver: spec.contract,
      conditions: spec.conditions, what: note, why: id === spec.notes.at(-1)[0] ? spec.conclusion : 'This operation determines the value used at the next checked reading location.',
      inputs: [], changes: [], effect: id === 'write' ? 'committed' : id === 'skip' || id === 'divide' || id === 'read' ? 'return' : 'read',
      paragraphId: input.finding.reportParagraphs.find(p => p.text.includes('Description'))?.id || '', phrase: '' });
  }
  events[0].why = ({ time: 'The later comparison uses this stored threshold, so omitting the positive start makes readiness possible earlier than the documented deadline.',
    lifecycle: 'Because the inactive branch writes neither value, the later read receives the old S; skipping a refresh does not manufacture zero.',
    accounting: 'Keeping both factors until the next line lets a subscale units input still produce an integer quote when the product reaches 100.' })[name];
  if (name === 'accounting') {
    for (const event of events) event.inputs = [['units', '9', 'contribution units'], ['rate', '15', 'quote units per 100 contribution units']].map(([name, expression, units]) =>
      ({ name, expression, units, type: 'uint256', origin: 'Illustrative input satisfying the source bounds, not observed state. The same input is used in the expected and actual calculation.', evidence: ['product', 'divide'] }));
    events[0].changes = [{ name: 'product', before: '9', operation: '* 15', after: '135', units: 'contribution units multiplied by quote rate', evidence: ['product'] }];
    events[1].changes = [{ name: 'integer quote', before: '135', operation: '/ 100', after: '1', units: 'integer quote units', evidence: ['product', 'divide'] }];
    events[1].what += ' Illustrative inputs units=9 and rate=15 satisfy the guard: the expected rule and actual code both give 1, whereas the reported divide-first calculation gives 0.';
  }
  if (name === 'time') {
    const u = input.sources.find(u => u.code.includes('Specification: schedule stores'));
    if (!u) throw Error('The independent documented rule is absent; do not invent it from the answer');
    const line = lines(u).find(row => row.text.includes('Specification: schedule stores'));
    evidence.push({ id: 'rule', claimId: 'c1', sourceId: u.id, line: line.line, endLine: line.line, quote: line.text, stance: 'context', explanation: 'The explicit source specification requires the start plus the duration, independently of the implementation assignment.' });
    events[0].changes = [{ name: 'deadline', before: 'prior deadline', operation: '= duration', after: 'duration', units: 'absolute clock units (actual value omits the start origin)', evidence: ['write'] }];
  }
  const all = evidence.map(e => e.id), obligations = capacity.kinds.map(kind => ({ id: kind, claimId: 'c1', kind, question: `Check ${kind} in this source scenario`, state: 'established', reason: spec.conclusion, evidence: all, documentation: [] }));
  const relationships = [{ from: events[0].id, to: events[1].id, kind: name === 'accounting' ? 'data' : 'later-transaction', explanation: name === 'accounting' ? 'The local product is the numerator of the following division in this invocation.' : 'After the first invocation returns, a separate read observes the stored value; this is not a direct runtime call.', binding: 'The same stated scenario and stored/local value.', evidence: all, callSiteId: '', dispatch: { kind: 'not-applicable', receiver: '', implementation: '', evidence: [], context: 'none', failure: 'not-applicable' } }];
  const causal = { scope: 'Synthetic source reasoning under the stated inputs, not observed deployment or an executed test.', summary: spec.summary, outcome: spec.outcome, obligations, events, relationships, order: events.map(e => e.id), checks: [] };
  const checks = capacity.targets(causal).map(target => ({ target: target.key, reason: spec.conclusion, evidence: all, documentation: [] }));
  const explanationReviews = evidence.map(e => ({ evidenceId: e.id, result: 'kept', reason: e.explanation, checkedSourceIds: [...new Set(evidence.map(x => x.sourceId))] }));
  const inputReviews = (input.semanticInput?.premises || []).map(p => ({ id: p.id, status: 'applied', reason: 'The stated expectation and source-conditional scenario are retained with their original attribution.', claimIds: ['c1'], eventIds: events.map(e => e.id), evidence: all }));
  if (input.checkOnly) return { result: 'kept', problems: [], inputReviews, explanationReviews, checks };
  if (input.repairOnly) return { mode: 'review-patch-v1', updates: [], inputReviews, explanationReviews, checks };
  if (input.phase === 'challenge') causal.checks = checks;
  return require('./source-bound-output').encode({ inputReviews, property: { text: spec.rule, basis: name === 'time' ? 'source-contract' : 'report-assumption', evidence: name === 'time' ? ['rule'] : [], documentation: [] },
    claims: [{ id: 'c1', allegation: input.finding.reportParagraphs.find(p => p.text.includes('Description'))?.text || spec.summary, actor: 'Caller', entry: Object.values(units)[0].id, implementation: spec.contract, conditions: spec.conditions, requiredFacts: [spec.rule], supportsIf: 'The reported operation differs from the checked expected rule.', contradictsIf: 'The decisive source contradicts the reported operation or consequence.', status: spec.outcome === 'supported' ? 'supported' : 'contradicted', reason: spec.conclusion, evidence: all, unknowns: [], nextQuestion: '' }],
    evidence, explanationReviews: input.phase === 'challenge' ? explanationReviews : [], transitions: [], questions: [], conclusion: { status: spec.outcome === 'supported' ? 'supported-in-scope' : 'contradicted-in-scope', text: spec.conclusion, limitations: [] },
    walkthrough: { assessment: { result: spec.outcome === 'supported' ? 'valid' : 'invalid', why: spec.conclusion, supportingEvidence: spec.outcome === 'supported' ? 'write' : '', opposingEvidence: spec.outcome === 'refuted' ? evidence.at(-1).id : '' } }, causal }, input);
}
module.exports = { response };
