'use strict';
// Finite local planning, NOT provider quota discovery or a measured ETA.
const MAX_CONCURRENCY = 32, DEFAULT_ATTEMPTS = 6;
const capacity = value => Math.max(1, Math.min(MAX_CONCURRENCY, Number.isInteger(value) ? value : 2));
function phases(job) {
  if(job.publishable)return 0;
  const operation=job.nextOperation;
  if(operation)return Math.max(0,Math.min(2,operation.phases||0));
  if(job.correctionHold||['blocked','failed','cancelled','paused','completed'].includes(job.state))return 0;
  return job.checkpoint?.stage==='challenge'?1:2;
}
function plan(jobs, resources, workers, providerCapacity, admission) {
  const unfinished = jobs.filter(job => !job.publishable);
  const pending=unfinished.map(job=>({job,phases:phases(job),admission:admission?.(job)}));
  const actionable=pending.filter(item=>item.phases&&item.admission?.available!==false);
  const expectedRequests = actionable.reduce((n,item)=>n+item.phases,0);
  const maximumRequests = actionable.reduce((n,{job}) => n + Math.max(0, job.requestLimit - job.requests), 0);
  const effectiveConcurrency = Math.min(capacity(workers), capacity(providerCapacity));
  return { eligible: actionable.length, estimatedRequests: expectedRequests, expectedRequests, maximumRequests,
    localActions:pending.filter(({job,phases})=>!phases&&['recover','revalidate','acquire'].includes(job.nextOperation?.kind)).length,
    awaitingEvidence:pending.filter(({job})=>job.nextOperation?.kind==='evidence').length,
    admissionBlocked:pending.filter(item=>item.phases&&item.admission?.available===false).length,
    phases:{verificationOnly:actionable.filter(item=>item.phases===1).length,authoringAndVerification:actionable.filter(item=>item.phases===2).length},
    remainingAllowance: Math.max(0, resources.limit - resources.requests), effectiveConcurrency,
    // Explicit one-minute assumption; no compatibility claim about old receipts.
    scenario: { label: 'Assumption-based service-work lower bound; not an ETA', activeRequestSeconds: 60,
      lowerBoundMinutes: expectedRequests / effectiveConcurrency,
      requiredConcurrency20: Math.ceil(expectedRequests / 20), requiredConcurrency30: Math.ceil(expectedRequests / 30),
      excludes: 'Local preparation, token/request quotas, backoff, repairs and longest dependent path. Remote capacity and monetary cost are unknown.' },
    basis: 'Expected requests follow the current admitted next operation: authoring plus fresh verification, or verification only. Local recovery/acquisition and unresolved external facts add no model requests. Explicit revisions count only when their required phases are admitted. Maximum is remaining selected-finding allocation, not a promise of useful work or remote capacity.' };
}
function owedChallenges(jobs, selectedId, requiresChallenge = () => true) {
  return jobs.filter(job => job.id !== selectedId && requiresChallenge(job.id) && !job.publishable &&
    (job.checkpoint?.stage === 'challenge' && !['blocked', 'failed', 'cancelled'].includes(job.state) ||
      job.state === 'running' && job.stage === 'generate')).length;
}
module.exports = { capacity, plan, phases, owedChallenges, MAX_CONCURRENCY, DEFAULT_ATTEMPTS };
