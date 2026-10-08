'use strict';
// Fixed source-review responses for mixed-preparation/README.md. They exercise
// the production gate/scheduler/renderer, not the correctness of a real model.
const capacity = require('../../extension/review-capacity');
function response(input) {
  input = require('../../extension/packet-context').expand(input);
  if (input.finding.id === 'I-4') return {};
  if (input.candidateOnly) throw new Error('An unchanged external dependency has no candidate amendment; retain its full verification instead.');
  const remote = input.finding.id === 'I-3', count = input.finding.id === 'I-2';
  const name = remote ? 'remoteFinish' : count ? 'checkCount' : 'finish';
  const unit = input.sources.find(item => item.name === `GuardBook::${name}`);
  if (!unit) throw new Error(`Production discovery omitted GuardBook::${name}.`);
  const paragraph = input.finding.reportParagraphs.find(item => item.text.includes('The report claims'));
  if (!paragraph) throw new Error('Production import omitted the original fictional description.');
  const line = remote ? 14 : count ? 11 : 8;
  const quote = remote ? '        remote.finish(accepted);' : count ? '        require(count != 0, "zero");' : '        require(accepted, "rejected");';
  const condition = remote ? 'The caller supplies an unknown remote implementation and accepted=false.' : count ? 'count is zero' : 'accepted is false';
  const note = remote ? 'This call uses the remote receiver supplied by the caller. Its implementation is unavailable, so its return or revert behavior is not established.' :
    count ? 'A zero count makes this require condition false. The invocation reverts rather than returning normally.' :
    'A false accepted input fails this require. The invocation reverts rather than returning normally.';
  const missing = 'Which implementation executes at the externally supplied remote receiver?';
  const obligations = capacity.kinds.map(kind => ({ id: kind, claimId: 'c1', kind, question: `Check ${kind}`,
    state: remote ? 'open' : 'established', reason: remote ? missing : note, evidence: ['guard'], documentation: [] }));
  const event = { id: 'guard-event', invocationId: `${name}-1`, transaction: 'tx1', phase: remote ? 'context' : 'guard', claimId: 'c1', evidenceId: 'guard', callSiteId: '',
    title: remote ? 'The implementation is not established' : count ? 'Zero fails the count guard' : 'False fails the guard', role: remote ? 'Unknown external receiver' : 'The decisive entry condition',
    actor: 'Caller', caller: 'msg.sender', receiver: 'GuardBook', conditions: [condition], what: note, why: remote ? 'An interface does not prove runtime behavior.' : 'The report requires normal completion under this same input.',
    inputs: [], changes: [], effect: remote ? 'read' : 'rolled-back', paragraphId: paragraph.id, phrase: '' };
  const causal = { scope: 'Fictional source interpretation, not an executed test.', summary: note, outcome: remote ? 'blocked' : 'refuted', obligations,
    events: [event], relationships: [], order: [event.id], checks: [] };
  const checks = capacity.targets(causal).map(item => ({ target: item.key, reason: note, evidence: ['guard'], documentation: [] }));
  const reviews = [{ evidenceId: 'guard', result: 'kept', reason: note, checkedSourceIds: [unit.id] }];
  if (input.checkOnly) return { result: 'kept', problems: [], ...(input.reviewPurpose?{inputReviews:[]}:{}), explanationReviews: reviews,
    checks:[...checks,...(input.candidateRevisionTargets||[]).map(target=>({target,reason:note,evidence:['guard'],documentation:[]}))] };
  causal.checks = input.phase === 'challenge' ? checks : [];
  return { property: { text: remote ? 'The report alleges normal completion in a deployed implementation.' : 'The report alleges normal completion on the stated input.', basis: 'report-assumption', evidence: [], documentation: [] },
    claims: [{ id: 'c1', allegation: remote ? 'The unknown remote implementation accepts false.' : count ? 'A zero-count invocation returns normally.' : 'A false-accepted invocation returns normally.',
      actor: 'Caller', entry: unit.id, implementation: `GuardBook.${name}`, conditions: [condition], requiredFacts: [remote ? missing : 'The supplied input must pass the guard.'],
      supportsIf: 'The stated invocation returns normally.', contradictsIf: 'The stated invocation reverts.', status: remote ? 'unresolved' : 'contradicted',
      reason: note, evidence: ['guard'], unknowns: remote ? [missing] : [], nextQuestion: remote ? missing : '' }],
    evidence: [{ id: 'guard', claimId: 'c1', sourceId: unit.id, line, endLine: line, quote, stance: remote ? 'context' : 'contradicts', explanation: note }],
    explanationReviews: input.phase === 'challenge' ? reviews : [], transitions: [], questions: remote ? [{ id: 'receiver', claimId: 'c1', text: missing, action: 'missing-context', target: 'Externally supplied IRemoteGuard receiver', why: 'The interface does not identify the running implementation.' }] : [],
    conclusion: { status: remote ? 'insufficient-evidence' : 'contradicted-in-scope', text: note, limitations: remote ? [missing] : [] },
    walkthrough: { steps: [{ evidenceId: 'guard', title: event.title, paragraphId: paragraph.id, phrase: '' }], assessment: { result: remote ? 'unclear' : 'invalid', why: note, supportingEvidence: '', opposingEvidence: remote ? '' : 'guard' } }, causal };
}
module.exports = { response };
