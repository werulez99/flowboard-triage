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
function accountingBaseline(journal) {
  return { project:journal.project,reportHash:journal.reportHash,requests:journal.resources.requests,limit:journal.resources.limit,
    receipts:journal.resources.receipts || {},jobs:Object.fromEntries(Object.entries(journal.jobs).map(([id,job])=>[id,{requests:job.requests,requestLimit:job.requestLimit}])) };
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
          !['challenge','complete'].includes(base.checkpoint?.stage)) deny('A compatible accepted stage is required, not a pending/rejected response.');
      if (receipts.length && !base.runs?.some(r=>r.requestId===receipts[0].requestId && r.resultAccepted)) deny('The reserved generation was not accepted by the engine.');
      const expected=savedBase(base);
      if (engine.hash(input.earlierDraft)!==engine.hash(expected.earlierDraft) || engine.hash(input.assembledEarlier||null)!==engine.hash(expected.assembledEarlier))
        deny('Challenge must review the exact compiled accepted generation.');
      if (!receipts.length && engine.hash(expected)!==c.retainedBaseHash) deny('Retained challenge-only base changed.');
    }
    return c.timeoutMs;
  }
  preparedInput(input) {
    const c=this.manifest.cases.find(c=>c.findingId===input.finding?.id);
    if(c?.provisionalNotePath){
      this.phasePlan(c.findingId);
      const note=JSON.parse(fs.readFileSync(c.provisionalNotePath));
      if(engine.hash(note)!==c.provisionalNoteHash)deny('Provisional note changed from the approved input.');
      input=require('../extension/provisional-work-note').attach(input,note);
    }else if(input.provisionalWorkNotes)deny('No provisional work note is approved for this case.');
    if(!c?.firstPacketPath || this.ledger.receipts.some(r=>r.findingId===c.findingId))return input;
    this.phasePlan(c.findingId); // trusted exact approval, never report/model input
    const frozen=JSON.parse(fs.readFileSync(c.firstPacketPath));
    if(engine.hash(packetIdentity(frozen))!==engine.hash(c.firstPacket))deny('Frozen approved packet changed.');
    const equivalent=value=>{
      const expanded=require('../extension/packet-context').expand(value);
      // Local acquisition can persist before an admission refusal. Only source
      // ordering and host acquisition history may differ; every current source
      // byte/metadata field, premise, question and accepted base must match.
      const {actions,...rest}=expanded;
      const nonAcquisitionActions=(actions||[]).filter(a=>!['source-preparation','checkpoint-resume','code-completion','context-priority','inspect','symbol','callers','references','missing-context'].includes(a.kind));
      return {...rest,nonAcquisitionActions,sources:[...rest.sources].sort((a,b)=>a.id.localeCompare(b.id))};
    };
    if(engine.hash(equivalent(input))!==engine.hash(equivalent(frozen)))deny('Current material input differs from the frozen approved packet.');
    this.check(frozen);
    return frozen; // send the EXACT approved bytes, not a replacement identity
  }
  phasePlan(findingId) {
    if (this.approval?.authorized !== true || this.approval.manifestHash !== engine.hash(this.manifest) || this.approval.maximumRequests !== this.manifest.maximumRequests || this.root !== this.manifest.root)
      deny('No trusted evaluation phase plan for this workspace/approval.');
    const item = this.manifest.cases.find(c => c.findingId === findingId);
    // Accounting observes paused siblings too. An empty plan denies their
    // dispatch without making a read-only debt scan fail the selected case.
    if (!item) return [];
    return [...item.phases];
  }
  continuation(journal) {
    const b=this.manifest.continuation;
    if(!b)return null;
    // Approval is checked before the host is given any allowance mutation.
    this.phasePlan(this.manifest.cases[0]?.findingId);
    if(this.ledger.manifestHash!==engine.hash(this.manifest)||this.ledger.used!==this.ledger.receipts.length||this.ledger.used>this.manifest.maximumRequests)
      deny('Continuation execution ledger is missing, mismatched or damaged.');
    if(this.manifest.cases.some(c=>c.phases.join()!=='challenge') || this.manifest.maximumRequests>2 ||
       !b.parentManifestHash || engine.hash(b.baseline)!==b.baselineHash || journal.project!==b.baseline.project || journal.reportHash!==b.baseline.reportHash)
      deny('Continuation requires its exact parent/nonzero-history baseline and challenge-only cases.');
    const marker=journal.evaluationContinuations?.[engine.hash(this.manifest)];
    if(!marker && engine.hash(accountingBaseline(journal))!==b.baselineHash)deny('Production baseline changed before additive approval.');
    if(marker && (marker.baselineHash!==b.baselineHash || marker.maximumRequests!==this.manifest.maximumRequests))deny('Continuation marker changed.');
    const prior=b.baseline.receipts;
    for(const [id,receipt]of Object.entries(prior))if(engine.hash(journal.resources.receipts[id])!==engine.hash(receipt))deny('A historical production receipt changed.');
    const extra=Object.values(journal.resources.receipts).filter(r=>!Object.hasOwn(prior,r.id));
    if(journal.resources.requests!==b.baseline.requests+extra.length || extra.some(r=>!this.ledger.receipts.some(x=>x.requestId===r.id&&x.findingId===r.findingId)) || extra.length>this.ledger.used)
      deny('Continuation ledger is behind or unrelated to production history.');
    for(const [id,old]of Object.entries(b.baseline.jobs))if(journal.jobs[id]?.requests!==old.requests+extra.filter(r=>r.findingId===id).length)deny('Finding accounting differs from the pinned baseline.');
    return {id:engine.hash(this.manifest),parentManifestHash:b.parentManifestHash,baselineHash:b.baselineHash,baselineRequests:b.baseline.requests,
      maximumRequests:this.manifest.maximumRequests,findings:Object.fromEntries(this.manifest.cases.map(c=>[c.findingId,{baselineRequests:b.baseline.jobs[c.findingId].requests,attempts:c.phases.length}]))};
  }
  phaseRemaining(id) {
    const phases=this.phasePlan(id);
    return this.ledger.used<this.manifest.maximumRequests && this.ledger.receipts.filter(r=>r.findingId===id).length<phases.length;
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
module.exports={EvaluationPlanGuard,packetIdentity,savedBase,accountingBaseline};
