'use strict';
// Explicit developer pilot only; no setting, board route or provider fallback.
const { hash } = require('../extension/investigation-engine');
const materialSources = input => hash(require('../extension/packet-context').expand(input).sources.map(({ id, file, line, endLine, code, sourceHash }) => ({ id, file, line, endLine, code, sourceHash })));
const substantive = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [value.checks, value.explanationReviews, value.claims, value.causal?.checks].some(items => Array.isArray(items) && items.some(item => typeof item?.reason === 'string' && item.reason.trim().length >= 8));
class ChallengePilotGuard {
  constructor(findingId, ledger, save) { this.findingId = findingId; this.ledger = ledger; this.save = save; }
  check(input) {
    const reject = message => { throw Object.assign(new Error(message), { code: 'REPORT_PAUSED' }); };
    if (input.phase !== 'challenge' || input.finding.id !== this.findingId) reject('Pilot permits only this saved finding’s challenge, never generation or siblings.');
    if (this.ledger.limit !== 2 || this.ledger.used >= 2) reject('Pilot request cap reached; no third invocation.');
    if (this.ledger.used === 1) {
      const prior = this.ledger.receipts[0], feedback = input.hostReview;
      const specific = feedback && (Array.isArray(feedback.problems) && feedback.problems.some(p => typeof p === 'string' && p.trim()) ||
        feedback.newLocalCode === true && materialSources(input) !== prior.sources);
      if (prior.outcome !== 'completed' || !prior.substantive || !specific) reject('C2 requires substantive structured C1 and concrete engine feedback/new evidence; transport retries are not authorized.');
    }
    return this.ledger.used === 0 ? 600000 : 240000;
  }
  reserve(input, requestId) {
    const timeoutMs = this.check(input), receipt = { requestId, phase: 'challenge', timeoutMs, sources: materialSources(input),
      inputHash: hash(input), at: new Date().toISOString(), outcome: 'reserved' };
    this.ledger.used++; this.ledger.receipts.push(receipt); this.save(this.ledger); return receipt;
  }
  result(receipt, value, audit) { Object.assign(receipt, { outcome: audit?.outcome || 'failed', substantive: substantive(value),
    finishedAt: new Date().toISOString(), audit }); this.save(this.ledger); }
}
class SingleReviewRepairGuard extends ChallengePilotGuard {
  check(input) {
    const deny = message => { throw Object.assign(new Error(message), { code: 'REPORT_PAUSED' }); };
    const permit = this.ledger.prerequisites;
    if (this.ledger.limit !== 1 || this.ledger.used !== 0) deny('R1 is one invocation only; no retry or second repair is authorized.');
    if (input.phase !== 'challenge' || input.finding?.id !== this.findingId) deny('R1 permits only the saved finding challenge; generation and siblings are forbidden.');
    if (!permit?.controlsPassed || !permit.localReplayHash || !permit.necessarySourcesRead || !permit.noIndispensableMissingEvidence)
      deny('R1 prerequisites are incomplete. Obtain the named evidence or finish local checks without spending a request.');
    if (!permit.savedBaseHash || hash(input.earlierDraft) !== permit.savedBaseHash || hash(input.snapshot) !== permit.snapshotHash)
      deny('R1 saved base/source/input identity changed; no request is authorized.');
    if (!input.hostReview?.rejectedOutput || !input.hostReview.validationProblems?.length || !input.evidenceScopes)
      deny('R1 needs the exact rejected response, structured repair feedback and immutable evidence scope manifest.');
    return 600000;
  }
}
module.exports = { ChallengePilotGuard, SingleReviewRepairGuard, substantive, materialSources };
