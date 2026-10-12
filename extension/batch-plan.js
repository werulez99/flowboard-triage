'use strict';
// Finite local planning, NOT provider quota discovery or a measured ETA.
const automatic = require('./automatic-triage');
const MAX_CONCURRENCY = 32, DEFAULT_ATTEMPTS = 6;
const capacity = value => Math.max(1, Math.min(MAX_CONCURRENCY, Number.isInteger(value) ? value : 2));
function phases(job) {
  if(automatic.complete(job))return 0;
  const operation=job.nextOperation;
  if(operation)return Math.max(0,Math.min(2,operation.phases||0));
  if(job.correctionHold||['blocked','failed','cancelled','paused','completed'].includes(job.state))return 0;
  return job.checkpoint?.stage==='challenge'?1:2;
}
function plan(jobs, resources, workers, providerCapacity, admission) {
  const unfinished = jobs.filter(job => !automatic.complete(job));
  const pending=unfinished.map(job=>({job,phases:phases(job),admission:admission?.(job)}));
  const actionable=pending.filter(item=>item.phases&&item.admission?.available!==false);
  const expectedRequests = actionable.reduce((n,item)=>n+item.phases,0);
  const maximumRequests = actionable.reduce((n,{job}) => n + Math.max(0, job.requestLimit - job.requests), 0);
  const effectiveConcurrency = Math.min(capacity(workers), capacity(providerCapacity));
  const dependencyDepth = actionable.reduce((depth,item)=>Math.max(depth,item.phases),0);
  return { eligible: actionable.length, estimatedRequests: expectedRequests, expectedRequests, maximumRequests,
    localActions:pending.filter(({job,phases})=>!phases&&['recover','revalidate','acquire'].includes(job.nextOperation?.kind)).length,
    awaitingEvidence:pending.filter(({job})=>job.nextOperation?.kind==='evidence').length,
    admissionBlocked:pending.filter(item=>item.phases&&item.admission?.available===false).length,
    phases:{verificationOnly:actionable.filter(item=>item.phases===1).length,authoringAndVerification:actionable.filter(item=>item.phases===2).length},
    remainingAllowance: Math.max(0, resources.limit - resources.requests), effectiveConcurrency,
    dependencyDepth, requestWavesLowerBound: Math.max(Math.ceil(expectedRequests/effectiveConcurrency),dependencyDepth),
    timing: { etaMs: null,
      basis: 'Real-provider duration is not measured for this report; no ETA is available.',
      target: 'The product target is a practical few-hour envelope for a large, complex report; this is not a measured completion estimate.',
      assumptions: 'Request waves are a scheduling lower bound, assuming all configured slots are available and equal request duration. Serial authoring/verification dependencies are included. Local preparation, active requests, token/request quotas, backoff and repairs may add work. No seconds-per-request assumption or remote capacity is inferred.' },
    basis: 'Planned requests follow available next operations: authoring plus fresh verification, or verification only. A current completed assessment adds no automatic work because its walkthrough is unavailable. Local recovery/acquisition and unresolved external facts add no model requests. Explicit revisions count only when their required phases are admitted. Maximum is remaining selected-finding allocation, not a promise of useful work or remote capacity.' };
}
function owedChallenges(jobs, selectedId, requiresChallenge = () => true) {
  return jobs.filter(job => job.id !== selectedId && requiresChallenge(job.id) && !automatic.complete(job) &&
    (job.checkpoint?.stage === 'challenge' && !['blocked', 'failed', 'cancelled'].includes(job.state) ||
      job.state === 'running' && job.stage === 'generate')).length;
}
module.exports = { capacity, plan, phases, owedChallenges, MAX_CONCURRENCY, DEFAULT_ATTEMPTS };
