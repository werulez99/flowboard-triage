'use strict';
// Explicit developer pilot only; no setting, board route or provider fallback.
const { hash } = require('../extension/investigation-engine');
const materialSources = input => hash(input.sources.map(({ id, file, line, endLine, code, sourceHash }) => ({ id, file, line, endLine, code, sourceHash })));
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
module.exports = { ChallengePilotGuard, substantive, materialSources };
