// Shared, dependency-free review model. Checkmarks/evidence labels are reviewer
// assertions; this module validates structure, never Solidity bug validity.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowboardReview = api;
})(globalThis, function() {
  'use strict';
  const checkpoints = [
    { id: 'revision', title: 'Source / report version', question: 'Does this checkout match the reported behavior? Distinguish a stale report from current code.' },
    { id: 'rule', title: 'Intended rule', question: 'What invariant or specification should hold? A surprising behavior is not necessarily a bug.' },
    { id: 'conditions', title: 'Permissions / state', question: 'Who may invoke the relevant code, and what state/guards must hold? Inspect modifiers and implementation targets.' },
    { id: 'behavior', title: 'Actual source behavior', question: 'Where do values or state change? Compare actual behavior with the intended rule, not citation order.' },
    { id: 'counterevidence', title: 'Try to disprove the claim', question: 'Which guard, accounting rule, specification or other implementation could refute it? Record contradictory evidence too.' },
    { id: 'impact', title: 'Consequence / conclusion', question: 'What consequence follows from the deviation? Separate bug validity, design choices and reported severity.' }
  ];
  const definitive = ['confirmed', 'invalid', 'design-decision', 'already-fixed'];
  function create(value) {
    return { version: 1, actor: value?.actor || '', decisionReason: value?.decisionReason || '',
      checks: checkpoints.map(check => ({ id: check.id, state: 'unchecked', note: '', ...value?.checks?.find(item => item.id === check.id) })),
      evidence: structuredClone(value?.evidence || []) };
  }
  function validate(value) {
    const fail = text => { throw new Error(text); };
    const text = (value, label, required = false, max = 4000) => {
      if (value === undefined && !required) return;
      if (typeof value !== 'string' || value.length > max || required && !value.trim()) fail(`${label}: ${required ? 'non-empty ' : ''}text required (max ${max}).`);
    };
    if (!value || Array.isArray(value) || value.version !== 1) fail('triage.version must be 1.');
    text(value.actor, 'Review actor'); text(value.decisionReason, 'Decision explanation');
    if (!Array.isArray(value.checks) || value.checks.length > checkpoints.length) fail('Invalid review checkpoints.');
    const seen = new Set();
    for (const check of value.checks) {
      if (!check || !checkpoints.some(item => item.id === check.id) || seen.has(check.id)) fail('Unknown/duplicate review checkpoint.');
      if (!['unchecked', 'checked', 'blocked', 'not-applicable'].includes(check.state)) fail('Unknown review checkpoint state.');
      text(check.note, 'Checkpoint reasoning', check.state !== 'unchecked'); seen.add(check.id);
    }
    if (!Array.isArray(value.evidence) || value.evidence.length > 30) fail('Keep at most 30 focused evidence entries.');
    const ids = new Set();
    for (const item of value.evidence) {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(item.id) || ids.has(item.id)) fail('Invalid/duplicate evidence ID.');
      ids.add(item.id);
      if (!['supports', 'contradicts', 'context'].includes(item.stance)) fail('Unknown evidence stance.');
      if (item.category !== undefined && !['behavior', 'claim', 'impact', 'guard', 'question'].includes(item.category)) fail('Unknown inline explanation category.');
      text(item.note, 'Evidence explanation', true);
      if (item.needsReview !== undefined && typeof item.needsReview !== 'boolean') fail('Evidence needsReview must be boolean.');
      if (!item.source && !item.reference) fail('Evidence needs a source line or a specification/test reference.');
      if (item.reference !== undefined) text(item.reference, 'Evidence reference', true, 1000);
      if (item.source) {
        text(item.source.file, 'Evidence source file', true, 1000);
        if (!item.source.file.endsWith('.sol') || /^(?:\/|[A-Za-z]:)/.test(item.source.file) || item.source.file.includes('\\') || item.source.file.includes('\0') || item.source.file.split('/').includes('..')) fail('Evidence source must be workspace-relative Solidity.');
        if (!Number.isSafeInteger(item.source.line) || item.source.line < 1) fail('Evidence source line must be a positive integer.');
        if (item.source.sourceHash !== undefined && !/^[0-9a-f]{64}$/.test(item.source.sourceHash)) fail('Evidence sourceHash must be SHA-256.');
      }
    }
    return value;
  }
  function readiness(finding) {
    const value = create(finding.triage);
    const current = item => !item.needsReview && (!item.source || !!item.source.sourceHash);
    const counts = Object.fromEntries(['supports', 'contradicts', 'context'].map(stance => [stance, value.evidence.filter(item => item.stance === stance && current(item)).length]));
    const gaps = value.checks.filter(check => check.state === 'unchecked' || check.state === 'blocked').map(check => checkpoints.find(item => item.id === check.id).title);
    const errors = [];
    try { validate(value); } catch (error) { errors.push(error.message); }
    if (definitive.includes(finding.status)) {
      if (!value.decisionReason.trim()) errors.push('Explain why the evidence supports this assessment.');
      if (!value.evidence.some(current)) errors.push('Add an explained current source/specification/test entry to the evidence ledger.');
      if (finding.status === 'confirmed' && !counts.supports) errors.push('A confirmed assessment needs supporting evidence.');
      if (finding.status === 'invalid' && !counts.contradicts) errors.push('A false-positive assessment needs evidence that contradicts the reported claim.');
    }
    return { counts, gaps, errors, outdated: value.evidence.filter(item => !current(item)).length, checked: value.checks.filter(check => ['checked', 'not-applicable'].includes(check.state)).length,
      total: checkpoints.length, toolVerified: false };
  }
  function brief(finding, context = {}) {
    const value = create(finding.triage), ready = readiness(finding);
    const lines = [`# ${finding.title || 'Finding review'}`, '', `Reviewer assessment: ${finding.status || 'unreviewed'} (not tool-verified)`,
      `Confidence: ${finding.confidence || 'unspecified'}; reported severity: ${finding.reportedSeverity || 'unspecified'}`,
      `Source checkout: ${context.checkoutRevision || 'not recorded'}; report revision: ${finding.reportRevision || 'unknown — compare versions'}`, '',
      '## Reported claim', finding.summary || 'Not recorded.', '', '## Intended behavior / rule', finding.expectedBehavior || 'Not established.', '',
      '## Observed source behavior', finding.actualBehavior || 'Not established.', '', '## Actor / required state', value.actor || 'Actor/permissions not established.',
      ...(finding.preconditions || []), '', '## Evidence for and against'];
    for (const item of value.evidence) lines.push(`- ${item.needsReview ? '[NEEDS RE-REVIEW] ' : ''}${item.stance}: ${item.source ? `${item.source.file}:${item.source.line}` : item.reference} — ${item.note}`);
    if (!value.evidence.length) lines.push('No structured evidence recorded.');
    if (finding.evidence?.length) lines.push('', 'Additional / legacy references (not automatically revalidated):', ...finding.evidence.map(text => `- ${text}`));
    lines.push('', '## Review reasoning', ...value.checks.map(check => `- ${checkpoints.find(item => item.id === check.id).title}: ${check.state} — ${check.note || 'Not recorded.'}`));
    lines.push('', '## Decision explanation', value.decisionReason || 'No conclusion established.', '', '## Unchecked / blocked review areas',
      ready.gaps.length ? ready.gaps.join('; ') : 'Reviewer marked all areas checked/not applicable; this is not semantic proof.', '',
      '## Remaining questions', ...(finding.openQuestions || ['Not recorded.']), '', '## Impact', finding.impact || 'Not established.');
    if (ready.errors.length) lines.push('', 'Incomplete assessment: ' + ready.errors.join(' '));
    return lines.join('\n');
  }
  function needsAttention(issue) {
    return ['unreviewed', 'insufficient-evidence'].includes(issue.status) || issue.mapped === false || issue.unresolved > 0 || issue.reviewGaps > 0 || issue.staleEvidence > 0;
  }
  function queue(issues, query = '', mode = 'all') {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return issues.filter(issue => terms.every(term => `${issue.id} ${issue.displayId || ''} ${issue.title} ${issue.severity} ${issue.status} ${(issue.files || []).join(' ')}`.toLowerCase().includes(term)))
      .filter(issue => mode === 'all' || (mode === 'attention' ? needsAttention(issue) : mode === 'unmapped' ? issue.mapped === false : issue.status === mode));
  }
  function nextAttention(issues, active) {
    const index = issues.findIndex(issue => issue.id === active);
    for (let offset = 1; offset <= issues.length; offset++) {
      const issue = issues[(index + offset) % issues.length];
      if (issue.id !== active && needsAttention(issue)) return issue;
    }
    return null;
  }
  function related(issues, active, anchors) {
    return issues.filter(issue => issue.id !== active).map(issue => {
      const shared = (issue.anchors || []).filter(other => anchors.some(anchor => anchor.file === other.file &&
        (anchor.function && other.function ? anchor.function === other.function && anchor.line === other.line : anchor.line === other.line)));
      const files = (issue.files || []).filter(file => anchors.some(anchor => anchor.file === file));
      return { ...issue, shared, sharedFiles: files };
    }).filter(issue => issue.shared.length || issue.sharedFiles.length)
      .sort((a, b) => b.shared.length - a.shared.length || b.sharedFiles.length - a.sharedFiles.length).slice(0, 8);
  }
  function quality(finding) {
    const value = create(finding.triage), notes = [], seen = new Map();
    for (const item of value.evidence) {
      if (item.needsReview || item.source && !item.source.sourceHash) continue;
      const key = item.source ? `${item.source.file}:${item.source.line}:${item.source.sourceHash}` : item.reference.trim().toLowerCase();
      const previous = seen.get(key) || [];
      if (previous.some(old => old.stance === item.stance && old.note.trim() === item.note.trim())) notes.push('Repeated evidence: the same reference and explanation appear more than once.');
      if (previous.some(old => ['supports', 'contradicts'].includes(old.stance) && ['supports', 'contradicts'].includes(item.stance) && old.stance !== item.stance)) notes.push('The same reference has supporting and contradicting interpretations. Explain the distinction before concluding.');
      previous.push(item); seen.set(key, previous);
    }
    if (finding.confidence === 'high' && readiness(finding).gaps.length) notes.push('High reviewer confidence has unchecked or blocked review areas. Explain why the remaining gaps do not change the conclusion.');
    return [...new Set(notes)];
  }
  function nextQuestion(finding) {
    const value = create(finding.triage);
    const next = value.checks.find(check => check.state === 'blocked') || value.checks.find(check => check.state === 'unchecked');
    return next ? { ...checkpoints.find(check => check.id === next.id), state: next.state, note: next.note } : null;
  }
  return { checkpoints, definitive, create, validate, readiness, brief, needsAttention, queue, nextAttention, related, quality, nextQuestion };
});
