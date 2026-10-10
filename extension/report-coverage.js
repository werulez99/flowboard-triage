'use strict';
// Auditable extraction, not a host-authored verdict. The challenger must read
// the ORIGINAL paragraphs, not only the author's list of allegations.
const {hash}=require('./review-content');
const VERSION='report-coverage-v1',MAX=256;
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text={type:'string',maxLength:4096},id={type:'string',pattern:'^[A-Za-z0-9_.-]{1,100}$'};
const ids={type:'array',items:id,maxItems:MAX*2};
const schema=object({version:{enum:[VERSION]},reportHash:{type:'string',pattern:'^[a-f0-9]{64}$'},
  dispositions:{type:'array',maxItems:MAX,items:object({id,paragraphId:id,start:{type:'integer',minimum:0},end:{type:'integer',minimum:1},
    kind:{enum:['claim','unresolved','context','proposed-change','duplicate']},claimIds:{type:'array',items:id,maxItems:8},duplicateOf:{type:'string',maxLength:100},reason:text})}});
const reviewSchema=object({reportHash:schema.properties.reportHash,reviewedIds:ids,
  changes:{type:'array',maxItems:MAX*2,items:object({id,kind:{enum:['added','changed','removed']},reason:text})},reason:text});
const paragraphs=draft=>require('./webview/walkthrough-model').paragraphs(draft.semanticInput?.reportText??draft.walkthrough?.reportText??'');
const reportHash=draft=>require('./semantic-input').hash(draft.semanticInput?.reportText??draft.walkthrough?.reportText??'');
function changes(before,after){const a=before?.dispositions||[],b=after?.dispositions||[];return [...new Set([...a,...b].map(x=>x.id))].flatMap(id=>{
  const old=a.find(x=>x.id===id),next=b.find(x=>x.id===id);return hash(old??null)===hash(next??null)?[]:[{id,kind:!old?'added':!next?'removed':'changed'}];});}
function problems(value,draft,{required=false,review=false,previous=null}={}){
  const result=[],map=value.reportCoverage,checked=value.reportReview;
  const add=(code,target,message)=>result.push({code,target,message,reason:message,kind:'structural',action:'Compare the complete original report with its assertion dispositions in the ordinary review; do not infer coverage from existing claims alone.'});
  if(!map){if(required)add('REPORT_COVERAGE_MISSING','reportCoverage','The original report has no assertion-to-claim disposition map. Whole-finding coverage is not established.');return result;}
  const format=require('./challenge-format');
  if(!format.valid(map,schema)){add('REPORT_COVERAGE_SHAPE','reportCoverage','Report dispositions exceed or violate the bounded contract; none were applied.');return result;}
  if(map.reportHash!==reportHash(draft))add('REPORT_COVERAGE_IDENTITY','reportCoverage','Report dispositions refer to a different original report.');
  const all=paragraphs(draft),claims=new Set((value.claims||draft.claims||[]).map(c=>c.id)),known=new Map(map.dispositions.map(d=>[d.id,d]));
  if(known.size!==map.dispositions.length)add('REPORT_COVERAGE_ID','reportCoverage','Report disposition IDs are not unique.');
  for(const d of map.dispositions){const p=all.find(p=>p.id===d.paragraphId);
    if(!p||d.start>=d.end||d.end>p.text.length||!p.text.slice(d.start,d.end).trim())add('REPORT_COVERAGE_SPAN',d.id,'A disposition must select an exact nonempty interval of its original paragraph.');
    if(!d.reason.trim()||d.claimIds.some(id=>!claims.has(id))||new Set(d.claimIds).size!==d.claimIds.length||d.kind==='claim'&&!d.claimIds.length)
      add('REPORT_COVERAGE_REFERENCE',d.id,'A mapped assertion needs its existing claim IDs and a concrete disposition reason.');
    if(d.kind==='duplicate'){
      const target=known.get(d.duplicateOf),seen=new Set([d.id]);let cursor=target;
      while(cursor?.kind==='duplicate'&&!seen.has(cursor.id)){seen.add(cursor.id);cursor=known.get(cursor.duplicateOf);}
      if(!target||!cursor||seen.has(cursor.id))add('REPORT_COVERAGE_DUPLICATE',d.id,'Repeated wording must reference an existing, non-cyclic disposition; it cannot hide a separate allegation.');
    }else if(d.duplicateOf)add('REPORT_COVERAGE_DUPLICATE',d.id,'Only a repeated-wording disposition may use duplicateOf.');
  }
  for(const p of all){const spans=map.dispositions.filter(d=>d.paragraphId===p.id).sort((a,b)=>a.start-b.start);let end=0;
    for(const d of spans){if(p.text.slice(end,d.start).trim())break;end=Math.max(end,d.end);}
    if(p.text.slice(end).trim())add('REPORT_COVERAGE_GAP',p.id,`Original paragraph ${p.id} contains text with no disposition. Material alternatives and late qualifications cannot disappear during first extraction.`);
  }
  if(review){
    if(!format.valid(checked,reviewSchema)||checked.reportHash!==map.reportHash||!checked.reason.trim())add('REPORT_COVERAGE_REVIEW','reportReview','The fresh challenge must compare the complete original report and saved corrections with the exact disposition map.');
    else {
      const requiredIds=new Set([...(previous?.reportCoverage?.dispositions||[]),...map.dispositions].map(d=>d.id));
      if(new Set(checked.reviewedIds).size!==checked.reviewedIds.length||[...requiredIds].some(id=>!checked.reviewedIds.includes(id)))add('REPORT_COVERAGE_REVIEW','reportReview/reviewedIds','Fresh report review omits a current or removed original disposition.');
      if(previous){const expected=changes(previous.reportCoverage,map);
        if(checked.reviewedIds.some(id=>!requiredIds.has(id))||checked.changes.length!==expected.length||new Set(checked.changes.map(c=>c.id)).size!==expected.length||expected.some(c=>!checked.changes.some(x=>x.id===c.id&&x.kind===c.kind&&x.reason.trim())))
          add('REPORT_COVERAGE_REVISION','reportReview/changes','Added, remapped and removed report dispositions need explicit fresh review reasons; old approval cannot be inherited.');
      }
    }
  }
  return result;
}
function assert(value,draft,options){const errors=problems(value,draft,options);if(errors.length)throw require('./review-scope').failure(errors);}
function unresolved(draft){return(draft.reportCoverage?.dispositions||[]).filter(d=>d.kind==='unresolved');}
function details(draft){const errors=problems(draft,draft,{required:!!draft.reportCoverageContract,review:true});return [...errors,...unresolved(draft).map(d=>({
  kind:'material-evidence',code:'REPORT_SCOPE_UNRESOLVED',target:'report:'+d.id,claimIds:d.claimIds,paragraphId:d.paragraphId,
  reason:d.reason,action:'Resolve this original reported scope and freshly review its disposition; unrelated checked claims remain distinct.'}))];}
const instruction=`REPORT COVERAGE report-coverage-v1. Read EVERY original report paragraph and saved correction, including alternate routes and late qualifications. Return reportCoverage bound to semanticInput.originalReport.sha256. Split each paragraph into its materially distinct assertions using original paragraphId and zero-based UTF-16 start/end offsets (end exclusive, relative to paragraph.text). Cover all non-whitespace text; headers/code/repeated wording also need concise dispositions, NOT extra claims/events. kind=claim links existing claimIds for allegations, preconditions and claimed consequences; kind=unresolved preserves material original scope with a precise missing fact/reason (claimIds may be empty for a separate unassessed route). context is non-allegation background; proposed-change is NOT current code; duplicate points to an existing disposition with genuinely identical scope. A single blanket covered label must not hide two assertions. Reasons explain the classification; the host validates exact coverage/references, NOT semantic completeness. Maximum 256 dispositions; if material scope cannot fit, retain a precise blocker, never omit it. Generate reportReview=null. The SAME fresh challenge must compare the FULL original report and corrections with the map, not just existing claims: return reportReview with the same reportHash, all original/current disposition IDs in reviewedIds, concrete overall reason, and changes for every added/changed/removed disposition. For candidate verification, compare the ORIGINAL reference map in candidateRevisions.before with earlierDraft.reportCoverage; kept preserves the candidate but does not waive its prior changes. Only a map unchanged from that reference has changes=[]. Review narrowing/reclassification and proposed code versus actual code adversarially; return repair if any material route is omitted or disguised as background. Honest reviewed unresolved scope prevents whole-finding refutation/complete coverage/Ready but does not erase an independently supported defect. No extra model stage or step per paragraph.`;
module.exports={VERSION,MAX,schema,reviewSchema,paragraphs,reportHash,changes,problems,assert,unresolved,details,instruction};
