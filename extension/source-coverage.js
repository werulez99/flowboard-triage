'use strict';
// Mechanical reading coverage only, never semantic or execution proof.
function contains(expected, supplied, read = false) {
  if (!expected?.source || !supplied?.complete || !supplied.source ||
      supplied.source.file !== expected.source.file || supplied.source.sourceHash !== expected.source.sourceHash ||
      supplied.source.line > expected.source.line || supplied.source.endLine < expected.source.endLine ||
      read && (supplied.readThrough || supplied.source.line - 1) < expected.source.endLine && !covers(supplied.readRanges,expected.source.line,expected.source.endLine)) return false;
  const lines = supplied.code.split('\n');
  return lines.length === supplied.source.endLine - supplied.source.line + 1 &&
    lines.slice(expected.source.line - supplied.source.line, expected.source.endLine - supplied.source.line + 1).join('\n') === expected.code;
}
function ranges(supplied){return supplied?(supplied.providedRanges||[{line:supplied.line,endLine:supplied.endLine}]):[];}
function union(ranges) {
  const result=[];
  for(const r of [...(ranges||[])].sort((a,b)=>a.line-b.line||a.endLine-b.endLine)){
    if(!Number.isSafeInteger(r.line)||!Number.isSafeInteger(r.endLine)||r.line<1||r.endLine<r.line)throw new Error('Invalid source coverage interval.');
    const last=result.at(-1);
    if(last&&r.line<=last.endLine+1)last.endLine=Math.max(last.endLine,r.endLine);
    else result.push({line:r.line,endLine:r.endLine});
  }
  return result;
}
function covers(ranges,line,endLine){return union(ranges).some(r=>r.line<=line&&r.endLine>=endLine);}
function read(unit,line,endLine){return (unit.readThrough??unit.source.line-1)>=endLine||covers(unit.readRanges,line,endLine);}
function failure(message){return Object.assign(new Error(message),{code:'LOCAL_READING_LIMIT'});}
// Check the actual expanded, numbered payload, not acquisition receipts or
// historical reading cursors. This proves supplied bytes, never interpretation.
function packet(input, units, models = []) {
  const expanded=require('./packet-context').expand(input), views=[];
  const known=new Map(units.map(u=>[u.id,u]));
  for(const source of expanded.sources||[]){
    const unit=known.get(source.id), selected=ranges(source);
    if(!unit||source.file!==unit.source.file||source.sourceHash!==unit.source.sourceHash||!selected.length||
       selected.some(r=>r.line<unit.source.line||r.endLine>unit.source.endLine))throw failure(`Supplied source ${source.id} differs from its canonical version/range.`);
    union(selected); // validate before slicing; keep wire order for exact bytes
    const lines=unit.code.split('\n');
    const exact=selected.flatMap(r=>lines.slice(r.line-unit.source.line,r.endLine-unit.source.line+1).map((s,i)=>`${r.line+i} | ${s}`)).join('\n');
    if(source.code!==exact)throw failure(`Supplied source ${source.id} does not contain its exact declared source views.`);
    views.push({source,selected});
  }
  const requireSpan=(file,sourceHash,line,endLine,label,ids)=>{
    const available=views.filter(v=>v.source.file===file&&v.source.sourceHash===sourceHash&&(!ids||ids.includes(v.source.id))).flatMap(v=>v.selected);
    if(!covers(available,line,endLine))throw failure(`${label} is not supplied in this request: ${file}:${line}-${endLine}.`);
  };
  for(const item of expanded.materialSourceRequirements||[])
    for(const range of item.ranges||[{line:item.line,endLine:item.endLine}])requireSpan(item.file,item.sourceHash,range.line,range.endLine,'Mandatory source');
  const notes=(models||[]).flatMap(model=>model?.evidence||[]);
  for(const note of notes){
    const unit=known.get(note.sourceId), line=note.source?.line??note.line,endLine=note.source?.endLine??note.endLine;
    if(!unit)throw failure(`Review of evidence ${note.id} lacks canonical source ${note.sourceId}.`);
    requireSpan(unit.source.file,unit.source.sourceHash,line,endLine,`Review of evidence ${note.id}`);
  }
  for(const model of models.filter(Boolean)){
    for(const entry of model.bindingPlan?.entries||model.causal?.entryBindings||[]){
      const caller=known.get(entry.sourceId),callee=known.get(entry.implementationSourceId);
      const site=caller&&require('./call-bindings').exactSite(caller,entry.callSiteId);
      if(!site||!callee||caller.source.sourceHash!==entry.sourceHash)throw failure(`Review binding ${entry.id} has no exact current source occurrence.`);
      requireSpan(caller.source.file,caller.source.sourceHash,site.span.line,site.span.endLine,`Review binding ${entry.id}`);
      requireSpan(callee.source.file,callee.source.sourceHash,callee.source.line,callee.source.endLine,`Review implementation ${entry.id}`);
    }
    for(const event of model.causal?.events||[])if(event.anchor){
      const anchor=event.anchor,unit=known.get(anchor.sourceId);
      if(!unit||anchor.source?.sourceHash!==unit.source.sourceHash)throw failure(`Review event ${event.id} has a stale source anchor.`);
      requireSpan(unit.source.file,unit.source.sourceHash,anchor.source.line,anchor.source.endLine,`Review event ${event.id}`);
    }
  }
  return { expanded, requireSpan };
}
module.exports = { contains, ranges, union, covers, read, packet };
