'use strict';
// Acquisition is evidence availability, not approval. Same IDs do not imply
// the same question. Keep exact wording/action/scope and context together.
const crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=q=>hash([q.id,q.claimId,q.text,q.why,q.action,q.target]);
const context=draft=>hash([draft.snapshot,draft.corrections,draft.semanticInput]);
const stamp=(question,draft)=>({questionIdentity:identity(question),questionContext:context(draft)});
function receipt(draft,question) {
  const matches=(draft.actions||[]).filter(action=>{
    if(action.questionId!==question.id)return false;
    if(action.questionIdentity)return action.questionIdentity===identity(question)&&action.questionContext===context(draft);
    // Older complete acquisition keys already bind the entire question and
    // compatible source/report/configuration. Do not borrow target-only history.
    const claims=[...(draft.claims||[]),...(draft.rejectedProposal?.proposal.claims||[]),...(draft.reviewCandidate?.candidate.claims||[])];
    const entries=[...new Set(claims.filter(c=>c.id===question.claimId).map(c=>c.entry))];if(!entries.length)entries.push(undefined);
    const version=action.acquisitionVersion;
    return !!version&&entries.some(entry=>action.acquisitionKey===hash([version,question,entry,draft.snapshot.reportHash,draft.snapshot.sourceDigest,draft.snapshot.configuration]));
  });
  return matches.at(-1)||null;
}
module.exports={identity,context,stamp,receipt};
