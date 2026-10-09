// Shared presentation policy. Exact references are location checks, not proof
// of model reasoning. No provider calls, code search or researcher mutations.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowboardWalkthrough = api;
})(globalThis, function() {
  'use strict';
  const capacity = typeof module === 'object' && module.exports ? require('./review-capacity') : globalThis.FlowboardCapacity;
  function paragraphs(report = '') {
    const result = [];
    const expression = /[^\r\n]+(?:\r?\n(?![ \t]*\r?\n)[^\r\n]+)*/g;
    for (const match of report.matchAll(expression)) {
      const start = match.index, end = start + match[0].length;
      result.push({ id: `p-${start}-${end}`, start, end, text: report.slice(start, end) });
    }
    return result;
  }
  // Exact original text for the guided reader, including developer comments.
  // Segment comments without interpreting comment-like strings as comments.
  function originalLines(code) {
    let block = false, quote = null, escaped = false;
    return code.replace(/\r\n/g, '\n').split('\n').map(line => {
      const pieces = []; let start = 0, comment = block;
      const flush = end => { if (end > start) pieces.push({ text: line.slice(start, end), comment }); start = end; };
      for (let i = 0; i < line.length; i++) {
        const char = line[i], next = line[i + 1];
        if (block) { if (char === '*' && next === '/') { i++; flush(i + 1); block = false; comment = false; } continue; }
        if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = null; continue; }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '/' && next === '/') { flush(i); comment = true; break; }
        if (char === '/' && next === '*') { flush(i); comment = true; block = true; i++; }
      }
      flush(line.length); return pieces;
    });
  }
  function reportLink(report, reference) {
    const paragraph = paragraphs(report).find(item => item.id === reference?.paragraphId);
    if (!paragraph) return null;
    const phrase = typeof reference.phrase === 'string' ? reference.phrase : '';
    const offset = phrase ? paragraph.text.indexOf(phrase) : -1;
    // Repeated phrases do not provide an unambiguous phrase-level reference.
    return { ...paragraph, phrase: offset >= 0 && paragraph.text.indexOf(phrase, offset + 1) < 0 ? phrase : '',
      phraseStart: offset >= 0 && paragraph.text.indexOf(phrase, offset + 1) < 0 ? paragraph.start + offset : null };
  }
  function exact(entry, unit) {
    const source = entry?.source;
    return !!(unit && source && source.file === unit.source.file && source.sourceHash === unit.source.sourceHash &&
      Number.isSafeInteger(source.line) && Number.isSafeInteger(source.endLine) && source.line >= unit.source.line &&
      source.endLine >= source.line && source.endLine <= unit.source.endLine && entry.quote ===
      unit.code.split('\n').slice(source.line - unit.source.line, source.endLine - unit.source.line + 1).join('\n'));
  }
  function assessment(draft, stale = false) {
    if (stale) return { result: 'unavailable', label: 'Code or report changed', why: 'Refresh the review before relying on these notes.', remaining: [] };
    const projected=draft?.assessmentProjection?.technical;
    if(projected&&projected.result!=='not-assessed')return {...projected,result:({supported:'valid',refuted:'invalid','insufficient-evidence':'unclear'})[projected.result],
      supports:projected.evidence?.find(e=>e.stance==='supports'),contradicts:projected.evidence?.find(e=>e.stance==='contradicts')};
    const states = { preparing: 'Preparing review', generating: 'Reading code', 'checking-source': 'Reading related code', challenging: 'Checking explanations',
      'provider-required': 'AI review is off', blocked: 'AI review unavailable', corrected: 'Review needs updating' };
    if (!draft || draft.phase !== 'ready') return { result: 'unavailable', label: states[draft?.phase] || 'Review not available',
      why: draft?.phase === 'blocked' ? 'The review could not finish. Available code and saved notes are still accessible.' :
        draft?.phase === 'provider-required' ? 'Enable the configured provider in Statements to prepare the automatic explanation.' : 'Code navigation is available while the review is prepared.', remaining: [] };
    const proposed = draft.walkthrough?.assessment;
    const evidence = draft.evidence || [], unresolved = draft.claims.some(item => item.status === 'unresolved' || item.needsReassessment);
    let result = proposed?.result || 'unclear';
    if (unresolved || result === 'valid' && (draft.property.basis === 'report-assumption' || !(draft.property.evidence?.length || draft.property.documentation?.length) || !evidence.some(item => item.stance === 'supports')) ||
      result === 'invalid' && !evidence.some(item => item.stance === 'contradicts')) result = 'unclear';
    if (!['valid', 'invalid', 'unclear'].includes(result)) result = 'unclear';
    const ordered = [...draft.claims.filter(item => item.status === 'unresolved'), ...draft.claims.filter(item => item.status !== 'unresolved')];
    const remaining = [...new Set([...(ordered.flatMap(item => item.unknowns || [])), ...(draft.conclusion?.limitations || [])])];
    if (draft.readingLimits?.length) remaining.push(`The review reached its code-reading limit. Available locally but still unread: ${draft.readingLimits.join('; ')}.`);
    if (proposed?.result && result !== proposed.result) remaining.unshift('The proposed issue result is not established across the checked paths and expected behavior.');
    if (!proposed) remaining.unshift('This saved review has scoped statement results, but no separate assessment of the whole issue.');
    return { result, label: { valid: 'Appears valid', invalid: 'Appears invalid', unclear: 'Still unclear' }[result],
      why: `${proposed?.result && result !== proposed.result ? 'The proposed issue result still needs checking across its paths and expected rule. ' : ''}${draft.causal?.summary || proposed?.why || draft.conclusion?.text || 'Read the scoped evidence before deciding.'}`, remaining,
      supports: evidence.find(item => item.id === proposed?.supportingEvidence && item.stance === 'supports') || evidence.find(item => item.stance === 'supports'),
      contradicts: evidence.find(item => item.id === proposed?.opposingEvidence && item.stance === 'contradicts') || evidence.find(item => item.stance === 'contradicts') };
  }
  function build(draft, report) {
    if (!draft || draft.phase !== 'ready' || !draft.publication?.ready || draft.publication.policy !== capacity.POLICY || !draft.causal) return null;
    if (typeof draft.walkthrough?.reportText === 'string' && draft.walkthrough.reportText !== report) return null;
    const units = new Map(draft.sources.map(item => [item.id, item]));
    const valid = draft.evidence.filter(item => exact(item, units.get(item.sourceId)) && item.explanationReview &&
      ['kept', 'repaired', 'added'].includes(item.explanationReview.result));
    const steps = [];
    for (const id of draft.causal.order) {
      const event = draft.causal.events.find(item => item.id === id), entry = valid.find(item => item.id === event?.evidenceId);
      const claim = entry && draft.claims.find(item => item.id === event.claimId && item.id === entry.claimId);
      if (!claim || !units.get(entry.sourceId)?.complete) return null;
      const unit = draft.nativeSources?.[event.id] || units.get(entry.sourceId);
      const visual = { ...(event.anchor ? { ...entry, ...event.anchor } : entry), sourceId: unit.id };
      if (!exact(visual, unit)) return null;
      steps.push({ ...event, kind: 'code', claim, evidence: visual, analyticalEvidence: entry, unit, report: reportLink(report, event),
        handoff: draft.causal.relationships.find(item => item.to === id && item.from === steps.at(-1)?.id), transitions: [] });
    }
    if (!steps.length) return null;
    // No invented closing step: the last checked event stays beside its code.
    return { key: [draft.findingId, draft.snapshot.sourceDigest, draft.snapshot.reportHash, draft.revision].join(':'), findingId: draft.findingId,
      report, snapshot: draft.snapshot, steps, draft, summary: draft.causal.summary, scope: draft.causal.scope,
      teaching: teaching(draft, steps) };
  }
  // Projection only: every displayed sentence already belongs to the accepted
  // property, claim, event or conclusion covered by the publication digest.
  // No second event order, new premise, numeric evaluation or attestation.
  function teaching(draft, steps, index=0) {
    const active=steps[index],claim=active.claim;
    // Scenario entry, not step zero. A distinct transaction or context edge
    // cannot borrow the first route's actor, assumptions or value history.
    let start=index;
    while(start>0&&steps[start-1].claimId===active.claimId&&steps[start-1].transaction===active.transaction&&steps[start].handoff?.kind!=='context')start--;
    const first=steps[start];
    return { mechanism: draft.causal.summary, rule: draft.property.text,
      basis: ({ 'report-assumption': 'Reported expectation (not independent proof)', 'source-contract': 'Source-linked rule',
        'test-expectation': 'Supplied test expectation', 'local-documentation': 'Supplied documentation', 'derived-security-invariant':'Reviewed invariant derived from mechanism and rights', unresolved: 'Unresolved expected rule' })[draft.property.basis],
      ruleEvidence: draft.property.evidence || [], ruleDocumentation: draft.property.documentation || [],
      actor: first.actor || claim.actor, conditions: [...new Set([...(claim.conditions || []), ...(first.conditions || [])])],scenario:claim.allegation,scenarioStart:start,
      conclusion: draft.conclusion?.text || '', claims: draft.claims.map(({ id, status, reason }) => ({ id, status, reason })),
      limitations: draft.conclusion?.limitations || [] };
  }
  function relationship(previous, next, connections, cardFor) {
    if (next?.handoff) return `${({call:'Call', callback:'Callback', return:'Return', branch:'Branch', data:'Data dependency', 'later-transaction':'Later transaction', context:'Context detour'})[next.handoff.kind]} · ${next.handoff.explanation}${next.handoff.binding ? ' ' + next.handoff.binding : ''}`;
    if (!previous?.unit || !next?.unit) return 'No further execution route is established here.';
    if (previous.unit.id === next.unit.id) return 'Another checked statement in the same function.';
    const a = cardFor(previous.unit), b = cardFor(next.unit);
    const edge = connections.find(item => item.from === a && item.to === b) || connections.find(item => item.from === b && item.to === a);
    if (!edge) return 'Next reading location. A direct call between these functions has not been established.';
    const from = edge.from === a ? previous.unit.name : next.unit.name, to = edge.to === b ? next.unit.name : previous.unit.name;
    return `${edge.kind === 'call' ? `Call: ${from} → ${to}` : edge.kind === 'state-dependency' ? 'Shared data, not a call' : 'Possible connection; implementation or conditions need checking'}. ${edge.reason || ''}`;
  }
  function transition(previous, next) {
    if (!next) return null;
    const link = next.handoff;
    return { title: next.title, functionName: next.unit?.name || '',label:({call:'Call',callback:'Callback',return:'Return',branch:'Branch',data:'Data dependency','later-transaction':'Later transaction',context:previous?.claimId!==next.claimId?'Alternative scenario':'Evidence detour'})[link?.kind]||'Next checked operation',
      explanation: link?.explanation || '', binding: link?.binding || '', kind: link?.kind || '',
      sameInvocation: !!previous && previous.invocationId === next.invocationId && previous.transaction === next.transaction };
  }
  function watchedChanges(route, index) {
    const step = route?.steps[index];
    if (!step?.invocationId || !step.transaction) return [];
    const values = new Map();
    // Reading order is not a trace. These are explicitly recorded changes
    // already inspected within one invocation, never merged across branches,
    // transactions, receivers, or repeated invocations of the same function.
    for (const event of route.steps.slice(0, index + 1)) {
      if (event.invocationId !== step.invocationId || event.transaction !== step.transaction || event.claimId !== step.claimId || event.receiver !== step.receiver) continue;
      for (const change of event.changes || []) values.set(change.name, { ...change, eventId: event.id, title: event.title, effect: event.effect });
      // A revert need not repeat every earlier write. Keep those attempted
      // values as history, but never leave them labeled as surviving state.
      // Other invocations (including a caught child failure) do not enter this
      // scope and cannot silently erase the caller's own recorded writes.
      if (event.effect === 'rolled-back') for (const [name, value] of values) values.set(name, { ...value, effect:'rolled-back', rollbackEventId:event.id });
    }
    return [...values.values()];
  }
  function inputLinks(route, step, input) {
    if (!route || !step || !input) return {};
    const parameter = (step.unit.parameterSpans || []).filter(item => item.name === input.name);
    const result = parameter.length === 1 && parameter[0].span ? { parameter: { unit: step.unit, span: parameter[0].span, text: parameter[0].name } } : {};
    const incoming = route.draft.causal.relationships.filter(link => ['call', 'callback'].includes(link.kind) && route.steps.some(event => event.id === link.to && event.invocationId === step.invocationId && event.transaction === step.transaction));
    if (incoming.length !== 1) return result;
    const caller = route.steps.find(event => event.id === incoming[0].from), site = caller?.unit.relatedCalls?.find(item => item.id === incoming[0].callSiteId);
    if (!site) return result;
    let argument;
    if (input.name === 'msg.value') argument = site.options?.find(item => item.name === 'value');
    else if (parameter.length === 1) {
      const index = parameter[0].index;
      if (site.implicitReceiver && index === 0) argument = { span: site.receiverSpan, expression: site.receiverExpression };
      else if (site.argumentSpans?.some(item => item.name != null)) {
        const name = site.declarations?.length === 1 ? site.declarations[0].parameters[index] : site.callKind === 'internal' ? input.name : null;
        const named = name ? site.argumentSpans.filter(item => item.name === name) : [];
        if (named.length === 1) argument = named[0];
      } else argument = site.argumentSpans?.find(item => item.index === index - (site.implicitReceiver ? 1 : 0));
    }
    if (argument?.span) result.argument = { unit: caller.unit, span: argument.span, text: argument.expression };
    return result;
  }
  return { paragraphs, reportLink, originalLines, exact, assessment, build, teaching, relationship, transition, watchedChanges, inputLinks };
});
