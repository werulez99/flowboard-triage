'use strict';
// Fixed source-review data for route-preparation/README.md. This is a gate and
// playback fixture, not a fresh model answer or an executed protocol trace.
const capacity = require('../../extension/review-capacity');
function response(input) {
  const names = ['commit', '_checkAmount', '_preview', '_increment', '_requireApproval'];
  const units = Object.fromEntries(names.map(name => [name, input.sources.find(unit => unit.name === `RouteBook::${name}`)]));
  for (const name of names) if (!units[name]?.complete) throw new Error(`The production packet did not supply complete RouteBook::${name}.`);
  const paragraph = input.finding.reportParagraphs.find(item => item.text.includes('The report claims'));
  if (!paragraph) throw new Error('The original report paragraph was not imported.');
  const lines = unit => unit.code.split('\n').map(text => { const match = text.match(/^(\d+) \| (.*)$/); if (!match) throw new Error('Expected original numbered source.'); return { line:Number(match[1]), text:match[2] }; });
  const evidence = [];
  function note(id, name, text, explanation, stance = 'context') {
    const unit = units[name], matches = lines(unit).filter(line => line.text.trim() === text);
    if (matches.length !== 1) throw new Error(`Fixture source anchor must be unique: ${name}: ${text}`);
    const selected = matches[0]; evidence.push({ id, claimId:'c1', sourceId:unit.id, line:selected.line, endLine:selected.line, quote:selected.text, stance, explanation });
    return id;
  }
  note('attempt', 'commit', 'attempts += 1;', 'The invocation first adds one to attempts. This is an intermediate write; the later internal approval failure can roll it back.');
  note('check-call', 'commit', '_checkAmount(requestedThreshold);', 'The threshold parameter is passed unchanged to the internal range guard. This must succeed before the illustrated preview and additions.');
  note('check-guard', '_checkAmount', 'require(requestedThreshold >= 1 && requestedThreshold <= 24, "threshold");', 'The range guard permits thresholds from 1 through 24 inclusive. Outside that range this invocation also reverts, before the counter additions.');
  note('preview-call', 'commit', 'uint256 delta = _preview(requestedThreshold);', 'The threshold is passed to the internal preview. Its returned total becomes delta, the expression used by the first increment.');
  note('preview-first', '_preview', 'if (requestedThreshold >= 1) {', 'The first branch contributes one when the threshold reaches one. Each later branch independently adds one for its own reached threshold.');
  note('preview-return', '_preview', 'return completed;', 'Only after all 24 threshold branches does the preview return their total. The result is measured in counter units, not assets or money.');
  note('first-call', 'commit', '_increment(delta);', 'This exact occurrence passes delta to amount. The later occurrence passes a different expression, so it is a separate helper invocation.');
  note('increment-write', '_increment', 'counter += amount;', 'This helper adds its own invocation parameter to counter. The source is reused by two calls, but their arguments and provisional results differ.');
  note('increment-return', '_increment', 'return;', 'The helper returns without changing the EVM caller or execution address. An internal return does not commit its preceding write independently.');
  note('second-call', 'commit', '_increment(1);', 'This second call passes the literal one to amount, not delta. Its write is still part of the same enclosing invocation.');
  note('approval-call', 'commit', '_requireApproval(approved);', 'The approval parameter reaches an internal guard after both counter additions. The call is not caught, so its failure propagates through commit.', 'contradicts');
  note('approval-guard', '_requireApproval', 'require(approved, "approval rejected");', 'On the reported false-approval path this require reverts. Because the internal failure is not caught, no preceding writes in commit persist.', 'contradicts');
  const byId = new Map(evidence.map(item => [item.id,item]));
  const site = id => {
    const anchor=byId.get(id),unit=input.sources.find(unit=>unit.id===anchor.sourceId),found=unit.relatedCalls.filter(call=>call.span.line===anchor.line&&call.span.endLine===anchor.endLine);
    if(found.length!==1)throw new Error(`Expected one exact fixture call occurrence at ${id}.`);return found[0];
  };
  const premises=['approved is false','requestedThreshold is an integer from 1 through 24','attempts + 1 and counter + delta + 1 do not overflow'];
  const events=[];
  const event=(id, invocationId, anchor, title, what, why, extra={})=>{
    const name=names.find(name=>units[name].id===byId.get(anchor).sourceId);
    const conditions=name==='commit'?premises:name==='_requireApproval'?['approved is false','approved is the unchanged input from the calling commit invocation.']:name==='_increment'?['The illustrated additions do not overflow.','The amount expression is supplied by this particular internal call.']:['The threshold is the unchanged input from commit, within its checked 1–24 range.'];
    const entry={id,invocationId,transaction:'commit-tx',phase:'read',claimId:'c1',evidenceId:anchor,callSiteId:'',title,role:({commit:'The entry owns the attempt and counter-update sequence.',_checkAmount:'This helper checks the threshold before the additions.',_preview:'This pure helper derives the first increment from reached thresholds.',_increment:'This internal helper performs one provisional addition.',_requireApproval:'This guard can reject all preceding work in this invocation.'})[name],actor:'Requesting caller',caller:'msg.sender',receiver:'RouteBook execution address',conditions,what,why,inputs:[],changes:[],effect:'read',paragraphId:paragraph.id,phrase:'',...extra};events.push(entry);return entry;
  };
  const parameter=(name,expression,origin,anchor,type='uint256')=>({name,expression,type,units:type==='bool'?'approval flag':'counter units',origin,evidence:[anchor]});
  const change=(name,before,operation,after,anchor)=>({name,before,operation,after,units:'counter units',evidence:[anchor]});
  event('attempt','commit-1','attempt','Record an attempted request','The attempt counter increases by one before the helpers run.','This is the earliest write the report says would survive.',{phase:'write',effect:'intermediate',changes:[change('attempts','A','+ 1','A + 1','attempt')]});
  event('check-call','commit-1','check-call','Check the threshold first',byId.get('check-call').explanation,'An early rejection would stop before the later counter updates.',{phase:'call',effect:'intermediate',callSiteId:site('check-call').id});
  event('check-guard','check-1','check-guard','Accept only the stated range',byId.get('check-guard').explanation,'The selected scenario satisfies this guard.',{phase:'guard',effect:'condition',inputs:[parameter('requestedThreshold','requestedThreshold','The commit parameter at the preceding exact call.','check-call')]});
  event('preview-call','commit-1','preview-call','Calculate the first increment',byId.get('preview-call').explanation,'The next helper supplies the value later passed as delta.',{phase:'call',effect:'intermediate',callSiteId:site('preview-call').id});
  event('preview-first','preview-1','preview-first','Count the reached thresholds',byId.get('preview-first').explanation,'The full function shows every contributing branch; this is not a fabricated numeric example.',{phase:'branch',effect:'condition',inputs:[parameter('requestedThreshold','requestedThreshold','The threshold passed at the preview call.','preview-call')]});
  event('preview-return','preview-1','preview-return','Return the completed total',byId.get('preview-return').explanation,'The returned total becomes delta in the entry function.',{phase:'return',effect:'return',inputs:[parameter('requestedThreshold','requestedThreshold','Unchanged parameter from the preview call.','preview-call')]});
  event('first-call','commit-1','first-call','Pass delta to the first addition',byId.get('first-call').explanation,'This call creates the first increment invocation.',{phase:'call',effect:'intermediate',callSiteId:site('first-call').id});
  event('first-write','increment-1','increment-write','Add the preview result', 'The first invocation adds delta to counter.','This write can still be rolled back by the approval rejection.',{phase:'write',effect:'intermediate',inputs:[parameter('amount','delta','The first _increment call argument.','first-call')],changes:[change('counter','C','+ delta','C + delta','increment-write')]});
  event('first-return','increment-1','increment-return','Return from the first addition',byId.get('increment-return').explanation,'Execution resumes before the second, distinct increment call.',{phase:'return',effect:'return',inputs:[parameter('amount','delta','Unchanged input from the first increment call.','first-call')]});
  event('second-call','commit-1','second-call','Pass one to the second addition',byId.get('second-call').explanation,'A repeated function does not mean a repeated argument.',{phase:'call',effect:'intermediate',callSiteId:site('second-call').id});
  event('second-write','increment-2','increment-write','Add one in the second invocation','This invocation receives the literal one and adds it to the provisional counter.','The two helper invocations are separate, but neither commits independently.',{phase:'write',effect:'intermediate',inputs:[parameter('amount','1','The literal at the second exact increment call.','second-call')],changes:[change('counter','C + delta','+ 1','C + delta + 1','increment-write')]});
  event('second-return','increment-2','increment-return','Return before the approval check',byId.get('increment-return').explanation,'The entry now reaches its last internal call.',{phase:'return',effect:'return',inputs:[parameter('amount','1','Unchanged input from the second increment call.','second-call')]});
  event('approval-call','commit-1','approval-call','Check approval after the additions',byId.get('approval-call').explanation,'This exact uncaught call is the decisive challenge to the reported persisted writes.',{phase:'call',effect:'intermediate',callSiteId:site('approval-call').id});
  event('approval-reject','approval-1','approval-guard','Reject the false approval',byId.get('approval-guard').explanation,'There is no successful return from this guard on the selected path.',{phase:'revert',effect:'rolled-back',inputs:[parameter('approved','approved','The false approval parameter passed by commit.','approval-call','bool')]});
  event('rollback','commit-1','approval-call','Roll back the whole commit invocation','The uncaught internal rejection propagates through commit. Its earlier attempt and counter writes do not persist.','The report’s claimed final state is refuted for the stated input; this is source reasoning, not an executed trace.',{phase:'rollback',effect:'rolled-back'});
  const relationships=[];
  const plain=(from,to,kind,explanation,ids)=>relationships.push({from,to,kind,explanation,binding:'No call binding: this link explains the named source relationship.',evidence:ids,callSiteId:'',dispatch:{kind:'not-applicable',receiver:'',implementation:'',evidence:[],context:'none',failure:'not-applicable'}});
  const call=(from,to,anchor,callee,binding)=>{
    const ids=[anchor,events.find(event=>event.id===to).evidenceId],dispatch={kind:'internal',receiver:'internal',implementation:units[callee].id,evidence:ids,context:'same',failure:'propagates'};
    const link={from,to,kind:'call',explanation:`The exact call enters ${callee}; the EVM caller and execution address stay unchanged.`,binding,evidence:ids,callSiteId:site(anchor).id,dispatch};relationships.push(link);return link;
  };
  const returned=(from,to,entry,explanation)=>relationships.push({from,to,kind:'return',explanation,binding:'Return to the original internal call; no transfer of execution address or EVM caller.',evidence:[...entry.evidence,events.find(event=>event.id===from).evidenceId,events.find(event=>event.id===to).evidenceId].filter((id,index,all)=>all.indexOf(id)===index),callSiteId:entry.callSiteId,dispatch:entry.dispatch});
  plain('attempt','check-call','data','The attempt write precedes the range check in the same invocation.',['attempt','check-call']);
  const check=call('check-call','check-guard','check-call','_checkAmount','requestedThreshold → requestedThreshold, unchanged counter units');
  returned('check-guard','preview-call',check,'After the in-range guard, execution returns to commit and reaches the preview call.');
  const preview=call('preview-call','preview-first','preview-call','_preview','requestedThreshold → requestedThreshold, unchanged counter units');
  plain('preview-first','preview-return','data','All threshold branches contribute to completed before the late return.',['preview-first','preview-return']);
  returned('preview-return','first-call',preview,'The preview returns completed into delta; commit passes delta to the first increment.');
  const first=call('first-call','first-write','first-call','_increment','delta → amount, counter units from the preview result');
  plain('first-write','first-return','data','The provisional addition is followed by this helper’s return.',['increment-write','increment-return']);
  returned('first-return','second-call',first,'The first helper returns to commit; the next distinct call passes one.');
  const second=call('second-call','second-write','second-call','_increment','1 → amount, one counter unit');
  plain('second-write','second-return','data','The second provisional addition is followed by its own return.',['increment-write','increment-return']);
  returned('second-return','approval-call',second,'After the second helper returns, commit reaches the approval check.');
  call('approval-call','approval-reject','approval-call','_requireApproval','approved → approved, the reported false approval flag');
  plain('approval-reject','rollback','branch','The false guard reverts; its uncaught internal failure propagates to the enclosing invocation. This is not a normal return.',['approval-guard','approval-call','attempt','increment-write']);
  const all=evidence.map(item=>item.id),summary='The final internal approval guard rejects false and rolls back the preceding attempt and counter writes. The report’s persisted-state allegation is refuted in this source scope.';
  const obligations=capacity.kinds.map(kind=>({id:kind,claimId:'c1',kind,question:`Check ${kind} for the stated approval-rejection route`,state:'established',reason:summary,evidence:all,documentation:[]}));
  const causal={scope:'Fictional source-derived scenario: threshold 1–24, approved=false, no earlier overflow. No execution or deployed state is asserted.',summary,outcome:'refuted',obligations,events,relationships,order:events.map(event=>event.id),checks:[]};
  const checks=capacity.targets(causal).map(item=>({target:item.key,reason:item.key.startsWith('event:')?events.find(event=>capacity.target('event',event)===item.key)?.what||summary:summary,evidence:all,documentation:[]}));
  const explanationReviews=evidence.map(item=>({evidenceId:item.id,result:'kept',reason:item.explanation,checkedSourceIds:names.map(name=>units[name].id)}));
  const inputReviews=(input.semanticInput?.premises||[]).map(premise=>({id:premise.id,status:'applied',reason:'The scenario applies the report’s false-approval condition and bounded threshold without treating it as an independent specification.',evidence:['check-guard','approval-guard'],claimIds:['c1'],eventIds:['approval-reject']}));
  const checkedInputs=input.semanticInput?{inputReviews}:{}; // Older product comparison has no saved-input schema.
  if(input.checkOnly)return{result:'kept',problems:[],...checkedInputs,explanationReviews,checks};
  if(input.repairOnly)return{mode:'review-patch-v1',updates:[],...checkedInputs,explanationReviews,checks};
  if(input.phase==='challenge')causal.checks=checks;
  return {property:{text:'The report alleges that a rejected internal approval leaves the invocation’s earlier storage writes committed.',basis:'report-assumption',evidence:[],documentation:[]},claims:[{id:'c1',allegation:'Attempt and counter writes persist after the internal approval guard rejects false.',actor:'Requesting caller',entry:units.commit.id,implementation:'RouteBook.commit',conditions:premises,requiredFacts:['The approval rejection must not roll back earlier writes.'],supportsIf:'The invocation completes with its earlier writes after rejection.',contradictsIf:'The uncaught guard reverts the invocation and its writes.',status:'contradicted',reason:summary,evidence:all,unknowns:[],nextQuestion:''}],evidence,...checkedInputs,explanationReviews:input.phase==='challenge'?explanationReviews:[],transitions:[],questions:[],conclusion:{status:'contradicted-in-scope',text:summary,limitations:[]},walkthrough:{steps:events.map(event=>({evidenceId:event.evidenceId,title:event.title,paragraphId:paragraph.id,phrase:''})),assessment:{result:'invalid',why:summary,supportingEvidence:'',opposingEvidence:'approval-guard'}},causal};
}
module.exports={response};
