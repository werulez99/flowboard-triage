'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const settings=require('../extension/provider-settings'),provider=require('../extension/semantic-provider'),health=require('../extension/provider-health');
test('outgoing schema subset is preflighted without dispatch and never silently rewrites a contract',()=>{
 const input={phase:'generate',finding:{title:'Fictional schema control'},sources:[]};
 const schema=provider.responseSchema(input),before=JSON.stringify(schema);
 assert.equal(settings.validateSchema(schema),settings.schemaContract);
 assert.equal(provider.requestMetrics(input).schemaContract,settings.schemaContract);
 for(const key of ['uniqueItems','oneOf','const','not']){
  const invalid=structuredClone(schema);invalid.properties.extra={type:'array',items:{type:'string'},[key]:true};invalid.required.push('extra');
  assert.throws(()=>settings.validateSchema(invalid),error=>error.code==='PROVIDER_SCHEMA'&&error.keyword===key&&error.failureKind==='request-format');
 }
 const optional=structuredClone(schema);optional.required=[];
 assert.throws(()=>settings.validateSchema(optional),{code:'PROVIDER_SCHEMA'});
 assert.equal(JSON.stringify(schema),before);
});
test('model preferences validate tokens, retain default and cannot expand account slot pools',()=>{
 assert.deepEqual(settings.resolve(),{model:null,reasoningEffort:'medium'});
 for(const model of ['--model x','x; echo secret','a\nb','a'.repeat(101)])assert.throws(()=>settings.resolve({model}),{code:'PROVIDER_CONFIGURATION'});
 assert.throws(()=>settings.resolve({reasoningEffort:'invented'}),{code:'PROVIDER_CONFIGURATION'});
 assert.notEqual(health.identity('codex'),health.identity('codex',{model:'explicit-model'}));
 assert.equal(settings.explicit({reasoningEffort:'medium'}),false);
});
test('actual adapter uses explicit safe argument arrays and separates requested from unobserved model',async t=>{
 // This transport control checks argument construction and audit attribution.
 // Keep the real token/effort resolver, while isolating installed-CLI capability
 // discovery: CI must not require an authenticated or installed Codex binary.
 // The only request child is the existing transport fixture.
 t.mock.method(settings,'validate',options=>settings.resolve(options));
 const config={model:'fixture-model',reasoningEffort:'high'},input={phase:'generate',finding:{title:'fictional-transport-check'},sources:[],providerConfiguration:config};let args;
 const result=await provider.runCodex(input,{...config,spawn(executable,argv,options){args=argv;return spawn(process.execPath,[path.join(__dirname,'fixtures/provider-cli.js'),'codex'],options);}});
 assert.equal(args[args.indexOf('--model')+1],config.model);assert.ok(args.includes('model_reasoning_effort="high"'));assert.ok(args.includes('--ignore-user-config'));
 assert.equal(result.audit.effectiveConfiguration.requestedModel,config.model);assert.equal(result.audit.effectiveConfiguration.reasoningEffort,'high');assert.equal(result.audit.effectiveConfiguration.observedModel,null);
 assert.throws(()=>provider.runCodex(input,{model:'different',reasoningEffort:'high'}),{code:'PROVIDER_CONFIGURATION'});
});
