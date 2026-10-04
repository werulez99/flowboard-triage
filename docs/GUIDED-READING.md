# Checked finding walkthroughs — 0.14

Import a report. The configured provider starts bounded background preparation of every legitimate finding, without a selection event. Step 1 opens on the existing canvas only when the complete report passes publication, unless the researcher deliberately started exploring. **Walkthrough** and **Read code** enter the same experience. Before publication, a compact status dock distinguishes running work, paused budget, failed requests and missing material evidence. It does not replace the graph. Read report and Explore code remain available. No prompt, manual annotation, form or human verdict is required.

## The reading route

Previous step and Next step present material events, not a simulated debugger trace. The separate causal model records invocation and transaction identity, caller, conditions, parameter origins, symbolic values, reads/writes and intermediate versus committed effects. Repeated calls are separate events. A typed handoff explains each move: call, callback, return, branch, data, later transaction or context. An alternative scenario is not a later executed call. Missing material context blocks publication; it is not an unfinished step. Decisive counterevidence must be included before the result.

Guided mode focuses an original native function card at readable scale; neighboring nodes remain visible and retain their positions. Code stays continuous, with original lines/comments, optional wrapping and in-card scrolling. The adjacent annotation is connected to the rendered highlighted row, not a stored pixel coordinate. The checked active handoff has a typed label and a distinct overlay; static candidate edges do not become execution claims. On narrow windows code and annotation stack. **Explore freely** preserves the step; **Resume walkthrough** and **Return to step** restore its invocation, lines, code scroll, annotation and camera. Previous restores a prior step's reading position, not protocol state. Native history and Undo remain available. Alt+Shift+Left/Right changes steps outside inputs and selections; Alt+Left/Right history remains separate.

The original report paragraph is displayed without rewriting it. An exact unique phrase can be highlighted inside its recorded paragraph. Repeated or unavailable phrases do not get guessed. **Read full report → Linked report statements** links back to their steps. Older results without paragraph references show that limitation instead of fabricating quotations.

## Preliminary AI opinion

The opinion has four parts: **Preliminary assessment**, **Why**, **Decisive code**, and **What remains**. It is not the saved researcher judgment. A supported bookkeeping statement alone does not confirm a bug; a contradicted local route cannot invalidate another unresolved implementation. Preparation/provider failure is distinct from a completed but inconclusive assessment.

Generation and evidence-grounded challenge use the bounded provider workflow. At most one response repair and two new-local-evidence checks are allowed, within the shared report allowance. A check needing unavailable information stops rather than repeating the same prompt. The host checks exact quotes, full-function identity, closed obligations, linked checks, event/transaction consistency, report identity and the matching preliminary assessment. A declaration may be a read step, not an executed operation or committed outcome. A matching location and model agreement do not prove an interpretation. Navigation never calls the provider.

Exact named definitions precede lexical candidates. Missing mandatory definitions block preparation rather than substituting generic tests. Import/remapping context narrows duplicate definitions and struct receiver types; interface declarations remain context, not concrete implementations. Questions read available local functions, declarations and explicit code locations before challenge. Helper completion is breadth-first, reserves eight of the forty source slots for later questions and avoids recursive expansion of every library detail. Limits remain explicit. Each excerpt is at most 800 lines/32,000 characters, with 110,000 code characters overall. Required incomplete functions cannot appear in a ready guide. Local documentation can support an expected rule only when its actual text applies. Reports and proposed fixes are not independent specifications.

## Atomic publication

`guide-policy.js` maintains the `checked-explanation-v3` gate. Each material statement needs evidence-linked applicability, entry, conditions, behavior, settlement, expected-rule, impact and counterevidence obligations. An obligation must be established, refuted, or justified as nonapplicable; an open obligation blocks the guide. A supported violation requires an independent rule and consequence. A refutation requires decisive counterevidence for the reviewed scope. A function invocation cannot silently switch to another function's source card or another transaction. Modifier steps can stay within the enclosing invocation. Older published guides are rechecked under the new policy; human decisions are not changed.

The first challenge returns compact checks; a disagreement returns specific problems. A targeted repair (`review-patch-v1`) changes only affected fields using stable IDs and the full target schema. Unchanged fields stay exact. Every note and causal target still needs fresh evidence-linked checks; missing checks cannot inherit approval. The host validates the assembled full model and exact references before the same publication gate. Legacy `review-delta-v1` responses remain readable. This reduces repeated output, not required reasoning. Complex requests can still time out.

Partial work and checked individual artifacts stay private until **every** legitimate finding is publishable and no import ambiguity remains. The host strips generated claims, notes, predictions and summaries on all unpublished report surfaces. `.flowboard/report-preparation.json` publishes one compatible manifest atomically. One blocked, failed, stale or paused job withholds the report without destroying compatible work. A digest seals each artifact; changed explanation text invalidates it even if its quotation matches. Older incomplete results cannot be relabeled ready. This is an evidence-handling gate, not a formal verifier or a truth oracle.

## Durable preparation and limits

`.flowboard/report.json` retains the full original report and a heading manifest. Group headings do not become synthetic findings. Reconciliation archives the previous index and leaves human draft/board files untouched. Ambiguous sections prevent publication instead of silently shrinking the denominator.

One local host owns the worker through a PID/attempt lock. Jobs run serially; one operational retry goes behind independent first attempts. Generation and newly read context are checkpointed before challenge. Host restart revalidates saved source/report/configuration and resumes unfinished stages. Closing the webview does not cancel jobs; stopping the extension host stops execution. Pause lets a current request finish, but starts no new request. Cancel aborts and invalidates late results. Both retain accepted work.

`flowboardTriage.reportRequestLimit` defaults to 12 requests shared by the report, never per finding. Explicit Resume adds one configured allowance and retains cumulative counts. A per-finding allowance of six requests prevents monopolizing a run. Codex requests have a 240-second wall deadline; Claude has a 180-second deadline and configured per-request USD cap. Codex has no dollar cap. Audit entries record request identity, stage, input size, timing, last available progress event and token/cost usage where supplied. A quiet provider is not reported as semantic progress. Unknown cost stays unknown.

The independent command uses the same backend, not a second review engine:

```sh
FLOWBOARD_EXTENSION_PATH=/path/to/native/extension node scripts/prepare-report.js /absolute/project --provider codex --requests 12
```

Add `--resume` to explicitly extend the allowance; `--first ID1,ID2` changes initial order only. The entire manifest remains the publication denominator. A report containing genuine unavailable dependencies may never qualify until that information is supplied.

## Freshness and persistence

The investigation is bound to the finding, source contents, report, project configuration and local documentation snapshot. File changes invalidate old links, including unsaved Solidity or relevant documentation/report edits. References are not moved to nearby matching text. A report change does not overwrite saved researcher decisions.

`investigation.causal` contains the checked events, typed relationships, obligations and checks. `investigation.walkthrough` retains the exact report text and preliminary assessment for compatibility. `state.view.walkthrough` saves the route key, step, mode, wrapping and exact reading/return positions. Project identity, source/dependency/configuration contents, documentation, report text and policy version bind the snapshot. Existing human notes and version-1 reviews remain readable. Finding/token and navigation-request IDs prevent late replies from replacing a newer selection.

## Verification boundaries

`npm test` covers source resolution, exact references, report-wide publication, bounded repairs, checkpoint recovery, report/selection races and preserved human work. `scripts/checked_guide_browser.py --batch --report-preparation --output <directory>` imports two fictional findings and runs the actual configured provider, backend and native renderer. It opens the never-selected second finding with no new request. `--case d7` or `--case h3` selects a single fictional case. `--recorded <fictional-result.json>` replays explicitly labeled responses, translating IDs only for identical code; it is not fresh reasoning. The harness checks exact highlights, full functions, faithful quotations, detours, keyboard navigation, four viewports, themes, reopening and freshness. External `--workspace --report --finding` input is read-only and does not claim report-wide publication; private captures must stay outside distributable files.

Browser harnesses simulate editor transport; they are not a live Cursor window. Installation and activation are separate: inspect the explicit `Activated Flowboard Triage <version> from <path>` Output entry after the researcher reloads the editor. Do not force a reload or publish private review artifacts.

Remaining limits include heuristic source discovery, ambiguous external dispatch, bounded excerpts, model interpretation errors and unavailable deployment/specification context. This tool explains defensive source review; it does not generate attacks, execute vulnerability reproductions or certify universal correctness.
