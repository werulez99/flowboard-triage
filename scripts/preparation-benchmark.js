'use strict';
// Local performance, not model quality. No provider is invoked. Compare the
// actual installed baseline and checkout on the same generated source set.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { performance } = require('node:perf_hooks');
const extension = path.resolve(process.env.FLOWBOARD_TRIAGE_EXTENSION_PATH || path.join(__dirname, '../extension'));
const { analyze } = require(path.join(extension, 'runner-adapter'));
const { SourceCatalog } = require(path.join(extension, 'source'));
const engine = require(path.join(extension, 'investigation-engine'));
const { TriageBoard } = require(path.join(extension, 'board'));
const samples = 30, summary = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return { samples: values.length, p50: sorted[Math.ceil(sorted.length * .50) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], total: values.reduce((a,b) => a+b, 0) };
};
async function main() {
  if (!process.env.FLOWBOARD_EXTENSION_PATH) throw new Error('Set FLOWBOARD_EXTENSION_PATH to the pinned native dependency.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-performance-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    for (let i = 0; i < 240; i++) fs.writeFileSync(path.join(root, `src/Count${i}.sol`), `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Count${i} {\n${Array.from({length:24}, (_,n) => `    // Unrelated source context ${n}: ${'padding '.repeat(8)}`).join('\n')}\n    function read() external pure returns(uint) { return ${i}; }\n}\n`);
    const started = performance.now(), indexed = await analyze(process.env.FLOWBOARD_EXTENSION_PATH, root, { mode: 'source', background: true });
    const catalog = new SourceCatalog(root, indexed.runner, indexed.result), indexMs = performance.now() - started;
    const request = { findingId:'I-01', finding:{title:'Fictional local counter',summary:'Read the counter.'},cards:[],connections:[] };
    const issue = { id:'I-01', reportText:'Fictional local counter.' }, draft = engine.create({findingId:'I-01', request, issue, catalog});
    engine.write(root, draft);
    const report = {status:()=>({published:false,mode:'running',stopped:[],total:240,ready:0}),published:()=>false};
    const board = Object.create(TriageBoard.prototype), model = { id:'I-01', token:'test', catalog, request, issue };
    let payloadBytes = 0, messages = 0, sourceReads = 0, sourceBytes = 0;
    Object.assign(board, {root, activeId:'I-01', models:new Map([['I-01',model]]), callbacks:{reportPreparation:()=>report},
      investigationCurrent:()=>true, post:async value=>{messages++;payloadBytes+=Buffer.byteLength(JSON.stringify(value));}});
    const readFile = fs.readFileSync;
    // Measurement only. Never used by the extension or a provider invocation.
    fs.readFileSync = function(file, ...rest) { const result = readFile.call(this,file,...rest); if (typeof file === 'string' && file.endsWith('.sol')) { sourceReads++; sourceBytes+=Buffer.byteLength(result); } return result; };
    const progress = [];
    try { for(let i=0;i<samples;i++) { const at=performance.now(); await board.reportProgress(); progress.push(performance.now()-at); } }
    finally { fs.readFileSync=readFile; }
    const snapshots = [];
    for(let i=0;i<samples;i++) { const at=performance.now(); engine.snapshot(catalog,request,issue); snapshots.push(performance.now()-at); }
    console.log(JSON.stringify({ version:require(path.join(extension,'package.json')).version, extension,
      boundary:'Actual source index and controller; simulated status transport; no provider and no Cursor UI.',
      dataset:{files:240,paddingLines:24,providerCalls:0}, hardware:{cpus:os.availableParallelism?.()||os.cpus().length,model:os.cpus()[0].model,memoryGiB:Math.round(os.totalmem()/2**30)},
      indexMs, progressMs:summary(progress), cachedSnapshotMs:summary(snapshots), sourceReadsDuringProgress:sourceReads,sourceBytesDuringProgress:sourceBytes,messages,payloadBytes }));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
