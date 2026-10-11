'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),acquisition=require('../extension/question-acquisition');
const {ReportPreparation}=require('../extension/report-preparation');
const coordinator=used=>Object.assign(Object.create(ReportPreparation.prototype),{state:{resources:{requests:used,limit:used}},options:{configuration:()=>({provider:'none'})}});
test('same-ID different recovery questions retain exact receipts, origins and legacy key compatibility',()=>{
  const first={id:'same',claimId:'claim',text:'Read the first guard.',why:'Original branch.',action:'symbol',target:'First::guard'},second={...first,text:'Read the other guard.',why:'Replacement branch.',target:'Second::guard'};
  const draft={snapshot:{reportHash:'report',sourceDigest:'sources',configuration:'config'},corrections:[],semanticInput:{premises:[]},claims:[{id:'claim',entry:'entry'}],questions:[],
    sources:['one','two'].map(id=>({id,name:id,source:{file:id+'.sol',line:1,endLine:3}})),actions:[],
    rejectedProposal:{proposal:{questions:[first],claims:[{id:'claim',entry:'entry'}]},origin:{requestId:'G'},state:'repair-dispatched'},
    currentRejection:{requestId:'R',responseHash:'response',reviewPurpose:'rejected-proposal-repair',materialQuestions:[second],validationProblems:[]}};
  draft.actions=[first,second].map((q,i)=>({questionId:q.id,...acquisition.stamp(q,draft),sourceIds:[i?'two':'one'],outcome:'source-returned',result:q.target}));
  const job={id:'fixture',requests:1,requestLimit:1};
  coordinator(1).recoveryStatus(job,draft);
  assert.deepEqual(job.missingInputs.map(q=>q.acquisition.sources[0].id),['one','two']);
  assert.deepEqual(job.missingInputs.map(q=>q.origins[0].requestId),['G','R']);
  const legacy={...draft.actions[0],questionIdentity:undefined,questionContext:undefined,acquisitionVersion:'old-resolver'};
  legacy.acquisitionKey=require('../extension/investigation-engine').hash(['old-resolver',first,'entry','report','sources','config']);
  draft.actions=[legacy];assert.equal(acquisition.receipt(draft,first),legacy);assert.equal(acquisition.receipt(draft,second),null);
  delete legacy.acquisitionKey;assert.equal(acquisition.receipt(draft,first),null,'An unattributed ID/target is not exact wording provenance.');
  draft.actions=[{questionId:first.id,...acquisition.stamp(first,draft),sourceIds:['one']}];draft.snapshot.sourceDigest='changed';
  assert.equal(acquisition.receipt(draft,first),null);
});
test('completed verification is distinct from publication and preserves original and authoring rejection history',()=>{
  const draft={snapshot:{},sources:[],actions:[],questions:[],claims:[],candidateVerification:{candidateHash:'exact'},
    candidateHistory:[{candidateHash:'older',verification:{requestId:'older'}},{candidateHash:'exact',verification:{requestId:'V',result:'kept',at:'now'}}],
    publication:{ready:false,details:[]},rejectedProposalHistory:[{origin:{requestId:'G'},validationProblems:[{code:'SCOPE',message:'original'}],
      authoringHistory:[{requestId:'R',diagnostics:{validationProblems:[{code:'FORMAT',message:'authoring'}]}}]}],
    localRevalidations:[{requestId:'R2',previousRejection:{validationProblems:[{code:'CAPACITY',message:'historical capacity'}]}}]};
  const job={id:'generic',requests:4,requestLimit:4};
  coordinator(4).recoveryStatus(job,draft);
  assert.deepEqual(job.verificationCompletion,{requestId:'V',result:'kept',at:'now',published:false});
  assert.deepEqual(job.rejectionHistory.map(item=>item.requestId),['G','R','R2']);assert.deepEqual(job.validationProblems,[]);
  assert.equal(job.retainedRejection,false);assert.equal(job.repairAvailable,false);
  draft.candidateVerification.candidateHash='changed';
  coordinator(4).recoveryStatus(job,draft);
  assert.equal(job.verificationCompletion,null,'An older verification cannot label a changed candidate checked.');
});
