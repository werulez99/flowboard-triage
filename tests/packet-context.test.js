'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const packet=require('../extension/packet-context'),provider=require('../extension/semantic-provider');
test('source metadata interning reconstructs exact IDs, spans, candidates and Unicode bytes',()=>{
  const shared={scopes:[{file:'src/\u0415.sol',sourceHash:'a'.repeat(64),contract:'Example',constructors:[],explanation:'\u041a\u043e\u0434 '.repeat(80)}],complete:false,gaps:['Receiver remains unproved']};
  const input={phase:'challenge',earlierDraft:{claims:[{id:'c1',unknowns:['Deployment']}]},sources:Array.from({length:8},(_,i)=>({id:`s${i}`,line:i+1,endLine:i+1,sourceHash:'b'.repeat(64),code:`${i+1} | // \u043a\u043e\u0434`,initialization:shared,relatedCalls:[{id:`call${i}`,declarations:shared.scopes,argumentSpans:[]}]}))};
  const original=structuredClone(input),packed=packet.compact(input);
  assert.deepEqual(packet.expand(packed),input);assert.deepEqual(input,original);assert.deepEqual(packed.earlierDraft,input.earlierDraft);
  assert.ok(provider.measureRequest(packed).requestBytes<provider.measureRequest(input).requestBytes);
  assert.throws(()=>packet.expand({...packed,sourceMetadata:{}}),/Unresolved/);
  assert.equal(packet.compact({sources:[]}).sourceContextFormat,undefined);
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
