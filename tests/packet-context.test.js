'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const packet=require('../extension/packet-context'),provider=require('../extension/semantic-provider');
test('source metadata interning reconstructs exact IDs, spans, candidates and Unicode bytes',()=>{
  const shared={scopes:[{file:'src/\u0415.sol',sourceHash:'a'.repeat(64),contract:'Example',constructors:[],explanation:'\u041a\u043e\u0434 '.repeat(80)}],complete:false,gaps:['Receiver remains unproved']};
  const input={phase:'challenge',earlierDraft:{claims:[{id:'c1',unknowns:['Deployment']}]},sources:Array.from({length:8},(_,i)=>({id:`s${i}`,line:i+1,endLine:i+1,sourceHash:'b'.repeat(64),code:`${i+1} | // \u043a\u043e\u0434`,initialization:shared,relatedCalls:[{id:`call${i}`,declarations:shared.scopes,argumentSpans:[]}]}))};
  const original=structuredClone(input),packed=packet.compact(input);
  assert.deepEqual(packet.expand(packed),input);assert.deepEqual(input,original);assert.deepEqual(packed.earlierDraft,input.earlierDraft);
  assert.ok(provider.measureRequest(packed).requestBytes<provider.measureRequest(input).requestBytes);
  assert.throws(()=>packet.expand({...packed,sourceMetadata:{}}),/Unsupported/);
  assert.equal(packet.compact({sources:[]}).sourceContextFormat,undefined);
});
test('v2 reconstructs rich call records, scalar paths, all coordinates and overlapping Unicode views; v1 stays readable',()=>{
  const calls=Array.from({length:30},(_,i)=>({id:'call-'+i,span:{start:i*17,end:i*17+15,line:i+2,endLine:i+2,column:4,endColumn:19},
    nameSpan:{start:i*17,end:i*17+5,line:i+2,endLine:i+2,column:4,endColumn:9},receiverExpression:'ledger.storageAccount',receiverTypes:['LibraryStorage.Account memory'],
    argumentSpans:Array.from({length:4},(_,j)=>({start:i*17+j,end:i*17+j+1,line:i+2,endLine:i+2,column:4+j,endColumn:5+j})),
    targets:[{file:'lib/a/repeated/long/path/Account.sol',line:22,contract:'Account',signature:'apply(uint256,uint256,uint256,uint256)'}]}));
  const code=Array.from({length:100},(_,i)=>`${i+1} | // \u0442\u043e\u0447\u0435\u043d \u0440\u0435\u0434 ${i} ${'context '.repeat(12)}`).join('\n');
  const input={phase:'challenge',candidateOnly:true,sources:Array.from({length:6},(_,i)=>({id:'source-'+i,file:'src/\u0421\u043c\u0435\u0442\u043a\u0430.sol',sourceHash:'a'.repeat(64),line:i+1,endLine:100,code:code.split('\n').slice(i).join('\n'),relatedCalls:structuredClone(calls)})),earlierDraft:{claims:[]}};
  const packed=packet.compact(input);assert.equal(packed.sourceContextFormat,'source-context-v2');assert.ok(packed.sourceMetadata.texts.length);assert.deepEqual(packet.expand(packed),input);
  assert.ok(provider.measureRequest(packed).requestBytes<provider.measureRequest(input).requestBytes);
  assert.deepEqual(packet.expand(packet.compactLegacy(input)),input);
  assert.ok(provider.measureRequest(packet.compactLegacy(input)).system.includes('source-context-v1'));
  for(const bad of [{$ref:99999},{$ref:0,extra:true},{$span:[0,1]},{$record:[999]},{$lines:[0,999999,4]}]){
    const changed=structuredClone(packed);changed.sources[0].relatedCalls=bad;assert.throws(()=>packet.expand(changed));
  }
  const cyclic=structuredClone(packed);cyclic.sourceMetadata.values[0]={$ref:0};cyclic.sources[0].relatedCalls={$ref:0};assert.throws(()=>packet.expand(cyclic),/Cyclic/);
});
test('source compaction leaves the enforced response contract unchanged',()=>{
  const old={phase:'challenge',candidateOnly:true},next={...old,sourceContextFormat:packet.VERSION};assert.deepEqual(provider.responseSchema(old),provider.responseSchema(next));
});
test('durable v2 replay preserves sparse full-definition views and literal template fields',()=>{
  const input={phase:'challenge',checkOnly:true,actions:[],materialSourceRequirements:[],sources:[]};
  for(let i=0;i<8;i++){
    const record={file:'src/\u0414\u043e\u0433\u043e\u0432\u043e\u0440.sol',sourceHash:'a'.repeat(64),questionId:'material-condition',line:10,endLine:11,unused:undefined};
    input.actions.push({...record,sourceIds:['source-'+i],outcome:'source-returned'});
    input.materialSourceRequirements.push({...record,reason:'Complete definition needed for the stated guard and settlement condition.'});
    input.sources.push({id:'source-'+i,...record,providedRanges:[{line:10,endLine:11},{line:20,endLine:21}],
      code:'10 |     function α() internal {\n11 |     }\n20 |     function β() internal {\n21 |     }',initialization:{...record,literal:{$ref:'not-a-wire-reference'}}});
  }
  const wire=JSON.parse(JSON.stringify(packet.compact(input))),plain=JSON.parse(JSON.stringify(input));
  assert.equal(wire.sourceContextFormat,'source-context-v2');assert.deepEqual(packet.expand(wire),plain);
  const cyclic=structuredClone(wire);cyclic.sourceMetadata.texts=[{$lines:[0,0,1]}];cyclic.sources[0].code={$lines:[0,0,1]};
  assert.throws(()=>packet.expand(cyclic),/Cyclic/);
  const count=require('../extension/review-capacity').limits.sources+1;
  const tooMany={phase:'challenge',sources:Array.from({length:count},(_,i)=>({id:'s'+i,code:'// exact source'}))};
  assert.equal(provider.measureRequest(tooMany).dispatchable,false);
  assert.throws(()=>provider.requestMetrics(tooMany),e=>e.code==='LOCAL_SOURCE_LIMIT'&&e.metrics.sourceCount===count);
});
test('oversized diagnostics retain exact complete metrics while production still rejects',()=>{
  const input={phase:'challenge',repairOnly:true,sources:[{id:'s',code:'原文'.repeat(50000)}],earlierDraft:{claims:[]}};
  const metrics=provider.measureRequest(input);assert.equal(metrics.dispatchable,false);
  assert.equal(metrics.inputBytes,Buffer.byteLength(JSON.stringify(input)));
  const fields=Object.values(metrics.inputFields).reduce((n,v)=>n+v,0);
  assert.equal(fields+metrics.inputSections.envelope,metrics.inputBytes);
  assert.equal(metrics.requestBytes,metrics.inputBytes+metrics.inputSections.instructions+metrics.inputSections.schema+128);
  assert.throws(()=>provider.requestMetrics(input),error=>error.code==='LOCAL_PACKET_LIMIT'&&error.metrics.inputHash===metrics.inputHash&&error.metrics.payload===JSON.stringify(input));
  const grown={...input,earlierDraft:{claims:[{reason:'文'.repeat(1000)}]}};
  assert.ok(provider.measureRequest(grown).requestBytes>metrics.requestBytes);
});
