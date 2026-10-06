'use strict';
// Offline preparation only. The invoke boundary always throws; no provider
// transport is imported or permitted here. Existing workspaces are read-only.
const fs=require('node:fs'),path=require('node:path');
const engine=require('../extension/investigation-engine');
const {packetIdentity}=require('./evaluation-plan-guard');
const sha=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
async function main(){
  const [frozenFile,destination,resume]=process.argv.slice(2),native=process.env.FLOWBOARD_EXTENSION_PATH;
  if(!path.isAbsolute(frozenFile||'')||!path.isAbsolute(destination||'')||!native||(fs.existsSync(destination)&&resume!=='--resume-local-setup'))
    throw Error('Usage: FLOWBOARD_EXTENSION_PATH=... node scripts/prepare-evaluation-plan.js ABSOLUTE_FROZEN_PROPOSAL NEW_PRIVATE_DIRECTORY');
  const old=JSON.parse(fs.readFileSync(frozenFile)),oldRoot=fs.realpathSync(old.root),repo=path.resolve(__dirname,'..');
  if([oldRoot,repo].some(base=>destination===base||destination.startsWith(base+path.sep)))throw Error('Private output must be outside source/repository.');
  const reference=path.join(path.dirname(frozenFile),'reference.json');
  if(sha(fs.readFileSync(reference))!==old.referenceHash)throw Error('Independent reference changed.');
  if(sha(fs.readFileSync(path.join(oldRoot,'.flowboard/report.json')))!==old.reportFileHash)throw Error('Retained report bytes changed.');
  for(const c of old.cases){
    if(engine.read(oldRoot,c.id))throw Error(`Existing ${c.id} investigation requires explicit saved-stage inspection, not fresh generation.`);
    for(const f of c.decisiveFiles)if(sha(fs.readFileSync(path.join(oldRoot,f.file)))!==f.sha256)throw Error('Decisive source changed.');
    const input=JSON.parse(fs.readFileSync(path.join(path.dirname(frozenFile),c.id,'input.json')));
    if(sha(JSON.stringify(input))!==c.inputHash)throw Error('Retained packet changed.');
  }
  const root=path.join(destination,'project'),exists=fs.existsSync(destination);
  if(exists && ['manifest.json','execution-ledger.json','project/.flowboard/investigations','project/.flowboard/report-preparation.json'].some(f=>fs.existsSync(path.join(destination,f))))
    throw Error('Cannot resume a setup with investigation/accounting history. Use the retained execution arrangement.');
  if(!exists)fs.mkdirSync(destination,{mode:0o700});
  // New identity, new journals. No accepted investigation, receipt, paid
  // history or canvas is copied. Retained human finding inputs are preserved.
  if(!exists)fs.cpSync(oldRoot,root,{recursive:true,filter:file=>!['.flowboard','node_modules'].includes(path.relative(oldRoot,file).split(path.sep)[0])});
  const report=JSON.parse(fs.readFileSync(path.join(oldRoot,'.flowboard/report.json'))),reportFile=path.join(destination,'original-report.md');
  if(!exists){fs.writeFileSync(reportFile,report.originalReport,{flag:'wx',mode:0o600});
    await require('../extension/report').importReport(reportFile,root,native,{deferMapping:true});}
  else if(fs.readFileSync(reportFile,'utf8')!==report.originalReport || JSON.parse(fs.readFileSync(path.join(root,'.flowboard/report.json'))).originalReport!==report.originalReport)
    throw Error('Interrupted setup report does not match the retained original.');
  fs.mkdirSync(path.join(root,'.flowboard/findings'),{recursive:true});
  for(const c of old.cases){const prior=path.join(oldRoot,'.flowboard/findings',c.id+'.json');
    if(fs.existsSync(prior))fs.copyFileSync(prior,path.join(root,'.flowboard/findings',c.id+'.json'));}
  const indexed=await require('../extension/runner-adapter').analyze(native,root,{mode:'source',background:true});
  const catalog=new(require('../extension/source').SourceCatalog)(root,indexed.runner,indexed.result);
  let enabled=false,selected=null,packet;
  const coordinator=new(require('../extension/report-preparation').ReportPreparation)(root,{
    configuration:()=>({provider:enabled?'codex':'none',workers:1,requestLimit:old.cases.reduce((n,c)=>n+c.futureMaximumRequests,0),findingRequestLimit:2}),
    catalog:async()=>catalog,invoke:async()=>{throw Error('OFFLINE SAFETY: transport must never be reached');},
    authorizeRequest:({input})=>{if(input.finding.id!==selected)throw Error('Unexpected offline sibling admission');packet=structuredClone(input);
      throw Object.assign(Error('Offline packet captured before reservation. No provider authorized.'),{code:'REPORT_PAUSED'});}
  });
  try {
    await coordinator.ensure();coordinator.control('pause');enabled=true;
    const manifest={version:1,authorization:'INACTIVE: separate explicit approval required',root:fs.realpathSync(root),
      proposalHash:sha(fs.readFileSync(frozenFile)),referenceHash:old.referenceHash,maximumRequests:old.cases.reduce((n,c)=>n+c.futureMaximumRequests,0),
      requestedProvider:'codex',requestedModel:'isolated CLI default; observed model unknown',reasoning:'medium',tools:'disabled',strictSchema:true,cases:[]};
    for(const c of old.cases){
      selected=c.id;packet=null;await coordinator.continueFinding(c.id);coordinator.control('pause');await coordinator.loop;
      if(!packet||packet.phase!=='generate'||coordinator.state.resources.requests!==0)throw Error('First production phase was not zero-reservation generation.');
      const directory=path.join(destination,c.id);fs.mkdirSync(directory,{mode:0o700});
      fs.writeFileSync(path.join(directory,'input.json'),JSON.stringify(packet,null,2),{flag:'wx',mode:0o600});
      const prior=JSON.parse(fs.readFileSync(path.join(path.dirname(frozenFile),c.id,'input.json')));
      const differences=Object.keys(packet).filter(k=>engine.hash(packet[k])!==engine.hash(prior[k]));
      if(packet.snapshot.sourceDigest!==prior.snapshot.sourceDigest || packet.snapshot.configuration!==prior.snapshot.configuration || packet.snapshot.documentation!==prior.snapshot.documentation)
        throw Error('New execution source/configuration/documentation does not match the proposal.');
      const metrics=require('../extension/semantic-provider').requestMetrics(packet);
      const row={findingId:c.id,phases:c.futureMaximumRequests===1?['generate']:['generate','challenge'],timeoutMs:c.deadlineMsEach,
        snapshotHash:engine.hash(packet.snapshot),firstPacket:packetIdentity(packet),oldFirstPacketHash:c.inputHash,
        firstPacketPath:path.join(directory,'input.json'),snapshot:packet.snapshot,changedTopLevelFields:differences,
        inputBytes:metrics.inputBytes,packetUpperBoundBytes:metrics.requestBytes,priorSavedStage:null,priorCaseRequests:0};
      manifest.cases.push(row);
    }
    const journal=coordinator.status();
    if(journal.requests!==0||journal.mode!=='paused')throw Error('Offline preparation did not remain paused/unspent.');
    fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(destination,'admission-preflight.json'),JSON.stringify({providerRequests:0,reservations:0,status:journal,manifestHash:engine.hash(manifest)},null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({manifestHash:engine.hash(manifest),root,cases:manifest.cases.map(c=>({id:c.findingId,phases:c.phases,changes:c.changedTopLevelFields,inputBytes:c.inputBytes})),providerRequests:0,reservations:0}));
  }finally{coordinator.dispose();await coordinator.loop;}
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={main};
