'use strict';
// Explicit developer evaluation only. Not reachable from editor navigation.
// This ledger supplements, never replaces, coordinator/account reservations.
const { hash } = require('../extension/investigation-engine');
const { valid } = require('../extension/challenge-format');
const provider = require('../extension/semantic-provider');
class FindingEvaluationGuard {
  constructor(ledger, save) { this.ledger = ledger; this.save = save; }
  check(input) {
    const l = this.ledger, deny = message => { throw Object.assign(new Error(message), { code: 'REPORT_PAUSED' }); };
    if (!l.eligible || !l.referenceHash || !l.frozenSnapshot || hash(input.snapshot) !== l.frozenSnapshot || input.finding?.id !== l.findingId)
      deny('Evaluation identity/evidence preflight does not match. No request is authorized.');
    if (!Array.isArray(l.phases) || ![['generate', 'challenge'].join(), ['challenge'].join(), ['generate'].join()].includes(l.phases.join()) || l.limit !== l.phases.length || l.used >= l.limit)
      deny('The fixed finding evaluation allowance is exhausted or invalid. No retry, replacement or repair is authorized.');
    if (input.phase !== l.phases[l.used]) deny('This evaluation permits only its next specified phase, never regeneration or siblings.');
    if (input.phase === 'challenge' && l.used === 1 && (!l.receipts[0]?.completeGeneration || l.receipts[0]?.outcome !== 'completed'))
      deny('Challenge requires a complete structured generation; failed transport cannot trigger another request.');
    if (input.phase === 'challenge' && !input.earlierDraft) deny('Challenge requires the compatible saved semantic base.');
    return 600000;
  }
  reserve(input, requestId) {
    const receipt = { requestId, phase: input.phase, timeoutMs: this.check(input), inputHash: hash(input), at: new Date().toISOString(), outcome: 'reserved' };
    this.ledger.used++; this.ledger.receipts.push(receipt); this.save(this.ledger); return receipt;
  }
  result(receipt, input, value, audit) {
    Object.assign(receipt, { outcome: audit?.outcome || 'failed', completeGeneration: input.phase === 'generate' && valid(value, provider.responseSchema(input)),
      finishedAt: new Date().toISOString(), audit }); this.save(this.ledger);
  }
}
module.exports = { FindingEvaluationGuard };
