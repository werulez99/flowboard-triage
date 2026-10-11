'use strict';
// Exact selected-detail records live beside the report journal, not repeated
// in every progress snapshot. References are content/owner bound and lazy.
const p=require('./protocol'),crypto=require('node:crypto');
const MAX_BYTES=8*1024*1024,LEGACY_BYTES=require('./review-capacity').limits.storageBytes;
const fields=['reviewReasoning','validationProblems','rejectionHistory','missingInputs','assessmentProjection'];
const slots=new WeakMap();
const sealed=new WeakMap();
function freeze(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);if(!Object.isFrozen(value))Object.freeze(value);}return value;}
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function detailError(job,key,ref,code,reason){return Object.assign(Error(reason),{code,findingId:job.id,field:key,file:ref?.file||null,reportDetail:true});}
function problem(error){return {code:error.code,kind:'local-reading',findingId:error.findingId,field:error.field,file:error.file,
  requiredForAssessment:error.field==='assessmentProjection',message:error.message,
  action:'recheck-local',actionLabel:'Recheck saved finding locally',
  nextAction:'Recheck this finding from its retained investigation and exact responses without a provider request, or restore the identified exact private detail file. Do not regenerate or reset report usage.'};}
function detail(job,key){
  try{const value=job[key];if(job.detailFailures)delete job.detailFailures[key];return{value};}
  catch(error){if(!error.reportDetail)throw error;const issue=problem(error);(job.detailFailures||={})[key]=issue;return{problem:issue};}
}
function problems(job){return Object.entries(job.detailFailures||{}).filter(([key])=>Object.hasOwn(job,key)||job.detailReferences?.[key]).map(([,issue])=>issue);}
function peek(job,key){const own=Object.getOwnPropertyDescriptor(job,key);if(!own)return undefined;if(!own.get)return own.value;const cached=slots.get(job)?.get(key)?.();return cached?.loaded?cached.value:undefined;}
function assessmentSummary(job){
  const own=Object.getOwnPropertyDescriptor(job,'assessmentProjection');
  if(!own||job.detailFailures?.assessmentProjection)return undefined;
  if(!own.get)return summary(own.value);
  const cached=slots.get(job)?.get('assessmentProjection')?.();
  return cached?.loaded?summary(cached.value):job.assessmentSummary;
}
function summary(value){
  if(!value)return undefined;
  const {technical,severity,engagement,execution,tutorial,artifact}=value;
  return {execution,tutorial,artifact,technical:technical&&Object.fromEntries(Object.entries(technical).filter(([key])=>!['evidence','claims','decisive','historical','details'].includes(key))),
    severity:severity&&Object.fromEntries(Object.entries(severity).filter(([key])=>!['factors','evidence'].includes(key))),engagement};
}
function attach(root,state){
  for(const job of Object.values(state.jobs||{})){
    if(slots.has(job))continue;
    const values=new Map();slots.set(job,values);
    for(const key of fields){
      let loaded=Object.hasOwn(job,key),value=job[key];const ref=job.detailReferences?.[key];
      if(ref&&typeof ref==='object'&&!Array.isArray(ref)&&!ref.reportHash)ref.reportHash=state.reportHash; // original journal owner, before report reconciliation
      if(!loaded&&!ref)continue;
      values.set(key,()=>({loaded,value}));
      Object.defineProperty(job,key,{configurable:true,enumerable:false,get(){
        if(!loaded){
          if(!ref||typeof ref!=='object'||Array.isArray(ref)||ref.file!==`.flowboard/report-details/${ref.hash}.json`||!/^[a-f0-9]{64}$/.test(ref.hash))throw detailError(job,key,ref,'REPORT_DETAIL_REFERENCE','Invalid auxiliary report detail reference; the saved journal and accounting were not reset.');
          let record;try{record=p.readWorkspaceJson(root,ref.file,LEGACY_BYTES);}catch(error){throw detailError(job,key,ref,error.code==='ENOENT'?'REPORT_DETAIL_MISSING':'REPORT_DETAIL_UNREADABLE',`Cannot read ${job.id}/${key}: ${error.code==='ENOENT'?'the exact auxiliary detail file is missing':'the auxiliary detail file is unreadable or invalid'}. Restore ${ref.file} or recheck this finding locally.`);}
          if(!record||typeof record!=='object'||Array.isArray(record)||record.version!==1||!Object.hasOwn(record,'value'))throw detailError(job,key,ref,'REPORT_DETAIL_FORMAT',`Auxiliary detail ${job.id}/${key} has an invalid record format; its text was not used.`);
          if(record.findingId!==job.id||record.field!==key||record.reportHash!==ref.reportHash)throw detailError(job,key,ref,'REPORT_DETAIL_OWNER',`Auxiliary detail ${job.id}/${key} belongs to a different finding, field or report; its text was not used.`);
          if(hash(record)!==ref.hash)throw detailError(job,key,ref,'REPORT_DETAIL_HASH',`Auxiliary detail ${job.id}/${key} no longer matches its exact saved hash; its text was not used.`);
          value=record.value;loaded=true;
        }return value;
      },set(next){value=next;loaded=true;if(job.detailFailures)delete job.detailFailures[key];}});
    }
  }
  return state;
}
function pack(root,state,{checkSize=true}={}){
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
        if(pending.value===undefined){delete references[key];if(key==='assessmentProjection')delete job.assessmentSummary;continue;}
        const object=pending.value&&typeof pending.value==='object',cached=object?sealed.get(pending.value):null,ref=references[key];
        const sameOwner=cached&&Object.isFrozen(pending.value)&&cached.reportHash===state.reportHash&&cached.findingId===id&&cached.field===key;
        // Only an exact frozen detail and its owner-bound saved reference can
        // skip repeated digest/summary work. This caches no job validity,
        // admission, accounting or currentness decision.
        if(sameOwner&&ref?.hash===cached.digest&&ref.file===cached.file&&ref.reportHash===state.reportHash){
          if(key==='assessmentProjection')job.assessmentSummary=cached.summary;
          continue;
        }
        const record={version:1,reportHash:state.reportHash,findingId:id,field:key,value:pending.value};
        const digest=sameOwner?cached.digest:hash(record),file=`.flowboard/report-details/${digest}.json`;
        if(ref?.hash!==digest||ref.file!==file||ref.reportHash!==state.reportHash){
          if(Buffer.byteLength(JSON.stringify(record))+1>LEGACY_BYTES)throw Error(`Report detail ${id}/${key} exceeds safe storage; previous journal preserved.`);
          p.atomicJson(root,file,record,{compact:true});references[key]={file,hash:digest,reportHash:state.reportHash};
        }
        if(object)freeze(pending.value);
        const projection=key==='assessmentProjection'?freeze(summary(pending.value)):undefined;
        if(key==='assessmentProjection')job.assessmentSummary=projection;
        if(object)sealed.set(pending.value,{reportHash:state.reportHash,findingId:id,field:key,digest,file,summary:projection});
      }
    }
    if(job.assessmentSummary)copy.assessmentSummary=job.assessmentSummary;else delete copy.assessmentSummary;
    if(Object.keys(references).length)copy.detailReferences=references;else delete copy.detailReferences;
    job.detailReferences=references;jobs[id]=copy;
  }
  const compact={...state,jobs};
  if(checkSize&&Buffer.byteLength(JSON.stringify(compact))+1>MAX_BYTES)throw Object.assign(Error('Compact report journal exceeds 8 MiB; the last usable journal and exact detail records were preserved. No usage was reset.'),{code:'REPORT_STORAGE_LIMIT'});
  return compact;
}
function read(root,file){
  const state=p.readWorkspaceJson(root,file,LEGACY_BYTES);
  if(!state||typeof state!=='object'||Array.isArray(state)||!state.jobs||typeof state.jobs!=='object'||Array.isArray(state.jobs)||
    !state.resources||!Number.isSafeInteger(state.resources.requests)||state.resources.requests<0||!Number.isSafeInteger(state.resources.limit)||state.resources.limit<0)
    throw Object.assign(Error('The core report journal or accounting is invalid. Restore the exact journal; no report state or spent usage was reset.'),{code:'REPORT_JOURNAL_CORRUPT'});
  return state;
}
module.exports={MAX_BYTES,LEGACY_BYTES,fields,attach,pack,read,detail,problems,peek,summary,assessmentSummary};
