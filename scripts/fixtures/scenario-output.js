'use strict';
// Synthetic source interpretations, never a protocol review or paid provider.
function response(input){
 input=require('../../extension/packet-context').expand(input);
 const capacity=require('../../extension/review-capacity'),specs=[
  {id:'withdrawal',name:'withdraw',actor:'User',condition:'approved == false',expression:'require(approved, "approval required");',parameter:'approved',argument:'false',title:'Reject the unapproved withdrawal',reason:'The false approval fails require before return units. This call returns no units.'},
  {id:'rebalance',name:'rebalance',actor:'Keeper',condition:'paused == true',expression:'require(!paused, "paused");',parameter:'paused',argument:'true',title:'Reject the paused rebalance',reason:'With paused true, !paused is false. The guard reverts before stored = target, so the old stored value remains.'}];
 const evidence=[],claims=[],events=[],obligations=[];
 for(const s of specs){const u=input.sources.find(u=>u.name==='ScenarioBook::'+s.name);if(!u?.complete)throw Error('Exact scenario function unavailable');
  const row=u.code.split('\n').find(l=>l.slice(l.indexOf(' | ')+3).trim()===s.expression);if(!row)throw Error('Scenario guard absent');const line=Number(row.split(' | ')[0]);
  evidence.push({id:s.id+'-guard',claimId:s.id,sourceId:u.id,line,endLine:line,quote:row.slice(row.indexOf(' | ')+3),stance:'contradicts',explanation:s.reason});
  claims.push({id:s.id,kind:'defect',severityFactors:null,allegation:s.actor+' rejected request allegedly proceeds.',actor:s.actor,entry:u.id,implementation:u.name,conditions:[s.condition],requiredFacts:[s.condition],supportsIf:'The guarded operation is reached despite the false guard.',contradictsIf:'The guard reverts first.',status:'contradicted',reason:s.reason,evidence:[s.id+'-guard'],unknowns:[],nextQuestion:''});
  events.push({id:s.id,invocationId:s.id+'-call',transaction:s.id+'-tx',phase:'guard',claimId:s.id,evidenceId:s.id+'-guard',callSiteId:'',title:s.title,role:'Decisive guard',actor:s.actor,caller:'msg.sender',receiver:'ScenarioBook',conditions:[s.condition],what:s.reason,why:'This refutes only this reported branch. The other scenario is checked independently.',inputs:[{name:s.parameter,expression:s.argument,type:'bool',units:'boolean flag',origin:'Explicit reported scenario input, not observed deployment state.',evidence:[s.id+'-guard']}],changes:[],effect:'rolled-back',paragraphId:input.finding.reportParagraphs[0].id,phrase:''});
  obligations.push(...capacity.kinds.map(kind=>({id:s.id+'-'+kind,claimId:s.id,kind,question:'Check '+kind+' for this rejected request',state:['impact','settlement'].includes(kind)?'not-applicable':'established',reason:s.reason,evidence:[s.id+'-guard'],documentation:[]})));
 }
 const relationships=[{from:'withdrawal',to:'rebalance',kind:'context',explanation:'Alternative scenario: a keeper submits a separate paused rebalance. This is not a call or a continuation of the user withdrawal.',binding:'No state or values are carried between these independent scenarios.',evidence:evidence.map(e=>e.id),callSiteId:'',dispatch:{kind:'not-applicable',receiver:'',implementation:'',evidence:[],context:'none',failure:'not-applicable'}}];
 const causal={scope:'Two fictional, independent rejected source-level requests; not observed transactions.',summary:'Each entry has a different boolean guard. Both stated rejected conditions fail before the alleged consequence.',outcome:'refuted',obligations,events,relationships,order:events.map(e=>e.id),checks:[]};
 const inputReviews=(input.semanticInput?.premises||[]).map(p=>({id:p.id,status:'applied',reason:causal.scope,claimIds:claims.map(c=>c.id),eventIds:events.map(e=>e.id),evidence:evidence.map(e=>e.id)}));
 const explanationReviews=evidence.map(e=>({evidenceId:e.id,result:'kept',reason:e.explanation,checkedSourceIds:[e.sourceId]})),checks=capacity.targets(causal).map(t=>({target:t.key,reason:'Each guard refutes its own alleged branch. The context handoff is a separate scenario with separate actor, flag and transaction.',evidence:evidence.map(e=>e.id),documentation:[]}));
 if(input.checkOnly)return{result:'kept',problems:[],inputReviews,explanationReviews,checks};
 if(input.phase==='challenge')causal.checks=checks;
 const value={inputReviews,property:{text:'A failed require reverts this call before subsequent operations.',basis:'report-assumption',derivation:null,evidence:[],documentation:[]},claims,evidence,explanationReviews:input.phase==='challenge'?explanationReviews:[],transitions:[],questions:[],causal,
  conclusion:{status:'contradicted-in-scope',text:'Neither reported rejected branch proceeds. An approved withdrawal or unpaused rebalance is a distinct scenario, not evidence of bypassing these guards.',limitations:[]},walkthrough:{assessment:{result:'invalid',why:'Both independent rejected conditions hit their own require before the alleged operation.',supportingEvidence:'',opposingEvidence:'rebalance-guard'}}};
 if(!input.assessmentContract){delete value.property.derivation;for(const c of value.claims){delete c.kind;delete c.severityFactors;}}
 return require('./source-bound-output').encode(value,input);
}
module.exports={response};
