'use strict';
// Optional developer input, never evidence, a saved premise or an attestation.
const hash=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
const STATUS='MODEL-PROPOSED, UNTRUSTED';
function fingerprints(input) {
  const expanded=require('./packet-context').expand(input);
  return {findingId:input.finding?.id,snapshotHash:hash(input.snapshot),reportHash:hash(input.finding),
    premiseHash:hash({semanticInput:input.semanticInput,corrections:input.corrections,previousScopes:input.previousScopes}),
    sourceHash:hash({sources:[...(expanded.sources||[])].sort((a,b)=>a.id.localeCompare(b.id)),compiler:input.compiler,documentation:input.documentation}),
    acceptedBaseHash:hash({earlierDraft:input.earlierDraft,assembledEarlier:input.assembledEarlier||null})};
}
function validate(input, note) {
  const keys=['version','status','requestId','responseHash','fingerprints','targetIds','proposal'];
  if(!note||Object.keys(note).length!==keys.length||keys.some(k=>!Object.hasOwn(note,k))||note.version!==1||note.status!==STATUS||
    typeof note.requestId!=='string'||!note.requestId||!/^[a-f0-9]{64}$/.test(note.responseHash)||
    !Array.isArray(note.targetIds)||!note.targetIds.length||note.targetIds.some(x=>typeof x!=='string')||
    !note.proposal||typeof note.proposal!=='object'||Buffer.byteLength(JSON.stringify(note))>16384||
    input.phase!=='challenge'||!input.earlierDraft||hash(note.fingerprints)!==hash(fingerprints(input)))
    throw Error('Provisional work note is invalid, too large or belongs to different current inputs.');
  return note;
}
function attach(input,note) {
  validate(input,note);
  if(input.provisionalWorkNotes&&hash(input.provisionalWorkNotes)!==hash([note]))throw Error('A different provisional note is already attached.');
  return {...input,provisionalWorkNotes:[structuredClone(note)]};
}
function check(input) {
  if(input.provisionalWorkNotes===undefined)return;
  if(!Array.isArray(input.provisionalWorkNotes)||input.provisionalWorkNotes.length!==1)throw Error('Only one bounded provisional work note is supported.');
  validate(input,input.provisionalWorkNotes[0]);
}
const instruction='provisionalWorkNotes, if supplied, contain MODEL-PROPOSED, UNTRUSTED sequential assistance from a prior scoped diagnostic, not independent confirmation. They are not source evidence, specification, human corrections, premises, or accepted reviews. Their local IDs grant no evidence identity. Independently check each useful proposal against the actual supplied source; adopt, reject or narrow it. Perform the ENTIRE ordinary review of all original claims/questions and every required fresh inputReview, explanationReview and causal check. Inherit no approval, completed obligation or publication eligibility from the note. Preserve material uncertainty. A wrong note must not override source or the original allegation.';
module.exports={STATUS,fingerprints,validate,attach,check,instruction};
