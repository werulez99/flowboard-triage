'use strict';
// Lossless source metadata interning. Text/IDs/ranges and the accepted semantic
// object are never summarized. Every reference resolves INSIDE this request.
const LEGACY = 'source-context-v1', VERSION = 'source-context-v2';
const fields = ['initialization', 'relatedCalls', 'parameterSpans', 'structure'];
function compactLegacy(input) {
  if (input.sourceContextFormat) return input;
  const counts = new Map();
  const count = value => {
    if (!value || typeof value !== 'object') return;
    const key = JSON.stringify(value);
    if (Buffer.byteLength(key) >= 160) counts.set(key, (counts.get(key) || 0) + 1);
    for (const item of Object.values(value)) count(item);
  };
  for (const unit of input.sources || []) for (const key of fields) count(unit[key]);
  const table = {}, ids = new Map();
  const encode = value => {
    if (!value || typeof value !== 'object') return value;
    const key = JSON.stringify(value);
    if (counts.get(key) > 1) {
      if (!ids.has(key)) {
        const id = `metadata-${ids.size + 1}`; ids.set(key, id);
        table[id] = children(value);
      }
      return { sourceMetadataRef: ids.get(key) };
    }
    return children(value);
  };
  const children = value => Array.isArray(value) ? value.map(encode) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  const sources = (input.sources || []).map(unit => ({ ...unit, ...Object.fromEntries(fields.filter(key => key in unit).map(key => [key, encode(unit[key])])) }));
  if (!ids.size) return input;
  const packed = { ...input, sources, sourceContextFormat: LEGACY, sourceMetadata: table };
  return Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(input)) ? packed : input;
}
function expandLegacy(input) {
  if (!input.sourceContextFormat) return input;
  if (input.sourceContextFormat !== LEGACY || !input.sourceMetadata) throw new Error('Unsupported source metadata representation.');
  const decode = (value, visiting = new Set()) => {
    if (!value || typeof value !== 'object') return value;
    if (Object.hasOwn(value, 'sourceMetadataRef')) {
      const id = value.sourceMetadataRef;
      if (Object.keys(value).length !== 1 || !Object.hasOwn(input.sourceMetadata, id) || visiting.has(id)) throw new Error('Unresolved or cyclic source metadata reference.');
      return decode(input.sourceMetadata[id], new Set([...visiting, id]));
    }
    return Array.isArray(value) ? value.map(item => decode(item, visiting)) : Object.fromEntries(Object.entries(value).map(([key,item]) => [key,decode(item,visiting)]));
  };
  const { sourceContextFormat, sourceMetadata, ...result } = input;
  result.sources = input.sources.map(unit => ({ ...unit, ...Object.fromEntries(fields.filter(key => key in unit).map(key => [key,decode(unit[key])])) }));
  return result;
}
const legacyInstruction = 'source-context-v1 is lossless metadata sharing. In source initialization, relatedCalls, parameterSpans or structure, an object {sourceMetadataRef: ID} means the exact value at sourceMetadata[ID] in THIS request (references may nest). Expand it before interpreting the field. The table contains the full values, not unavailable host lookups. Source IDs, quotes, occurrences, candidates and semantic earlierDraft remain unchanged. This is not review or proof of runtime dispatch.';
const spanKeys = ['start','end','line','endLine','column','endColumn'];
const extraFields=['materialSourceRequirements','candidateProblems','actions'];
const tags = ['$ref','$span','$record','$lines','$code','$segments'];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function compact(input) {
  if (input.sourceContextFormat) return input;
  // The contract is the JSON transport value, not JavaScript-only undefined
  // properties (which JSON omits). Normalize before deriving record templates
  // so a durable replay expands exactly like the first process invocation.
  input=JSON.parse(JSON.stringify(input));
  const counts=new Map(), shapes=new Map(), samples=new Map();
  const count=value=>{
    if(value===undefined)return;
    const key=JSON.stringify(value);
    if(bytes(value)>=16)counts.set(key,(counts.get(key)||0)+1);
    if(value&&typeof value==='object'){
      if(!Array.isArray(value)){const shape=JSON.stringify(Object.keys(value));shapes.set(shape,(shapes.get(shape)||0)+1);if(!samples.has(shape))samples.set(shape,[]);samples.get(shape).push(value);}
      for(const child of Object.values(value))count(child);
    }
  };
  for(const unit of input.sources||[])for(const [key,value] of Object.entries(unit))if(key!=='id'&&key!=='code')count(value);
  for(const key of extraFields)if(key in input)count(input[key]);
  const values=[],records=[],ids=new Map(),recordIds=new Map();
  const children=value=>{
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(encode);
    const keys=Object.keys(value), shape=JSON.stringify(keys);
    if(keys.length===6&&spanKeys.every(k=>Number.isSafeInteger(value[k])&&value[k]>=0))return {$span:spanKeys.map(k=>value[k])};
    if(tags.some(k=>Object.hasOwn(value,k))||(keys.length>=3&&shapes.get(shape)>1)){
      if(!recordIds.has(shape)){
        const constants={},varying=[];
        for(const k of keys){if(samples.get(shape).every(s=>JSON.stringify(s[k])===JSON.stringify(value[k])))constants[k]=value[k];else varying.push(k);}
        // Constants stay literal in the template. No missing-field inference.
        recordIds.set(shape,records.length);records.push({keys,constants,varying});
      }
      const id=recordIds.get(shape);return {$record:[id,...records[id].varying.map(k=>encode(value[k]))]};
    }
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encode(v)]));
  };
  const encode=value=>{
    if(value===undefined)return value;
    const key=JSON.stringify(value);
    if(counts.get(key)>1){
      if(!ids.has(key)){ids.set(key,values.length);values.push(null);values[ids.get(key)]=children(value);}
      return {$ref:ids.get(key)};
    }
    return children(value);
  };
  // Numbered source lines remain literal readable text. Only actually
  // overlapping, equal lines in the same file/version can share a block.
  const sources=(input.sources||[]).map(unit=>Object.fromEntries(Object.entries(unit).map(([k,v])=>[k,k==='id'||k==='code'?v:encode(v)])));
  const texts=[],pieces=new Map();
  const groups=new Map();
  for(const [index,u] of (input.sources||[]).entries())if(typeof u.code==='string'){
    const lines=u.code.split('\n'),ranges=u.providedRanges||[{line:u.line,endLine:u.endLine}];
    if(ranges.reduce((n,r)=>n+r.endLine-r.line+1,0)!==lines.length)continue;
    const key=JSON.stringify([u.file,u.sourceHash]);if(!groups.has(key))groups.set(key,[]);
    let cursor=0;const parts=[];
    for(const [part,r]of ranges.entries()){
      const length=r.endLine-r.line+1,text=lines.slice(cursor,cursor+length).join('\n');cursor+=length;parts.push(text);
      groups.get(key).push({index,part,u:{...u,line:r.line,endLine:r.endLine,code:text}});
    }pieces.set(index,parts);
  }
  for(const group of groups.values()){
    group.sort((a,b)=>a.u.line-b.u.line);let cluster=[];
    const flush=()=>{
      if(cluster.length<2)return;
      const first=cluster[0].u.line,lines=[];
      for(const {u} of cluster)for(const [i,line] of u.code.split('\n').entries()){
        const at=u.line-first+i;if(lines[at]!==undefined&&lines[at]!==line)return;lines[at]=line;
      }
      const block=lines.join('\n'),views=cluster.map(({u})=>({$lines:[texts.length,u.line-first,u.endLine-u.line+1]}));
      if(bytes(block)+views.reduce((n,v)=>n+bytes(v),0)>=cluster.reduce((n,{u})=>n+bytes(u.code),0))return;
      texts.push(block);cluster.forEach(({index,part},i)=>pieces.get(index)[part]=views[i]);
    };
    let end=-1;
    for(const item of group){if(item.u.line>end){flush();cluster=[];}cluster.push(item);end=Math.max(end,item.u.endLine);}flush();
  }
  const code=value=>{
    const lines=value.split('\n'),rows=lines.map(line=>line.match(/^(\d+) \| ( *)(.*)$/));
    if(rows.some(m=>!m))return value;
    if(rows.some((m,i)=>Number(m[1])!==Number(rows[0][1])+i)){
      const groups=[];for(const [i,m]of rows.entries()){if(!i||Number(m[1])!==Number(rows[i-1][1])+1)groups.push([]);groups.at(-1).push(lines[i]);}
      const result={$segments:groups.map(group=>code(group.join('\n')))};return bytes(result)<bytes(value)?result:value;
    }
    const result={$code:[Number(rows[0][1]),rows.map(m=>[m[2].length,m[3]])]};
    return bytes(result)<bytes(value)?result:value;
  };
  for(const [index,parts]of pieces){
    const encoded=parts.map(p=>typeof p==='string'?code(p):p);
    sources[index].code=parts.length===1?encoded[0]:{$segments:encoded};
  }
  for(const unit of sources)if(typeof unit.code==='string')unit.code=code(unit.code);
  const extras=Object.fromEntries(extraFields.filter(k=>k in input).map(k=>[k,encode(input[k])]));
  const packed={...input,...extras,sources,sourceContextFormat:VERSION,sourceMetadata:{values,records,texts:texts.map(code)}};
  // Instructions count too; tiny packets retain the ordinary representation.
  return bytes(packed)+Buffer.byteLength(instructionFor(packed))<bytes(input)?packed:input;
}
function expand(input){
  if(!input.sourceContextFormat)return input;
  if(input.sourceContextFormat===LEGACY)return expandLegacy(input);
  const table=input.sourceMetadata;
  if(input.sourceContextFormat!==VERSION||!table||!['values','records','texts'].every(k=>Array.isArray(table[k])))throw Error('Unsupported source metadata representation.');
  const index=(items,id)=>{if(!Number.isSafeInteger(id)||id<0||id>=items.length)throw Error('Unresolved source context reference.');return items[id];};
  let budget=1000000,remainingBytes=48*1024*1024;
  const charge=n=>{remainingBytes-=n;if(remainingBytes<0)throw Error('Source context expanded byte limit exceeded.');};
  const decode=(v,visiting=new Set())=>{
    if(--budget<0)throw Error('Source context expansion limit exceeded.');
    if(!v||typeof v!=='object'){if(typeof v==='string')charge(Buffer.byteLength(v));return v;}
    if(Array.isArray(v))return v.map(x=>decode(x,visiting));
    const tag=tags.find(k=>Object.hasOwn(v,k));
    if(tag){
      if(Object.keys(v).length!==1)throw Error('Ambiguous source context tag.');
      if(tag==='$ref'){if(visiting.has(v.$ref))throw Error('Cyclic source context reference.');return decode(index(table.values,v.$ref),new Set([...visiting,v.$ref]));}
      if(tag==='$span'){if(!Array.isArray(v.$span)||v.$span.length!==6||!v.$span.every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('Invalid exact source span.');return Object.fromEntries(spanKeys.map((k,i)=>[k,v.$span[i]]));}
      if(tag==='$record'){
        if(!Array.isArray(v.$record))throw Error('Invalid source record.');
        const [id,...values]=v.$record,{keys,constants,varying}=index(table.records,id);
        if(!Array.isArray(keys)||!Array.isArray(varying)||!constants||varying.length!==values.length||keys.some(k=>typeof k!=='string')||new Set(keys).size!==keys.length||
          keys.length!==Object.keys(constants).length+varying.length||new Set(varying).size!==varying.length||varying.some(k=>!keys.includes(k)||Object.hasOwn(constants,k))||Object.keys(constants).some(k=>!keys.includes(k)))throw Error('Ambiguous source record fields.');
        return Object.fromEntries(keys.map(k=>{if(Object.hasOwn(constants,k)){charge(bytes(constants[k]));return[k,structuredClone(constants[k])];}return[k,decode(values[varying.indexOf(k)],visiting)];}));
      }
      if(tag==='$code'){
        if(!Array.isArray(v.$code)||v.$code.length!==2)throw Error('Invalid numbered code block.');
        const [line,rows]=v.$code;
        if(!Number.isSafeInteger(line)||line<1||!Array.isArray(rows)||rows.length>100000||rows.some(r=>!Array.isArray(r)||r.length!==2||!Number.isSafeInteger(r[0])||r[0]<0||r[0]>100000||typeof r[1]!=='string'||/[\r\n]/.test(r[1])))throw Error('Invalid exact code lines.');
        charge(rows.reduce((n,r)=>n+r[0]+Buffer.byteLength(r[1])+24,0));
        return rows.map(([spaces,text],i)=>`${line+i} | ${' '.repeat(spaces)}${text}`).join('\n');
      }
      if(tag==='$segments'){
        if(!Array.isArray(v.$segments)||v.$segments.length>100000)throw Error('Invalid source code segments.');
        const pieces=v.$segments.map(piece=>decode(piece,visiting));if(pieces.some(p=>typeof p!=='string'))throw Error('Invalid source code segment text.');return pieces.join('\n');
      }
      if(!Array.isArray(v.$lines)||v.$lines.length!==3)throw Error('Invalid source text view.');
      const [id,start,length]=v.$lines,key='text:'+id;if(visiting.has(key))throw Error('Cyclic source text reference.');
      const block=decode(index(table.texts,id),new Set([...visiting,key]));
      if(typeof block!=='string'||![start,length].every(Number.isSafeInteger)||start<0||length<1||start+length>block.split('\n').length)throw Error('Invalid source text range.');
      return block.split('\n').slice(start,start+length).join('\n');
    }
    return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,decode(x,visiting)]));
  };
  const {sourceContextFormat,sourceMetadata,...result}=input;
  result.sources=input.sources.map(u=>Object.fromEntries(Object.entries(u).map(([k,v])=>[k,decode(v)])));
  for(const key of extraFields)if(key in result)result[key]=decode(result[key]);
  return result;
}
const instruction='source-context-v2 is LOSSLESS source representation. Decode tagged values in sources using sourceMetadata IN THIS REQUEST: {$ref:N} is values[N] recursively decoded. {$record:[N,...V]} uses records[N]: keys gives original object field order; constants are exact literal field values; varying gives field names corresponding to recursively decoded V. {$span:[start,end,line,endLine,column,endColumn]} is that exact six-field position object, offsets/columns unchanged. {$code:[L,rows]} is numbered code: each [spaces,text] row at index i means original line L+i, with exactly spaces leading ASCII spaces followed by literal text; reconstruct `LINE | original text` for each row and join with newline. {$lines:[N,start,count]} takes sourceMetadata.texts[N] (decode first), splits on newline, slices at zero-based start for count lines, and joins with newline. All code and shared values are present here, not host lookups. Expand before reading, quoting or binding. Distinct source IDs/calls/arguments/receivers/invocations stay distinct. A context text view is not an execution frame or semantic review. Earlier draft/revisions/check requirements are unchanged.';
function instructionFor(input){return input.sourceContextFormat===LEGACY?legacyInstruction:input.sourceContextFormat===VERSION?instruction+' The same tags may appear in materialSourceRequirements, candidateProblems and actions. {$segments:[blocks]} joins decoded numbered code blocks with newline; gaps in original line numbers are deliberate context exclusions listed in providedRanges, NEVER truncated functions or checked omitted lines. All evidence must lie wholly in a provided range. A newly required omitted definition must be acquired before it can be explained or checked.':'';}
module.exports = { VERSION, compact, expand, instruction, instructionFor, compactLegacy };
