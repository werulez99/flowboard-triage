'use strict';
// Exact selected-detail records live beside the report journal, not repeated
// in every progress snapshot. References are content/owner bound and lazy.
const p=require('./protocol'),crypto=require('node:crypto');
const MAX_BYTES=8*1024*1024,LEGACY_BYTES=require('./review-capacity').limits.storageBytes;
const fields=['reviewReasoning','validationProblems','rejectionHistory','missingInputs','assessmentProjection'];
const slots=new WeakMap();
const sealed=new WeakMap();
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function summary(value){
  if(!value)return undefined;
  const {technical,severity,engagement,execution,tutorial}=value;
  return {execution,tutorial,technical:technical&&Object.fromEntries(Object.entries(technical).filter(([key])=>!['evidence','claims','decisive','historical','details'].includes(key))),
    severity:severity&&Object.fromEntries(Object.entries(severity).filter(([key])=>!['factors','evidence'].includes(key))),engagement};
}
function attach(root,state){
  for(const job of Object.values(state.jobs||{})){
    if(slots.has(job))continue;
    const values=new Map();slots.set(job,values);
    for(const key of fields){
      let loaded=Object.hasOwn(job,key),value=job[key];const ref=job.detailReferences?.[key];
      if(ref&&!ref.reportHash)ref.reportHash=state.reportHash; // original journal owner, before report reconciliation
      if(!loaded&&!ref)continue;
      values.set(key,()=>({loaded,value}));
      Object.defineProperty(job,key,{configurable:true,enumerable:false,get(){
        if(!loaded){
          if(!ref||ref.file!==`.flowboard/report-details/${ref.hash}.json`||!/^[a-f0-9]{64}$/.test(ref.hash))throw Error('Invalid report detail reference; the saved journal was not reset.');
          const record=p.readWorkspaceJson(root,ref.file,LEGACY_BYTES);
          if(hash(record)!==ref.hash||record.findingId!==job.id||record.field!==key||record.reportHash!==ref.reportHash)throw Error('Report detail identity changed; restore its exact private record.');
          value=record.value;loaded=true;
        }return value;
      },set(next){value=next;loaded=true;}});
    }
  }
  return state;
}
function pack(root,state){
  attach(root,state);
  const jobs={};
  for(const [id,job]of Object.entries(state.jobs||{})){
    const copy={...job},references={...(job.detailReferences||{})};
    for(const key of fields){
      const slot=slots.get(job).get(key),own=Object.getOwnPropertyDescriptor(job,key);
      if(!own){delete references[key];if(key==='assessmentProjection')delete job.assessmentSummary;continue;}
      const pending=own.get?slot():{loaded:true,value:job[key]};
      delete copy[key];
      if(pending.loaded){
        if(key==='assessmentProjection')job.assessmentSummary=summary(pending.value);
        if(pending.value===undefined){delete references[key];continue;}
        const record={version:1,reportHash:state.reportHash,findingId:id,field:key,value:pending.value};
        const owner=JSON.stringify([state.reportHash,id,key]),cached=pending.value&&typeof pending.value==='object'?sealed.get(pending.value):null;
        const digest=cached?.owner===owner?cached.digest:hash(record),file=`.flowboard/report-details/${digest}.json`;
        if(references[key]?.hash!==digest){
          if(Buffer.byteLength(JSON.stringify(record))+1>LEGACY_BYTES)throw Error(`Report detail ${id}/${key} exceeds safe storage; previous journal preserved.`);
          p.atomicJson(root,file,record,{compact:true});references[key]={file,hash:digest,reportHash:state.reportHash};
        }
        if(pending.value&&typeof pending.value==='object'){freeze(pending.value);sealed.set(pending.value,{owner,digest});}
      }
    }
    if(job.assessmentSummary)copy.assessmentSummary=job.assessmentSummary;else delete copy.assessmentSummary;
    if(Object.keys(references).length)copy.detailReferences=references;else delete copy.detailReferences;
    job.detailReferences=references;jobs[id]=copy;
  }
  const compact={...state,jobs};
  if(Buffer.byteLength(JSON.stringify(compact))+1>MAX_BYTES)throw Object.assign(Error('Compact report journal exceeds 8 MiB; the last usable journal and exact detail records were preserved. No usage was reset.'),{code:'REPORT_STORAGE_LIMIT'});
  return compact;
}
function read(root,file){return p.readWorkspaceJson(root,file,LEGACY_BYTES);}
module.exports={MAX_BYTES,LEGACY_BYTES,fields,attach,pack,read};
