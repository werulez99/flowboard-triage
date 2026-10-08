'use strict';
// Syntax and deterministic source selection, not interpretation or approval.
// The old string-path decoder remains in challenge-format for exact replay.
const crypto = require('node:crypto');
const coverage = require('./source-coverage');
const VERSION = 'source-edits-v2';
const CANDIDATE = 'candidate-edit-v2', REPAIR = 'review-edit-v2';
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readOnly = new Set(['inputReviews', 'explanationReviews', 'bindingFormat', 'checks']);
const safeId = id => typeof id === 'string' && !!id && !/[\/~]/.test(id) && !['__proto__','constructor','prototype'].includes(id);
function catalog(input, full) {
  const plain = require('./packet-context').expand(input), previous = plain.earlierDraft;
  if (!previous) throw new Error('Authoring needs its exact immutable reference.');
  const targets = [], removals = [];
  const note = structuredClone(full.properties.evidence.items);
  for (const key of ['sourceId','line','endLine','quote']) delete note.properties[key];
  note.properties.selection = object({ sourceId: { type: 'string', enum: plain.sources.map(s => s.id) },
    sourceHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, line: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } });
  note.required = Object.keys(note.properties);
  const visit = (properties, base, prefix) => {
    for (const [key, field] of Object.entries(properties)) {
      if (readOnly.has(key)) continue;
      const path = `${prefix}/${key}`;
      if (path === '/causal') { visit(field.properties, base?.[key] || {}, path); continue; }
      if (field.type === 'array' && field.items?.properties?.id) {
        const ids = (base[key] || []).map(item => item.id);
        if (ids.some(id => !safeId(id)) || new Set(ids).size !== ids.length) throw new Error('Authoring reference has ambiguous stable IDs.');
        const shape = path === '/evidence' ? note : field.items;
        if (ids.length) targets.push({ op: 'replace', paths: ids.map(id => `${path}/${id}`), shape, collection: path });
        // Nested value/change records have no stable identities. Expose their
        // entire arrays, never numeric descendants or synthesized item keys.
        for(const [name,child] of Object.entries(field.items.properties))
          if(ids.length&&child.type==='array'&&!child.items?.properties?.id&&(child.items?.type==='object'||child.items?.anyOf))
            targets.push({op:'set',paths:ids.map(id=>`${path}/${id}/${name}`),shape:child});
        targets.push({ op: 'add', paths: [path], shape, collection: path });
        if (path !== '/claims') removals.push(...ids.map(id => `${path}/${id}`));
      } else targets.push({ op: 'set', paths: [path], shape: field });
    }
  };
  visit(full.properties, previous, '');
  return { targets, removals };
}
// Reuse definitions in the enforced schema rather than copying a second,
// unenforced target schema into the instruction string.
function shareSchema(schema) {
  const counts = new Map(), visit = value => {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && (typeof value.type === 'string' || Array.isArray(value.anyOf) || Array.isArray(value.enum))) {
      const key = JSON.stringify(value); if (key.length >= 28) counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  visit(schema);
  const defs = {}, names = new Map();
  const encode = (value, root = false) => {
    if (!value || typeof value !== 'object') return value;
    const key = JSON.stringify(value);
    if (!root && counts.get(key) > 1) {
      if (!names.has(key)) { const name = `t${names.size}`; names.set(key, name); defs[name] = encode(value, true); }
      return { $ref: '#/$defs/' + names.get(key) };
    }
    return Array.isArray(value) ? value.map(v => encode(v)) : Object.fromEntries(Object.entries(value).map(([k,v]) => [k, encode(v)]));
  };
  const result = encode(schema, true);
  return Object.keys(defs).length ? { ...result, $defs: defs } : result;
}
function schema(input, full) {
  const { targets, removals } = catalog(input, full);
  const grouped=new Map();
  for(const t of targets){const key=JSON.stringify([t.op,t.shape]);if(!grouped.has(key))grouped.set(key,{...t,paths:[]});grouped.get(key).paths.push(...t.paths);}
  const alternatives = [...grouped.values()].map(t => object({ op: { enum: [t.op] }, target: { type: 'string', enum: t.paths }, value: t.shape }));
  if (removals.length) alternatives.push(object({ op: { enum: ['remove'] }, target: { type: 'string', enum: removals } }));
  return shareSchema(object({ mode: { enum: [input.candidateOnly ? CANDIDATE : REPAIR] },
    edits: { type: 'array', maxItems: 80, items: { anyOf: alternatives } },
    ...(!input.candidateOnly ? { ...(full.properties.inputReviews ? { inputReviews: full.properties.inputReviews } : {}),
      explanationReviews: full.properties.explanationReviews, checks: full.properties.causal.properties.checks } : {}) }));
}
function problem(code, target, message, extra = {}) { return { code, target, message, ...extra }; }
function collectionBounds(value, shape, path = '', entries = [], template = false) {
  if (shape.type === 'array') {
    if (Number.isInteger(shape.maxItems)) entries.push({ path, current: Array.isArray(value) ? value.length : template ? null : 0, maximum: shape.maxItems });
    if (shape.items?.type === 'object') {
      for (const [i,item] of (Array.isArray(value) ? value : []).entries())
        collectionBounds(item,shape.items,`${path}/${item.id || i}`,entries);
      // New objects obey the same nested limits, not a missing-reference exemption.
      if (template || shape.items.properties?.id) collectionBounds(null,shape.items,`${path}/{new}`,entries,true);
    }
  } else if (shape.type === 'object') for (const [key,child] of Object.entries(shape.properties))
    if (!readOnly.has(key)) collectionBounds(value?.[key],child,`${path}/${key}`,entries,template);
  return entries;
}
function aggregateInstruction(input, full) {
  const reference=require('./packet-context').expand(input).earlierDraft;
  return 'AGGREGATE CAPACITY (path, current count, final maximum), derived from this immutable reference and canonical schema. Replace preserves count; add increases it; remove decreases it; whole-array set uses its final length. Nested limits also apply to new objects ({new}, current=null). These are ceilings, not target counts. Preserve material scope and justified removals; valid individual edits never authorize a final overflow. Do not repeat this bookkeeping in tutorial prose.\n'+JSON.stringify(collectionBounds(reference,full));
}
function failure(problems) { return Object.assign(new Error(problems.map(p => `${p.target}: ${p.message}`).join('\n')), { code: 'AUTHORING_REJECTED', validationProblems: problems }); }
function evidenceProblems(notes, input, units) {
  const supplied = require('./packet-context').expand(input).sources, problems = [];
  for (const note of notes || []) {
    if (!note || typeof note !== 'object') continue;
    const target = '/evidence/' + (note.id || '?'), unit = units.find(u => u.id === note.sourceId), view = supplied.find(u => u.id === note.sourceId);
    if (!unit || !view) { problems.push(problem('EVIDENCE_SOURCE', target, 'Evidence names an unavailable source.', {sourceId:note.sourceId})); continue; }
    if (!Number.isSafeInteger(note.line) || !Number.isSafeInteger(note.endLine) || note.endLine < note.line ||
        !coverage.covers(coverage.ranges(view), note.line, note.endLine)) {
      problems.push(problem('EVIDENCE_RANGE', target, 'Evidence interval is not entirely supplied in this request.', { sourceId:note.sourceId,line:note.line,endLine:note.endLine })); continue;
    }
    const exact = unit.code.split('\n').slice(note.line-unit.source.line,note.endLine-unit.source.line+1).join('\n');
    if (typeof note.quote !== 'string' || note.quote.trim() !== exact.trim()) problems.push(problem('EVIDENCE_QUOTE', target,
      'Legacy quote differs from its exact selected lines. The old answer is not changed; a new explicit source selection is required.', {sourceId:note.sourceId,line:note.line,endLine:note.endLine}));
  }
  return problems;
}
// Inspect independently readable legacy updates without applying any of
// them. A bad address does not conceal a separate, exact source mismatch.
function legacyProblems(value, input, full, units) {
  const format = require('./challenge-format'), previous = input.earlierDraft, problems = [], touched = [];
  if (!Array.isArray(value?.updates)) return [problem('EDIT_STRUCTURE','/','Legacy response has no readable updates array.')];
  for (const update of value.updates.slice(0,80)) {
    const target = typeof update?.path === 'string' ? update.path : '/';
    let parsed;
    try { parsed = JSON.parse(update.valueJSON); }
    catch { problems.push(problem('EDIT_VALUE',target,'Legacy valueJSON is not valid JSON.')); continue; }
    if (touched.some(p=>p===target||p.startsWith(target+'/')||target.startsWith(p+'/'))) problems.push(problem('EDIT_CONFLICT',target,'Duplicate/overlapping edits are not permitted.'));
    touched.push(target);
    try { format.assemblePatch({mode:format.PATCH,updates:[update],inputReviews:[],explanationReviews:[],checks:[]},previous,full); }
    catch(error) { problems.push(problem('EDIT_TARGET_OR_VALUE',target,error.message)); }
    if (target === '/evidence' && Array.isArray(parsed)) problems.push(...evidenceProblems(parsed,input,units));
    else if (/^\/evidence\/[^/]+$/.test(target) && parsed && typeof parsed === 'object') problems.push(...evidenceProblems([parsed],input,units));
  }
  return problems;
}
function questionHints(value, full, reference) {
  // Independently readable, UNTRUSTED acquisition requests only. Never apply
  // removals or let a rejected replacement erase the original uncertainty.
  const result={questions:[],validationProblems:[]}, valid=require('./challenge-format').valid;
  const reject=(target,message)=>result.validationProblems.push(problem('QUESTION_HINT_REJECTED',target,message));
  const claims=new Set((reference?.claims||[]).map(c=>c.id)), old=reference?.questions||[];
  const inScope=q=>valid(q,full.properties.questions.items)&&safeId(q.id)&&
    (!reference||q.claimId===''||claims.has(q.claimId))&&
    !old.some(o=>o.id===q.id&&o.claimId!==q.claimId);
  if ([CANDIDATE,REPAIR].includes(value?.mode)) {
    if(!reference||!Array.isArray(value.edits)||value.edits.length>80)return result;
    const relevant=value.edits.filter(e=>typeof e?.target==='string'&&(e.target==='/questions'||e.target.startsWith('/questions/')));
    for(const edit of relevant){
      const q=edit.value,target=edit.target,actual=edit.op==='add'&&q?`/questions/${q.id}`:target;
      // Conflicts with even an invalid or remove operation make this hint
      // ambiguous; unrelated invalid edits do not suppress a useful request.
      const overlaps=relevant.filter(e=>{const p=e.op==='add'&&e.value?`/questions/${e.value.id}`:e.target;return p===actual||p.startsWith(actual+'/')||actual.startsWith(p+'/');});
      if(overlaps.length!==1){reject(target,'Conflicting question edits are not acquisition hints.');continue;}
      if(edit.op==='remove')continue;
      const shape=object({op:{enum:['add','replace']},target:{type:'string'},value:full.properties.questions.items});
      if(!valid(edit,shape)||!inScope(q)||
        !(edit.op==='add'?target==='/questions'&&!old.some(o=>o.id===q.id):target===`/questions/${q.id}`&&old.some(o=>o.id===q.id))){
        reject(target,'Question needs a complete typed object, legal add/replace target, stable ID and original claim scope.');continue;
      }
      result.questions.push(structuredClone(q));
    }
  } else {
    const matching=(Array.isArray(value?.updates)?value.updates:[]).filter(u=>u?.path==='/questions');
    if(matching.length===1)try{const items=JSON.parse(matching[0].valueJSON);
      if(valid(items,full.properties.questions)&&new Set(items.map(q=>q.id)).size===items.length&&items.every(inScope))result.questions=structuredClone(items);
      else reject('/questions','Legacy question array has invalid shape, identity or claim scope.');
    }catch{reject('/questions','Legacy question array is not readable JSON.');}
    else if(matching.length>1)reject('/questions','Conflicting legacy question arrays are not acquisition hints.');
  }
  if(result.questions.length>full.properties.questions.maxItems){
    reject('/questions','Acquisition hints exceed the bounded question capacity.');result.questions=[];
  }
  return result;
}
const questions=(value,full,reference)=>questionHints(value,full,reference).questions;
const mergeQuestions=(original,hints)=>[...new Map([...(original||[]),...(hints||[])].map(q=>[JSON.stringify(q),q])).values()];
function guidance(value) {
  // Legacy JSON strings are decoded only as UNTRUSTED guidance, not edits.
  // Preserve every target/value, including illegal addresses and bad quotes.
  if(!['candidate-patch-v1','review-patch-v1'].includes(value?.mode)||!Array.isArray(value.updates))return structuredClone(value);
  const {updates,...rest}=value;
  return {...rest,encoding:'decoded-values-guidance-v1',updates:updates.map(update=>{
    try{const {valueJSON,...fields}=update;return{...fields,value:JSON.parse(valueJSON)};}
    catch{return structuredClone(update);}
  })};
}
function selected(note, input, units, target) {
  const selection = note.selection, source = input.sources.filter(s => s.id === selection.sourceId), unit = units.filter(s => s.id === selection.sourceId);
  if (source.length !== 1 || unit.length !== 1 || source[0].sourceHash !== selection.sourceHash || unit[0].source.sourceHash !== selection.sourceHash)
    throw failure([problem('SOURCE_SELECTION_VERSION', target, 'Selection must identify one exact current supplied source and version.')]);
  if (!Number.isSafeInteger(selection.line) || !Number.isSafeInteger(selection.endLine) || selection.line < 1 || selection.endLine < selection.line || selection.endLine-selection.line>80 ||
      !coverage.covers(coverage.ranges(source[0]), selection.line, selection.endLine))
    throw failure([problem('SOURCE_SELECTION_RANGE', target, 'The complete selected interval must occur in the current supplied views.', { sourceId: selection.sourceId, line: selection.line, endLine: selection.endLine })]);
  coverage.packet(input, units);
  const quote = unit[0].code.split('\n').slice(selection.line - unit[0].source.line, selection.endLine - unit[0].source.line + 1).join('\n');
  const { selection: _, ...rest } = note;
  return { ...rest, sourceId: selection.sourceId, line: selection.line, endLine: selection.endLine, quote };
}
function compile(value, input, full, units) {
  const format = require('./challenge-format'), plain = require('./packet-context').expand(input), spec = schema(input, full);
  const problems = [], updates = [], mappings = [], touched = [];
  const { targets, removals } = catalog(input, full);
  if (!value || !Array.isArray(value.edits) || value.edits.length > 80) throw failure([problem('EDIT_STRUCTURE', '/', 'Expected a bounded edits array.')]);
  for (const edit of value.edits) {
    const target = typeof edit?.target === 'string' ? edit.target : '/';
    const match = targets.find(t => t.op === edit?.op && t.paths.includes(target));
    if (edit?.op !== 'remove' && !match || edit?.op === 'remove' && !removals.includes(target)) {
      problems.push(problem('EDIT_TARGET', target, 'Use an enumerated target and operation. ID-less arrays require a complete set operation.')); continue;
    }
    const shape = match ? object({ op: { enum: [match.op] }, target: { enum: match.paths }, value: match.shape }) : object({ op: { enum: ['remove'] }, target: { enum: removals } });
    if (!format.valid(edit, shape)) { problems.push(problem('EDIT_VALUE', target, 'The complete typed value or operation fields do not match this target.')); continue; }
    const actual = edit.op === 'add' ? `${target}/${edit.value.id}` : target;
    if (edit.op === 'add' && (!safeId(edit.value.id) || targets.some(t => t.op === 'replace' && t.paths.includes(actual)))) {
      problems.push(problem('EDIT_ID', actual, 'Add needs a new safe stable ID; existing items use replace.')); continue;
    }
    if (edit.op === 'replace' && edit.value.id !== target.split('/').at(-1)) { problems.push(problem('EDIT_ID', target, 'Replacement must preserve the target stable ID.')); continue; }
    if (touched.some(p => p === actual || p.startsWith(actual + '/') || actual.startsWith(p + '/'))) {
      problems.push(problem('EDIT_CONFLICT', actual, 'Duplicate and ancestor/descendant edits are rejected atomically.')); continue;
    }
    touched.push(actual);
    let replacement = edit.op === 'remove' ? null : structuredClone(edit.value);
    if (actual.startsWith('/evidence/') && replacement) {
      try { replacement = selected(replacement, plain, units, actual); mappings.push({ target: actual, selection: edit.value.selection, quoteHash: hash(replacement.quote) }); }
      catch (error) { problems.push(...(error.validationProblems || [problem('SOURCE_SELECTION_BYTES', actual, error.message)])); continue; }
    }
    updates.push({ path: actual, value: replacement });
  }
  if (!format.valid(value, spec) && !problems.length) problems.push(problem('EDIT_STRUCTURE', '/', 'Response fields/mode must match the enforced authoring schema; candidate authoring supplies no checks.'));
  if (problems.length) throw failure(problems);
  // Only catalog-admitted typed operations reach this private clone. Do not
  // pass new typed objects through legacy valueJSON's separate string bound;
  // every field/list retains the canonical schema and transport/storage bounds.
  const output=structuredClone(plain.earlierDraft);output.causal ||= {};
  for(const update of updates){
    const keys=update.path.split('/').slice(1);let container=output;
    for(const key of keys.slice(0,-1))container=Array.isArray(container)?container.find(item=>item.id===key):container[key];
    const key=keys.at(-1);
    if(Array.isArray(container)){
      const index=container.findIndex(item=>item.id===key);
      if(update.value===null)container.splice(index,1);
      else if(index<0)container.push(update.value);else container[index]=update.value;
    }else container[key]=update.value;
  }
  output.inputReviews=value.inputReviews||[];output.explanationReviews=value.explanationReviews||[];output.causal.checks=value.checks||[];
  if(!format.valid(output,full)){
    const previous=new Map(collectionBounds(plain.earlierDraft,full).map(item=>[item.path,item.current]));
    const bounds=collectionBounds(output,full).filter(item=>item.current>item.maximum).map(item=>problem('EDIT_CAPACITY',item.path,
      `Assembled ${item.path} has ${item.current} items; the canonical maximum is ${item.maximum}. No edits were admitted.`,
      {current:previous.get(item.path)??0,final:item.current,actual:item.current,maximum:item.maximum}));
    throw failure(bounds.length?bounds:[problem('EDIT_ASSEMBLY','/','The assembled typed response is an incomplete explanation or violates the complete canonical field/list schema. No edits were admitted.')]);
  }
  return { output, mapping: { version: VERSION, responseHash: hash(value), canonicalHash: hash(output), selections: mappings } };
}
const instruction = `AUTHORING SYNTAX source-edits-v2. The enforced response schema is the authoritative catalog of legal operations, exact targets and typed values; no JSON-in-a-string or arbitrary slash paths. set replaces the named field/ID-less array as a WHOLE (including relationships). replace replaces one existing stable-ID object with its COMPLETE typed value, preserving its ID; this includes the complete changes array when replacing an event. add supplies a COMPLETE new object at a collection target with a fresh ID. remove names one enumerated existing item. Preserve unaffected fields exactly. Never invent relationship IDs or use array indexes. Duplicate/overlapping edits are rejected atomically. Checks and derived fields are not editable.
New/replaced evidence supplies selection={sourceId,sourceHash,line,endLine}, using original line numbers and the EXACT supplied source version. This replaces model-authored quote/line fields for those notes. The WHOLE interval must be supplied, including sparse-view coverage. The host copies that literal code, without searching, guessing or normalizing a quote. This mechanical selection proves no interpretation: provide correct claim ownership, stance, explanation, conditions and counterevidence; full review must independently judge them. Unchanged historical evidence retains its exact quote. Every existing evidence ID-to-claim association is immutable, including shared context; never reassign it. Use removal plus a fresh claim-specific ID and all dependent updates. Do not remove or rename a material claim. Full structural/source/scope checks follow atomic assembly; no partial edit can be published.`;
const task = input => input.candidateOnly ? 'Return candidate-edit-v2 WITHOUT review arrays or approvals. Complete the private explanation; a separate full check is required. No check attestation in any surrounding instruction applies to this authoring response. If assembledEarlier is absent, earlierDraft with its source-binding selectors is the complete provided unaccepted reference; do not invent a missing derived object.' : 'Return review-edit-v2 WITH fresh inputReviews, explanationReviews for every old/current/changed/removed note, and checks for every causal target. Exact source selection confers no approval. Keep all material scope and counterevidence.';
module.exports = { VERSION, CANDIDATE, REPAIR, schema, catalog, compile, selected, failure, problem, collectionBounds, aggregateInstruction, evidenceProblems, legacyProblems, questions, questionHints, mergeQuestions, guidance, instruction, task };
