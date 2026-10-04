'use strict';
// Durable, source-only report work. No board/webview owns these jobs. Accepted
// investigations remain private until one compatible manifest is published.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const p = require('./protocol'), store = require('./store'), reports = require('./report');
const engine = require('./investigation-engine'), policy = require('./guide-policy');
const FILE = '.flowboard/report-preparation.json';
const LOCK = '.flowboard/report-preparation.lock.json';
const VERSION = 1, now = () => new Date().toISOString();
const hash = engine.hash;
const checked = draft => !!draft && draft.phase === 'ready' && draft.publication?.digest === policy.digest(draft) && policy.gate(draft).ready;
function reconcile(root) {
  const report = store.readReport(root);
  let original = report.originalReport;
  if (typeof original !== 'string') {
    if (!report.reportName || path.basename(report.reportName) !== report.reportName) throw new Error('The original imported report is unavailable. Import that report again; saved reviews are preserved.');
    const file = path.join(root, report.reportName);
    if (!p.contained(fs.realpathSync(root), fs.realpathSync(file))) throw new Error('The report is outside this project. Import the original file again.');
    original = fs.readFileSync(file, 'utf8');
    if (hash(original) !== report.reportHash) throw new Error('The report file changed since import. Import the updated report; old researcher records will be preserved.');
  }
  if (hash(original) !== report.reportHash) throw new Error('The imported report text does not match its identity. Import the report again.');
  const parsed = reports.parseReport(original, { manifest: true });
  const prefix = report.reportNamespace || '';
  const entries = parsed.issues.map(item => ({ ...item, id: prefix + item.id }));
  const removed = report.issues.filter(item => !entries.some(candidate => candidate.id === item.id && candidate.title === item.title));
  const issues = entries.map(item => {
    const old = report.issues.find(value => value.id === item.id && value.title === item.title);
    return { ...(old || {}), id: item.id, displayId: item.displayId, title: item.title, reportText: item.body, reportSpan: item.reportSpan,
      severity: item.fields.severity || 'Unspecified', ...(old ? {} : { status: 'unreviewed', mappingPending: true, request: null, warnings: item.warnings, unresolved: [] }) };
  });
  const reconciliation = { ...parsed.manifest, policy: 'headings-v2', removedEntries: removed.map(item => ({ id: item.id, title: item.title,
    reason: 'The original section is grouping/context, not a separate finding. Its saved draft and board were retained.' })) };
  if (!report.originalReport || report.reconciliation?.policy !== 'headings-v2' || JSON.stringify(issues.map(item => [item.id, item.reportText])) !== JSON.stringify(report.issues.map(item => [item.id, item.reportText]))) {
    p.atomicJson(root, `.flowboard/recovery/report-before-reconciliation-${crypto.randomUUID()}.json`, report);
    Object.assign(report, { originalReport: original, issues, reconciliation });
    p.atomicJson(root, '.flowboard/report.json', report);
  }
  return { report, entries, reconciliation };
}
class ReportPreparation {
  constructor(root, options) {
    this.root = root; this.options = options; this.owner = crypto.randomUUID(); this.epoch = 0; this.disposed = false;
    this.state = null; this.active = null; this.tasks = new Map(); this.loop = null; this.pendingRestart = false; this.pendingRetry = false;
  }
  save() { clearTimeout(this.progressTimer); this.progressTimer = null; this.state.updatedAt = now(); p.atomicJson(this.root, FILE, this.state);
    Promise.resolve().then(() => this.options.changed?.(this.status())).catch(error => this.options.log?.(`Report display update: ${error.message}`)); }
  progress() { if (!this.progressTimer) this.progressTimer = setTimeout(() => { if (!this.disposed) this.save(); }, 250); }
  status() {
    if (!this.state) return null;
    const jobs = Object.values(this.state.jobs), counts = {};
    for (const job of jobs) counts[job.state] = (counts[job.state] || 0) + 1;
    return { version: VERSION, reportName: this.state.reportName, reportHash: this.state.reportHash, project: this.state.project,
      total: jobs.length, ready: jobs.filter(job => job.publishable).length, counts, ambiguities: this.state.ambiguities.length,
      published: !!this.state.publication, mode: this.state.mode, reason: this.state.reason || '', startedAt: this.state.startedAt,
      requests: this.state.resources.requests, requestLimit: this.state.resources.limit, costUSD: this.state.resources.costUSD,
      plan: this.state.plan && { ...this.state.plan, remainingAllowance: this.state.resources.limit - this.state.resources.requests }, concurrency: this.state.concurrency,
      active: jobs.filter(job => job.state === 'running').map(({ id, stage, startedAt, progress, lastUsefulActivity }) => ({ id, stage, startedAt, progress, lastUsefulActivity })),
      stopped: jobs.filter(job => ['failed', 'blocked', 'cancelled', 'paused'].includes(job.state))
        .sort((a, b) => ['failed', 'blocked', 'cancelled', 'paused'].indexOf(a.state) - ['failed', 'blocked', 'cancelled', 'paused'].indexOf(b.state))
        .slice(0, 8).map(({ id, state, reason, stage }) => ({ id, state, reason, stage })) };
  }
  lock() {
    const file = path.join(this.root, LOCK); fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ owner: this.owner, pid: process.pid, at: now() })); fs.closeSync(fd); this.locked = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = p.readWorkspaceJson(this.root, LOCK, 4096);
      try { process.kill(prior.pid, 0); } catch (probe) {
        if (probe.code === 'ESRCH') { fs.unlinkSync(file); return this.lock(); } throw probe;
      }
      throw new Error(`Report preparation is already owned by another local host (PID ${prior.pid}).`);
    }
  }
  unlock() {
    if (!this.locked) return;
    try { if (p.readWorkspaceJson(this.root, LOCK, 4096).owner === this.owner) fs.unlinkSync(path.join(this.root, LOCK)); } catch { /* owner already released */ }
    this.locked = false;
  }
  async ensure({ retry = false } = {}) {
    if (this.loop) { if (retry || this.state?.mode === 'interrupted') this.pendingRestart = true; this.pendingRetry ||= retry; return this.loop; }
    if (this.disposed) return;
    // Even a missed watcher event must revoke a ready report on reopening.
    // The catalog provider reconciles content once for this generation; no
    // per-finding scan is required. Reuse is checked below under the report lock.
    this.loop = this.run(retry).catch(error => {
      if (this.state) { this.state.mode = 'paused'; this.state.reason = error.message; this.state.publication = null; this.save(); }
      this.options.log?.(`Report preparation stopped: ${error.message}`);
    }).finally(() => { this.unlock(); this.loop = null; if (this.pendingRestart && !this.disposed) {
      const again = this.pendingRetry; this.pendingRestart = false; this.pendingRetry = false; return this.ensure({ retry: again });
    } });
    return this.loop;
  }
  async run(retry) {
    this.lock();
    const { report, entries, reconciliation } = reconcile(this.root);
    const project = hash(fs.realpathSync(this.root)), identity = hash([VERSION, policy.POLICY, project, report.reportHash, entries.map(item => [item.id, item.title, item.body])]);
    if (!retry && this.state?.publication && this.state.mode === 'completed' && this.state.identity === identity && !this.options.dirty?.()) {
      this.indexAbort = new AbortController(); const reuseEpoch = this.epoch;
      const catalog = await this.options.catalog(this.indexAbort.signal);
      const generation = require('./workspace-snapshot').validate(catalog, { force: true });
      if (reuseEpoch === this.epoch && generation.key === this.reconciledKey) return this.status();
    }
    let old;
    try { old = p.readWorkspaceJson(this.root, FILE, 8 * 1024 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (old && old.identity !== identity) p.atomicJson(this.root, `.flowboard/recovery/preparation-${old.identity}.json`, old);
    const config = this.options.configuration();
    const concurrency = Math.max(1, Math.min(4, Number.isInteger(config.workers) ? config.workers : 2));
    if (config.executable && !path.isAbsolute(config.executable)) throw new Error('The configured model CLI path must be absolute, without shell arguments.');
    this.state = old?.identity === identity ? old : { version: VERSION, identity, project, reportHash: report.reportHash, reportName: report.reportName,
      startedAt: old?.reportHash === report.reportHash ? old.startedAt : now(), mode: 'running', jobs: {}, publication: null,
      resources: old?.reportHash === report.reportHash ? old.resources : { requests: 0, limit: Math.max(1, Math.min(10000, config.requestLimit || 12)), costUSD: null } };
    // A manifest from another host is a candidate, never current publication
    // before this host revalidates report, saved source and all artifacts.
    this.state.publication = null;
    this.state.resources.receipts ||= {};
    this.state.concurrency = { configured: concurrency, achieved: 0 };
    this.state.ambiguities = reconciliation.ambiguities;
    for (const entry of entries) {
      const job = this.state.jobs[entry.id] ||= { id: entry.id, state: 'queued', attempt: 0, requests: 0, publishable: false, outcome: null };
      job.requestLimit ||= config.findingRequestLimit || 6;
      if (job.state === 'running') { job.state = 'queued'; job.interruptedAt = now(); job.reason = 'The previous host stopped. Resume from the last valid checkpoint.'; }
      if (retry && !job.publishable) { job.state = 'queued'; job.requestLimit = job.requests + (config.findingRequestLimit || 6); delete job.reason; }
    }
    if (retry) { this.state.mode = 'running'; this.state.reason = ''; this.state.resources.limit = Math.max(this.state.resources.limit, this.state.resources.requests + Math.max(1, config.requestLimit || 12)); }
    this.save();
    if (['paused', 'cancelled'].includes(this.state.mode) && !retry) return;
    if (!['codex', 'claude'].includes(config.provider)) {
      this.state.mode = 'paused'; this.state.reason = 'Choose an authenticated provider in workspace settings. Code and the original report remain available.'; this.save(); return;
    }
    const epoch = this.epoch;
    this.indexAbort = new AbortController();
    const catalog = await this.options.catalog(this.indexAbort.signal);
    if (epoch !== this.epoch || this.disposed) return;
    require('./workspace-snapshot').validate(catalog, { force: true });
    // Recheck the complete manifest before reuse, including working-tree
    // changes, imported report text, local documentation and configuration.
    for (const entry of entries) {
      const job = this.state.jobs[entry.id];
      if (!job.snapshot) continue;
      const request = this.request(entry, catalog, report);
      const saved = engine.read(this.root, entry.id);
      if (!saved || !engine.revalidate(saved, catalog, request, this.issue(entry))) {
        job.state = 'queued'; job.publishable = false; job.outcome = null; this.state.publication = null;
      } else if (job.publishable && !checked(saved)) {
        job.state = 'queued'; job.publishable = false;
      } else if (checked(saved)) {
        Object.assign(job, { state: 'completed', publishable: true, digest: policy.digest(saved), snapshot: saved.snapshot, outcome: saved.causal.outcome });
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    this.state.mode = 'running'; this.save();
    const priority = (this.options.firstFinding || '').split(',').filter(Boolean);
    const ordered = priority.length ? [...priority.flatMap(id => entries.filter(entry => entry.id === id)), ...entries.filter(entry => !priority.includes(entry.id))] : entries;
    const queue = ordered.filter(entry => ['queued', 'retry-scheduled'].includes(this.state.jobs[entry.id].state));
    const estimatedRequests = queue.reduce((n, entry) => n + (this.state.jobs[entry.id].checkpoint?.stage === 'challenge' ? 1 : 2), 0);
    this.state.plan = { eligible: queue.length, estimatedRequests, remainingAllowance: this.state.resources.limit - this.state.resources.requests,
      basis: 'One generation and one challenge for each cold finding, one challenge for a reusable draft; repairs may need more. This is an estimate, not a completion guarantee.' };
    this.save();
    // Alternate untouched work with durable continuations. Appending every
    // challenge behind a large cold manifest prevents any useful result within
    // a small allowance; running only continuations can starve untouched work.
    const freshQueue = queue.filter(entry => this.state.jobs[entry.id].checkpoint?.stage !== 'challenge');
    const continuedQueue = queue.filter(entry => this.state.jobs[entry.id].checkpoint?.stage === 'challenge');
    const retryQueue = [];
    let preferContinuation = true;
    const next = () => {
      let entry;
      if (continuedQueue.length && (preferContinuation || !freshQueue.length)) { entry = continuedQueue.shift(); preferContinuation = false; }
      else if (freshQueue.length) { entry = freshQueue.shift(); preferContinuation = true; }
      else entry = retryQueue.shift();
      return entry;
    };
    const worker = async () => {
      while ((freshQueue.length || continuedQueue.length || retryQueue.length) && !this.disposed && epoch === this.epoch && this.state.mode === 'running') {
        if (this.state.resources.requests >= this.state.resources.limit) { this.pauseForBudget(); break; }
        const entry = next(), job = this.state.jobs[entry.id];
        if (!['queued', 'retry-scheduled'].includes(job.state)) continue;
        try { await this.work(entry, catalog, report, job, epoch, config); }
        catch (error) {
          if (epoch === this.epoch) { Object.assign(job, { state: 'failed', publishable: false, reason: error.message, finishedAt: now() }); this.save(); }
        }
        if (job.state === 'queued') continuedQueue.push(entry);
        else if (job.state === 'retry-scheduled') retryQueue.push(entry);
        await new Promise(resolve => setImmediate(resolve));
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: concurrency }, worker));
    const crashed = workers.find(result => result.status === 'rejected');
    if (crashed) throw crashed.reason; // do not release the report lock while another worker lives
    if (epoch !== this.epoch || this.disposed) return;
    const jobs = Object.values(this.state.jobs);
    if (jobs.length && !this.state.ambiguities.length && jobs.every(job => job.publishable && job.state === 'completed')) {
      require('./workspace-snapshot').validate(catalog, { force: true });
      if (store.readReport(this.root).reportHash !== this.state.reportHash) throw new Error('The report changed before publication.');
      for (const entry of entries) {
        const draft = engine.read(this.root, entry.id);
        if (!checked(draft) || !engine.sameSnapshot(draft.snapshot, engine.snapshot(catalog, this.request(entry, catalog, report), this.issue(entry)))) throw new Error(`The saved ${entry.id} explanation changed before publication.`);
      }
      this.state.publication = { id: crypto.randomUUID(), identity, at: now(), artifacts: Object.fromEntries(jobs.map(job => [job.id, job.digest])) };
      this.reconciledKey = require('./workspace-snapshot').validate(catalog).key;
    }
    if (this.state.mode === 'running') this.state.mode = this.state.publication ? 'completed' : 'incomplete';
    this.save();
  }
  issue(entry) { return { ...entry, reportText: entry.body }; }
  request(entry, catalog, report) {
    const mapped = reports.draftIssue(entry, this.root, catalog.runner, catalog.result, report.sourceRevision, catalog);
    if (mapped.request) return mapped.request;
    // A missing mapping is a real preparation blocker, not a reason to omit a
    // manifest entry. The engine's applicability check supplies the exact gap.
    return { findingId: entry.id, finding: { title: `${entry.displayId}: ${entry.title}`.slice(0, 250), summary: entry.body.slice(0, 4000), status: 'unreviewed' }, cards: [], connections: [] };
  }
  pauseForBudget() {
    this.state.mode = 'paused'; this.state.reason = `Report request budget reached (${this.state.resources.requests}/${this.state.resources.limit}). Resume adds another configured allowance; saved checks are reused.`;
    for (const job of Object.values(this.state.jobs)) if (job.state === 'queued') { job.state = 'paused'; job.reason = 'Waiting for report request budget.'; }
    this.save();
  }
  async work(entry, catalog, report, job, epoch, config) {
    const issue = this.issue(entry), request = this.request(entry, catalog, report);
    const fresh = engine.create({ findingId: entry.id, request, issue, catalog });
    let draft = engine.read(this.root, entry.id);
    if (draft && !engine.revalidate(draft, catalog, request, issue)) { engine.archive(this.root, draft); fresh.storageRevision = draft.revision; fresh.revision = draft.revision + 1; fresh.corrections = draft.corrections; draft = fresh; }
    draft ||= fresh;
    if (checked(draft)) { engine.validateCurrent(catalog, draft); Object.assign(job, { state: 'completed', publishable: true, digest: policy.digest(draft), snapshot: draft.snapshot, outcome: draft.causal.outcome }); this.save(); return; }
    const abort = new AbortController(); this.active = { abort, id: entry.id }; this.tasks.set(entry.id, this.active);
    this.state.concurrency.achieved = Math.max(this.state.concurrency.achieved, this.tasks.size);
    const attemptId = crypto.randomUUID();
    Object.assign(job, { state: 'running', stage: draft.checkpoint?.stage || 'locating-code', attempt: job.attempt + 1, attemptId, owner: this.owner, startedAt: now(), snapshot: fresh.snapshot, publishable: false }); this.save();
    const owns = () => epoch === this.epoch && this.state.jobs[entry.id]?.attemptId === attemptId;
    const current = () => !this.disposed && owns() && !abort.signal.aborted && p.readWorkspaceJson(this.root, '.flowboard/report.json', 12 * 1024 * 1024).reportHash === report.reportHash && !this.options.dirty?.();
    try {
      draft = await engine.advance({ root: this.root, catalog, request, issue, findingId: entry.id, draft,
        provider: config.provider, executable: config.executable, budget: config.budget, signal: abort.signal, current, invoke: this.options.invoke, yieldAfterStage: true,
        beforeRequest: async data => {
          if (this.state.mode !== 'running') throw Object.assign(new Error('Paused after the current request. Resume will reuse the accepted stage.'), { code: 'REPORT_PAUSED' });
          if (!current()) throw Object.assign(new Error('Preparation inputs changed before dispatch.'), { code: 'INVESTIGATION_SUPERSEDED' });
          if (this.state.resources.requests >= this.state.resources.limit) throw Object.assign(new Error(`Report request allowance exhausted (${this.state.resources.requests}/${this.state.resources.limit}). Accepted stages are saved.`), { code: 'REPORT_BUDGET' });
          if (job.requests >= job.requestLimit) throw Object.assign(new Error(`Finding ${job.id} request allowance exhausted (${job.requests}/${job.requestLimit}). Other findings may continue.`), { code: 'FINDING_BUDGET' });
          this.state.resources.requests++; job.requests++; job.stage = data.phase; job.inputBytes = data.inputBytes;
          job.lastReservation = { id: `${attemptId}:${job.requests}`, phase: data.phase, at: now(), inputBytes: data.inputBytes };
          this.state.resources.receipts[job.lastReservation.id] = { ...job.lastReservation, findingId: job.id, outcome: 'reserved', costUSD: null };
          this.save();
          return structuredClone(job.lastReservation);
        },
        onProgress: progress => { if (this.disposed || !owns() || abort.signal.aborted) return; job.progress = progress; job.lastUsefulActivity = now(); this.progress(); },
        onResult: (audit, reservation) => {
          if (!reservation || this.state.reportHash !== report.reportHash || this.state.resources.receipts[reservation.id]?.finishedAt) return;
          this.state.resources.receipts[reservation.id] = { ...reservation, findingId: job.id, finishedAt: now(), outcome: audit.outcome,
            costUSD: Number.isFinite(audit.costUSD) ? audit.costUSD : null, outputBytes: audit.outputBytes ?? null, usage: audit.usage || null,
            elapsedMs: audit.startedAt && audit.finishedAt ? Date.parse(audit.finishedAt) - Date.parse(audit.startedAt) : null };
          const receipts = Object.values(this.state.resources.receipts);
          this.state.resources.costUSD = receipts.length === this.state.resources.requests && receipts.every(item => item.costUSD !== null) ? receipts.reduce((n, item) => n + item.costUSD, 0) : null;
          this.save();
        },
        publish: async value => { if (!current()) return; job.stage = value.phase; job.checkpoint = value.checkpoint || null; job.revision = value.revision; this.save(); }
      });
      if (!current()) return;
      Object.assign(job, { state: checked(draft) ? 'completed' : draft.yielded ? 'queued' : draft.failureKind === 'provider' || draft.failureKind === 'validation' || draft.failureKind === 'structural' ? 'failed' : ['report-budget', 'finding-budget', 'paused'].includes(draft.failureKind) ? 'paused' : 'blocked',
        outcome: checked(draft) ? draft.causal.outcome : 'inconclusive', reason: draft.error || 'The explanation still needs material evidence.',
        publishable: checked(draft), digest: checked(draft) ? policy.digest(draft) : null, checkpoint: draft.checkpoint || null,
        finishedAt: now(), elapsedMs: Date.now() - Date.parse(job.startedAt), runs: draft.runs.slice(-12) });
      if (draft.failureKind === 'provider' && (job.providerFailures = (job.providerFailures || 0) + 1) < 2 && job.requests < job.requestLimit && this.state.mode === 'running') job.state = 'retry-scheduled';
      this.save();
      if (draft.failureKind === 'report-budget') this.pauseForBudget();
    } catch (error) { if (current()) { Object.assign(job, { state: 'failed', outcome: 'inconclusive', reason: error.message, finishedAt: now() }); this.save(); } }
    finally {
      // No silent return (dirty input, abort or late response) may orphan a job.
      if (owns() && job.state === 'running') {
        Object.assign(job, { state: 'paused', publishable: false, finishedAt: now(),
          reason: this.options.dirty?.() ? 'Relevant unsaved edits paused this finding. Save them before resuming.' : 'This attempt stopped before completing its stage. Accepted work is saved.' });
        this.save();
      }
      if (this.tasks.get(entry.id)?.abort === abort) this.tasks.delete(entry.id);
      if (this.active?.id === entry.id) this.active = this.tasks.values().next().value || null;
    }
  }
  published(draft) { return !!draft && !!this.state?.publication && this.state.publication.identity === this.state.identity && this.state.publication.artifacts[draft.findingId] === policy.digest(draft) && checked(draft); }
  async control(action) {
    if (action === 'resume' || action === 'retry') return this.ensure({ retry: true });
    if (!this.state) return;
    if (!['pause', 'cancel'].includes(action)) throw new Error('Unknown report preparation action.');
    this.state.mode = action === 'pause' ? 'paused' : 'cancelled'; this.state.publication = null;
    this.state.reason = action === 'pause' ? 'Paused. A request already running may finish; no new request will start. Accepted stages are saved.' : 'Cancelled. Accepted stages and researcher work are saved.';
    if (action === 'cancel') { for (const task of this.tasks.values()) task.abort.abort(); this.indexAbort?.abort(); this.epoch++; }
    for (const job of Object.values(this.state.jobs)) if (['queued', 'retry-scheduled', ...(action === 'cancel' ? ['running'] : [])].includes(job.state)) job.state = action === 'pause' ? 'paused' : 'cancelled';
    this.save();
  }
  invalidate(reason) {
    if (!this.state) return;
    for (const task of this.tasks.values()) task.abort.abort(); this.indexAbort?.abort(); this.epoch++; this.state.publication = null; this.state.mode = 'interrupted'; this.state.reason = reason;
    for (const job of Object.values(this.state.jobs)) { job.publishable = false; job.state = 'queued'; }
    this.save();
  }
  dispose() { this.disposed = true; clearTimeout(this.progressTimer); for (const task of this.tasks.values()) task.abort.abort(); this.indexAbort?.abort(); if (this.state) {
    for (const job of Object.values(this.state.jobs)) if (job.state === 'running') job.state = 'queued';
    try { this.save(); } catch (error) { if (error.code !== 'ENOENT') this.options.log?.(`Could not checkpoint host shutdown: ${error.message}`); }
  } }
}
module.exports = { ReportPreparation, reconcile, FILE, checked };
