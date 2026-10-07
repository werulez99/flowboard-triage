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
module.exports={VERSION,assertCurrent,eligible,begin,material,originalSourceIds};
