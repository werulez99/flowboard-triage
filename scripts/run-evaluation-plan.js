'use strict';
// No implicit live mode. Inspection reads the plan only; execution needs an
// independently approved exact manifest, plus all ordinary product gates.
const fs=require('node:fs'),path=require('node:path');
const engine=require('../extension/investigation-engine'),provider=require('../extension/semantic-provider');
const {EvaluationPlanGuard,packetIdentity}=require('./evaluation-plan-guard');
async function verifyAdmission(manifest) {
  let catalog, selected; const verified=[];
  const root=fs.realpathSync(manifest.root),native=process.env.FLOWBOARD_EXTENSION_PATH;
  if(!native||root!==manifest.root)throw Error('Exact workspace/native dependency required.');
  const coordinator=new(require('../extension/report-preparation').ReportPreparation)(root,{
    configuration:()=>({provider:'codex',workers:1,requestLimit:manifest.maximumRequests,findingRequestLimit:2}),
    catalog:async()=>{if(!catalog){const r=await require('../extension/runner-adapter').analyze(native,root,{mode:'source',background:true});catalog=new(require('../extension/source').SourceCatalog)(root,r.runner,r.result);}return catalog;},
    invoke:async()=>{throw Error('Offline admission inspection must never dispatch.');},
    authorizeRequest:({input})=>{
      if(input.finding.id!==selected.findingId || input.phase!==selected.phases[0] || engine.hash(packetIdentity(input))!==engine.hash(selected.firstPacket)) {
        fs.writeFileSync(path.join(path.dirname(selected.firstPacketPath),`drift-${Date.now()}.json`),JSON.stringify(input,null,2),{flag:'wx',mode:0o600});
        throw Error('Saved next production packet differs from the frozen execution identity.');
      }
      verified.push(input.finding.id);
      throw Object.assign(Error('Inactive evaluation: inspected before reservation; no dispatch authorized.'),{code:'REPORT_PAUSED'});
    }
  });
  try{
    for(const c of manifest.cases){selected=c;await coordinator.continueFinding(c.findingId);coordinator.control('pause');await coordinator.loop;
      if(coordinator.status().requests!==0)throw Error('Offline admission found consumed accounting; no further inspection.');}
    if(verified.length!==manifest.cases.length)throw Error('Not every saved next packet matched. Inspect finite coordinator status.');
    console.log(JSON.stringify({manifestHash:engine.hash(manifest),verified,providerRequests:0,reservations:0,mode:coordinator.status().mode}));
  }finally{coordinator.dispose();await coordinator.loop;}
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
    if(journal.resources.requests>ledger.used || Object.values(journal.jobs).some(job=>job.requests>ledger.receipts.filter(r=>r.findingId===job.id).length))
      throw Error('Evaluation ledger is missing or behind production accounting; no allowance is recreated.');
    const save=value=>ownership.publish(ledgerFile,value,true);
    let catalog;
    const guard=new EvaluationPlanGuard({manifest,approval,ledger,save,root,acceptedBase:id=>{
      const draft=engine.read(root,id);if(draft)engine.validateCurrent(catalog,draft);return draft;
    }});
    const invoke=async(input,options)=>{
      const receipt=guard.dispatch(input,options.requestId);
      // Raw immutable packets/responses remain private beside the manifest.
      const prefix=path.join(path.dirname(file),`request-${ledger.used}`);
      fs.writeFileSync(prefix+'-input.json',JSON.stringify(input,null,2),{flag:'wx',mode:0o600});
      try { const result=await provider.runProvider(input,{...options,timeoutMs:receipt.timeoutMs});
        fs.writeFileSync(prefix+'-result.json',JSON.stringify(result,null,2),{flag:'wx',mode:0o600});guard.result(receipt,input,result);return result;
      } catch(error){guard.result(receipt,input,null,error);throw error;}
    };invoke.isProviderTransport=true;
    coordinator=new(require('../extension/report-preparation').ReportPreparation)(root,{
      configuration:()=>({provider:'codex',executable:manifest.executable,workers:1,requestLimit:manifest.maximumRequests,findingRequestLimit:2}),
      catalog:async signal=>{if(!catalog){const r=await require('../extension/runner-adapter').analyze(native,root,{mode:'source',background:true,signal});catalog=new(require('../extension/source').SourceCatalog)(root,r.runner,r.result);}return catalog;},
      phasePlan:id=>guard.phasePlan(id), authorizeRequest:({input})=>guard.authorize(input),invoke,
      log:message=>console.error(message)
    });
    // Only explicit case-local admission, never Resume entire report. Existing
    // exhausted accounting is not reset or increased on reopen.
    for(const c of manifest.cases){await coordinator.continueFinding(c.findingId);coordinator.control('pause');await coordinator.loop;}
    console.log(JSON.stringify({used:ledger.used,status:coordinator.status()}));
  } finally {coordinator?.dispose();await coordinator?.loop;ownership.removeOwned(lock,owner.owner);}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
