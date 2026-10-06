'use strict';
// Developer-only, explicit approval boundary. This never replaces the real
// coordinator/account reservation or provider health/ownership checks.
const fs = require('node:fs');
const engine = require('../extension/investigation-engine');
const provider = require('../extension/semantic-provider');
const { FindingEvaluationGuard } = require('./finding-evaluation-guard');
const deny = message => { throw Object.assign(new Error(message), { code: 'REPORT_PAUSED' }); };
function packetIdentity(input) {
  const m = provider.requestMetrics(input);
  return Object.fromEntries(['inputHash','sourcePacketHash','schemaHash','instructionHash'].map(k => [k,m[k]]));
}
function savedBase(draft) {
  const earlier = require('../extension/challenge-format').earlier(draft, provider.schema);
  return { earlierDraft: draft.bindingPlan ? require('../extension/source-bindings').wire(earlier, draft.bindingPlan) : earlier,
    assembledEarlier: draft.bindingPlan ? require('../extension/source-bindings').derived(draft) : null };
}
class EvaluationPlanGuard {
  constructor({ manifest, approval, ledger, save, root, acceptedBase }) {
    this.manifest=manifest;this.approval=approval;this.ledger=ledger;this.save=save;this.root=fs.realpathSync(root);this.acceptedBase=acceptedBase;
  }
  check(input) {
    const {manifest:m,approval:a,ledger:l}=this;
    if (a?.authorized !== true || a.manifestHash !== engine.hash(m) || a.maximumRequests !== m.maximumRequests)
      deny('Inactive evaluation: separate explicit approval of this exact manifest is required.');
    if (this.root !== m.root || m.maximumRequests !== m.cases.reduce((n,c)=>n+c.phases.length,0) || m.maximumRequests > 5 ||
        new Set(m.cases.map(c=>c.findingId)).size !== m.cases.length || l.manifestHash !== engine.hash(m)) deny('Evaluation workspace/manifest identity changed.');
    if (l.used !== l.receipts.length || l.used >= m.maximumRequests) deny('Aggregate evaluation allowance exhausted or damaged.');
    const c=m.cases.find(c=>c.findingId===input.finding?.id);
    if (!c || c.timeoutMs <= 0 || c.timeoutMs > 600000 || engine.hash(input.snapshot)!==c.snapshotHash) deny('Unapproved finding, snapshot or deadline.');
    const receipts=l.receipts.filter(r=>r.findingId===c.findingId);
    new FindingEvaluationGuard({eligible:true,referenceHash:m.referenceHash,frozenSnapshot:c.snapshotHash,findingId:c.findingId,
      phases:c.phases,limit:c.phases.length,used:receipts.length,receipts},()=>{}).check(input);
    if (!receipts.length && engine.hash(packetIdentity(input))!==engine.hash(c.firstPacket)) deny('First outbound data/source/schema/instruction packet drifted.');
    if (input.phase==='challenge') {
      const base=this.acceptedBase(c.findingId);
      if (!base || !engine.sameSnapshot(base.snapshot,input.snapshot) || base.pendingResponse || base.lastRejected ||
          base.checkpoint?.stage!=='challenge') deny('A compatible accepted generation is required, not a pending/rejected response.');
      if (receipts.length && !base.runs?.some(r=>r.requestId===receipts[0].requestId && r.resultAccepted)) deny('The reserved generation was not accepted by the engine.');
      const expected=savedBase(base);
      if (engine.hash(input.earlierDraft)!==engine.hash(expected.earlierDraft) || engine.hash(input.assembledEarlier||null)!==engine.hash(expected.assembledEarlier))
        deny('Challenge must review the exact compiled accepted generation.');
      if (!receipts.length && engine.hash(expected)!==c.retainedBaseHash) deny('Retained challenge-only base changed.');
    }
    return c.timeoutMs;
  }
  authorize(input) {
    const timeoutMs=this.check(input), receipt={findingId:input.finding.id,phase:input.phase,timeoutMs,...packetIdentity(input),
      reservedAt:new Date().toISOString(),outcome:'reserved',requestId:null,dispatched:false};
    // Persist before returning to the normal reservation. A later interruption
    // consumes this permission; it never refunds authority for a retry.
    this.ledger.used++;this.ledger.receipts.push(receipt);this.save(this.ledger);return receipt;
  }
  dispatch(input, requestId) {
    const receipt=this.ledger.receipts.findLast(r=>r.findingId===input.finding.id);
    if (!requestId || !receipt || receipt.dispatched || receipt.outcome!=='reserved' ||
        engine.hash(packetIdentity(input))!==engine.hash(Object.fromEntries(Object.keys(packetIdentity(input)).map(k=>[k,receipt[k]]))))
      deny('No unused exact pre-admission reservation for this dispatch.');
    receipt.dispatched=true;receipt.requestId=requestId;this.save(this.ledger);return receipt;
  }
  result(receipt,input,result,error) {
    const audit=result?.audit||error?.audit;
    Object.assign(receipt,{outcome:result?'completed':'failed',finishedAt:new Date().toISOString(),audit:audit||null,
      completeGeneration:input.phase==='generate' && !!result && require('../extension/challenge-format').valid(result.value,provider.responseSchema(input)),
      responseHash:result?engine.hash(result.value):null,error:error?.message||null});this.save(this.ledger);
  }
}
module.exports={EvaluationPlanGuard,packetIdentity,savedBase};
