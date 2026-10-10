'use strict';
// Preferences are host configuration, never model output or shell fragments.
const {execFileSync}=require('node:child_process'),fs=require('node:fs');
const efforts=['none','minimal','low','medium','high','xhigh'],known=new Map();
function resolve(options={}){
  const model=options.model??'',effort=options.reasoningEffort??'medium';
  if(typeof model!=='string'||model!==''&&!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(model)||!efforts.includes(effort))
    throw Object.assign(new Error('Invalid Codex model/reasoning setting. Use a model identifier, not CLI arguments, and a supported reasoning label.'),{code:'PROVIDER_CONFIGURATION'});
  return{model:model||null,reasoningEffort:effort};
}
function explicit(options){const value=resolve(options);return !!value.model||value.reasoningEffort!=='medium';}
function capabilities(executable='codex'){
  let stamp='PATH';try{const s=fs.statSync(executable);stamp=[s.size,s.mtimeMs].join(':');}catch{}
  const key=executable+':'+stamp;if(known.has(key))return known.get(key);
  let help;try{help=execFileSync(executable,['exec','--help'],{encoding:'utf8',timeout:5000,maxBuffer:128*1024,stdio:['ignore','pipe','pipe']});}
  catch{throw Object.assign(new Error('Cannot verify the configured CLI model/config flags locally. Check the executable; no review was dispatched.'),{code:'PROVIDER_CONFIGURATION'});}
  if(!help.includes('--model')||!help.includes('--config')||!help.includes('--ignore-user-config'))throw Object.assign(new Error('The installed CLI does not advertise the required isolated model/config flags.'),{code:'PROVIDER_CONFIGURATION'});
  const result={modelFlag:'--model',reasoningKey:'model_reasoning_effort',availability:'remote model access and model-specific reasoning support unobserved'};known.set(key,result);return result;
}
function validate(options){const value=resolve(options);if(explicit(options))capabilities(options.executable||'codex');return value;}
module.exports={efforts,resolve,explicit,capabilities,validate};
