'use strict';
// Durable, source-only report work. No board/webview owns these jobs. Accepted
// Each accepted investigation is published atomically after its own checks.
// Report completion is aggregate progress, never permission to read a guide.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const p = require('./protocol'), store = require('./store'), reports = require('./report');
const engine = require('./investigation-engine'), policy = require('./guide-policy');
const batch = require('./batch-plan');
const automatic = require('./automatic-triage');
const journal=require('./report-journal');
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
    this.pendingFindings = new Map(); this.admitting = new Map(); this.localEligible = new Set(); this.controlRevision = 0;
  }
  continueFinding(id, { repairSavedAnalysis = false, repairResponseHash, recheckLocalPreparation = false, requirements, followupAuthorization, reviseAnalysis, operationIdentity } = {}) {
    p.identifier(id, 'finding continuation ID');
    if (this.disposed) throw new Error('This report owner is closed. Reopen the report.');
    if (!store.readReport(this.root).issues.some(item => item.id === id)) throw new Error('The selected finding is no longer in this report.');
    if (!this.pendingFindings.has(id) && !this.admitting.has(id) && !this.localEligible.has(id) && !this.tasks.has(id)) {
      if(!repairSavedAnalysis&&!recheckLocalPreparation&&!reviseAnalysis)
        operationIdentity ??= require('./next-review-operation').candidateRepair(engine.read(this.root,id))?.identity;
      this.pendingFindings.set(id, { revision: this.controlRevision, epoch: this.epoch, repairSavedAnalysis, repairResponseHash, recheckLocalPreparation, requirements, followupAuthorization, reviseAnalysis, operationIdentity });
    }
    // Existing workers admit this at a durable stage boundary. No report-wide
    // resume, allowance increase or cancellation of a sibling is implied.
    return this.ensure();
  }
  prioritize(id) {
    // Selection can reorder eligible work, but never starts a request, resumes
    // a paused report, or interrupts another finding's accepted stage.
    if (typeof id !== 'string' || id === this.preferredFinding) return;
    this.preferredFinding = id; this.priorityStages = 2;
  }
  holdCorrection(id, expected, change) {
    // Synchronous, owned and durable BEFORE cancellation or any await. Only
    // this finding is withheld; queues, receipts and sibling owners survive.
    p.identifier(id, 'correction finding ID');
    engine.correct(structuredClone(expected), change); // validate without changing the saved argument
    const temporary = !this.locked;
    if (temporary) this.lock();
    try {
      if (!this.ownsLock()) throw new Error('Report ownership changed before the correction hold.');
      const latest = journal.read(this.root,FILE);
      if (this.state && this.savedJournalHash && hash(latest) !== this.savedJournalHash) throw new Error('The report journal advanced in another host. Reopen before correcting.');
      this.state ||= latest; this.savedJournalHash = hash(latest);
      const job = this.state.jobs[id]; if (!job) throw new Error('The corrected finding is no longer in this report.');
      if (job.correctionHold && job.correctionHold.state !== 'applied') {
        if (hash(job.correctionHold.change) !== hash(change)) throw new Error('A previous correction is safely held. Resolve it before submitting a different correction.');
        return job.correctionHold;
      }
      const intent = { id: crypto.randomUUID(), state: 'pending', at: now(), expectedRevision: expected.revision,
        snapshotHash: hash(expected.snapshot), correctionsHash: hash(expected.corrections), semanticInputHash: hash(expected.semanticInput || null),
        claim: change.claimId ? expected.claims.filter(c => c.id === change.claimId).map(c => [c.id,c.allegation]) : expected.claims.map(c => [c.id,c.allegation]),
        change: structuredClone(change), reservationId: this.tasks.has(id) ? job.lastReservation?.id || null : null };
      if(job.correctionHold){job.correctionHistory ||= [];job.correctionHistory.push(job.correctionHold);}
      this.pendingFindings.delete(id); this.admitting.delete(id); this.localEligible.delete(id); this.accepted.delete(id);
      automatic.clear(job);
      delete job.assessmentProjection;
      Object.assign(job, { correctionHold: intent, state: 'paused', publishable: false, accepted: null, digest: null,
        reason: 'Researcher correction saved as an intent. Only this finding is held while its owned work settles.' });
      this.save();
      if (journal.read(this.root,FILE).jobs[id]?.correctionHold?.id !== intent.id) throw new Error('The correction hold could not be persisted. No replacement review is permitted.');
      this.tasks.get(id)?.abort.abort();
      return intent;
    } finally { if (temporary) this.unlock(); }
  }
  async settleCorrection(id) {
    const task = this.tasks.get(id);
    if (task) {
      let timer;
      const settled = await Promise.race([task.settled.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),12000);})]);
      clearTimeout(timer);
      if (!settled) throw new Error('Correction intent is saved; this finding remains held because its owned work has not settled. Siblings may continue.');
    }
    const temporary = !this.locked; if (temporary) this.lock();
    try {
      if (!this.ownsLock()) throw new Error('Correction intent retained; report ownership changed before settlement.');
      const latest = journal.read(this.root,FILE);
      if (hash(latest)!==this.savedJournalHash) throw new Error('Correction intent retained; another owner changed the report journal. Reopen it.');
      const job=this.state.jobs[id],intent=job?.correctionHold;
      if (!intent) throw new Error('No saved correction intent for this finding.');
      const receipt=intent.reservationId && this.state.resources.receipts[intent.reservationId];
      if (intent.reservationId && (!receipt?.finishedAt || receipt.audit?.teardown?.confirmed===false ||
          (!this.options.invoke || this.options.invoke.isProviderTransport) && receipt.audit?.teardown?.confirmed!==true)) {
        const cleanup=receipt?.audit?.teardown;
        if (!cleanup || cleanup.unverifiedDescendants || cleanup.streamsClosed===false || !require('./provider-process').processGroup(cleanup).confirmed) {
          job.reason='Correction intent retained; owned-process cleanup is unconfirmed. This finding remains held, not requeued.';this.save();
          throw new Error(job.reason);
        }
      }
      const draft=engine.read(this.root,id);
      if (!draft) throw new Error('Correction intent retained; the saved argument is unavailable.');
      if (!draft.corrections.some(c=>c.intentId===intent.id)) {
        if (draft.recoveryRequired || hash(draft.snapshot)!==intent.snapshotHash || hash(draft.corrections)!==intent.correctionsHash ||
            hash(draft.semanticInput||null)!==intent.semanticInputHash || draft.revision<intent.expectedRevision ||
            intent.claim.some(([key,allegation])=>!draft.claims.some(c=>c.id===key && c.allegation===allegation)))
          throw new Error('Correction intent retained; source, premises or claim scope changed. Inspect the advanced draft before reconciling this correction.');
        const correction=engine.correct(draft,intent.change);correction.intentId=intent.id;
        engine.write(this.root,draft);
      }
      Object.assign(intent,{state:'applied',appliedAt:intent.appliedAt||now(),appliedRevision:draft.revision});
      Object.assign(job,{state:'paused',stage:'corrected',checkpoint:draft.checkpoint||null,revision:draft.revision,
        reason:'Researcher correction saved. Continue this finding explicitly to reassess the new premises; no request was started.'});
      this.save(); return draft;
    } finally { if (temporary) this.unlock(); }
  }
  notifyStatus() {
    if (this.disposed || this.statusNotification) return;
    this.statusNotification = true;
    Promise.resolve().then(() => { this.statusNotification = false; if (!this.disposed) return this.options.changed?.(this.status(undefined,this.options.selectedFinding?.())); })
      .catch(error => this.options.log?.(`Report display update: ${error.message}`));
  }
  localAdmissionFailure(reason) {
    this.admissionStatus = { mode: 'paused', reason, admission: { scope: 'report', project: hash(fs.realpathSync(this.root)),
      reportHash: this.state?.reportHash || null, revision: this.controlRevision, observedAt: now(),
      kind: /owner|another.*host|journal/i.test(reason) ? 'ownership' : 'setup', reason,
      action: 'Reopen after the named host or setup condition changes. No new request was authorized by this refusal.' } };
    this.notifyStatus();
  }
  save() { clearTimeout(this.progressTimer); this.progressTimer = null;
    // Controls outside a run also need ownership. Never overwrite another
    // live host's journal merely to display a local admission failure.
    if (this.locked && !this.ownsLock()) { this.locked = false; this.localAdmissionFailure('Report ownership changed. No journal update or new request is permitted from this host.'); return; }
    const temporary = !this.locked;
    if (temporary) try { this.lock(); } catch (error) { this.localAdmissionFailure(error.message); return; }
    try {
      if (temporary && this.savedJournalHash) {
        const latest = journal.read(this.root,FILE);
        if (hash(latest) !== this.savedJournalHash) { this.localAdmissionFailure('Another host updated this report. Reopen it before applying a control; its journal was preserved.'); return; }
      }
      this.aggregate(); this.state.updatedAt = now();
      // Atomic persistence checks the exact serialized bytes once. Other pack
      // callers retain its default size guard; no durable save is deferred.
      try { this.savedJournalHash = p.atomicJson(this.root, FILE, journal.pack(this.root,this.state,{checkSize:false}), { compact: true, maxBytes:journal.MAX_BYTES }); }
      catch(error){if(error.code==='JSON_STORAGE_LIMIT'){error.code='REPORT_STORAGE_LIMIT';error.message='Compact report journal exceeds 8 MiB; the last usable journal and exact detail records were preserved. No usage was reset.';}throw error;}
    }
    finally { if (temporary) this.unlock(); }
    this.notifyStatus(); }
  progress() { if (!this.progressTimer) this.progressTimer = setTimeout(() => { if (!this.disposed) this.save(); }, 250); }
  status(mapping,selectedId,{fullDetails=false}={}) {
    if (!this.state) return this.admissionStatus ? { ...this.admissionStatus, project: this.admissionStatus.admission.project,
      reportHash: this.admissionStatus.admission.reportHash, total: 0, ready: 0, counts: {}, jobs: [], active: [], stopped: [], requests: 0, requestLimit: 0 } : null;
    const jobs = Object.values(this.state.jobs), counts = {};
    const profiles=require('./assessment-profile');mapping??=profiles.resolve(this.root,this.options.configuration?.().engagementProfile);
    const mapped=assessment=>!assessment?undefined:profiles.remap(assessment,mapping);
    for (const job of jobs) counts[job.state] = (counts[job.state] || 0) + 1;
    // A report observation is compact by default. Only an explicit selected
    // finding (or diagnostic/export caller) reads immutable detail records.
    const projected=jobs.map(job=>{
      const {id,state,stage,reason,outcome,publishedAt,failureKind,currentAttempt,verificationCompletion,hasPrivateCandidate,privateCandidateState,retainedRejection,repairAvailable,localRecheckAvailable,revisionAction,nextOperation}=job;
      const dirty=!!this.options.dirty?.(id);if(dirty)automatic.clear(job);
      const selected=fullDetails||selectedId===id,details={};
      if(selected)for(const key of journal.fields)details[key]=journal.detail(job,key).value;
      const detailProblems=journal.problems(job),assessmentProjection=dirty?undefined:mapped(selected?details.assessmentProjection:journal.assessmentSummary(job));
      const assessmentAvailable=!!assessmentProjection?.technical?.identity&&['supported','refuted','insufficient-evidence'].includes(assessmentProjection.technical.result);
      const digest=this.artifact(id),assessmentState=assessmentAvailable?'available':dirty||detailProblems.some(p=>p.requiredForAssessment)?'unavailable':'not-assessed';
      return{id,state,stage,reason,outcome,publishedAt,failureKind,currentAttempt,verificationCompletion,hasPrivateCandidate,privateCandidateState,retainedRejection,repairAvailable,
        localRecheckAvailable:localRecheckAvailable||!!detailProblems.length,revisionAction,
        nextOperation:selected?nextOperation:nextOperation&&{kind:nextOperation.kind,phase:nextOperation.phase,phases:nextOperation.phases,reason:nextOperation.reason},continueAction:this.continuationEligibility(job),
        ...details,assessmentProjection,assessmentAvailable,assessmentCompleted:automatic.complete(job)&&!dirty,assessmentState,detailProblems,publishable:!!digest,digest,
        ...(dirty?{state:'paused',reason:'Relevant unsaved edits paused this finding. Save them before resuming.'}:{})};
    });
    const assessmentCounts={},availableAssessmentCounts={};for(const job of projected){
      if(job.assessmentAvailable){const result=job.assessmentProjection.technical.result;availableAssessmentCounts[result]=(availableAssessmentCounts[result]||0)+1;}
      if(job.assessmentCompleted){const result=automatic.record(this.state.jobs[job.id]).result;assessmentCounts[result]=(assessmentCounts[result]||0)+1;}
    }
    const available=projected.filter(job=>job.assessmentAvailable).length;
    const assessed=projected.filter(job=>job.assessmentCompleted).length;
    const projectedById=new Map(projected.map(job=>[job.id,job])),config=this.options.configuration?.()||{};
    const plan=batch.plan(jobs,this.state.resources,config.workers,config.providerCapacity,job=>{
      const observed=projectedById.get(job.id);return job.nextOperation?.kind==='revision'?observed.revisionAction:observed.continueAction;
    });
    return { version: VERSION, reportName: this.state.reportName, reportHash: this.state.reportHash, project: this.state.project,
      total: jobs.length, ready: jobs.filter(job => this.artifact(job.id)).length, counts, ambiguities: this.state.ambiguities.length,
      assessmentAvailable:available,assessed,notAssessed:jobs.length-assessed,assessmentCounts,availableAssessmentCounts,
      triageComplete:jobs.length>0&&!this.state.ambiguities.length&&assessed===jobs.length,selectedId:selectedId||null,detailMode:fullDetails?'full':'selected',
      published: !!this.state.publication, mode: this.admissionStatus?.mode || this.state.mode, reason: this.admissionStatus?.reason || this.state.reason || '', startedAt: this.state.startedAt,
      admission: this.admissionStatus?.admission || null,
      requests: this.state.resources.requests, requestLimit: this.state.resources.limit, costUSD: this.state.resources.costUSD,
      batch: this.batchStatus(),
      plan,
      concurrency: { ...this.state.concurrency, dispatched: this.dispatched.size, workers: this.tasks.size,
        waiting: jobs.filter(job => job.state === 'waiting-for-provider-capacity').length },
      jobs: projected,
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
  triageComplete() {
    const jobs=Object.values(this.state?.jobs||{});
    return jobs.length>0&&!this.state.ambiguities?.length&&jobs.every(job=>automatic.complete(job)&&!this.options.dirty?.(job.id));
  }
  batchStatus() {
    const value=this.state?.batch;if(!value)return null;
    const start=Date.parse(value.startedAt),end=Date.parse(value.finishedAt);
    // Historical stopped attempts without a recorded boundary stay unknown.
    // A status poll or later human reading must not manufacture review time.
    const elapsedMs=Number.isFinite(start)&&(Number.isFinite(end)||this.batchAttemptActive)?Math.max(0,(Number.isFinite(end)?end:Date.now())-start):null;
    return {...value,elapsedMs};
  }
  beginBatchAttempt() {
    const value=this.state?.batch;if(!value||this.batchAttemptActive)return;
    if(value.finishedAt||this.batchWasStopped||['paused','cancelled','completed','incomplete'].includes(this.state.mode)||['completed','incomplete','deadline-exceeded'].includes(value.outcome)){
      const {previousAttempts,...previous}=value;
      this.state.batch={startedAt:now(),outcome:'pending',previousAttempts:[...(previousAttempts||[]),previous],
        ...(value.stopPolicy?{stopPolicy:value.stopPolicy,deadlineAt:value.deadlineAt}:{})};
    }
    this.batchWasStopped=false;
    this.batchAttemptActive=true;
  }
  finishBatch() {
    const value=this.state?.batch;if(!value)return;
    if(!this.batchAttemptActive)return; // Current coverage does not rewrite a historical stopped attempt.
    if(value.outcome!=='deadline-exceeded')value.outcome=this.triageComplete()?'completed':'incomplete';
    value.finishedAt ||= now();
    this.batchAttemptActive=false;
  }
  accept(entry, draft, job, evaluated=null) {
    if (job.correctionHold) return;
    if (this.options.dirty?.(entry.id)) { this.withholdDirty(job); return; }
    evaluated ||= policy.evaluate(draft);
    this.recoveryStatus(job,draft,evaluated);
    const digest = evaluated.digest, at = job.accepted?.digest === digest ? job.accepted.at : now();
    const accepted = { digest, at, policy: policy.POLICY, project: this.state.project, findingHash: entryHash(entry),
      generation: draft.revision, sourceSnapshot: draft.snapshot, dependencies: draft.dependencies || null };
    const {sourceSnapshot,dependencies,...acceptedSummary}=accepted;
    // The journal records publication identity, not another copy of source
    // dependencies or provider audits. Exact records stay in the investigation
    // and receipts. Reopen rebuilds the full live map only after validating them.
    Object.assign(job, { state: 'completed', stage: 'ready', publishable: true, digest, snapshot: {reportHash:draft.snapshot.reportHash}, outcome: draft.causal.outcome,
      findingHash: entryHash(entry), accepted:acceptedSummary, publishedAt: at, reason: '', failureKind: null, missingInputs: [], validationProblems: [],assessmentProjection:evaluated.assessment });
    this.accepted.set(entry.id, accepted);
  }
  artifact(id) { return this.state?.jobs[id]?.correctionHold || this.options.dirty?.(id) ? null : this.accepted.get(id)?.digest || null; }
  recordFailure(job, error) {
    automatic.clear(job);
    delete job.assessmentProjection;
    this.accepted.delete(job.id);
    Object.assign(job, { state: 'failed', publishable: false, accepted: null, digest: null, outcome:null,
      stage: 'saved-record', reason: `Cannot restore this finding's saved record: ${error.message} Original files were preserved. Inspect or recover this finding's local record, then retry.`, finishedAt: now() });
  }
  withholdDirty(job) {
    automatic.clear(job);
    delete job.assessmentProjection;
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
      for (const job of Object.values(this.state?.jobs || {})) {
        automatic.clear(job);delete job.assessmentProjection;job.publishable = false;job.accepted=null;job.digest=null;job.outcome=null;job.state = 'stale'; job.reason = error.message;
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
  ownsLock() {
    try { return !!this.locked && require('./provider-ownership').snapshot(path.join(this.root, LOCK))?.entry?.owner === this.owner; }
    catch { return false; }
  }
  async ensure({ retry = false } = {}) {
    if (this.loop) { if (retry || this.state?.mode === 'interrupted') this.pendingRestart = true; this.pendingRetry ||= retry; return this.loop; }
    if (this.disposed) return;
    // Even a missed watcher event must revoke a ready report on reopening.
    // The catalog provider reconciles content once for this generation; no
    // per-finding scan is required. Reuse is checked below under the report lock.
    const runEpoch = this.epoch, attempted = new Map(this.pendingFindings);
    this.loop = this.run(retry).catch(error => {
      if (this.disposed || runEpoch !== this.epoch) return;
      this.localAdmissionFailure(error.message);
      if (this.state && this.locked) { this.state.mode = 'paused'; this.state.reason = error.message; this.save(); }
      this.options.log?.(`Report preparation stopped: ${error.message}`);
    }).finally(() => {
      clearTimeout(this.deadlineTimer); this.deadlineTimer = null;
      // Includes stopped setup, cancellation and host shutdown. The worker
      // promises have settled before this boundary; reading does not renew it.
      if(this.state&&this.ownsLock()){
        this.finishBatch();
        try{this.save();}catch(error){this.options.log?.(`Could not record automatic run boundary: ${error.message}`);}
      }
      // Setup may stop before admission. Consume only the intents this run
      // attempted, not a genuinely new action received while it was awaiting.
      for (const [id, intent] of attempted) if (this.pendingFindings.get(id) === intent) this.pendingFindings.delete(id);
      this.unlock(); this.loop = null; this.localEligible.clear(); if ((this.pendingRestart || this.pendingFindings.size) && !this.disposed) {
      const again = this.pendingRetry; this.pendingRestart = false; this.pendingRetry = false; return this.ensure({ retry: again });
    } });
    return this.loop;
  }
  async run(retry) {
    this.lock();
    this.admissionStatus = null; this.notifyStatus();
    let reconciled;
    try{reconciled=reconcile(this.root);}catch(error){
      for(const job of Object.values(this.state?.jobs||{})){automatic.clear(job);this.accepted.delete(job.id);delete job.assessmentProjection;job.publishable=false;job.outcome=null;}
      throw error;
    }
    const { report, entries, reconciliation } = reconciled;
    const project = hash(fs.realpathSync(this.root)), identity = hash([VERSION, policy.POLICY, project, report.reportHash, entries.map(item => [item.id, item.title, item.body])]);
    // Reopen reconciles canonical records once, including non-Ready reviews.
    // A same-source generation cannot prove that a saved record still exists.
    // Ordinary status polls remain projection-only and never take this path.
    let old;
    try { old = journal.read(this.root,FILE); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.savedJournalHash = old ? hash(old) : null;
    if (old && old.identity !== identity) p.atomicJson(this.root, `.flowboard/recovery/preparation-${old.identity}.json`, old);
    if(old)journal.attach(this.root,old); // bind lazy history to its original report, not a later collection
    const config = this.options.configuration();
    const concurrency = batch.capacity(config.workers);
    if (config.executable && !path.isAbsolute(config.executable)) throw new Error('The configured model CLI path must be absolute, without shell arguments.');
    const sameProject = old?.project === project;
    this.state = old?.identity === identity ? old : { version: VERSION, identity, project, reportHash: report.reportHash, reportName: report.reportName,
      startedAt: sameProject ? old.startedAt : now(), mode: sameProject && ['paused', 'cancelled'].includes(old.mode) ? old.mode : 'running',
      jobs: sameProject ? old.jobs : {}, publication: null,
      resources: sameProject ? old.resources : { requests: 0, limit: Math.min(10000, config.requestLimit > 0 ? config.requestLimit : entries.length * (config.findingRequestLimit || batch.DEFAULT_ATTEMPTS)),
        allowanceMode: config.requestLimit > 0 ? 'explicit' : 'automatic', costUSD: null },
      ...(!sameProject ? { batch: { startedAt: report.importedAt, outcome: 'pending',
        ...(config.batchDeadlineMs > 0 ? { stopPolicy: 'explicit-user-v1', deadlineAt: new Date(Date.parse(report.importedAt) + config.batchDeadlineMs).toISOString() } : {}) } } : old.batch ? { batch: old.batch } : {}) };
    if(!old)this.batchAttemptActive=true;
    this.batchWasStopped=!!old&&['paused','cancelled','completed','incomplete'].includes(old.mode);
    this.accepted.clear(); // Rebuild current publication beside assessment seals below.
    if (this.state.batch?.deadlineAt && !this.deadlineEnabled()) {
      this.state.batch.historicalStop ||= { deadlineAt: this.state.batch.deadlineAt, outcome: this.state.batch.outcome, finishedAt: this.state.batch.finishedAt || null };
      if (this.state.reason?.startsWith('Preparation deadline reached;')) this.state.reason = 'The historical automatic time limit no longer stops review. Work remains paused; explicitly continue an eligible finding within its existing allowance.';
    }
    this.state.version = VERSION;
    journal.attach(this.root,this.state);
    const currentIds = new Set(entries.map(entry => entry.id));
    for (const id of Object.keys(this.state.jobs)) if (!currentIds.has(id)) { delete this.state.jobs[id]; this.accepted.delete(id); }
    this.state.resources.receipts ||= {};
    // Only a trusted host execution plan can add a separate evaluation window.
    // This hook is absent from ordinary editor/report input. It runs with report
    // ownership, before selected admission, and cannot erase lifetime receipts.
    const addition = this.options.evaluationContinuation?.(this.state);
    if (addition) {
      this.state.evaluationContinuations ||= {};
      if (!this.state.evaluationContinuations[addition.id]) {
        if (addition.baselineRequests !== this.state.resources.requests || !Number.isSafeInteger(addition.maximumRequests) || addition.maximumRequests < 1 ||
            Object.entries(addition.findings).some(([id, value]) => !this.state.jobs[id] || value.baselineRequests !== this.state.jobs[id].requests || value.attempts !== 1))
          throw new Error('Evaluation continuation accounting changed before owned admission.');
        this.state.evaluationContinuations[addition.id] = addition;
        this.state.resources.limit = addition.baselineRequests + addition.maximumRequests;
        for (const [id, value] of Object.entries(addition.findings)) this.state.jobs[id].requestLimit = value.baselineRequests + value.attempts;
      }
    }
    this.state.concurrency = { configured: concurrency, providerCapacity: batch.capacity(config.providerCapacity), achieved: this.state.concurrency?.achieved || 0 };
    this.state.ambiguities = reconciliation.ambiguities;
    for (const entry of entries) {
      const job = this.state.jobs[entry.id] ||= { id: entry.id, state: 'queued', attempt: 0, requests: 0, publishable: false, outcome: null };
      if (job.findingHash && job.findingHash !== entryHash(entry)) {
        automatic.clear(job);delete job.assessmentProjection;Object.assign(job, { state: 'queued', publishable: false, accepted: null, digest: null, outcome: null }); this.accepted.delete(entry.id);
      }
      job.findingHash = entryHash(entry);
      job.requestLimit ||= config.findingRequestLimit || 6;
      if (job.dirtyPaused && !this.options.dirty?.(entry.id)) { job.state = 'queued'; delete job.dirtyPaused; delete job.reason; }
      if (['running', 'waiting-for-provider-capacity'].includes(job.state)) { job.state = 'queued'; job.interruptedAt = now(); job.reason = 'The previous host stopped. Resume from the last valid checkpoint.'; }
    }
    this.save();
    if (this.expired()) {
      this.expire();
      // Expiry forbids fresh work, not reading already paid compatible guides.
      // A new host must still rebuild their current-source publication map.
      if (!fs.existsSync(path.join(this.root, '.flowboard/investigations'))) return;
    }
    this.armDeadline();
    // Disabled providers must not make ordinary import eagerly index code.
    // Existing private/accepted artifacts still take the local revalidation
    // path below, including migration while report work is paused.
    if (!['codex', 'claude'].includes(config.provider) && !fs.existsSync(path.join(this.root, '.flowboard/investigations'))) {
      this.state.mode = 'paused'; this.state.reason = 'Choose an authenticated provider to prepare walkthroughs. The report and code remain available.'; this.save(); return;
    }
    const epoch = this.epoch;
    this.indexAbort = new AbortController();
    const catalog = await this.validatedCatalog(this.indexAbort.signal);
    if (this.expired()) this.expire();
    if (epoch !== this.epoch || this.disposed) return;
    const currentReport = store.readReport(this.root);
    if (currentReport.reportHash !== report.reportHash || entries.some(entry => !currentReport.issues.some(item => item.id === entry.id)))
      throw new Error('The report changed during preparation setup. No selected continuation was admitted; reopen the current report.');
    // Recheck the complete manifest before reuse, including working-tree
    // changes, imported report text, local documentation and configuration.
    for (const entry of entries) {
      const job = this.state.jobs[entry.id];
      if (job.correctionHold) {
        try { await this.settleCorrection(entry.id); } catch(error) { job.state='paused';job.reason=error.message;this.save(); }
        continue;
      }
      if (this.options.dirty?.(entry.id)) { this.withholdDirty(job); continue; }
      try {
      const saved = engine.read(this.root, entry.id);
      if (!saved) {
        const expected=job.publishable||job.requests>0||Object.hasOwn(job,'assessmentProjection')||job.detailReferences?.assessmentProjection;
        if(expected)this.recordFailure(job,new Error('The canonical investigation record is missing.'));
        else{automatic.clear(job);this.accepted.delete(entry.id);delete job.assessmentProjection;job.publishable=false;job.accepted=null;job.digest=null;}
        continue;
      }
      job.checkpoint = saved.checkpoint || null;
      job.revision=saved.revision;
      const request = this.request(entry, catalog, report);
      if (!engine.revalidate(saved, catalog, request, this.issue(entry))) {
        automatic.clear(job);delete job.assessmentProjection;job.state = 'queued'; job.publishable = false; job.outcome = null; job.accepted = null;this.accepted.delete(entry.id);
        continue;
      } else if (saved.failureCode === 'LOCAL_GATE_WITHDRAWN') {
        Object.assign(job, { state: 'blocked', stage: 'challenge', publishable: false, accepted: null, reason: saved.error });
        this.accepted.delete(entry.id);
      } else if (job.publishable && !checked(saved)) {
        job.state = 'queued'; job.publishable = false; job.accepted = null; this.accepted.delete(entry.id);
      } else if (checked(saved)) {
        this.accept(entry, saved, job);
      } else if ((saved.pendingResponse || saved.failureCode==='RECEIPT_STORAGE_FAILED') && !this.pendingFindings.get(entry.id)?.repairSavedAnalysis) {
        // A completed transport receipt is already paid. Revalidate/replay it
        // before provider, pause and allowance checks, without authorizing a
        // new request or resuming any sibling's paid work.
        await this.work(entry, catalog, report, job, epoch, config, true);
        // work projects its recovered result under its currentness/ownership
        // checks. The pre-recovery object must never overwrite that projection.
        continue;
      }
      if (!job.publishable) this.recoveryStatus(job, saved);
      } catch (error) { this.recordFailure(job, error); }
      await new Promise(resolve => setImmediate(resolve));
    }
    this.reconciledKey = require('./workspace-snapshot').validate(catalog).key;
    // Generic retry renews only genuinely unfinished canonical work. A
    // tutorial blocker is not permission to reopen or top up an assessment.
    if(retry){
      const unfinished=entries.filter(entry=>!automatic.complete(this.state.jobs[entry.id]));
      if(unfinished.length){
        for(const entry of unfinished){const job=this.state.jobs[entry.id];job.state='queued';job.requestLimit=job.requests+(config.findingRequestLimit||6);delete job.reason;}
        this.state.mode='running';this.state.reason='';
        this.state.resources.limit=Math.max(this.state.resources.limit,this.state.resources.requests+Math.max(1,config.requestLimit||unfinished.length*(config.findingRequestLimit||6)));
        if(['codex','claude'].includes(config.provider)&&(!this.options.invoke||this.options.invoke.isProviderTransport))
          await require('./provider-health').reset(config.provider,{...this.options.providerResources,executable:config.executable,model:config.model,reasoningEffort:config.reasoningEffort});
      }
    }
    this.save();
    const admitPending = async () => {
      const admitted = [];
      for (const [id, intent] of [...this.pendingFindings]) {
        this.pendingFindings.delete(id);
        const entry = entries.find(item => item.id === id), job = this.state.jobs[id];
        if (!entry || !job) { this.options.log?.('Selected continuation was discarded because its finding left the report.'); continue; }
        if (job.publishable || this.tasks.has(id)) continue;
        if(automatic.complete(job)&&!intent.reviseAnalysis&&!intent.recheckLocalPreparation&&!intent.repairSavedAnalysis)continue;
        if (job.correctionHold && job.correctionHold.state!=='applied') { job.reason='Saved correction is still held. Settle or reconcile it before continuing.';this.save();continue; }
        if(intent.reviseAnalysis){
          const draft=engine.read(this.root,id),eligibility=this.revisionEligibility(job,draft);
          if(!eligibility.available){job.reason=eligibility.reason;this.recoveryStatus(job,draft);this.save();continue;}
          automatic.clear(job);this.beginBatchAttempt();
          try{engine.beginCandidateRevision({root:this.root,draft,catalog,request:this.request(entry,catalog,report),issue:this.issue(entry),revision:intent.reviseAnalysis});}
          catch(error){const saved=engine.read(this.root,id);if(saved&&engine.revalidate(saved,catalog,this.request(entry,catalog,report),this.issue(entry)))this.recoveryStatus(job,saved);throw error;}
          this.recoveryStatus(job,draft);
          // Explicit selected allocation, not a refund or report-wide resume.
          // Exact revision identity was checked before changing the ceiling.
          this.allocateRevision(job,draft,eligibility);
          job.checkpoint=draft.checkpoint;
          this.save();
        }
        if(intent.recheckLocalPreparation){
          const draft=engine.read(this.root,id);
          if(intent.followupAuthorization)engine.beginRejectedFollowup({root:this.root,draft,catalog,request:this.request(entry,catalog,report),issue:this.issue(entry),authorization:intent.followupAuthorization});
          if(!draft||draft.pendingResponse||draft.rejectedProposal?.state==='repair-dispatched'&&draft.rejectedProposal.followup?.state!=='pending'){job.reason='Recover the existing paid response or reconcile its owned attempt before preparing new input.';this.save();continue;}
          if(intent.requirements){
            if(!engine.compatible(draft,catalog,this.request(entry,catalog,report),this.issue(entry)))throw new Error('Local preparation changed context.');
            draft.localPreparation={requirements:structuredClone(intent.requirements),contextHash:require('./review-candidate').identity(draft)};
            draft.revision++;engine.write(this.root,draft);
          }
          await this.work(entry,catalog,report,job,epoch,config,false,true);
          continue;
        }
        if (this.options.phaseRemaining?.(id) === false || this.options.phasePlan?.(id)?.length===0) { job.reason = 'The explicitly authorized evaluation phases are exhausted. Retained work is unchanged; no further request is permitted.'; this.save(); continue; }
        const remaining = this.state.resources.limit - this.state.resources.requests;
        if (remaining <= 0) {
          job.reason = `Shared report allowance exhausted (${this.state.resources.requests}/${this.state.resources.limit}). This finding was not resumed; no allowance was added.`;
          this.save(); continue;
        }
        this.admitting.set(id, intent);
        try {
          if (['codex', 'claude'].includes(config.provider) && (!this.options.invoke || this.options.invoke.isProviderTransport))
            await require('./provider-health').reset(config.provider, { ...this.options.providerResources, executable: config.executable,model:config.model,reasoningEffort:config.reasoningEffort });
          if (this.disposed || !this.ownsLock() || intent.revision !== this.controlRevision || intent.epoch !== this.epoch ||
              this.admitting.get(id) !== intent || this.state.jobs[id] !== job || this.tasks.has(id) || job.publishable ||
              this.options.dirty?.(id) || this.options.configuration().provider !== config.provider ||
              this.options.configuration().executable !== config.executable || this.options.phaseRemaining?.(id) === false || !store.readReport(this.root).issues.some(item => item.id === id)) continue;
        } finally { if (this.admitting.get(id) === intent) this.admitting.delete(id); }
        const available = this.state.resources.limit - this.state.resources.requests;
        if (available <= 0) { job.reason = 'Shared report allowance exhausted during admission; no request was reserved.'; this.save(); continue; }
        // A crash can occur after the immutable successor is saved but before
        // its selected allocation reaches the journal. An explicit Continue
        // finishes that same admission, never creates another successor.
        const pendingRevision=engine.read(this.root,id);
        if(pendingRevision?.reviewCandidate?.state==='revision-pending'){
          const eligibility=this.revisionEligibility(job,pendingRevision,true);
          if(!eligibility.available){job.reason=eligibility.reason;this.save();continue;}
          this.allocateRevision(job,pendingRevision,eligibility);
        }
        const next=require('./next-review-operation').decide(pendingRevision,pendingRevision?policy.gate(pendingRevision):null);
        if(intent.operationIdentity&&intent.operationIdentity!==next.identity){
          job.reason='The selected operation changed before admission. Inspect its current candidate, feedback and source; no request was reserved.';this.save();continue;
        }
        if(next.reviewPurpose==='candidate-repair'&&!intent.repairSavedAnalysis){
          const eligibility=this.candidateRepairEligibility(job,pendingRevision,intent.operationIdentity);
          if(!eligibility.available){job.reason=eligibility.reason;this.save();continue;}
          this.allocateOperation(job,next.identity,eligibility);
          job.candidateRepairAdmission={identity:next.identity,candidateHash:next.candidateHash,feedbackRequestId:next.feedbackRequestId};
          this.save();
        }else if(next.kind==='verify'){
          const eligibility=this.operationEligibility(job,next);
          if(!eligibility.available){job.reason=eligibility.reason;this.save();continue;}
          this.allocateOperation(job,next.identity,eligibility);
        }else if(['acquire','revalidate','evidence'].includes(next.kind)&&!intent.repairSavedAnalysis&&!intent.reviseAnalysis){
          job.reason=next.reason;this.save();continue;
        }
        if(intent.repairSavedAnalysis){
          const draft=engine.read(this.root,id);
          if(engine.candidateRepairRetry(draft)){
            const eligibility=this.operationEligibility(job,{kind:'revision',phases:2});
            if(!eligibility.available){job.reason=eligibility.reason;this.save();continue;}
            engine.beginCandidateRepairRetry({root:this.root,draft,catalog,request:this.request(entry,catalog,report),issue:this.issue(entry),responseHash:intent.repairResponseHash});
            this.allocateOperation(job,intent.repairResponseHash,eligibility);
          }else if(require('./rejected-proposal').followupEligible(draft))engine.beginRejectedFollowup({root:this.root,draft,catalog,request:this.request(entry,catalog,report),issue:this.issue(entry),
            authorization:intent.followupAuthorization||{id:crypto.randomUUID(),responseHash:draft.currentRejection.responseHash}});
          else engine.beginRejectedRepair({root:this.root,draft,catalog,request:this.request(entry,catalog,report),issue:this.issue(entry)});
          job.checkpoint=draft.checkpoint;this.recoveryStatus(job,draft);
        }
        // Only an exhausted selected-finding allowance can be renewed, bounded
        // by already authorized shared capacity. Sibling limits never change.
        if (job.requests >= job.requestLimit) job.requestLimit = job.requests + Math.min(available, config.findingRequestLimit || 6);
        if(job.correctionHold) { job.correctionHistory ||= [];job.correctionHistory.push(job.correctionHold);delete job.correctionHold; }
        automatic.clear(job);this.beginBatchAttempt();job.state = 'queued'; job.reason = ''; job.providerFailures = 0;
        this.localEligible.add(id); admitted.push(entry); this.save();
      }
      return admitted;
    };
    await admitPending();
    if(this.triageComplete()&&!this.pendingFindings.size){this.state.mode='completed';this.state.reason='';this.finishBatch();this.save();return;}
    if (['paused', 'cancelled'].includes(this.state.mode) && !retry && !this.localEligible.size) return;
    if (!['codex', 'claude'].includes(config.provider)) {
      this.state.mode = 'paused'; this.state.reason = 'Choose an authenticated provider to prepare unfinished findings. Checked walkthroughs and original code remain available.'; this.save(); return;
    }
    if (!['paused', 'cancelled'].includes(this.state.mode)) this.state.mode = 'running';
    this.save();
    const priority = (this.options.firstFinding || '').split(',').filter(Boolean);
    const ordered = priority.length ? [...priority.flatMap(id => entries.filter(entry => entry.id === id)), ...entries.filter(entry => !priority.includes(entry.id))] : entries;
    const allowed = id => !this.state.jobs[id]?.correctionHold && !automatic.complete(this.state.jobs[id]) && (this.state.mode === 'running' || this.localEligible.has(id));
    const queue = ordered.filter(entry => allowed(entry.id) && ['queued', 'retry-scheduled'].includes(this.state.jobs[entry.id].state));
    this.state.plan = batch.plan(queue.map(entry => this.state.jobs[entry.id]), this.state.resources, concurrency, config.providerCapacity);
    if (!old && this.state.resources.allowanceMode === 'automatic') this.state.resources.limit = this.state.plan.maximumRequests;
    if (!old && this.state.plan.expectedRequests > this.state.resources.limit - this.state.resources.requests) {
      this.state.mode = 'paused'; this.state.reason = `The explicit report cap cannot cover the planned ${this.state.plan.expectedRequests} requests (generation plus mandatory challenge); ${this.state.resources.limit} allowed. No request was reserved. Choose an explicit sufficient allowance before starting.`;
      for (const entry of queue) { this.state.jobs[entry.id].state = 'paused'; this.state.jobs[entry.id].reason = this.state.reason; }
      this.save(); return;
    }
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
      while ((freshQueue.length || continuedQueue.length || retryQueue.length || this.pendingFindings.size) && !this.disposed && epoch === this.epoch) {
        if (this.expired()) { this.expire(); break; }
        for (const entry of await admitPending()) if (![...freshQueue, ...continuedQueue, ...retryQueue].some(item => item.id === entry.id)) continuedQueue.push(entry);
        if (this.state.resources.requests >= this.state.resources.limit) {
          if (this.state.mode === 'running') this.pauseForBudget();
          else for (const id of this.localEligible) { const job = this.state.jobs[id]; if (job.state === 'queued') { job.state = 'paused'; job.reason = 'Shared report allowance exhausted; accepted stages are saved.'; } }
          break;
        }
        if (!freshQueue.length && !continuedQueue.length && !retryQueue.length) break;
        const entry = next(), job = this.state.jobs[entry.id];
        if (!allowed(entry.id) || !['queued', 'retry-scheduled'].includes(job.state)) continue;
        // A persisted short backoff never consumes a slot or a reservation.
        // Other workers and already readable findings remain independent.
        while (Date.parse(job.retryAfter || '') > Date.now() && allowed(entry.id) && !this.expired() && !this.disposed)
          await new Promise(resolve => setTimeout(resolve, Math.min(100, Date.parse(job.retryAfter) - Date.now())));
        if (this.expired()) { this.expire(); break; }
        if (!allowed(entry.id) || this.disposed || epoch !== this.epoch) continue;
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
    if (this.triageComplete()) {
      try{
        require('./workspace-snapshot').validate(catalog, { force: true });
        if(store.readReport(this.root).reportHash!==this.state.reportHash)throw new Error('The report changed before automatic triage completed.');
      }catch(error){for(const job of jobs)this.recordFailure(job,error);throw error;}
      for (const entry of entries) {
        try {
          const draft = engine.read(this.root, entry.id);
          if(!draft||!engine.revalidate(draft,catalog,this.request(entry,catalog,report),this.issue(entry)))throw new Error(`The saved ${entry.id} assessment changed before automatic completion.`);
          const evaluated=policy.evaluate(draft);
          this.recoveryStatus(this.state.jobs[entry.id],draft,evaluated);
          if(!automatic.complete(this.state.jobs[entry.id]))throw new Error(`The saved ${entry.id} assessment needs current substantive review.`);
        } catch (error) { this.recordFailure(this.state.jobs[entry.id], error); }
      }
      this.reconciledKey = require('./workspace-snapshot').validate(catalog).key;
    }
    if (this.state.mode === 'running') this.state.mode = this.triageComplete() ? 'completed' : 'incomplete';
    this.finishBatch();
    this.localEligible.clear();
    this.save();
  }
  issue(entry) { return { ...entry, reportText: entry.body }; }
  deadlineEnabled() { return this.state?.batch?.stopPolicy === 'explicit-user-v1' && Number.isFinite(Date.parse(this.state.batch.deadlineAt)); }
  expired() { return this.deadlineEnabled() && Date.now() >= Date.parse(this.state.batch.deadlineAt); }
  armDeadline() {
    clearTimeout(this.deadlineTimer); this.deadlineTimer=null;
    if(this.disposed||!this.deadlineEnabled()||this.state.batch.outcome==='deadline-exceeded')return;
    if(this.expired()){this.expire();return;}
    // Timers are not a wall-clock guarantee. An early callback or clock
    // adjustment must not strand an explicit-limit capacity wait forever.
    this.deadlineTimer=setTimeout(()=>this.armDeadline(),Math.min(2147483647,Math.max(1,Date.parse(this.state.batch.deadlineAt)-Date.now())));
  }
  observationOnly(id) { return this.options.phasePlan?.(id)?.join() === 'generate'; }
  requiresChallenge(id) {
    const phases = this.options.phasePlan?.(id);
    // A trusted evaluation window owes only its permitted remaining phases.
    // Ordinary reports still protect every admitted finding's challenge.
    return phases === undefined || phases.includes('challenge') && this.options.phaseRemaining?.(id) !== false;
  }
  expire() {
    if (!this.expired() || this.disposed || this.state.batch.outcome === 'completed') return;
    this.state.batch.outcome = 'deadline-exceeded'; this.state.batch.finishedAt ||= now();
    this.state.batch.unfinished = Object.values(this.state.jobs).filter(job => !automatic.complete(job)).map(job => job.id);
    this.state.mode = 'paused'; this.state.reason = `Preparation deadline reached; ${this.state.batch.unfinished.length} findings lack a current completed technical assessment. Checked results and paid checkpoints are retained. This run did not meet its acceptance window.`;
    this.controlRevision++; this.pendingFindings.clear(); this.localEligible.clear();
    this.indexAbort?.abort(); for (const task of this.tasks.values()) task.abort.abort();
    for (const job of Object.values(this.state.jobs)) if (['queued', 'retry-scheduled', 'waiting-for-provider-capacity'].includes(job.state)) { job.state = 'paused'; job.reason = this.state.reason; }
    this.save();
  }
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
  async work(entry, catalog, report, job, epoch, config, localOnly = false, preparationOnly = false) {
    if (job.correctionHold) return;
    if (this.options.dirty?.(entry.id)) { this.withholdDirty(job); this.save(); return; }
    const issue = this.issue(entry), request = this.request(entry, catalog, report);
    const fresh = engine.create({ findingId: entry.id, request, issue, catalog });
    let draft = engine.read(this.root, entry.id);
    const wasReady = draft?.phase === 'ready';
    if (draft && !engine.revalidate(draft, catalog, request, issue)) { engine.archive(this.root, draft); fresh.storageRevision = draft.revision; fresh.revision = draft.revision + 1; fresh.corrections = draft.corrections; draft = fresh; }
    draft ||= fresh;
    if (wasReady && draft.failureCode === 'LOCAL_GATE_WITHDRAWN') {
      Object.assign(job, { state: 'blocked', stage: 'challenge', publishable: false, accepted: null, reason: draft.error });
      this.accepted.delete(entry.id); this.recoveryStatus(job, draft); this.save(); return;
    }
    if (checked(draft)) { engine.validateCurrent(catalog, draft); this.accept(entry, draft, job); this.save(); return; }
    const existing=policy.evaluate(draft);
    if(!preparationOnly&&automatic.current(draft,existing)){
      engine.validateCurrent(catalog,draft);this.recoveryStatus(job,draft,existing);this.save();return;
    }
    automatic.clear(job);this.beginBatchAttempt();
    let settled;const abort = new AbortController(); this.active = { abort, id: entry.id, settled:new Promise(resolve=>settled=resolve) }; this.tasks.set(entry.id, this.active);
    const attemptId = crypto.randomUUID();
    Object.assign(job, { state: 'running', stage: preparationOnly?'preparing-local-context':draft.checkpoint?.stage || 'locating-code', progress: null,
      attempt: job.attempt + 1, attemptId, owner: this.owner, startedAt: now(), snapshot: {reportHash:fresh.snapshot.reportHash}, publishable: false }); this.save();
    const owns = () => epoch === this.epoch && this.state.jobs[entry.id]?.attemptId === attemptId;
    const current = () => {
      if (this.disposed || job.correctionHold || (!localOnly && this.expired()) || !owns() || !this.ownsLock() || abort.signal.aborted || this.options.dirty?.(entry.id)) return false;
      try {
        return p.readWorkspaceJson(this.root, '.flowboard/report.json', 12 * 1024 * 1024).reportHash === report.reportHash &&
          engine.findingInputHash(this.request(entry, catalog, report), issue) === fresh.snapshot.reportHash;
      } catch { return false; } // A malformed concurrent edit cannot accept an old scope.
    };
    try {
      draft = await engine.advance({ root: this.root, catalog, request, issue, findingId: entry.id, draft,
        provider: config.provider, executable: config.executable, model:config.model,reasoningEffort:config.reasoningEffort,budget: config.budget, signal: abort.signal, current, invoke: this.options.invoke,
        providerResources: { ...this.options.providerResources, capacity: batch.capacity(config.providerCapacity) }, yieldAfterStage: true, localOnly, preparationOnly, prepareRequest: this.options.prepareRequest, candidateSeed: this.options.candidateSeed?.(entry.id), recoveryReservation: job.lastReservation,
        beforeRequest: async data => {
          const phases = this.options.phasePlan?.(entry.id);
          if (phases && !phases.includes(data.phase)) throw Object.assign(new Error('This authorized phase plan does not permit the next request; retained observation remains unpublished.'), { code: 'REPORT_PAUSED' });
          if (this.state.mode !== 'running' && !this.localEligible.has(entry.id)) throw Object.assign(new Error('Paused after the current request. Resume will reuse the accepted stage.'), { code: 'REPORT_PAUSED' });
          if (!current()) throw Object.assign(new Error('Preparation inputs changed before dispatch.'), { code: 'INVESTIGATION_SUPERSEDED' });
          if (this.state.resources.requests >= this.state.resources.limit) throw Object.assign(new Error(`Report request allowance exhausted (${this.state.resources.requests}/${this.state.resources.limit}). Accepted stages are saved.`), { code: 'REPORT_BUDGET' });
          if (job.requests >= job.requestLimit) throw Object.assign(new Error(`Finding ${job.id} request allowance exhausted (${job.requests}/${job.requestLimit}). Other findings may continue.`), { code: 'FINDING_BUDGET' });
          const challengeCapacity = () => {
            const owed = batch.owedChallenges(Object.values(this.state.jobs), entry.id, id => this.requiresChallenge(id)) + (data.phase === 'generate' && this.requiresChallenge(entry.id) ? 1 : 0);
            if (this.state.resources.limit - this.state.resources.requests <= owed) throw Object.assign(new Error(`Remaining allowance is reserved for ${owed} mandatory challenges of admitted findings; no new request was reserved.`), { code: 'FINDING_BUDGET' });
            if(data.input.candidateOnly&&(draft.reviewCandidate?.successor||draft.reviewCandidate?.authoringRejection)&&
              (!this.revisionPhases(entry.id)||job.requestLimit-job.requests<2||this.state.resources.limit-this.state.resources.requests-owed<2))
              throw Object.assign(new Error('The explicit revision no longer has capacity for authoring and its fresh verification; no authoring request was reserved.'),{code:'FINDING_BUDGET'});
            if(data.input.candidateOnly&&draft.reviewCandidate?.state==='repair-requested'&&!draft.reviewCandidate.authoringRejection){
              const eligible=this.candidateRepairEligibility({...job,state:'queued'},draft,job.candidateRepairAdmission?.identity);
              if(!job.candidateRepairAdmission?.identity||!eligible.available||eligible.additionalAllocation)
                throw Object.assign(new Error(eligible.reason||'The exact candidate repair needs selected admission for authoring and fresh verification.'),{code:'FINDING_BUDGET'});
            }
          };
          challengeCapacity();
          await this.options.authorizeRequest?.({ ...data, findingId: entry.id });
          if (!current()) throw Object.assign(new Error('Preparation superseded during request authorization.'), { code: 'INVESTIGATION_SUPERSEDED' });
          if (this.state.mode !== 'running' && !this.localEligible.has(entry.id)) throw Object.assign(new Error('Paused during request authorization; no request was reserved.'), { code: 'REPORT_PAUSED' });
          // Another worker may reserve while an explicit authorization hook
          // awaits. Recheck shared accounting immediately before incrementing.
          if (this.state.resources.requests >= this.state.resources.limit) throw Object.assign(new Error('Shared report allowance exhausted before reservation.'), { code: 'REPORT_BUDGET' });
          challengeCapacity();
          this.state.resources.requests++; job.requests++; job.stage = data.phase; job.inputBytes = data.inputBytes; job.state = 'running';
          job.lastReservation = { id: `${attemptId}:${job.requests}`, phase: data.phase, ...(data.input.reviewPurpose ? { reviewPurpose: data.input.reviewPurpose } : {}), at: now(), inputBytes: data.inputBytes };
          job.lastReservation.timing = { stageStartedAt: job.startedAt, capacityWaitMs: data.capacity?.waitMs || 0,
            preparationAndHostSchedulingMs: Math.max(0, Date.now() - Date.parse(job.startedAt) - (data.capacity?.waitMs || 0)) };
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
          if (!reservation || this.state.reportHash !== report.reportHash) return;
          const owned=this.state.resources.receipts[reservation.id];
          if(!this.ownsLock()||!owned||owned.findingId!==job.id||owned.phase!==reservation.phase||owned.reviewPurpose!==reservation.reviewPurpose||audit.requestId&&audit.requestId!==reservation.id)throw new Error('Terminal receipt does not belong to this owned finding reservation.');
          if(owned.finishedAt)return;
          const previous=structuredClone(this.state.resources);
          this.state.resources.receipts[reservation.id] = { ...reservation, findingId: job.id, finishedAt: now(), outcome: audit.outcome,
            hostInvocationElapsedMs: Date.now() - Date.parse(reservation.at),
            audit,
            costUSD: Number.isFinite(audit.costUSD) ? audit.costUSD : null, outputBytes: audit.outputBytes ?? null, usage: audit.usage || null,
            elapsedMs: audit.startedAt && audit.finishedAt ? Date.parse(audit.finishedAt) - Date.parse(audit.startedAt) : null };
          const receipts = Object.values(this.state.resources.receipts);
          this.state.resources.costUSD = receipts.length === this.state.resources.requests && receipts.every(item => item.costUSD !== null) ? receipts.reduce((n, item) => n + item.costUSD, 0) : null;
          try{this.save();}catch(error){this.state.resources=previous;throw error;}
        },
        onAccepted: audit => {
          const receipt = audit.requestId && this.state.resources.receipts[audit.requestId];
          if (receipt) { receipt.hostAcceptedAt = audit.hostAcceptedAt; receipt.audit = audit; receipt.localIngestionElapsedMs = Date.parse(audit.hostAcceptedAt) - Date.parse(receipt.finishedAt); job.lastUsefulActivity = audit.hostAcceptedAt; this.save(); }
        },
        onDispatchEnd: reservation => { if (reservation) this.dispatched.delete(reservation.id); },
        publish: async value => {
          if (!current()) return;
          job.stage = value.phase; job.checkpoint = value.checkpoint || null; job.revision = value.revision;
          // advance has already persisted this exact investigation revision.
          // Stage/checkpoint are a report projection, not another receipt or
          // publication boundary. Reopen restores them from the investigation
          // before scheduling/owed-challenge admission. Keep reservation,
          // result, acceptance, final publication and controls synchronously
          // saved below/above; do not rewrite every sibling for this projection.
          this.notifyStatus();
        }
      });
      if (!current()) return;
      // One synchronous evaluation of this exact terminal revision. No cache
      // survives mutation, currentness validation or a subsequent response.
      const evaluated=policy.evaluate(draft),ready=evaluated.checked,assessed=automatic.current(draft,evaluated);
      Object.assign(job, { state: assessed ? 'completed' : draft.yielded ? 'queued' : draft.failureKind === 'provider' || draft.failureKind === 'validation' || draft.failureKind === 'structural' ? 'failed' : ['report-budget', 'finding-budget', 'paused', 'provider-health'].includes(draft.failureKind) ? 'paused' : draft.failureKind === 'capacity' ? 'retry-scheduled' : 'blocked',
        outcome: evaluated.assessment.technical.result,assessmentProjection:evaluated.assessment, reason: draft.error || 'The explanation still needs material evidence.',
        publishable: ready, digest: ready ? evaluated.digest : null, checkpoint: draft.checkpoint || null,
        finishedAt: now(), elapsedMs: Date.now() - Date.parse(job.startedAt) });
      if (ready) this.accept(entry, draft, job,evaluated);
      else this.recoveryStatus(job, draft,evaluated);
      if (this.observationOnly(entry.id) && draft.yielded && draft.checkpoint?.stage === 'challenge') {
        Object.assign(job, { state: 'blocked', stage: 'unpublished-observation', publishable: false,
          reason: 'The authorized generation-only observation is saved. No challenge is authorized and no checked walkthrough is published.' });
        this.localEligible.delete(entry.id);
      }
      const diagnostic = draft.runs.at(-1)?.diagnostics?.lastReportedError;
      const nonRetryable = ['authentication', 'authorization', 'request-format', 'context-limit', 'model-unavailable'].includes(diagnostic?.category) || diagnostic?.code === 'insufficient_quota';
      if (!assessed && draft.failureKind === 'provider' && !nonRetryable && (job.providerFailures = (job.providerFailures || 0) + 1) < 2 && job.requests < job.requestLimit && this.state.mode === 'running') {
        job.state = 'retry-scheduled';
        if (['rate-limit', 'provider-unavailable'].includes(diagnostic?.category)) job.retryAfter = new Date(Date.now() + 1000).toISOString();
      }
      this.save();
      if (draft.failureKind === 'report-budget') this.pauseForBudget();
      if (draft.failureKind === 'provider-health') {
        this.state.mode = 'paused'; this.state.reason = draft.error;
        for (const pending of Object.values(this.state.jobs)) if (['queued', 'retry-scheduled'].includes(pending.state)) { pending.state = 'paused'; pending.reason = draft.error; }
        this.save();
      }
    } catch (error) { if (current()) { automatic.clear(job);Object.assign(job, { state: 'failed', outcome: 'not-assessed', reason: error.message, finishedAt: now() }); this.save(); } }
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
      settled();
    }
  }
  published(draft,evaluated=null) { if(!draft)return false;const value=evaluated||policy.evaluate(draft);return this.artifact(draft.findingId)===value.digest&&value.checked; }
  revisionPhases(id) {
    if(this.options.phaseRemaining?.(id)===false)return false;
    if(!this.options.phasePlan)return true; // ordinary configured lifecycle
    const remaining=this.options.remainingPhasePlan?.(id);
    // A boolean remaining permission or one challenge slot cannot authorize
    // authoring followed by a different, fresh verification purpose.
    return Array.isArray(remaining)&&remaining.length>=2&&
      remaining[0].phase==='challenge'&&remaining[0].reviewPurpose==='candidate-repair'&&
      remaining[1].phase==='challenge'&&remaining[1].reviewPurpose==='candidate-reverification';
  }
  continuationEligibility(job) {
    const blocked=reason=>({available:false,reason});
    const plan=this.options.phasePlan?.(job.id),phase=job.nextOperation?.phase|| (job.nextOperation?.kind==='verify'||job.hasPrivateCandidate||job.checkpoint?.stage==='challenge'?'challenge':'generate');
    if(this.options.phaseRemaining?.(job.id)===false||plan&&!plan.includes(phase))return blocked('The applicable phase plan does not permit the next request.');
    if(job.privateCandidateState==='terminal')return blocked('Use an explicit revision of the terminal review, not Continue.');
    if(job.awaitingRejectedRepair)return blocked('The received repair was rejected. Use Repair saved analysis when its authoring/verification pair is available; local replay cannot edit the response.');
    if(automatic.complete(job)||job.publishable||job.correctionHold||job.failureKind==='storage'||job.retainedRejection||['running','waiting-for-provider-capacity'].includes(job.state))return blocked('This finding is already assessed, active, or needs its specific recovery action.');
    if(job.privateCandidateState==='revision-pending')return this.revisionEligibility(job,engine.read(this.root,job.id),true);
    if(job.privateCandidateState==='repair-requested')return this.candidateRepairEligibility(job,engine.read(this.root,job.id),job.nextOperation?.identity);
    if(job.nextOperation?.kind==='verify')return this.operationEligibility(job,job.nextOperation);
    if(['evidence','acquire','revalidate'].includes(job.nextOperation?.kind))return blocked(job.nextOperation.reason);
    if(this.state.resources.requests>=this.state.resources.limit)return blocked('Shared report allowance is exhausted.');
    if(!['codex','claude'].includes(this.options.configuration().provider))return blocked('Enable the configured source-only provider.');
    return{available:true,reason:'Continue only this finding within the applicable phases and shared allowance.'};
  }
  allocateRevision(job,draft,eligibility) {
    this.allocateOperation(job,draft.reviewCandidate.successor.id,eligibility);
  }
  allocateOperation(job,id,eligibility) {
    if(!eligibility.additionalAllocation)return;
    if(!id)throw new Error('Selected allocation needs the exact retained operation identity.');
    const before=job.requestLimit;job.requestLimit+=eligibility.additionalAllocation;
    job.selectedAllocations=[...(job.selectedAllocations||[]),{id,at:now(),before,after:job.requestLimit,
      used:job.requests,candidateHash:eligibility.candidateHash,feedbackRequestId:eligibility.feedbackRequestId}];
  }
  operationEligibility(job,operation){
    const blocked=reason=>({available:false,reason}),count=operation.phases;
    if(![1,2].includes(count))return blocked(operation.reason);
    if(job.correctionHold||job.state==='running'||job.state==='waiting-for-provider-capacity')return blocked('This finding is held or already active.');
    if(count===2&&!this.revisionPhases(job.id))return blocked('The applicable phase plan does not permit repair authoring and fresh verification.');
    const plan=this.options.remainingPhasePlan?.(job.id);
    if(count===1&&(this.options.phaseRemaining?.(job.id)===false||this.options.phasePlan&&!plan?.length||plan&&(plan[0].phase!=='challenge'||plan[0].reviewPurpose&&plan[0].reviewPurpose!=='retained-verification')))
      return blocked('The fixed phase plan does not permit this complete retained verification.');
    const remaining=this.state.resources.limit-this.state.resources.requests,owed=batch.owedChallenges(Object.values(this.state.jobs),job.id,id=>this.requiresChallenge(id));
    if(remaining-owed<count)return blocked(`${count===1?'Fresh verification':'Authoring and fresh verification'} needs ${count} request(s); shared remaining ${remaining}, owed sibling checks ${owed}. Spent usage is unchanged.`);
    if(!['codex','claude'].includes(this.options.configuration().provider))return blocked('Enable the configured source-only provider for the indicated operation.');
    const additionalAllocation=Math.max(0,count-(job.requestLimit-job.requests));
    return{available:true,additionalAllocation,reason:`${operation.reason||'Repair the retained response, then obtain complete fresh verification.'} Required requests: ${count}; selected additional allocation: ${additionalAllocation}; shared remaining: ${remaining}; owed sibling checks: ${owed}.`};
  }
  candidateRepairEligibility(job,draft,expectedIdentity){
    const operation=require('./next-review-operation').candidateRepair(draft),blocked=reason=>({available:false,reason});
    if(!operation||operation.unavailable)return blocked(operation?.reason||'A current repair-requested candidate is required.');
    if(expectedIdentity&&expectedIdentity!==operation.identity)return blocked('The retained candidate repair identity changed. Reopen its current feedback and source before continuing.');
    if(draft.pendingResponse||draft.recoveryRequired)return blocked('Recover the owned response before authoring a repair.');
    const last=draft.runs?.at(-1);
    if(last?.requestId!==operation.feedbackRequestId||last.outcome!=='completed'||last.teardown?.confirmed!==true)
      return blocked('The exact completed verifier response and confirmed cleanup are required before candidate repair.');
    return {...this.operationEligibility(job,operation),identity:operation.identity,candidateHash:operation.candidateHash,feedbackRequestId:operation.feedbackRequestId};
  }
  revisionEligibility(job,draft,pending=false) {
    let accepted;
    const blocked=reason=>({available:false,...(accepted||{}),reason});
    const candidates=require('./review-candidate'),schema=require('./semantic-provider').schema;
    try{accepted=!pending&&candidates.acceptedRevision(draft,schema);}catch(error){return blocked(error.message);}
    if(!accepted&&(!draft||draft.reviewCandidate?.state!==(pending?'revision-pending':'terminal')||pending&&!draft.reviewCandidate.successor))return blocked('A current accepted partial assessment or completed terminal candidate review is required for private revision.');
    let feedback;
    try{if(!accepted){candidates.assertCurrent(draft,schema);feedback=require('./review-feedback').current(draft.reviewCandidate);
      if(!feedback&&draft.reviewCandidate.successor?.kind!=='accepted-partial')return blocked('The terminal review needs its exact negative verifier response.');}}
    catch(error){return blocked(error.message);}
    if(draft.pendingResponse||draft.recoveryRequired||job.correctionHold)return blocked('Recover the owned response or settle the saved correction first.');
    if(draft.runs.at(-1)?.teardown?.confirmed!==true)return blocked('Owned provider cleanup is unconfirmed.');
    if(!this.revisionPhases(job.id))return blocked('The applicable phase plan does not permit both repair authoring and fresh verification.');
    const finding=job.requestLimit-job.requests,report=this.state.resources.limit-this.state.resources.requests;
    const owed=batch.owedChallenges(Object.values(this.state.jobs),job.id,id=>this.requiresChallenge(id));
    if(report-owed<2)return blocked(`A private revision requires authoring and fresh verification; shared requests remaining: ${report}, owed sibling verifications: ${owed}. No requests were reserved or allowances reset.`);
    if(!['codex','claude'].includes(this.options.configuration().provider))return blocked('Enable the configured source-only provider to author and freshly verify a private revision.');
    const additionalAllocation=Math.max(0,2-finding);
    return {available:true,additionalAllocation,...(accepted||{candidateHash:draft.reviewCandidate.candidateHash,...(feedback?{feedbackHash:feedback.responseHash,feedbackRequestId:feedback.requestId}:{kind:'accepted-partial'})}),
      reason:`${accepted?'Revise a concrete unresolved question, property or scope; the accepted predecessor stays readable.':'Reconcile the recorded revision work.'} Then obtain full fresh verification (2 requests). ${additionalAllocation?`This action adds ${additionalAllocation} to this finding’s allowed ceiling; ${job.requests} spent requests remain spent. `:''}Shared capacity remaining: ${report}; owed sibling verifications: ${owed}.`};
  }
  recoveryStatus(job, draft, evaluated=null) {
    evaluated ||= draft.property?policy.evaluate(draft):null;
    const admitted=draft.runs?.at(-1)?.resultAccepted===true;
    const currentRejection=draft.currentRejection&&!(admitted&&draft.runs.at(-1).requestId===draft.currentRejection.requestId)?draft.currentRejection:null;
    job.nextOperation=require('./next-review-operation').decide(draft,evaluated?.publication);
    job.assessmentProjection=evaluated?.assessment||require('./technical-assessment').project(draft,draft.publication||{ready:false});
    job.failureKind = draft.failureKind || null;
    job.hasPrivateCandidate=!!draft.reviewCandidate;
    job.privateCandidateState=draft.reviewCandidate?.state||null;
    job.awaitingRejectedRepair=engine.candidateRepairRetry(draft);
    job.revisionAction=this.revisionEligibility(job,draft);
    const candidate=draft.reviewCandidate, feedback=candidate?.verification;
    const rejectedCheck=feedback?.result==='repair'&&feedback.candidateHash===candidate.candidateHash&&feedback.revisionHash===hash(candidate.revisions)&&
      (!draft.currentRejection||draft.currentRejection.requestId===feedback.requestId)?feedback:null;
    job.localRecheckAvailable=(draft.failureKind==='local-reading'||['verify','acquire','revalidate'].includes(job.nextOperation.kind))&&!draft.pendingResponse&&!job.correctionHold&&(draft.rejectedProposal?.state!=='repair-dispatched'||draft.rejectedProposal.followup?.state==='pending');
    job.retainedRejection=!job.hasPrivateCandidate&&(!admitted&&!!draft.lastRejected&&draft.failureCode==='REVIEW_REFERENCE_SCOPE'||!!draft.rejectedProposal);
    const candidateRetry=engine.candidateRepairRetry(draft)&&this.operationEligibility(job,{kind:'revision',phases:2}).available;
    const repairPending=candidateRetry||require('./rejected-proposal').eligible(draft)||require('./rejected-proposal').followupEligible(draft)||
      !draft.reviewCandidate&&(draft.rejectedProposal?.state==='repair-pending'||draft.rejectedProposal?.followup?.state==='pending');
    job.repairAvailable=!!repairPending&&!draft.recoveryRequired&&!['local-reading','storage'].includes(draft.failureKind)&&!job.correctionHold&&['codex','claude'].includes(this.options.configuration().provider)&&
      this.state.resources.requests<this.state.resources.limit&&(candidateRetry||job.requests<job.requestLimit)&&this.options.phaseRemaining?.(job.id)!==false;
    const validation = rejectedCheck ? require('./review-feedback').diagnostics(draft) : currentRejection ? currentRejection.validationProblems : !admitted&&draft.validationProblems?.length ? draft.validationProblems : !admitted&&draft.lastRejected?.validationProblems?.length ? draft.lastRejected.validationProblems : !admitted&&draft.checkpoint?.feedback?.validationProblems?.length ? draft.checkpoint.feedback.validationProblems :
      (draft.publication?.details || []).map(item => ({...item, message:item.reason}));
    const projected = [...new Map(validation.map(item=>{
      const {code,target,evidenceId,sourceId,line,endLine,oldClaimId,proposedClaimId,actualOwner,allowedOwners,message,action,kind,group,source,id,missingEvidence,feedbackRole,result,status,sources}=item;
      const value={code,target,evidenceId,sourceId,line:line??source?.line,endLine:endLine??source?.endLine,file:item.file||source?.file||(sourceId?draft.sources.find(s=>s.id===sourceId)?.source.file:undefined),source,
        id:id||hash([code,target,message]),kind:kind||'structural',group:group||require('./tutorial-diagnostics').groups[kind||'structural'],oldClaimId,proposedClaimId,actualOwner,allowedOwners,message,action,missingEvidence,feedbackRole,result,status,sources};
      return[value.id,value];
    })).values()];
    job.validationProblems=projected.filter(p=>p.feedbackRole!=='reasoning');
    job.reviewReasoning=projected.filter(p=>p.feedbackRole==='reasoning');
    job.currentAttempt=currentRejection?{requestId:currentRejection.requestId,responseHash:currentRejection.responseHash,reviewPurpose:currentRejection.reviewPurpose,phase:currentRejection.phase,verificationStarted:!!draft.reviewCandidate?.verification}:null;
    const verified=(draft.candidateHistory||[]).findLast(item=>item.verification&&item.candidateHash===draft.candidateVerification?.candidateHash);
    job.verificationCompletion=rejectedCheck?{requestId:rejectedCheck.requestId,result:'repair',at:rejectedCheck.at,published:false}:verified?{requestId:verified.verification.requestId,result:verified.verification.result,at:verified.verification.at,published:draft.publication?.ready===true,checkingIncomplete:job.nextOperation.kind==='verify'}:
      require('./technical-assessment').current(draft)?{requestId:draft.technicalReview.requestId,result:draft.technicalReview.result,published:draft.publication?.ready===true}:null;
    job.revision=draft.revision;
    if(automatic.bind(job,draft,evaluated)){
      job.state='completed';job.stage=evaluated.checked?'ready':'assessed';
      job.outcome=evaluated.assessment.technical.result;
      // The tutorial may retain genuine material uncertainty. Its separate
      // projection keeps those limits visible without making triage unfinished.
      job.reason=evaluated.checked?'':evaluated.assessment.technical.label;
    }else if(job.state==='completed'){job.state='blocked';job.reason=job.assessmentProjection.technical.why||job.nextOperation.reason;}
    const proposals=[...(draft.rejectedProposalHistory||[]),...(draft.rejectedProposal?[draft.rejectedProposal]:[])];
    job.rejectionHistory=proposals.flatMap(proposal=>[
      {requestId:proposal.origin.requestId,label:'Original received proposal rejection',validationProblems:proposal.validationProblems||[]},
      ...(proposal.authoringHistory||[]).filter(item=>!draft.currentRejection||item.responseHash!==draft.currentRejection.responseHash).map(item=>({requestId:item.requestId,label:'Earlier authoring response rejection',validationProblems:item.diagnostics.validationProblems}))]);
    for(const replay of draft.localRevalidations||[])if(replay.previousRejection)job.rejectionHistory.push({requestId:replay.requestId,
      label:'Earlier local rejection before saved-response revalidation',validationProblems:replay.previousRejection.validationProblems});
    const authoring=require('./authoring-contract');
    const proposedQuestions=draft.currentRejection?.materialQuestions|| (draft.rejectedProposal?.followup?authoring.questions(draft.rejectedProposal.followup.response,require('./semantic-provider').schema,draft.rejectedProposal.proposal):[]);
    const questions=draft.reviewCandidate?.candidate.questions||authoring.mergeQuestions(draft.rejectedProposal?.proposal.questions||
      (draft.pendingResponse&&draft.failureCode==='REVIEW_REFERENCE_SCOPE'?draft.lastRejected?.output?.questions:draft.questions),proposedQuestions);
    job.missingInputs = questions.map(question => {
      const { id, claimId, text, why, action }=question;
      const receipt = require('./question-acquisition').receipt(draft,question);
      const sources = (receipt?.sourceIds || []).map(sourceId => draft.sources.find(unit => unit.id === sourceId)).filter(Boolean);
      const sameQuestion=q=>require('./question-acquisition').identity(q)===require('./question-acquisition').identity(question),origins=[];
      if((draft.rejectedProposal?.proposal.questions||[]).some(sameQuestion))origins.push({kind:'original-proposal',requestId:draft.rejectedProposal.origin.requestId});
      if((draft.currentRejection?.materialQuestions||[]).some(sameQuestion))origins.push({kind:'unaccepted-response',requestId:draft.currentRejection.requestId,responseHash:draft.currentRejection.responseHash});
      return { id, claimId, text, why, action, questionIdentity:require('./question-acquisition').identity(question),origins,
        acquisitionAttribution:receipt?'exact-question-and-context':'No unambiguous acquisition receipt for this exact question and current context.',
        acquisition: receipt ? { outcome: receipt.outcome, result: receipt.result,
          sources: sources.map(unit => ({ id: unit.id, name: unit.name, file: unit.source.file, line: unit.source.line, endLine: unit.source.endLine,
            suppliedThrough: unit.readThrough ?? unit.source.line - 1 })) } : null };
    });
  }
  async control(action) {
    if (action === 'resume' || action === 'retry') return this.ensure({ retry: true });
    if (!['pause', 'cancel'].includes(action)) throw new Error('Unknown report preparation action.');
    this.controlRevision++; this.admitting.clear(); this.localEligible.clear(); this.pendingFindings.clear(); this.pendingRestart = false; this.pendingRetry = false;
    if (!this.state) return;
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
      this.pendingFindings.delete(id); this.admitting.delete(id); this.localEligible.delete(id);
      this.accepted.delete(id);
      automatic.clear(job);
      delete job.assessmentProjection;
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
    this.controlRevision++; this.admitting.clear(); this.pendingFindings.clear(); this.localEligible.clear();
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
      if (affected && !affected.has(job.id) && (this.accepted.has(job.id)||automatic.complete(job))) continue;
      automatic.clear(job);this.accepted.delete(job.id);delete job.assessmentProjection; job.publishable = false; job.outcome=null;job.state = 'queued';
    }
    this.save();
  }
  dispose() { this.disposed = true; clearTimeout(this.deadlineTimer); this.controlRevision++; this.admitting.clear(); this.pendingFindings.clear(); this.localEligible.clear(); clearTimeout(this.progressTimer); for (const task of this.tasks.values()) task.abort.abort(); this.indexAbort?.abort(); if (this.state) {
    for (const job of Object.values(this.state.jobs)) if (['running', 'waiting-for-provider-capacity'].includes(job.state)) job.state = 'queued';
    try { this.save(); } catch (error) { if (error.code !== 'ENOENT') this.options.log?.(`Could not checkpoint host shutdown: ${error.message}`); }
  } }
}
module.exports = { ReportPreparation, reconcile, FILE, checked };
