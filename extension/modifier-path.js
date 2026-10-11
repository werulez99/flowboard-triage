'use strict';
// One source-resolved modifier, one placeholder, bounded private scalar writes
// and exact non-virtual private helpers. Unknown entry state is not assumed.
const {functionParts,lexicalCode,matching}=require('./solidity-text');
const execution=require('./execution-slice');
const state=require('./state-predicates');
function inspect(unit,suffix,values,units){
  const unknown=(code,reason,kind='capability',source)=>({reachable:null,code,kind,reason,source});
  const match=/^([A-Za-z_$][\w$]*)(?:\s*\((.*)\))?$/.exec(suffix);
  if(!match||suffix.includes('(')&&matching(suffix,suffix.indexOf('('))!==suffix.length-1)return unknown('MODIFIER_COMPOSITION_UNSUPPORTED',`Modifier composition ${suffix} is outside the supported single-placeholder local subset.`);
  const owner=unit.contract||unit.name.split('::')[0];
  const named=[...units.values()].filter(s=>/^\s*modifier\b/.test(lexicalCode(s.code))&&s.name.split('::').at(-1)===match[1]);
  let exact=named.filter(s=>s.complete&&s.source.file===unit.source.file&&s.source.sourceHash===unit.source.sourceHash&&(s.contract||s.name.split('::')[0])===owner);
  if(!exact.length&&unit.initialization?.complete)exact=named.filter(s=>s.complete&&unit.initialization.scopes.some(scope=>scope.file===s.source.file&&scope.sourceHash===s.source.sourceHash&&scope.contract===(s.contract||s.name.split('::')[0])));
  if(exact.length!==1)return unknown(named.length?'MODIFIER_OWNER_UNRESOLVED':'MODIFIER_SOURCE_MISSING',named.length?
    `The supplied ${match[1]} definition has no unique exact local owner; inherited modifier resolution is not established.`:`The exact ${owner}::${match[1]} modifier body is not supplied.`,named.length?'capability':'local-reading');
  const modifier=exact[0],body=functionParts(modifier.code,match[1]),tree=execution.parse(modifier);
  if(!require('./source-coverage').read(modifier,modifier.source.line,modifier.source.endLine)||modifier.modelRanges&&!require('./source-coverage').covers(modifier.modelRanges,modifier.source.line,modifier.source.endLine))return unknown('MODIFIER_VIEW_MISSING','The complete modifier view is not supplied/read in this context.','local-reading',modifier.source);
  if(!body||!tree)return unknown('MODIFIER_SYNTAX_UNSUPPORTED','The supplied modifier structure cannot be parsed.','capability',modifier.source);
  const placeholders=[...body.body.matchAll(/\b_\s*;/g)],node=tree.nodes.find(n=>lexicalCode(modifier.code.slice(n.start,n.end)).trim()==='_;');
  if(placeholders.length!==1||!node)return unknown('MODIFIER_PLACEHOLDER_UNSUPPORTED','The modifier needs exactly one unconditional top-level placeholder.','capability',modifier.source);
  const bindings=require('./call-bindings'),parameters=bindings.parameterNames(body.header),args=require('./failure-data').parts(match[2]||'');
  if(parameters.length!==args.length||parameters.some(p=>!p))return unknown('MODIFIER_ARGUMENT_BINDING','Modifier arguments cannot be bound uniquely.','structural',modifier.source);
  // Even an unused modifier parameter is evaluated by Solidity. Do not turn
  // guard(sideEffect()) { _; } into a pass-through by ignoring the argument.
  const pure=value=>{
    if(/^(?:unicode)?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(value.trim()))return true;
    const text=lexicalCode(value);
    return /^[\w$\s.()!<>=&|]*$/.test(text)&&!/(?<![!<>=])=(?!=)/.test(text)&&
      [...text.matchAll(/([\w$]+)\s*\(/g)].every(m=>m[1]==='address');
  };
  if(!args.every(pure))return unknown('MODIFIER_ARGUMENT_EFFECT_UNSUPPORTED','A modifier argument may invoke code, mutate or fail; its evaluation is outside this local subset.','capability',modifier.source);
  // A modifier and each private helper have their own lexical scope. Caller
  // parameter names are not modifier/helper storage values.
  const bound=new Map([...values].filter(([key])=>key.startsWith('@storage:')||key.startsWith('msg.sender')||/^[\w$]+\.[\w$]+$/.test(key)));
  for(let i=0;i<parameters.length;i++){const scalar=execution.scalar(args[i],values);bound.set(parameters[i],scalar!==null?{scalar}:execution.boolean(args[i],values));}
  const local=[...units.values()].filter(s=>s.complete&&s.source.file===modifier.source.file&&s.source.sourceHash===modifier.source.sourceHash&&(s.contract||s.name.split('::')[0])===(modifier.contract||modifier.name.split('::')[0]));
  const constants=new Map(),variables=new Set(),declarations=new Map();
  for(const s of local.filter(s=>s.contextKind==='state')){
    if(!require('./source-coverage').read(s,s.source.line,s.source.endLine)||s.modelRanges&&!require('./source-coverage').covers(s.modelRanges,s.source.line,s.source.endLine))continue;
    const text=lexicalCode(s.code).trim(),constant=/^uint256\s+private\s+constant\s+(\w+)\s*=\s*(\d+)\s*;$/.exec(text),variable=/^uint256\s+private\s+(\w+)\s*;$/.exec(text);
    if(constant)constants.set(constant[1],{scalar:constant[2]});if(variable){variables.add(variable[1]);declarations.set(variable[1],s);}
  }
  for(const [key,value]of constants)bound.set(key,value);
  if(parameters.some(key=>constants.has(key)||variables.has(key)))return unknown('MODIFIER_SHADOWING_UNSUPPORTED','A modifier parameter shadows the supported state/constant declaration; its separate binding is required.','capability',modifier.source);
  const storageOwner=modifier.contract||modifier.name.split('::')[0];
  for(const key of variables){
    bound.delete(key);const d=declarations.get(key),matches=[...state.stored(values)].filter(([,v])=>v?.storage?.declaration===state.identity(d));
    if(matches.length===1){bound.set(key,matches[0][1]);bound.set('@alias:'+key,matches[0][0]);}
    else if(!matches.length){const fact=values.get(`${storageOwner}.${key}`);if(fact?.scalar||fact?.notEqual)bound.set(key,fact);}
  }
  let helperProblem=null;
  const helperFor=text=>{
    const call=/^(\w+)\s*\(\s*\)\s*;$/.exec(text);if(!call)return null;
    const matches=local.filter(s=>s.name.split('::').at(-1)===call[1]&&/^\s*function\b/.test(lexicalCode(s.code)));
    if(matches.length!==1)return null;
    const helper=matches[0],parts=functionParts(helper.code,call[1]);
    if(!parts||!/\bprivate\b/.test(parts.header)||/(?:virtual|override|returns)\b/.test(parts.header)||parts.header.slice(parts.parametersStart-parts.start,parts.parametersEnd-parts.start).trim())return null;
    const suffix=parts.header.slice(parts.parametersEnd-parts.start+1).replace(/\b(?:private|view|pure|payable)\b/g,'').trim();
    if(suffix){helperProblem=unknown('MODIFIER_HELPER_MODIFIERS_UNSUPPORTED',`The private helper ${helper.name} has its own modifier (${suffix}); its body alone cannot establish the helper effect. Nested modifier composition is not supported.`,'capability',helper.source);return null;}
    return helper;
  };
  // Reject effects even after the placeholder: ignoring a postlude would
  // falsely equate reaching the body with committing the transaction.
  const simple=(n,frame=modifier,seen=[])=>{
    const raw=frame.code.slice(n.start,n.end).trim(),text=lexicalCode(raw);
    const write=/^(\w+)\s*=\s*(\w+|\d+)\s*;$/.exec(text);
    if(write&&variables.has(write[1])&&(constants.has(write[2])||/^\d+$/.test(write[2])))return true;
    const helper=helperFor(text);
    if(helper){if(seen.includes(helper.id)||seen.length>=8)return false;const tree=execution.parse(helper);return !!tree&&tree.nodes.every(n=>safe(n,helper,[...seen,helper.id]));}
    if(/^throw\s*;$/.test(text))return true;
    if(!/^(?:require\s*\(|assert\s*\(|revert\b)/.test(text))return false;
    const open=text.indexOf('('),close=matching(text,open);
    return open>=0&&close>=0&&require('./failure-data').parts(raw.slice(open+1,close)).every(pure);
  };
  const safe=(n,frame=modifier,seen=[])=>frame===modifier&&n===node||n.kind==='block'&&n.children.every(child=>safe(child,frame,seen))||n.kind==='if'&&pure(n.condition)&&safe(n.yes,frame,seen)&&(!n.no||safe(n.no,frame,seen))||n.kind==='simple'&&simple(n,frame,seen);
  if(!tree.nodes.every(n=>safe(n)))return helperProblem||unknown('MODIFIER_EFFECT_UNSUPPORTED','The supplied modifier contains an unresolved helper, alias or unsupported pre/post effect. Supported writes require an exact private uint256 declaration and constant/literal value.','capability',modifier.source);
  const effects=(frame,depth=0)=>({assignment(match,node,current){
    const value=execution.scalar(match[3],current);
    if(!variables.has(match[2])||value===null)return{outcome:'unknown',reason:'Modifier write value or declaration is unresolved.'};
    const k=current.get('@alias:'+match[2]),prior=k&&current.get(k),next={...(prior?.storage?{storage:prior.storage}:{}),scalar:value};
    current.set(match[2],next);if(k)current.set(k,next);current.set(`${storageOwner}.${match[2]}`,next);return{outcome:'continue'};
  },operation(node,current){
    const helper=helperFor(lexicalCode(frame.code.slice(node.start,node.end)).trim());
    if(!helper||depth>=8)return{outcome:'unknown',reason:'Modifier helper resolution is unsupported.'};
    if(!require('./source-coverage').read(helper,helper.source.line,helper.source.endLine)||helper.modelRanges&&!require('./source-coverage').covers(helper.modelRanges,helper.source.line,helper.source.endLine))return{outcome:'unknown',code:'MODIFIER_HELPER_VIEW_MISSING',kind:'local-reading',source:helper.source,reason:'Supply the complete modifier helper body.'};
    const helperValues=new Map([...current].filter(([key])=>key.startsWith('@storage:')||key.startsWith('msg.sender')||key.startsWith('@alias:')||variables.has(key)||constants.has(key)||/^[\w$]+\.[\w$]+$/.test(key)));
    const result=execution.pathTo(helper,Infinity,helperValues,{complete:true,...effects(helper,depth+1)});
    if(result.reachable===true){for(const [key,value]of result.values)current.set(key,value);return{outcome:'continue'};}
    return{outcome:result.outcome||'unknown',code:result.code,kind:result.kind,reason:result.reason,source:helper.source,failure:result.failure};
  }});
  const prefix=execution.pathTo(modifier,node.start,bound,effects(modifier));
  if(prefix.reachable===null&&['local-reading','capability'].includes(prefix.kind))return{...prefix,source:prefix.source||modifier.source};
  if(prefix.reachable!==true)return {...prefix,code:prefix.reachable===false?'MODIFIER_PREFIX_REJECTS':'MODIFIER_GUARD_PREMISE',kind:prefix.reachable===false?'structural':'material-evidence',source:modifier.source,
    reason:prefix.reachable===false?prefix.reason:`The supplied ${match[1]} prefix (${modifier.code.slice(body.bodyStart,node.start).trim()}) is resolved, but its entry-state guard is not established by exact scenario predicates. Supply the qualified storage/argument fact; a natural-language non-nested or authorization label alone is not a value proof.`};
  // Deferred until body completion: body writes can invalidate a guard. The
  // postlude is only proved when literal/constant facts suffice independently.
  const postlude=execution.pathTo(modifier,Infinity,new Map(constants),{after:node.end,complete:true,...effects(modifier)});
  const updated=state.transfer(values,prefix.values);
  for(const name of variables)if(prefix.values.has(`${storageOwner}.${name}`))updated.set(`${storageOwner}.${name}`,prefix.values.get(`${storageOwner}.${name}`));
  // Storage and caller lexical names are separate. Only a same-owner body may
  // read this private declaration, and never through a shadowing parameter.
  const callerParameters=bindings.parameterNames(functionParts(unit.code,unit.name.split('::').at(-1)).header);
  if(owner===storageOwner)for(const name of variables)if(!callerParameters.includes(name)&&prefix.values.has(name))updated.set(name,prefix.values.get(name));
  const finish=bodyValues=>execution.pathTo(modifier,Infinity,state.frame(modifier,state.transfer(prefix.values,bodyValues),units),{after:node.end,complete:true,...effects(modifier)});
  return {reachable:true,values:state.frame(unit,updated,units),guardState:prefix.values,guards:prefix.guards,source:modifier.source,postlude,finish,
    code:postlude.reachable===false?'MODIFIER_POSTLUDE_REVERTS':postlude.reachable===null?'MODIFIER_POSTLUDE_UNKNOWN':'MODIFIER_SUPPORTED'};
}
module.exports={inspect};
