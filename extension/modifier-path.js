'use strict';
// One exact local modifier, one top-level placeholder. No writes, calls or
// inherited-name guessing. Unknown guards remain scenario premises, not proof.
const {functionParts,lexicalCode,matching}=require('./solidity-text');
const execution=require('./execution-slice');
function inspect(unit,suffix,values,units){
  const unknown=(code,reason,kind='capability',source)=>({reachable:null,code,kind,reason,source});
  const match=/^([A-Za-z_$][\w$]*)(?:\s*\((.*)\))?$/.exec(suffix);
  if(!match||suffix.includes('(')&&matching(suffix,suffix.indexOf('('))!==suffix.length-1)return unknown('MODIFIER_COMPOSITION_UNSUPPORTED',`Modifier composition ${suffix} is outside the supported single-placeholder local subset.`);
  const owner=unit.contract||unit.name.split('::')[0];
  const named=[...units.values()].filter(s=>/^\s*modifier\b/.test(lexicalCode(s.code))&&s.name.split('::').at(-1)===match[1]);
  const exact=named.filter(s=>s.complete&&s.source.file===unit.source.file&&s.source.sourceHash===unit.source.sourceHash&&(s.contract||s.name.split('::')[0])===owner);
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
  const bound=new Map(values);for(let i=0;i<parameters.length;i++)bound.set(parameters[i],execution.boolean(args[i],values));
  // Reject effects even after the placeholder: ignoring a postlude would
  // falsely equate reaching the body with committing the transaction.
  const simple=n=>{
    const raw=modifier.code.slice(n.start,n.end).trim(),text=lexicalCode(raw);
    if(/^throw\s*;$/.test(text))return true;
    if(!/^(?:require\s*\(|assert\s*\(|revert\b)/.test(text))return false;
    const open=text.indexOf('('),close=matching(text,open);
    return open>=0&&close>=0&&require('./failure-data').parts(raw.slice(open+1,close)).every(pure);
  };
  const safe=n=>n===node||n.kind==='block'&&n.children.every(safe)||n.kind==='if'&&pure(n.condition)&&safe(n.yes)&&(!n.no||safe(n.no))||n.kind==='simple'&&simple(n);
  if(!tree.nodes.every(safe))return unknown('MODIFIER_EFFECT_UNSUPPORTED','The supplied modifier contains a write, invocation or unsupported pre/post effect.','capability',modifier.source);
  const prefix=execution.pathTo(modifier,node.start,bound);
  if(prefix.reachable!==true)return {...prefix,code:prefix.reachable===false?'MODIFIER_PREFIX_REJECTS':'MODIFIER_GUARD_PREMISE',kind:prefix.reachable===false?'structural':'material-evidence',source:modifier.source,
    reason:prefix.reachable===false?prefix.reason:`The supplied ${match[1]} prefix (${modifier.code.slice(body.bodyStart,node.start).trim()}) is not resolved by the exact scenario predicates. Natural-language authorization is not automatically an address equality; body reachability remains unknown.`};
  // Deferred until body completion: body writes can invalidate a guard. The
  // postlude is only proved when literal/constant facts suffice independently.
  const postlude=execution.pathTo(modifier,Infinity,new Map(),{after:node.end,complete:true});
  return {reachable:true,values,guards:prefix.guards,source:modifier.source,postlude,
    code:postlude.reachable===false?'MODIFIER_POSTLUDE_REVERTS':postlude.reachable===null?'MODIFIER_POSTLUDE_UNKNOWN':'MODIFIER_SUPPORTED'};
}
module.exports={inspect};
