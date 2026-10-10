'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),coverage=require('../extension/report-coverage'),provider=require('../extension/semantic-provider'),format=require('../extension/challenge-format');
function fixture(){
 const draft={semanticInput:{reportText:'Route A claims normal completion. Route B independently claims loss.\n\nRepeated wording.\n\nProposed patch: remove the guard.\n\nLate qualification: only under an unknown deployment.'},claims:[{id:'a'},{id:'b'}]};
 const ps=coverage.paragraphs(draft),map={version:coverage.VERSION,reportHash:coverage.reportHash(draft),dispositions:ps.map((p,i)=>({id:'d'+i,paragraphId:p.id,start:0,end:p.text.length,kind:i===2?'proposed-change':i===3?'unresolved':'claim',claimIds:i===3?[]:['a','b'],duplicateOf:'',reason:'Explicit fictional reviewed disposition.'}))};
 const value={claims:draft.claims,reportCoverage:map,reportReview:{reportHash:map.reportHash,reviewedIds:map.dispositions.map(d=>d.id),changes:[],reason:'Checked the complete fictional report, including its independent route and late qualification.'}};
 return{draft,value};
}
test('report intervals, duplicates, late scope and fresh original-to-current disposition changes cannot disappear',()=>{
 const{draft,value}=fixture();assert.deepEqual(coverage.problems(value,draft,{required:true,review:true,previous:value}),[]);
 const omitted=structuredClone(value);omitted.reportCoverage.dispositions.pop();assert.ok(coverage.problems(omitted,draft,{review:true}).some(p=>p.code==='REPORT_COVERAGE_GAP'));
 const narrowed=structuredClone(value);narrowed.reportCoverage.dispositions[3].kind='context';assert.ok(coverage.problems(narrowed,draft,{review:true,previous:value}).some(p=>p.code==='REPORT_COVERAGE_REVISION'));
 narrowed.reportReview.changes=[{id:'d3',kind:'changed',reason:'Fictional fresh check of exact reclassification; not host approval.'}];assert.deepEqual(coverage.problems(narrowed,draft,{review:true,previous:value}),[]);
 const duplicate=structuredClone(value);duplicate.reportCoverage.dispositions[1].kind='duplicate';duplicate.reportCoverage.dispositions[1].duplicateOf='d1';assert.ok(coverage.problems(duplicate,draft).some(p=>p.code==='REPORT_COVERAGE_DUPLICATE'));
 draft.semanticInput.reportText+=' Changed premise';assert.ok(coverage.problems(value,draft).some(p=>p.code==='REPORT_COVERAGE_IDENTITY'));
});
test('same ordinary request includes bounded extraction and fresh challenge; legacy has no invented attestations',()=>{
 const input={phase:'generate',finding:{title:'Fictional two routes'},sources:[],reportCoverageContract:coverage.VERSION};
 const metrics=provider.measureRequest(input);assert.match(metrics.system,/Read EVERY original/);assert.ok(provider.fullSchema(input).required.includes('reportCoverage'));
 const check=provider.responseSchema({...input,phase:'challenge',checkOnly:true});assert.ok(check.required.includes('reportReview'));
 assert.equal(format.valid({result:'kept',problems:[],inputReviews:[],explanationReviews:[],checks:[]},check),false);
 assert.equal(provider.fullSchema({...input,reportCoverageContract:undefined}).properties.reportCoverage,undefined);
 assert.match(provider.measureRequest({...input,checkOnly:true,phase:'challenge'}).system,/absence in earlierDraft is NOT by itself/);
});
