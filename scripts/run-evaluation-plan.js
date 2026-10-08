'use strict';
// No implicit live mode. Inspection reads the plan only; execution needs an
// independently approved exact manifest, plus all ordinary product gates.
const fs=require('node:fs'),path=require('node:path');
const engine=require('../extension/investigation-engine'),provider=require('../extension/semantic-provider');
const {EvaluationPlanGuard,packetIdentity}=require('./evaluation-plan-guard');
// Private answer retention at the existing spawn boundary. Never retain
// reasoning/tool events or arbitrary stderr. A malformed final JSON answer is
// still an immutable answer, even when the adapter cannot return parsed value.
function retainAnswers(file, launch=require('node:child_process').spawn, io=fs) {
  const status={state:'pending',encoding:'strict-utf8',rawByteExact:false,messages:0,stored:0,errors:[]}, answers=[];
  const failed=(kind,operation,error)=>{status.state='failed';status.errors.push({kind,operation,
    code:['ENOSPC','EIO','EACCES','EPERM','EMFILE','EEXIST'].includes(error?.code)?error.code:'other',at:new Date().toISOString()});};
  const capture=(...args)=>{
    let descriptor;
    try{descriptor=io.openSync(file,'wx',0o600);}catch(error){failed('storage','open',error);throw error;}
    let child;try{child=launch(...args);}catch(error){try{io.closeSync(descriptor);}catch(storage){failed('storage','close',storage);}throw error;}
    const decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',bytes=0,decodeFailed=false;
    const line=value=>{
      let event;try{event=JSON.parse(value);}catch{return;} // Malformed event, not a storage error.
      if(!event||event.type!=='item.completed'||event.item?.type!=='agent_message'||typeof event.item.text!=='string')return;
      const answer={receivedAt:new Date().toISOString(),text:event.item.text};answers.push(answer);status.messages++;
      if(status.errors.some(e=>e.kind==='storage'))return;
      try{const encoded=Buffer.from(JSON.stringify(answer)+'\n');let offset=0;
        while(offset<encoded.length){const written=io.writeSync(descriptor,encoded,offset,encoded.length-offset);if(!written)throw Object.assign(Error('No write progress'),{code:'EIO'});offset+=written;}
        status.stored++;
      }catch(error){failed('storage','write',error);}
    };
    const append=text=>{buffer+=text;let i;while((i=buffer.indexOf('\n'))>=0){line(buffer.slice(0,i));buffer=buffer.slice(i+1);}};
    const decode=(chunk,stream)=>{if(decodeFailed)return;try{append(decoder.decode(chunk,{stream}));}catch(error){decodeFailed=true;failed('decoding','utf8',error);}};
    child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes<=provider.MAX_OUTPUT_BYTES)decode(Buffer.from(chunk),true);
      else if(!decodeFailed){decodeFailed=true;failed('output-limit','capture',{});}});
    child.once('close',()=>{
      if(!decodeFailed){decode(undefined,false);if(!decodeFailed&&buffer)line(buffer);}
      try{io.closeSync(descriptor);}catch(error){failed('storage','close',error);}
      if(status.state!=='failed')status.state='complete';
    });
    return child;
  };
  capture.status=status;capture.answers=answers;return capture;
}
async function verifyAdmission(manifest) {
  const verified=[];
  const root=fs.realpathSync(manifest.root),native=process.env.FLOWBOARD_EXTENSION_PATH;
  if(!native||root!==manifest.root)throw Error('Exact workspace/native dependency required.');
  const inventory=()=>{const found={};const walk=folder=>{for(const name of fs.readdirSync(folder).sort()){const f=path.join(folder,name),s=fs.lstatSync(f);if(s.isSymbolicLink())throw Error('Unexpected saved-record symlink.');if(s.isDirectory())walk(f);else found[path.relative(root,f)]=engine.hash(fs.readFileSync(f).toString('base64'));}};walk(path.join(root,'.flowboard'));return found;};
  const before=inventory(),journal=JSON.parse(fs.readFileSync(path.join(root,'.flowboard/report-preparation.json')));
  verifyParent(manifest);
  const indexed=await require('../extension/runner-adapter').analyze(native,root,{mode:'source',background:true});
  const catalog=new(require('../extension/source').SourceCatalog)(root,indexed.runner,indexed.result);
  const report=require('../extension/store').readReport(root),parsed=require('../extension/report').parseReport(report.originalReport,{manifest:true});
  // This ephemeral guard only CHECKS admissibility. No approval file, lock,
  // coordinator ensure, reservation, health reset or saved-project write.
  const guard=new EvaluationPlanGuard({manifest,approval:{authorized:true,manifestHash:engine.hash(manifest),maximumRequests:manifest.maximumRequests},
    ledger:{manifestHash:engine.hash(manifest),used:0,receipts:[]},root,save:()=>{throw Error('Offline inspection cannot reserve.');},acceptedBase:id=>engine.read(root,id)});
  if(manifest.continuation)guard.continuation(journal);
  const observer=new(require('../extension/report-preparation').ReportPreparation)(root,{});
  for(const c of manifest.cases){
    const issue=report.issues.find(i=>i.id===c.findingId),entry=parsed.issues.find(i=>i.id===c.findingId);
    if(!issue||!entry)throw Error('Finding no longer matches the imported report.');
    const request=observer.request(entry,catalog,report),saved=engine.read(root,c.findingId);let packet;
    let prepared;
    if(c.phases[0]==='challenge')({packet,preparation:prepared}=await require('./saved-stage-packet').inspectSavedStage({root,catalog,request,issue,findingId:c.findingId,saved,candidateSeed:guard.candidateSeed(c.findingId)}));
    else {
      if(saved?.runs?.some(r=>r.resultAccepted)||saved?.pendingResponse)throw Error('A paid stage exists; fresh generation inspection would misrepresent continuation.');
      const draft=saved?structuredClone(saved):engine.create({findingId:c.findingId,request,issue,catalog});
      await engine.advance({root,catalog,request,issue,findingId:c.findingId,draft,persist:false,provider:'codex',current:()=>true,publish:async()=>{},invoke:async input=>{
        packet=input;throw Object.assign(Error('Offline capture; no reservation.'),{code:'LOCAL_READING_LIMIT'});
      }});
    }
    if(!packet)throw Error('No admissible next packet.');
    guard.acceptedBase=id=>id===c.findingId&&prepared?prepared:engine.read(root,id);
    guard.check(guard.preparedInput(packet));verified.push(c.findingId);
  }
  if(engine.hash(before)!==engine.hash(inventory()))throw Error('Offline verification changed retained records.');
  console.log(JSON.stringify({manifestHash:engine.hash(manifest),verified,providerRequests:0,newReservations:0,baselineRequests:journal.resources.requests,savedRecordsUnchanged:true}));
}
function verifyParent(manifest) {
  const c=manifest.continuation;if(!c)return;
  if(!path.isAbsolute(c.parentManifestPath||'')||!path.isAbsolute(c.parentLedgerPath||'')||
    engine.hash(JSON.parse(fs.readFileSync(c.parentManifestPath)))!==c.parentManifestHash ||
    engine.hash(JSON.parse(fs.readFileSync(c.parentLedgerPath)))!==c.parentLedgerHash)throw Error('Parent manifest/ledger changed or missing; no continuation permission.');
  if(manifest.cases.some(item=>item.reviewPurpose)) {
    const cycle=manifest.reviewCycle, parent=JSON.parse(fs.readFileSync(c.parentManifestPath)), ledger=JSON.parse(fs.readFileSync(c.parentLedgerPath));
    if(cycle?.kind==='received-proposal-repair-v1'){
      const selected=manifest.cases[0],previous=parent.cases[0],isRepair=selected?.reviewPurpose==='rejected-proposal-repair',isFollowup=selected?.reviewPurpose==='rejected-proposal-followup';
      if(!cycle.id||manifest.cases.length!==1||manifest.maximumRequests!==1||!selected.originalProposalHash||parent.cases.length!==1||previous.findingId!==selected.findingId||
        selected.phases?.length!==1||selected.phases[0]!=='challenge'||!Number.isFinite(selected.timeoutMs)||selected.timeoutMs<=0||selected.timeoutMs>(isRepair||isFollowup?300000:600000)||
        ledger.receipts?.length!==1||
        (isRepair?(!!parent.reviewCycle||previous.phases?.length!==1||previous.phases[0]!=='generate'||ledger.used!==1||ledger.receipts[0].outcome!=='completed'):
          (isFollowup?previous.reviewPurpose!=='rejected-proposal-repair'||!selected.followupAuthorization?.id||selected.followupAuthorization.responseHash!==ledger.receipts[0].responseHash:
            selected.reviewPurpose!=='candidate-verification'||!['rejected-proposal-repair','rejected-proposal-followup'].includes(previous.reviewPurpose))||parent.reviewCycle?.id!==cycle.id||parent.reviewCycle.kind!==cycle.kind||
          previous.originalProposalHash!==selected.originalProposalHash||ledger.used!==1||ledger.receipts[0].outcome!=='completed'||ledger.receipts[0].audit?.teardown?.confirmed!==true))
        throw Error('Rejected-proposal continuation requires its exact completed parent and explicit new authoring authority, then the same one full V; no retry or repair after verification.');
      return;
    }
    const order=['candidate-completion','candidate-verification','candidate-repair','candidate-reverification'];
    const purpose=manifest.cases[0].reviewPurpose, index=order.indexOf(purpose);
    if(!cycle || !cycle.id || manifest.cases.length!==1 || manifest.maximumRequests!==1 || index<0 ||
       (parent.reviewCycle ? parent.reviewCycle.id!==cycle.id || order.indexOf(parent.cases[0].reviewPurpose)!==index-1 || ledger.used!==1 ||
         ledger.receipts[0].outcome!=='completed' || ledger.receipts[0].audit?.teardown?.confirmed===false : index>1))
      throw Error('Candidate cycle permits C -> V -> conditional R -> V2 once; timeout/interruption cannot open another slot.');
  }
}
function executionOptions({manifest,guard,catalog,invoke}) {
  return {configuration:()=>({provider:'codex',executable:manifest.executable,workers:1,requestLimit:manifest.maximumRequests,findingRequestLimit:2}),
    catalog,prepareRequest:input=>guard.preparedInput(input),candidateSeed:id=>guard.candidateSeed(id),phasePlan:id=>guard.phasePlan(id),phaseRemaining:id=>guard.phaseRemaining(id),evaluationContinuation:journal=>guard.continuation(journal),authorizeRequest:({input})=>guard.authorize(input),invoke,
    log:message=>console.error(message)};
}
async function runCases(coordinator,manifest) {
  for(const c of manifest.cases){await coordinator.continueFinding(c.findingId);coordinator.control('pause');await coordinator.loop;}
}
async function main() {
  const [file,mode,approvalFile]=process.argv.slice(2);
  if (!file || !path.isAbsolute(file)) throw Error('Usage: node scripts/run-evaluation-plan.js ABSOLUTE_MANIFEST [--execute ABSOLUTE_APPROVAL]');
  const manifest=JSON.parse(fs.readFileSync(file));
  if(mode==='--verify-admission')return verifyAdmission(manifest);
  if (!mode) { console.log(JSON.stringify({manifestHash:engine.hash(manifest),authorization:'inactive; no dispatch',root:manifest.root,
    maximumRequests:manifest.maximumRequests,cases:manifest.cases.map(c=>({findingId:c.findingId,phases:c.phases,firstPacket:c.firstPacket,timeoutMs:c.timeoutMs}))},null,2));return; }
  if (mode!=='--execute' || !path.isAbsolute(approvalFile||'')) throw Error('Explicit execution mode and separate approval file required.');
  const approval=JSON.parse(fs.readFileSync(approvalFile));
  if (!approval.authorized || approval.manifestHash!==engine.hash(manifest) || approval.maximumRequests!==manifest.maximumRequests) throw Error('No approval for this exact evaluation.');
  verifyParent(manifest);
  const root=fs.realpathSync(manifest.root),native=process.env.FLOWBOARD_EXTENSION_PATH;
  if (!native || root!==manifest.root) throw Error('Exact workspace and original native dependency required.');
  const sha=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const identity=await require('../extension/runtime-diagnostics').providerIdentity('codex',manifest.executable,true);
  if(!manifest.transport || identity.version!==manifest.transport.cliVersion ||
      sha(fs.readFileSync(manifest.acceptanceReference))!==manifest.referenceHash ||
      fs.realpathSync(identity.resolvedExecutable)!==manifest.transport.executableRealpath ||
      sha(fs.readFileSync(identity.resolvedExecutable))!==manifest.transport.executableHash ||
      sha(fs.readFileSync(require.resolve('../extension/semantic-provider')))!==manifest.transport.adapterHash ||
      JSON.parse(fs.readFileSync(path.join(native,'package.json'))).version!==manifest.transport.nativeVersion)
    throw Error('Configured CLI/adapter/native identity changed; re-inspect before approval. No model request started.');
  const ownership=require('../extension/provider-ownership'),lock=path.join(path.dirname(file),'execution.lock'),owner=ownership.ownerMetadata();
  if(ownership.reap(lock))throw Error('Evaluation is owned by another process.');
  ownership.publish(lock,owner);
  let coordinator;
  try {
    const ledgerFile=path.join(path.dirname(file),'execution-ledger.json');
    const ledger=fs.existsSync(ledgerFile)?JSON.parse(fs.readFileSync(ledgerFile)):{manifestHash:engine.hash(manifest),used:0,receipts:[]};
    const journal=JSON.parse(fs.readFileSync(path.join(root,'.flowboard/report-preparation.json')));
    if(!manifest.continuation && (journal.resources.requests>ledger.used || Object.values(journal.jobs).some(job=>job.requests>ledger.receipts.filter(r=>r.findingId===job.id).length)))
      throw Error('Evaluation ledger is missing or behind production accounting; no allowance is recreated.');
    const save=value=>ownership.publish(ledgerFile,value,true);
    let catalog;
    const guard=new EvaluationPlanGuard({manifest,approval,ledger,save,root,acceptedBase:id=>{
      const draft=engine.read(root,id);if(draft)engine.validateCurrent(catalog,draft);return draft;
    }});
    if(manifest.continuation)guard.continuation(journal);
    const invoke=async(input,options)=>{
      const receipt=guard.dispatch(input,options.requestId);
      // Raw immutable packets/responses remain private beside the manifest.
      const prefix=path.join(path.dirname(file),`request-${ledger.used}`);
      fs.writeFileSync(prefix+'-input.json',JSON.stringify(input,null,2),{flag:'wx',mode:0o600});
      const capture=retainAnswers(prefix+'-response.jsonl');
      try { const result=await provider.runProvider(input,{...options,timeoutMs:receipt.timeoutMs,spawn:capture});
        result.audit.answerCapture=structuredClone(capture.status);
        if(capture.status.state==='failed')result.answerCaptureRecovery=structuredClone(capture.answers);
        try{fs.writeFileSync(prefix+'-result.json',JSON.stringify(result,null,2),{flag:'wx',mode:0o600});}
        catch(error){result.audit.answerCapture.resultStorageFailure={code:['ENOSPC','EIO','EACCES','EPERM'].includes(error.code)?error.code:'other'};}
        guard.result(receipt,input,result);return result;
      } catch(error){
        if(error.audit)error.audit.answerCapture=structuredClone(capture.status);
        // A malformed answer remains recoverable even if the first capture file failed.
        if(capture.status.state==='failed')try{fs.writeFileSync(prefix+'-capture-recovery.json',JSON.stringify({capture:capture.status,answers:capture.answers}),{flag:'wx',mode:0o600});}catch{/* The receipt still records capture failure; no success is claimed. */}
        guard.result(receipt,input,null,error);throw error;}
    };invoke.isProviderTransport=true;
    coordinator=new(require('../extension/report-preparation').ReportPreparation)(root,executionOptions({manifest,guard,
      catalog:async signal=>{if(!catalog){const r=await require('../extension/runner-adapter').analyze(native,root,{mode:'source',background:true,signal});catalog=new(require('../extension/source').SourceCatalog)(root,r.runner,r.result);}return catalog;},invoke}));
    // Only explicit case-local admission, never Resume entire report. Existing
    // exhausted accounting is not reset or increased on reopen.
    await runCases(coordinator,manifest);
    console.log(JSON.stringify({used:ledger.used,status:coordinator.status()}));
  } finally {coordinator?.dispose();await coordinator?.loop;ownership.removeOwned(lock,owner.owner);}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main,verifyAdmission,executionOptions,runCases,verifyParent,retainAnswers};
