'use strict';
// Finite local planning, NOT provider quota discovery or a measured ETA.
const MAX_CONCURRENCY = 32, DEFAULT_ATTEMPTS = 6, DEADLINE_MS = 30 * 60 * 1000;
const capacity = value => Math.max(1, Math.min(MAX_CONCURRENCY, Number.isInteger(value) ? value : 2));
function plan(jobs, resources, workers, providerCapacity) {
  const unfinished = jobs.filter(job => !job.publishable);
  const expectedRequests = unfinished.reduce((n, job) => n + (job.checkpoint?.stage === 'challenge' ? 1 : 2), 0);
  const maximumRequests = unfinished.reduce((n, job) => n + Math.max(0, job.requestLimit - job.requests), 0);
  const effectiveConcurrency = Math.min(capacity(workers), capacity(providerCapacity));
  return { eligible: unfinished.length, estimatedRequests: expectedRequests, expectedRequests, maximumRequests,
    remainingAllowance: Math.max(0, resources.limit - resources.requests), effectiveConcurrency,
    // Explicit one-minute assumption; no compatibility claim about old receipts.
    scenario: { label: 'Assumption-based service-work lower bound; not an ETA', activeRequestSeconds: 60,
      lowerBoundMinutes: expectedRequests / effectiveConcurrency,
      requiredConcurrency20: Math.ceil(expectedRequests / 20), requiredConcurrency30: Math.ceil(expectedRequests / 30),
      excludes: 'Local preparation, token/request quotas, backoff, repairs and longest dependent path. Remote capacity and monetary cost are unknown.' },
    basis: 'Expected: generation + mandatory challenge, or one saved-stage challenge. Maximum: bounded remaining finding attempts, including one response repair across the retained generation/challenge checkpoint and at most two new-source follow-ups; a transport retry also consumes allowance.' };
}
function owedChallenges(jobs, selectedId) {
  return jobs.filter(job => job.id !== selectedId && !job.publishable &&
    (job.checkpoint?.stage === 'challenge' && !['blocked', 'failed', 'cancelled'].includes(job.state) ||
      job.state === 'running' && job.stage === 'generate')).length;
}
module.exports = { capacity, plan, owedChallenges, MAX_CONCURRENCY, DEFAULT_ATTEMPTS, DEADLINE_MS };
