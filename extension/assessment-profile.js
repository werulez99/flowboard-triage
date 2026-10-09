'use strict';
// Finite mapping over reviewed factors, not executable policy or a second verdict.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const VERSION='general-audit-v1';
const bands={'systemic-irreversible':'Critical','material-loss-or-critical-function':'High','bounded-harm':'Medium','minor-deviation':'Low','non-security':'Informational'};
const names=Object.values(bands),hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function validate(value){
  if(!value||value.version!==1||typeof value.name!=='string'||!value.name.trim()||value.name.length>120||typeof value.revision!=='string'||!value.revision.trim()||value.revision.length>120||
    Object.keys(value).some(k=>!['version','name','revision','labels','eligibleBands'].includes(k))||!Array.isArray(value.eligibleBands)||value.eligibleBands.some(x=>!names.includes(x))||new Set(value.eligibleBands).size!==value.eligibleBands.length||
    !value.labels||typeof value.labels!=='object'||Array.isArray(value.labels)||Object.keys(value.labels).some(k=>!names.includes(k))||Object.values(value.labels).some(v=>typeof v!=='string'||!v.trim()||v.length>60))
    throw new Error('Invalid engagement mapping. Use version 1, name, revision, labels and eligibleBands only. Trust, scope and intended-behavior changes require an explicit finding correction, not a label profile.');
  return {...value,identity:hash(value)};
}
function load(root,relative){
  if(!relative)return null;
  const file=path.resolve(root,relative);
  if(path.isAbsolute(relative)||!file.startsWith(path.resolve(root)+path.sep)||!fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep))throw new Error('The engagement mapping must be a local file inside this workspace.');
  if(fs.statSync(file).size>16384)throw new Error('Engagement mapping exceeds 16 KiB.');
  return validate(JSON.parse(fs.readFileSync(file,'utf8')));
}
function project(draft,assessment,profile=null){
  const technical=assessment.technical,result={rubric:VERSION,severity:{state:'not-assessable',label:'Not assessed',reason:'No current reviewed severity factors are available.'},engagement:{state:'not-assessed',reason:'No engagement rules selected.'}};
  if(profile)result.engagement={state:'not-assessed',name:profile.name,revision:profile.revision,identity:profile.identity,reason:'No reviewed established-defect severity band is available for this mapping.'};
  if(technical.result==='refuted'){result.severity={state:'not-applicable',label:'Not applicable to the refuted allegation',reason:'Reported severity is preserved separately.'};return result;}
  if(technical.result!=='supported'||technical.legacy)return result;
  const claims=draft.claims.filter(c=>technical.supported.includes(c.id)),assessed=claims.filter(c=>c.severityFactors&&bands[c.severityFactors.consequence]);
  if(assessed.length){
    const selected=assessed.sort((a,b)=>names.indexOf(bands[a.severityFactors.consequence])-names.indexOf(bands[b.severityFactors.consequence]))[0],f=selected.severityFactors;
    const conditions=[...new Set([...f.conditions,...f.unknowns,...(assessed.length<claims.length?['Other established defects have unassessed magnitude.']:[])])],band=bands[f.consequence];
    result.severity={state:conditions.length?'conditional':'assessed',band,label:band+(conditions.length?' · conditional':''),conditions,reason:f.reason,claimId:selected.id,evidence:f.evidence,factors:f,identity:technical.identity};
    if(profile)result.engagement={state:conditions.length?'conditional':profile.eligibleBands.includes(band)?'eligible':'excluded',name:profile.name,revision:profile.revision,identity:profile.identity,label:profile.labels[band]||band,reason:`${profile.name} (${profile.revision}) ${profile.eligibleBands.includes(band)?'includes':'excludes'} the ${band} band.`};
  }else if(profile)result.engagement={state:'not-assessed',name:profile.name,revision:profile.revision,reason:'The selected mapping needs reviewed severity factors; no additional request is started.'};
  return result;
}
function remap(assessment,profile){
  const copy=structuredClone(assessment);copy.engagement={state:'not-assessed',reason:'No engagement rules selected.'};
  const s=copy.severity;
  if(profile){copy.engagement={state:'not-assessed',name:profile.name,revision:profile.revision,identity:profile.identity,reason:'No reviewed severity band is available for this mapping.'};
    if(copy.technical.result==='supported'&&s?.band)copy.engagement={...copy.engagement,state:s.state==='conditional'?'conditional':profile.eligibleBands.includes(s.band)?'eligible':'excluded',label:profile.labels[s.band]||s.band,reason:`${profile.name} (${profile.revision}) ${profile.eligibleBands.includes(s.band)?'includes':'excludes'} the ${s.band} band.`};}
  return copy;
}
const instruction=`OPTIONAL DIMENSIONS general-audit-v1. Claim kind distinguishes defect, context and impact-qualification; null means not assessed. A true contextual fact cannot keep a refuted defect alive. property.basis may be derived-security-invariant ONLY with derivation: mechanism facts establishing rights/obligations, reason deriving the property, adopted assumptions, credible counterevidence and source evidence IDs. A slogan, suspected implementation, test reproducing behavior or imported policy alone cannot certify intended behavior. Review derivation under existing rule/conditions/counterevidence obligations, including revisions. Do not invent minimum fees, rounding up, deployment, trust or recovery promises.
severityFactors is optional (null when unavailable). Reuse the SAME reviewed scenario; do not add a request or material question for severity-only information. General Audit v1 maps systemic-irreversible to Critical, material-loss-or-critical-function to High, bounded-harm to Medium, minor-deviation to Low, non-security to Informational; unknown is not Informational. These are qualitative anchors, not universal contest rules. Give affected party/asset, scale, duration/repetition/caps, permissions, economics and actual recovery with relevant evidence. Separate victim loss, profit, capital, fees, principal and yield; do not sum alternative scenarios or assume repetition without a reset mechanism. conditions/unknowns are severity-only qualifications, never a way to hide missing feasibility or material consequence. Conditional premises must be compatible with established guards and source facts. Existing impact/conditions/counterevidence checks review these factors and every changed/removed assertion. Refuted allegations have no established-defect severity. Known/duplicate/reportability and human decisions do not determine technical validity.`;
module.exports={VERSION,bands,validate,load,project,remap,instruction};
