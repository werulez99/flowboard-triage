'use strict';
// A received proposal is a reference for revisions, NEVER an accepted base.
const candidates=require('./review-candidate'),format=require('./challenge-format'),checkpoint=require('./provider-result');
const VERSION='received-proposal-v1';
function assertCurrent(draft,schema) {
  const state=draft.rejectedProposal;
  if(!state||state.version!==VERSION||state.contextHash!==candidates.identity(draft)||
      state.acceptedStateHash!==candidates.hash(candidates.wire(draft,schema))||state.proposalHash!==candidates.hash(state.proposal)||
      state.origin.recordHash!==state.original.hash||state.origin.proposalHash!==state.proposalHash)
    throw Object.assign(new Error('Retained rejected proposal/source/premise identity changed. No repair or verification is current.'),{code:'REJECTED_PROPOSAL_STALE'});
  return state;
}
function eligible(draft) {return !!draft?.pendingResponse&&draft.pendingResponse.phase==='generate'&&draft.lastRejected?.output&&draft.failureCode==='REVIEW_REFERENCE_SCOPE'&&!draft.rejectedProposal;}
function begin(root,draft,schema) {
  if(draft.rejectedProposal)return assertCurrent(draft,schema);
  if(!eligible(draft))throw new Error('A complete retained reference-rejected proposal is required. Local replay is not semantic repair.');
  const expected={phase:'generate',snapshot:draft.snapshot,corrections:draft.corrections,previous:null};
  const received=checkpoint.read(root,draft.findingId,draft.pendingResponse,expected);
  if(!received||candidates.hash(received.result.value)!==candidates.hash(draft.lastRejected.output))throw new Error('Retained rejection no longer matches the exact received response.');
  const proposal=candidates.unchecked(received.result.value),shape=proposal.bindingFormat?require('./source-bindings').schema(schema):schema;
  if(!format.valid(proposal,shape))throw new Error('The received proposal is not a complete supported structure; repair admission is withheld.');
  require('./review-content').bounds(proposal);
  const original=checkpoint.retain(root,draft.findingId,draft.pendingResponse,expected),proposalHash=candidates.hash(proposal);
  draft.rejectedProposal={version:VERSION,state:'repair-pending',contextHash:candidates.identity(draft),acceptedStateHash:candidates.hash(candidates.wire(draft,schema)),
    proposal,proposalHash,original,origin:{kind:'received-rejected',recordHash:original.hash,proposalHash,requestId:received.result.audit.requestId||null,
      inputHash:candidates.hash(received.input),responseHash:candidates.hash(received.result.value)},
    validationProblems:require('./review-scope').referenceProblems(proposal),at:new Date().toISOString()};
  // Explicitly transfer replay ownership to the immutable original record.
  // The next pending response will be R, not another replay or replacement G.
  delete draft.pendingResponse;
  draft.phase='rejected-proposal-repair';draft.checkpoint={...draft.checkpoint,stage:'challenge'};
  draft.validationProblems=draft.rejectedProposal.validationProblems;
  draft.publication={ready:false,problems:['Received analysis is unaccepted. Its proposed repair needs full fresh verification.']};
  return draft.rejectedProposal;
}
function material(draft,units,schema) {
  const state=assertCurrent(draft,schema),value=require('./review-content').fromWire(state.proposal,units);
  // A lossless field mapping for acquisition and revision comparison only.
  // Do not call accept or install these fields into the accepted draft.
  return {...value,evidence:value.evidence.map(e=>({...e,note:e.explanation,source:{...units.find(u=>u.id===e.sourceId).source,line:e.line,endLine:e.endLine}}))};
}
function originalSourceIds(root,draft,schema){const state=assertCurrent(draft,schema),record=checkpoint.read(root,draft.findingId,state.original,{phase:'generate',snapshot:draft.snapshot,corrections:draft.corrections,previous:null});if(!record)throw new Error('Original proposal sources are unavailable.');return record.units.map(u=>u.id);}
function followupEligible(draft) {
  return !!draft?.rejectedProposal && !draft.reviewCandidate && !!draft.pendingResponse &&
    draft.currentRejection?.responseHash && draft.currentRejection.cleanupConfirmed && draft.currentRejection.reviewPurpose?.startsWith('rejected-proposal-') &&
    (!draft.rejectedProposal.followup || draft.rejectedProposal.followup.state === 'dispatched');
}
function assertFollowup(root,draft,schema) {
  const state=assertCurrent(draft,schema),f=state.followup;if(!f)return null;
  const expected={phase:'challenge',snapshot:draft.snapshot,corrections:draft.corrections,previous:candidates.hash(format.earlier(draft,schema))};
  const record=checkpoint.read(root,draft.findingId,f.archive,expected);
  if(!record||!['pending','dispatched'].includes(f.state)||record.result.audit.outcome!=='completed'||record.result.audit.teardown?.confirmed!==true||
    record.result.audit.requestId!==f.requestId||candidates.hash(record.input)!==f.inputHash||candidates.hash(record.result.value)!==f.fromResponseHash||
    candidates.hash(f.response)!==f.fromResponseHash||record.input.candidateIdentity?.referenceOrigin?.recordHash!==state.origin.recordHash||
    !state.authoringHistory.some(h=>h.archive.hash===f.archive.hash&&h.responseHash===f.fromResponseHash))
    throw Object.assign(new Error('Follow-up no longer matches its immutable received response, ownership or source/premise/proposal lineage.'),{code:'REJECTED_PROPOSAL_STALE'});
  return record;
}
function followup(root,draft,schema,authorization) {
  const state=assertCurrent(draft,schema);
  if(!authorization?.id||!authorization.responseHash)throw new Error('An explicit owned follow-up identity and rejected response are required.');
  if(state.followup?.id===authorization.id){
    if(state.followup.fromResponseHash!==authorization.responseHash)throw new Error('Follow-up authorization changed.');
    return state.followup; // Never renew a consumed/pending identity on restart.
  }
  if(!followupEligible(draft)||draft.currentRejection.responseHash!==authorization.responseHash||
      state.authoringHistory?.some(item=>item.authorizationId===authorization.id))throw new Error('No matching completed rejected authoring attempt can transfer to this follow-up.');
  const expected={phase:'challenge',snapshot:draft.snapshot,corrections:draft.corrections,previous:candidates.hash(format.earlier(draft,schema))};
  const received=checkpoint.read(root,draft.findingId,draft.pendingResponse,expected);
  if(!received||received.result.audit.outcome!=='completed'||received.result.audit.teardown?.confirmed!==true||
      received.result.audit.requestId!==draft.currentRejection.requestId||candidates.hash(received.result.value)!==authorization.responseHash||
      received.input.candidateIdentity?.referenceOrigin?.recordHash!==state.origin.recordHash)
    throw new Error('Completed response ownership, original proposal, context or cleanup is not confirmed.');
  const archive=checkpoint.retain(root,draft.findingId,draft.pendingResponse,expected);
  state.authoringHistory=[...(state.authoringHistory||[]),{archive,diagnostics:structuredClone(draft.currentRejection),
    authorizationId:state.followup?.id||null,requestId:received.result.audit.requestId,responseHash:authorization.responseHash}];
  state.followup={id:authorization.id,state:'pending',fromResponseHash:authorization.responseHash,archive,
    inputHash:candidates.hash(received.input),requestId:received.result.audit.requestId,
    response:structuredClone(received.result.value),diagnostics:structuredClone(draft.currentRejection.validationProblems),at:new Date().toISOString()};
  // The consumed first repair stays repair-dispatched. A distinct explicitly
  // requested follow-up, not a refund/reset, now owns subsequent work.
  delete draft.pendingResponse;
  draft.phase='rejected-proposal-followup';draft.failureKind=null;draft.failureCode=null;
  draft.error='Saved rejected authoring is archived. Local preparation precedes the explicitly requested correction; verification has not started.';
  delete draft.localPreparation?.preflight;
  return state.followup;
}
module.exports={VERSION,assertCurrent,eligible,begin,material,originalSourceIds,followupEligible,followup,assertFollowup};
