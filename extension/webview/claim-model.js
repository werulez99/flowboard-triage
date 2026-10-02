// Claim-level arguments are reviewer assertions, not semantic analysis results.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowboardClaims = api;
})(globalThis, function() {
  'use strict';
  const states = ['unreviewed', 'supported', 'contradicted', 'mixed', 'unresolved'];
  const origins = ['unknown', 'report', 'specification', 'implementation', 'test'];
  const current = item => !!item && !item.needsReview && (!item.source || !!item.source.sourceHash);
  function argument(claim, evidence) {
    const links = (claim.evidence || []).map(link => ({ ...link, entry: evidence.find(item => item.id === link.evidenceId) }));
    const counts = Object.fromEntries(['supports', 'contradicts', 'context'].map(stance => [stance, links.filter(link => link.stance === stance && current(link.entry)).length]));
    const gaps = [];
    if (!links.length) gaps.push('No evidence linked to this claim.');
    if (links.some(link => !current(link.entry))) gaps.push('Some linked evidence is missing, historical or unbound.');
    if (!claim.observed?.trim()) gaps.push('Observed source behavior has not been recorded.');
    if (['unreviewed', 'unresolved', 'mixed'].includes(claim.state)) gaps.push(`Claim remains ${claim.state}.`);
    for (const question of claim.questions || []) gaps.push(question);
    return { links, counts, gaps, toolVerified: false };
  }
  function validate(profile) {
    const text = (value, label, required = false, max = 4000) => {
      if (value === undefined && !required) return;
      if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw new Error(`${label}: ${required ? 'non-empty ' : ''}text required (max ${max}).`);
    };
    if (profile.ruleOrigin !== undefined) {
      if (!profile.ruleOrigin || !origins.includes(profile.ruleOrigin.kind)) throw new Error('Unknown intended-rule origin.');
      text(profile.ruleOrigin.reference, 'Rule origin reference', profile.ruleOrigin.kind !== 'unknown', 1000);
    }
    if (profile.claims === undefined) return;
    if (!Array.isArray(profile.claims) || profile.claims.length > 20) throw new Error('Keep at most 20 focused report claims.');
    const ids = new Set(), evidence = profile.evidence || [];
    for (const claim of profile.claims) {
      if (!claim || typeof claim.id !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(claim.id) || ids.has(claim.id)) throw new Error('Invalid/duplicate claim ID.');
      ids.add(claim.id); text(claim.text, 'Claim statement', true, 2000);
      if (!states.includes(claim.state)) throw new Error('Unknown claim review state.');
      for (const field of ['observed', 'conditions', 'consequence']) text(claim[field], `Claim ${field}`);
      text(claim.reason, 'Claim decision reasoning', claim.state !== 'unreviewed');
      if (claim.questions !== undefined) {
        if (!Array.isArray(claim.questions) || claim.questions.length > 12) throw new Error('Keep at most 12 questions per claim.');
        claim.questions.forEach(question => text(question, 'Claim question', true, 1000));
      }
      if (!Array.isArray(claim.evidence) || claim.evidence.length > 30) throw new Error('Claim evidence must be an array of at most 30 links.');
      const linked = new Set();
      for (const link of claim.evidence) {
        if (!link || !evidence.some(item => item.id === link.evidenceId) || linked.has(link.evidenceId)) throw new Error('Missing/duplicate claim evidence reference.');
        linked.add(link.evidenceId);
        if (!['supports', 'contradicts', 'context'].includes(link.stance)) throw new Error('Unknown claim-specific evidence stance.');
        text(link.reason, 'Why this evidence bears on the claim', true, 1000);
      }
      const { counts } = argument(claim, evidence);
      if (['supported', 'mixed'].includes(claim.state) && !counts.supports) throw new Error('A supported/mixed claim needs current supporting evidence.');
      if (['contradicted', 'mixed'].includes(claim.state) && !counts.contradicts) throw new Error('A contradicted/mixed claim needs current contradicting evidence.');
    }
  }
  function gaps(profile) {
    const claims = profile.claims || [], result = [];
    if (!Array.isArray(claims)) return result;
    if (!claims.length) return result;
    if (!profile.ruleOrigin || profile.ruleOrigin.kind === 'unknown') result.push('Intended-rule provenance is unknown');
    if (profile.ruleOrigin?.kind === 'report') result.push('Intended rule is asserted by the report, not independently established');
    for (const claim of claims) if (argument(claim, profile.evidence || []).gaps.length) result.push(`Claim ${claim.id} has unresolved review areas`);
    return result;
  }
  function detach(profile, evidenceId) {
    profile.evidence = profile.evidence.filter(item => item.id !== evidenceId);
    for (const claim of profile.claims || []) if (claim.evidence.some(link => link.evidenceId === evidenceId)) {
      claim.evidence = claim.evidence.filter(link => link.evidenceId !== evidenceId); claim.state = 'unreviewed';
    }
  }
  function invalidate(profile) {
    for (const item of profile.evidence || []) item.needsReview = true;
    for (const claim of profile.claims || []) claim.state = 'unreviewed';
  }
  function reconcile(previous, next) {
    const ruleChanged = JSON.stringify(previous.ruleOrigin) !== JSON.stringify(next.ruleOrigin);
    for (const claim of next.claims || []) {
      if (ruleChanged || claim.evidence.some(link => JSON.stringify(previous.evidence.find(item => item.id === link.evidenceId)) !== JSON.stringify(next.evidence.find(item => item.id === link.evidenceId)))) claim.state = 'unreviewed';
    }
  }
  function brief(profile) {
    if (!profile.claims?.length) return [];
    const origin = profile.ruleOrigin;
    const lines = ['', '## Claim-by-claim argument (reviewer assessment, not execution order)',
      `Rule provenance: ${origin?.kind || 'unknown'} — ${origin?.reference || 'Not established.'}`];
    for (const claim of profile.claims) {
      lines.push('', `### ${claim.id}: ${claim.text}`, `Review state: ${claim.state}`, `Observed: ${claim.observed || 'Not established.'}`,
        `Conditions: ${claim.conditions || 'Not established.'}`, `Consequence: ${claim.consequence || 'Not established.'}`, `Reason: ${claim.reason || 'Not recorded.'}`);
      for (const link of argument(claim, profile.evidence).links) {
        const item = link.entry, location = item?.source ? `${item.source.file}:${item.source.line}` : item?.reference || 'Missing evidence';
        lines.push(`- ${current(item) ? '' : '[NEEDS RE-REVIEW] '}${link.stance}: ${location} — ${link.reason}`, `  Observation: ${item?.note || 'Missing.'}`);
      }
      lines.push(...argument(claim, profile.evidence).gaps.map(gap => `- Open: ${gap}`));
    }
    return lines;
  }
  return { states, origins, current, argument, validate, gaps, detach, invalidate, reconcile, brief };
});
