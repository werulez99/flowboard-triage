'use strict';
// Durable, source-only report work. No board/webview owns these jobs. Accepted
// Each accepted investigation is published atomically after its own checks.
// Report completion is aggregate progress, never permission to read a guide.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const p = require('./protocol'), store = require('./store'), reports = require('./report');
const engine = require('./investigation-engine'), policy = require('./guide-policy');
const FILE = '.flowboard/report-preparation.json';
const LOCK = '.flowboard/report-preparation.lock.json';
const VERSION = 2, now = () => new Date().toISOString();
const hash = engine.hash;
const checked = draft => !!draft && draft.phase === 'ready' && draft.publication?.policy === policy.POLICY && draft.publication?.digest === policy.digest(draft) && policy.gate(draft).ready;
const entryHash = entry => hash([entry.id, entry.title, entry.body]);
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
  const entries = parsed.issues.map(item => {
    const savedId = report.issueIdentities?.[item.id];
    const match = savedId && report.issues.find(old => old.id === savedId && old.displayId === item.displayId && old.title === item.title && old.reportText === item.body);
    const id = match ? savedId : prefix + item.id; p.identifier(id, 'reconciled finding ID');
    return { ...item, id };
  });
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
    this.accepted = new Map(); this.requests = new WeakMap(); this.dispatched = new Set();
  }
  prioritize(id) {
    // Selection can reorder eligible work, but never starts a request, resumes
    // a paused report, or interrupts another finding's accepted stage.
    if (typeof id !== 'string' || id === this.preferredFinding) return;
    this.preferredFinding = id; this.priorityStages = 2;
  }
  save() { clearTimeout(this.progressTimer); this.progressTimer = null; this.aggregate(); this.state.updatedAt = now(); p.atomicJson(this.root, FILE, this.state);
    Promise.resolve().then(() => this.options.changed?.(this.status())).catch(error => this.options.log?.(`Report display update: ${error.message}`)); }
  progress() { if (!this.progressTimer) this.progressTimer = setTimeout(() => { if (!this.disposed) this.save(); }, 250); }
  status() {
    if (!this.state) return null;
    const jobs = Object.values(this.state.jobs), counts = {};
    for (const job of jobs) counts[job.state] = (counts[job.state] || 0) + 1;
    return { version: VERSION, reportName: this.state.reportName, reportHash: this.state.reportHash, project: this.state.project,
      total: jobs.length, ready: jobs.filter(job => this.artifact(job.id)).length, counts, ambiguities: this.state.ambiguities.length,
      published: !!this.state.publication, mode: this.state.mode, reason: this.state.reason || '', startedAt: this.state.startedAt,
      requests: this.state.resources.requests, requestLimit: this.state.resources.limit, costUSD: this.state.resources.costUSD,
      plan: this.state.plan && { ...this.state.plan, remainingAllowance: this.state.resources.limit - this.state.resources.requests },
      concurrency: { ...this.state.concurrency, dispatched: this.dispatched.size, workers: this.tasks.size,
        waiting: jobs.filter(job => job.state === 'waiting-for-provider-capacity').length },
      jobs: jobs.map(({ id, state, stage, reason, digest, outcome, publishedAt }) => ({ id, state, stage, reason,
        publishable: !!this.artifact(id), digest: this.artifact(id), outcome, publishedAt })),
      active: jobs.filter(job => ['running', 'waiting-for-provider-capacity'].includes(job.state)).map(({ id, state, stage, startedAt, progress, lastUsefulActivity }) => ({ id, state, stage, startedAt, progress, lastUsefulActivity })),
      stopped: jobs.filter(job => ['failed', 'blocked', 'cancelled', 'paused'].includes(job.state))
        .sort((a, b) => ['failed', 'blocked', 'cancelled', 'paused'].indexOf(a.state) - ['failed', 'blocked', 'cancelled', 'paused'].indexOf(b.state))
        .slice(0, 8).map(({ id, state, reason, stage }) => ({ id, state, reason, stage })) };
  }
  aggregate() {
    if (!this.state) return;
    const jobs = Object.values(this.state.jobs);
    const complete = jobs.length > 0 && !this.state.ambiguities?.length && jobs.every(job => this.artifact(job.id));
    // Retain this legacy aggregate for metrics, not as a reading gate.
    this.state.publication = complete ? { id: this.state.publication?.id || crypto.randomUUID(), identity: this.state.identity,
      at: this.state.publication?.at || now(), artifacts: Object.fromEntries(jobs.map(job => [job.id, this.accepted.get(job.id).digest])) } : null;
  }
  accept(entry, draft, job) {
    if (this.options.dirty?.(entry.id)) { this.withholdDirty(job); return; }
    const digest = policy.digest(draft), at = job.accepted?.digest === digest ? job.accepted.at : now();
    const accepted = { digest, at, policy: policy.POLICY, project: this.state.project, findingHash: entryHash(entry),
      generation: draft.revision, sourceSnapshot: draft.snapshot, dependencies: draft.dependencies || null };
    Object.assign(job, { state: 'completed', stage: 'ready', publishable: true, digest, snapshot: draft.snapshot, outcome: draft.causal.outcome,
      findingHash: entryHash(entry), accepted, publishedAt: at, reason: '' });
    this.accepted.set(entry.id, accepted);
  }
  artifact(id) { return this.options.dirty?.(id) ? null : this.accepted.get(id)?.digest || null; }
  recordFailure(job, error) {
    this.accepted.delete(job.id);
    Object.assign(job, { state: 'failed', publishable: false, accepted: null, digest: null,
      stage: 'saved-record', reason: `Cannot restore this finding's saved record: ${error.message} Original files were preserved. Inspect or recover this finding's local record, then retry.`, finishedAt: now() });
  }
  withholdDirty(job) {
    this.accepted.delete(job.id);
    Object.assign(job, { state: 'paused', publishable: false, dirtyPaused: true,
      reason: 'Relevant unsaved edits paused this finding. Save them before resuming.' });
  }
  async validatedCatalog(signal) {
    try {
      const catalog = await this.options.catalog(signal);
      require('./workspace-snapshot').validate(catalog, { force: true });
      return catalog;
    } catch (error) {
      if (signal?.aborted || this.disposed) throw error;
      // A missed content change or unavailable index cannot retain a ready
      // badge on reopening. This is source validation, not provider failure.
      this.accepted.clear();
      for (const job of Object.values(this.state?.jobs || {})) if (job.publishable) {
        job.publishable = false; job.state = 'stale'; job.reason = error.message;
      }
      throw error;
    }
  }
  lock() {
    const file = path.join(this.root, LOCK); fs.mkdirSync(path.dirname(file), { recursive: true });
    const ownership = require('./provider-ownership');
    for (let attempt = 0; attempt < 3; attempt++) try {
      ownership.publish(file, ownership.ownerMetadata(this.owner)); this.locked = true; return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = ownership.reap(file);
      if (prior) throw new Error(`Report preparation is already owned by another local host (PID ${prior.entry?.pid || 'unknown'}).`);
    }
    throw new Error('Report ownership changed repeatedly. No work was dispatched; retry when the other host has stopped.');
  }
  unlock() {
    if (!this.locked) return;
    try { require('./provider-ownership').removeOwned(path.join(this.root, LOCK), this.owner); } catch { /* owner already released; an existing live lock remains protective */ }
    this.locked = false;
  }
  async ensure({ retry = false } = {}) {
    if (this.loop) { if (retry || this.state?.mode === 'interrupted') this.pendingRestart = true; this.pendingRetry ||= retry; return this.loop; }
    if (this.disposed) return;
    // Even a missed watcher event must revoke a ready report on reopening.
    // The catalog provider reconciles content once for this generation; no
    // per-finding scan is required. Reuse is checked below under the report lock.
    const runEpoch = this.epoch;
    this.loop = this.run(retry).catch(error => {
      if (this.disposed || runEpoch !== this.epoch) return;
      if (this.state && this.locked) { this.state.mode = 'paused'; this.state.reason = error.message; this.save(); }
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
      const catalog = await this.validatedCatalog(this.indexAbort.signal);
      const generation = require('./workspace-snapshot').validate(catalog);
      const loaded = new Map(report.issues.map(issue => [issue.id, issue.request]));
      const sameInputs = entries.every(entry => !this.options.dirty?.(entry.id) && this.accepted.get(entry.id)?.sourceSnapshot.reportHash ===
        engine.findingInputHash(loaded.get(entry.id) || this.request(entry, catalog, report), this.issue(entry)));
      if (reuseEpoch === this.epoch && generation.key === this.reconciledKey && sameInputs) return this.status();
    }
    let old;
    try { old = p.readWorkspaceJson(this.root, FILE, 8 * 1024 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (old && old.identity !== identity) p.atomicJson(this.root, `.flowboard/recovery/preparation-${old.identity}.json`, old);
    const config = this.options.configuration();
    const concurrency = Math.max(1, Math.min(4, Number.isInteger(config.workers) ? config.workers : 2));
    if (config.executable && !path.isAbsolute(config.executable)) throw new Error('The configured model CLI path must be absolute, without shell arguments.');
    const sameProject = old?.project === project;
    this.state = old?.identity === identity ? old : { version: VERSION, identity, project, reportHash: report.reportHash, reportName: report.reportName,
      startedAt: sameProject ? old.startedAt : now(), mode: sameProject && ['paused', 'cancelled'].includes(old.mode) ? old.mode : 'running',
      jobs: sameProject ? old.jobs : {}, publication: null,
      resources: sameProject ? old.resources : { requests: 0, limit: Math.max(1, Math.min(10000, config.requestLimit || 12)), costUSD: null } };
    this.state.version = VERSION;
    const currentIds = new Set(entries.map(entry => entry.id));
    for (const id of Object.keys(this.state.jobs)) if (!currentIds.has(id)) { delete this.state.jobs[id]; this.accepted.delete(id); }
    this.state.resources.receipts ||= {};
    this.state.concurrency = { configured: concurrency, achieved: 0 };
    this.state.ambiguities = reconciliation.ambiguities;
    for (const entry of entries) {
      const job = this.state.jobs[entry.id] ||= { id: entry.id, state: 'queued', attempt: 0, requests: 0, publishable: false, outcome: null };
      if (job.findingHash && job.findingHash !== entryHash(entry)) {
        Object.assign(job, { state: 'queued', publishable: false, accepted: null, digest: null, outcome: null }); this.accepted.delete(entry.id);
      }
      job.findingHash = entryHash(entry);
      job.requestLimit ||= config.findingRequestLimit || 6;
      if (job.dirtyPaused && !this.options.dirty?.(entry.id)) { job.state = 'queued'; delete job.dirtyPaused; delete job.reason; }
      if (['running', 'waiting-for-provider-capacity'].includes(job.state)) { job.state = 'queued'; job.interruptedAt = now(); job.reason = 'The previous host stopped. Resume from the last valid checkpoint.'; }
      if (retry && !job.publishable) { job.state = 'queued'; job.requestLimit = job.requests + (config.findingRequestLimit || 6); delete job.reason; }
    }
    if (retry) { this.state.mode = 'running'; this.state.reason = ''; this.state.resources.limit = Math.max(this.state.resources.limit, this.state.resources.requests + Math.max(1, config.requestLimit || 12)); }
    if (retry && ['codex', 'claude'].includes(config.provider) && (!this.options.invoke || this.options.invoke.isProviderTransport))
      await require('./provider-health').reset(config.provider, { ...this.options.providerResources, executable: config.executable });
    this.save();
    // Disabled providers must not make ordinary import eagerly index code.
    // Existing private/accepted artifacts still take the local revalidation
    // path below, including migration while report work is paused.
    if (!['codex', 'claude'].includes(config.provider) && !fs.existsSync(path.join(this.root, '.flowboard/investigations'))) {
      this.state.mode = 'paused'; this.state.reason = 'Choose an authenticated provider to prepare walkthroughs. The report and code remain available.'; this.save(); return;
    }
    const epoch = this.epoch;
    this.indexAbort = new AbortController();
    const catalog = await this.validatedCatalog(this.indexAbort.signal);
    if (epoch !== this.epoch || this.disposed) return;
    // Recheck the complete manifest before reuse, including working-tree
    // changes, imported report text, local documentation and configuration.
    for (const entry of entries) {
      const job = this.state.jobs[entry.id];
      if (this.options.dirty?.(entry.id)) { this.withholdDirty(job); continue; }
      try {
      const saved = engine.read(this.root, entry.id);
      if (!saved) { this.accepted.delete(entry.id); if (job.publishable) job.state = 'queued'; job.publishable = false; job.accepted = null; continue; }
      const request = this.request(entry, catalog, report);
      if (!engine.revalidate(saved, catalog, request, this.issue(entry))) {
        job.state = 'queued'; job.publishable = false; job.outcome = null; job.accepted = null; this.accepted.delete(entry.id);
      } else if (job.publishable && !checked(saved)) {
        job.state = 'queued'; job.publishable = false; job.accepted = null; this.accepted.delete(entry.id);
      } else if (checked(saved)) {
        this.accept(entry, saved, job);
      } else if (saved.pendingResponse) {
        // A completed transport receipt is already paid. Revalidate/replay it
        // before provider, pause and allowance checks, without authorizing a
        // new request or resuming any sibling's paid work.
        await this.work(entry, catalog, report, job, epoch, config, true);
      }
      } catch (error) { this.recordFailure(job, error); }
      await new Promise(resolve => setImmediate(resolve));
    }
    this.reconciledKey = require('./workspace-snapshot').validate(catalog).key;
    this.save();
    if (['paused', 'cancelled'].includes(this.state.mode) && !retry) return;
    if (!['codex', 'claude'].includes(config.provider)) {
      this.state.mode = 'paused'; this.state.reason = 'Choose an authenticated provider to prepare unfinished findings. Checked walkthroughs and original code remain available.'; this.save(); return;
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
      // A selected cold finding can finish generation and challenge promptly.
      // Limit the promotion to two boundaries so repairs cannot starve the
      // ordinary alternating untouched/continuation queues.
      if (this.priorityStages > 0) for (const queue of [continuedQueue, freshQueue]) {
        const index = queue.findIndex(item => item.id === this.preferredFinding);
        if (index >= 0) { this.priorityStages--; return queue.splice(index, 1)[0]; }
      }
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
        try {
          const draft = engine.read(this.root, entry.id);
          if (!checked(draft) || !engine.sameSnapshot(draft.snapshot, engine.snapshot(catalog, this.request(entry, catalog, report), this.issue(entry)))) throw new Error(`The saved ${entry.id} explanation changed before publication.`);
        } catch (error) { this.recordFailure(this.state.jobs[entry.id], error); }
      }
      this.reconciledKey = require('./workspace-snapshot').validate(catalog).key;
    }
    if (this.state.mode === 'running') this.state.mode = this.state.publication ? 'completed' : 'incomplete';
    this.save();
  }
  issue(entry) { return { ...entry, reportText: entry.body }; }
  request(entry, catalog, report) {
    let cached = this.requests.get(catalog); if (!cached) { cached = new Map(); this.requests.set(catalog, cached); }
    const key = entryHash(entry);
    let request = cached.get(key);
    if (!request) {
      const mapped = reports.draftIssue(entry, this.root, catalog.runner, catalog.result, report.sourceRevision, catalog);
      request = mapped.request;
      if (request) cached.set(key, request);
    }
    // Saved researcher expectations/conditions are real finding inputs. Keep
    // structural discovery cached, but never reuse an old semantic input just
    // because the imported report is unchanged. Human decisions stay separate.
    let saved;
    try { saved = store.selectedDraft(store.readDraft(this.root, entry.id), entry.id); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (request) return saved ? { ...request, finding: { ...request.finding, ...saved.finding } } : request;
    if (saved) return saved;
    // A missing mapping is a real preparation blocker, not a reason to omit a
    // manifest entry. The engine's applicability check supplies the exact gap.
    return { findingId: entry.id, finding: { title: `${entry.displayId}: ${entry.title}`.slice(0, 250), summary: entry.body.slice(0, 4000), status: 'unreviewed' }, cards: [], connections: [] };
  }
  pauseForBudget() {
    this.state.mode = 'paused'; this.state.reason = `Report request budget reached (${this.state.resources.requests}/${this.state.resources.limit}). Resume adds another configured allowance; saved checks are reused.`;
    for (const job of Object.values(this.state.jobs)) if (job.state === 'queued') { job.state = 'paused'; job.reason = 'Waiting for report request budget.'; }
    this.save();
  }
  async work(entry, catalog, report, job, epoch, config, localOnly = false) {
    if (this.options.dirty?.(entry.id)) { this.withholdDirty(job); this.save(); return; }
    const issue = this.issue(entry), request = this.request(entry, catalog, report);
    const fresh = engine.create({ findingId: entry.id, request, issue, catalog });
    let draft = engine.read(this.root, entry.id);
    if (draft && !engine.revalidate(draft, catalog, request, issue)) { engine.archive(this.root, draft); fresh.storageRevision = draft.revision; fresh.revision = draft.revision + 1; fresh.corrections = draft.corrections; draft = fresh; }
    draft ||= fresh;
    if (checked(draft)) { engine.validateCurrent(catalog, draft); this.accept(entry, draft, job); this.save(); return; }
    const abort = new AbortController(); this.active = { abort, id: entry.id }; this.tasks.set(entry.id, this.active);
    const attemptId = crypto.randomUUID();
    Object.assign(job, { state: 'running', stage: draft.checkpoint?.stage || 'locating-code', progress: null,
      attempt: job.attempt + 1, attemptId, owner: this.owner, startedAt: now(), snapshot: fresh.snapshot, publishable: false }); this.save();
    const owns = () => epoch === this.epoch && this.state.jobs[entry.id]?.attemptId === attemptId;
    const current = () => {
      if (this.disposed || !owns() || abort.signal.aborted || this.options.dirty?.(entry.id)) return false;
      try {
        return p.readWorkspaceJson(this.root, '.flowboard/report.json', 12 * 1024 * 1024).reportHash === report.reportHash &&
          engine.findingInputHash(this.request(entry, catalog, report), issue) === fresh.snapshot.reportHash;
      } catch { return false; } // A malformed concurrent edit cannot accept an old scope.
    };
    try {
      draft = await engine.advance({ root: this.root, catalog, request, issue, findingId: entry.id, draft,
        provider: config.provider, executable: config.executable, budget: config.budget, signal: abort.signal, current, invoke: this.options.invoke,
        providerResources: this.options.providerResources, yieldAfterStage: true, localOnly,
        beforeRequest: async data => {
          if (this.state.mode !== 'running') throw Object.assign(new Error('Paused after the current request. Resume will reuse the accepted stage.'), { code: 'REPORT_PAUSED' });
          if (!current()) throw Object.assign(new Error('Preparation inputs changed before dispatch.'), { code: 'INVESTIGATION_SUPERSEDED' });
          if (this.state.resources.requests >= this.state.resources.limit) throw Object.assign(new Error(`Report request allowance exhausted (${this.state.resources.requests}/${this.state.resources.limit}). Accepted stages are saved.`), { code: 'REPORT_BUDGET' });
          if (job.requests >= job.requestLimit) throw Object.assign(new Error(`Finding ${job.id} request allowance exhausted (${job.requests}/${job.requestLimit}). Other findings may continue.`), { code: 'FINDING_BUDGET' });
          this.state.resources.requests++; job.requests++; job.stage = data.phase; job.inputBytes = data.inputBytes; job.state = 'running';
          job.lastReservation = { id: `${attemptId}:${job.requests}`, phase: data.phase, at: now(), inputBytes: data.inputBytes };
          this.state.resources.receipts[job.lastReservation.id] = { ...job.lastReservation, findingId: job.id, outcome: 'reserved', costUSD: null };
          this.dispatched.add(job.lastReservation.id);
          this.state.concurrency.achieved = Math.max(this.state.concurrency.achieved, this.dispatched.size);
          this.save();
          return structuredClone(job.lastReservation);
        },
        onProgress: progress => {
          if (this.disposed || !owns() || abort.signal.aborted) return;
          job.progress = progress;
          if (progress.event === 'provider.capacity.waiting') { job.state = 'waiting-for-provider-capacity'; job.stage = 'waiting-for-provider-capacity'; }
          else if (progress.event === 'provider.capacity.acquired') { job.state = 'running'; job.stage = draft.checkpoint?.stage || 'generating'; }
          // Transport heartbeat and elapsed time are not useful analysis.
          if (progress.useful || progress.firstSubstantiveContentAt || progress.finalStructuredContentAt) job.lastUsefulActivity = progress.at || now();
          this.progress();
        },
        onResult: (audit, reservation) => {
          if (!reservation || this.state.reportHash !== report.reportHash || this.state.resources.receipts[reservation.id]?.finishedAt) return;
          this.state.resources.receipts[reservation.id] = { ...reservation, findingId: job.id, finishedAt: now(), outcome: audit.outcome,
            audit,
            costUSD: Number.isFinite(audit.costUSD) ? audit.costUSD : null, outputBytes: audit.outputBytes ?? null, usage: audit.usage || null,
            elapsedMs: audit.startedAt && audit.finishedAt ? Date.parse(audit.finishedAt) - Date.parse(audit.startedAt) : null };
          const receipts = Object.values(this.state.resources.receipts);
          this.state.resources.costUSD = receipts.length === this.state.resources.requests && receipts.every(item => item.costUSD !== null) ? receipts.reduce((n, item) => n + item.costUSD, 0) : null;
          this.save();
        },
        onAccepted: audit => {
          const receipt = audit.requestId && this.state.resources.receipts[audit.requestId];
          if (receipt) { receipt.hostAcceptedAt = audit.hostAcceptedAt; receipt.audit = audit; job.lastUsefulActivity = audit.hostAcceptedAt; this.save(); }
        },
        onDispatchEnd: reservation => { if (reservation) this.dispatched.delete(reservation.id); },
        publish: async value => { if (!current()) return; job.stage = value.phase; job.checkpoint = value.checkpoint || null; job.revision = value.revision; this.save(); }
      });
      if (!current()) return;
      Object.assign(job, { state: checked(draft) ? 'completed' : draft.yielded ? 'queued' : draft.failureKind === 'provider' || draft.failureKind === 'validation' || draft.failureKind === 'structural' ? 'failed' : ['report-budget', 'finding-budget', 'paused', 'provider-health'].includes(draft.failureKind) ? 'paused' : draft.failureKind === 'capacity' ? 'retry-scheduled' : 'blocked',
        outcome: checked(draft) ? draft.causal.outcome : 'inconclusive', reason: draft.error || 'The explanation still needs material evidence.',
        publishable: checked(draft), digest: checked(draft) ? policy.digest(draft) : null, checkpoint: draft.checkpoint || null,
        finishedAt: now(), elapsedMs: Date.now() - Date.parse(job.startedAt), runs: draft.runs.slice(-12) });
      if (checked(draft)) this.accept(entry, draft, job);
      if (draft.failureKind === 'provider' && (job.providerFailures = (job.providerFailures || 0) + 1) < 2 && job.requests < job.requestLimit && this.state.mode === 'running') job.state = 'retry-scheduled';
      this.save();
      if (draft.failureKind === 'report-budget') this.pauseForBudget();
      if (draft.failureKind === 'provider-health') {
        this.state.mode = 'paused'; this.state.reason = draft.error;
        for (const pending of Object.values(this.state.jobs)) if (['queued', 'retry-scheduled'].includes(pending.state)) { pending.state = 'paused'; pending.reason = draft.error; }
        this.save();
      }
    } catch (error) { if (current()) { Object.assign(job, { state: 'failed', outcome: 'inconclusive', reason: error.message, finishedAt: now() }); this.save(); } }
    finally {
      // No silent return (dirty input, abort or late response) may orphan a job.
      if (owns() && ['running', 'waiting-for-provider-capacity'].includes(job.state)) {
        Object.assign(job, { state: 'paused', publishable: false, finishedAt: now(),
          ...(this.options.dirty?.(entry.id) ? { dirtyPaused: true } : {}),
          reason: this.options.dirty?.(entry.id) ? 'Relevant unsaved edits paused this finding. Save them before resuming.' : 'This attempt stopped before completing its stage. Accepted work is saved.' });
        this.save();
      }
      if (this.tasks.get(entry.id)?.abort === abort) this.tasks.delete(entry.id);
      if (this.active?.id === entry.id) this.active = this.tasks.values().next().value || null;
    }
  }
  published(draft) { return !!draft && this.artifact(draft.findingId) === policy.digest(draft) && checked(draft); }
  async control(action) {
    if (action === 'resume' || action === 'retry') return this.ensure({ retry: true });
    if (!this.state) return;
    if (!['pause', 'cancel'].includes(action)) throw new Error('Unknown report preparation action.');
    this.state.mode = action === 'pause' ? 'paused' : 'cancelled';
    this.state.reason = action === 'pause' ? 'Paused. A request already running may finish; no new request will start. Accepted stages are saved.' : 'Cancelled. Accepted stages and researcher work are saved.';
    if (action === 'pause') for (const task of this.tasks.values()) if (this.state.jobs[task.id]?.state === 'waiting-for-provider-capacity') task.abort.abort();
    if (action === 'cancel') { for (const task of this.tasks.values()) task.abort.abort(); this.indexAbort?.abort(); this.epoch++; this.pendingRestart = false; }
    for (const job of Object.values(this.state.jobs)) if (['queued', 'retry-scheduled', 'waiting-for-provider-capacity', ...(action === 'cancel' ? ['running'] : [])].includes(job.state)) job.state = action === 'pause' ? 'paused' : 'cancelled';
    this.save();
  }
  invalidate(reason, change = {}) {
    if (!this.state) return;
    if (change.findingId) {
      const id = change.findingId, job = this.state.jobs[id];
      if (!job) return;
      if (change.saved && !this.options.dirty?.(id)) {
        try {
          const report = store.readReport(this.root), issue = report.issues.find(item => item.id === id);
          const prior = this.accepted.get(id)?.sourceSnapshot || job.snapshot;
          if (issue?.request && prior?.reportHash === engine.findingInputHash(issue.request, issue)) return;
        } catch { /* An unreadable/malformed saved input must be withheld. */ }
      }
      this.tasks.get(id)?.abort.abort();
      this.accepted.delete(id);
      Object.assign(job, { attemptId: crypto.randomUUID(), publishable: false, accepted: null, digest: null,
        state: 'queued', reason });
      if (this.options.dirty?.(id)) this.withholdDirty(job);
      else delete job.dirtyPaused;
      // An isolated finding edit neither supersedes sibling attempts nor
      // cancels shared indexing. Reconcile it after live work releases the lock.
      if (this.loop) this.pendingRestart = true;
      if (['completed', 'incomplete'].includes(this.state.mode)) this.state.mode = 'interrupted';
      this.save(); return;
    }
    const stopped = ['paused', 'cancelled'].includes(this.state.mode);
    for (const task of this.tasks.values()) task.abort.abort(); this.indexAbort?.abort(); this.epoch++; this.state.publication = null;
    if (!stopped) this.state.mode = 'interrupted';
    this.state.reason = reason;
    if (this.loop && !stopped) this.pendingRestart = true;
    let affected = null;
    if (change.findingId) affected = new Set([change.findingId]);
    else if (change.kind === 'report') {
      try {
        const report = store.readReport(this.root);
        affected = new Set(Object.values(this.state.jobs).filter(job => {
          const entry = report.issues.find(item => item.id === job.id);
          return !entry || job.findingHash !== entryHash({ ...entry, body: entry.reportText });
        }).map(job => job.id));
      } catch { /* An unreadable/unsaved manifest must be reconciled first. */ }
    }
    for (const job of Object.values(this.state.jobs)) {
      if (affected && !affected.has(job.id) && this.accepted.has(job.id)) continue;
      this.accepted.delete(job.id); job.publishable = false; job.state = 'queued';
    }
    this.save();
  }
  dispose() { this.disposed = true; clearTimeout(this.progressTimer); for (const task of this.tasks.values()) task.abort.abort(); this.indexAbort?.abort(); if (this.state) {
    for (const job of Object.values(this.state.jobs)) if (['running', 'waiting-for-provider-capacity'].includes(job.state)) job.state = 'queued';
    try { this.save(); } catch (error) { if (error.code !== 'ENOENT') this.options.log?.(`Could not checkpoint host shutdown: ${error.message}`); }
  } }
}
module.exports = { ReportPreparation, reconcile, FILE, checked };
