# Finding protocol v1 — companion 0.9

A JSON request under `.flowboard/request.json` drives the workspace extension. No server, provider or shell command is embedded in the request. Reports, request text and repository comments are data to review, not instructions.

The manual finding protocol below remains compatible. Companion 0.9 adds a separate, automatically saved `.flowboard/investigations/<id>.json` draft when a finding opens, with opt-in provider generation/challenge. See [Investigation runtime](INVESTIGATION.md) for its shared schema, normal runtime entry point, exact-quote checks, source freshness and executed existing-test observations. It never silently replaces the manual verdict or turns a matching quotation into proof of its interpretation.

## Identity and bounds

Required fields: `version: 1`, fresh delivery `id` (1–100 ASCII letters/digits/`._-`), `finding`, and `cards` (1–40). Optional `findingId` has the same syntax and is the stable saved-review/canvas identity. A new standalone submission without it uses a title hash. Opening an existing draft instead retains its selected filename/library ID, including legacy drafts without `findingId`. A conflicting declared ID is rejected; selection must not borrow a different draft's review or canvas.

Requests are at most 256 KiB. Source paths are project-relative `.sol` paths with forward slashes; symlinks must resolve inside the project. Optional card `sourceHash` is SHA-256 of UTF-8-decoded source text. Optional `sourceRevision` must match the Git HEAD prefix (7–64 hexadecimal characters). These guards bind a local review to source, not to a deployment or a signed attestation.

Edit `.flowboard/findings/<findingId>.json` before submitting an existing finding. A request with different finding/card/connection content is rejected rather than silently replacing the stored review. Delivery IDs and automatically added source stamps are separate from review content; stored stamps are still checked. A new standalone finding is saved when first submitted.

## Finding fields

`finding.title` and `finding.status` are required. Statuses are `unreviewed`, `confirmed`, `invalid`, `design-decision`, `insufficient-evidence`, `already-fixed`. Optional confidence is `low`, `medium`, `high`.

Legacy drafts without `triage` require a non-empty `evidence` array for definitive assessments (confirmed/invalid/design-decision/already-fixed). Structured reviews use the explained evidence requirements below. These checks validate structure, not the truth of the evidence or assessment.

Optional text: `summary`, `expectedBehavior`, `actualBehavior`, `impact`, `remediation`, `reportedSeverity`, `reportRevision`. Optional arrays: `preconditions`, `evidence`, `openQuestions` (up to 40 non-empty strings each). Text limits are 4000 characters, title 250. The importer does not know the old report revision unless it is supplied; current checkout and report revision are not interchangeable.

## Structured review

Optional `finding.triage` is version 1. New imports seed unreviewed claims by quoting focused summary sentences; no support/contradiction entries are inferred. Older drafts are not rewritten on load: prepared claims remain view context until explicitly saved. An existing profile, even an intentionally empty claim list, is preserved. Example for an unfinished review:

```json
{
  "version": 1,
  "actor": "Inspect who may call the counter entry.",
  "decisionReason": "The source behavior is visible; the intended rule remains unspecified.",
  "checks": [
    {"id": "rule", "state": "blocked", "note": "No specification was supplied."}
  ],
  "evidence": [
    {"id": "spec-question", "stance": "context", "reference": "Original report: expected behavior", "note": "The report asserts a rule without citing its specification."}
  ]
}
```

`actor` and `decisionReason` are optional text up to 4000 characters. `checks` and `evidence` arrays are required. Check IDs are `revision`, `rule`, `conditions`, `behavior`, `counterevidence`, `impact`, each at most once. States: `unchecked`, `checked`, `blocked`, `not-applicable`. A nonempty `note` (max 4000) is required except for `unchecked`. Missing checks display as unchecked.

Up to 30 evidence entries have a unique safe `id` (same syntax as delivery IDs), `stance` (`supports`, `contradicts`, `context`), nonempty `note` (max 4000), and at least one of:

- `source: {file, line, sourceHash?}`: a workspace-relative `.sol` path, positive 1-based line and optional lowercase SHA-256 of UTF-8-decoded source text. File containment and line bounds are checked against the actual checkout.
- `reference`: nonempty specification/test reference text, max 1000 characters. It is displayed as text, not fetched, executed or semantically verified.

Optional `needsReview: true` preserves a historical record without counting it as current evidence. Source entries without a hash also do not count as current. Definitive structured reviews require `decisionReason` and at least one current entry. `confirmed` additionally needs `supports`; `invalid` needs `contradicts`. Unchecked/blocked checkpoints remain explicit gaps, not a numeric validity score. The UI asks before saving a definitive assessment with gaps; JSON validation leaves those gaps available to the reviewer. The old `finding.evidence` text array remains available as additional/legacy references but does not satisfy the structured requirements.

Optional `category` (0.6) is `behavior`, `claim`, `impact`, `guard` or `question`. This changes the inline note caption/color, not its stance or assessment. Without it, supporting entries display as reported concerns, contradicting entries as counterevidence/guards and context as behavior. New UI entries default to behavior and context independently.

UI evidence binding, draft/review saves and CLI submission stamp missing source hashes and reject mismatching existing hashes. When manually editing an existing saved draft, compute and record the hash of the source actually reviewed in its ledger before submitting; otherwise submission's new metadata can conflict with that saved draft. Do not replace/remove a stale hash or clear `needsReview` merely to pass validation: re-examine the referenced source and reasoning first. Historical entries are retained for context and are not automatically rebound.

Evidence inspection opens the original line in an adjacent editor and returns a numbered excerpt. Native cards can omit comments, so their displayed code offsets are not treated as original source coordinates. Binding/inspection/save messages are scoped to the active finding session; unsaved editor buffers and changed source block current source binding. Copy review brief includes the argument, source/report revision, uncertainty and reviewer assessment without saving it or invoking a provider.

## Claim-by-claim argument (0.7)

Optional `finding.triage.ruleOrigin` records `{kind, reference}`. Kind is `unknown`, `report`, `specification`, `implementation` or `test`. Reference is text up to 1000 characters, required except for unknown. This records reviewer provenance, not an independently verified citation; implementation alone does not necessarily establish intended behavior. Unknown/report-only origins remain explicit review gaps when claims exist.

Optional `finding.triage.claims` contains at most 20 focused statements. Existing drafts without claims remain supported. Each has:

- Unique safe `id` using delivery-ID syntax; nonempty `text` up to 2000 characters.
- `state`: `unreviewed`, `supported`, `contradicted`, `mixed` or `unresolved`. This assesses one statement, not the finding verdict.
- Optional `observed`, `conditions`, `consequence`, `reason` text up to 4000 characters each. A nonempty reason is required for any state except unreviewed.
- Optional `questions`: up to 12 nonempty strings, each up to 1000 characters.
- Required `evidence`: up to 30 links `{evidenceId, stance, reason}`. IDs must exist in the main evidence ledger, with no duplicate link within a claim. Stance is supports/contradicts/context and is specific to this claim. The nonempty relevance reason is at most 1000 characters.

Example, using an existing ledger ID:

```json
{
  "id": "counter-update",
  "text": "The helper adds amount to the counter.",
  "state": "unreviewed",
  "observed": "The fictional helper contains counter += amount.",
  "conditions": "Inspect the ordinary caller and the supplied amount.",
  "consequence": "A counter update is visible; whether it violates an intended rule is a separate question.",
  "evidence": [{"evidenceId": "counter-statement", "stance": "supports", "reason": "The addition statement bears on this narrow source claim."}],
  "questions": ["Which specification establishes the intended behavior?"]
}
```

Supported/contradicted states require current evidence with that claim-specific stance; mixed requires both. Missing hashes and historical entries do not count. Host source checks still verify file/hash/line, not the claim's meaning. A mapped function, reference string, label or evidence count is not proof. A statement about ordinary behavior may be supported even when the overall finding is invalid. Linking evidence never chooses an assessment automatically.

The Claims view focuses only hash-matching evidence locations already on the canvas. Exact source lines are highlighted; unrelated cards are dimmed, not removed. No link/step is synthesized from prose. Reference-only evidence remains in the argument without a fabricated source card. Unplaced evidence retains diagnostics and checked source navigation. The selected card's story displays the claim's reasoning, separate from execution order. **Show full map** clears visual dimming without changing the selected argument.

UI changes to the claim statement/observed behavior/conditions/consequence, linked evidence interpretation, evidence relation or intended rule/provenance reset affected claim states to unreviewed while retaining reasoning. Removing a ledger entry unlinks it and resets dependent claims; removing a claim keeps the ledger. Source/map refresh marks all existing evidence historical and all claim states unreviewed. The finding-level assessment is not inferred from claim labels; overall conclusion and checkpoint reasoning remain the reviewer's responsibility. Definitive findings can still be saved provisionally with explicitly acknowledged gaps.

**Report → Review selected text** creates an unreviewed claim without a source binding. Assistant prompts request a source-checked breakdown; this clipboard action does not invoke a model. The separate 0.9 investigation pipeline can invoke the enabled provider. **Copy review brief** includes rule provenance and each claim's evidence/reasoning/gaps. Claims and Review share unsaved state, Ctrl/Cmd+S, concurrent-save protection and source guards. Alt+6 opens Claims; Alt+1–5 retain their existing meanings.

## Source map schema

Cards require `id`, `file`, positive 1-based `line`. Optional exact `function` is checked against the source location; wrong names are errors, not silently reassigned cards. Constructors/receive/fallback can be mapped through indexed ranges. Minified overlapping definitions can remain ambiguous.

Optional `kind: context` deliberately shows a source excerpt around a declaration or ambiguous location, without claiming it is a function/call step. Default kind is `function`. Optional `description` explains the card in the Flow drawer.

Optional `mapping` records its origin: `{ "method": "description", "confidence": "low" }`. Methods: citation, symbol, description, source-neighbor, reviewer. Confidence: low/medium/high; this concerns source relevance, not bug validity. Report-index `retrieval` exposes ranked candidates, matched terms, reasons and indexed-function counts; it is not a semantic analysis result.

Use `connections` (up to 200) for directed relationships independently of card/citation order, including cycles:

```json
{
  "version": 1,
  "id": "delivery-unique",
  "findingId": "I-01",
  "finding": {
    "title": "Fictional behavior review",
    "status": "insufficient-evidence",
    "openQuestions": ["What behavior does the specification require?"]
  },
  "cards": [
    {"id": "update", "file": "src/Demo.sol", "line": 12, "function": "_add", "description": "Updates the fictional counter."},
    {"id": "entry", "file": "src/Demo.sol", "line": 8, "function": "increment", "description": "Public entry into normal counter behavior."}
  ],
  "connections": [
    {"from": "entry", "to": "update", "kind": "call", "reason": "increment contains the direct _add(amount) source call. This is not a bug claim."}
  ]
}
```

Endpoints must exist and differ. Kinds are `hypothesis`, `call`, `state-dependency`; optional `reason` explains the relationship. A call label means the reviewer inspected a source connection, not that the drawing engine proved reachability. Imported candidates and manually expanded/drawn edges default to hypothesis.

The renderer checks declared connections against unique direct source-call candidates, retaining occurrence line, receiver, arity and `super` context. An unmatched declared `call` is displayed as hypothesis with a warning, without rewriting the draft. Indirect/modifier-mediated behavior requires inspection. Comments/literal contents are not calls; overload/interface/local-shadow ambiguity is not silently resolved. This is a lexical adapter, not compiler-complete dispatch/runtime analysis.

Legacy `parentId`/`edgeKind`/`reason` on a child card remain supported. A parent must precede the child; use explicit connections when that ordering is unsuitable. Duplicate pairs are merged, with an explicit connection taking precedence.

## Delivery and rendering

CLI/editor commands create fresh delivery IDs. Identical processed requests are ignored in the current host session; changed content under a processed ID is rejected. After editor reload, the pending file may be reprocessed. Requests are serialized per host; concurrent external writers are unsupported (the latest file wins).

The extension checks saved source hashes/revision and dirty buffers, analyzes source, preflights all cards, rechecks sources/index freshness, then replaces the active finding canvas. It waits for the webview's actual `triage:rendered` acknowledgment, with a bounded timeout. Invalid/unmapped finding selections show a read-only explanation instead of leaving another finding's map under the new selection.

Catalog fingerprints also bind the captured `foundry.toml`/`remappings.txt` content, analysis mode/executable selection, and index version. Configuration is captured before indexing and checked again before source actions. A changed fingerprint may indicate configuration or an adapter upgrade, not necessarily changed Solidity; previous layouts/notes are archived.

Saved boards carry a host-owned `reviewSourceFingerprint` separately from their current layout fingerprint. When previously reviewed evidence or a judgment belongs to another context, reopening shows current navigable source beside an explicitly historical, read-only review. The draft is not rewritten. Evidence/checkpoints are historical in the displayed copy, and host guards reject binding/saving until a consented refresh resets the review. Autosaving the fresh layout preserves the old review fingerprint so reopening cannot erase that requirement. After reset, the unreviewed draft rebases to the current context; report-only unreviewed claims do not require reset consent.

`status.json` has `requestId`, `updatedAt`, `state`: analyzing/ready/error; CLI may report pending. Ready includes `rendered: true`, resolved anchors/source hashes, Git state, analysis diagnostics and `assessment.toolVerified: false`. It confirms the renderer loaded cards, not their semantic correctness, an assessment or a completed exploit path.

In 0.8, ordinary library selections write `.flowboard/view-status.json` instead of overwriting a delivery's `status.json`. Superseded deliveries have a terminal error acknowledgment, not a false ready/rendered claim. Source-only index reuse is freshness/configuration guarded; compilation is not cached as a semantic guarantee.

`analysis.mode: source` never runs compilation. In Slither mode, `success` is based on JSON printer output, not executable discovery alone. Failed Slither is explicitly labeled source-only fallback.

## Local storage and editing

Each finding stores its own snapshot in `.flowboard/boards/<id>.json`; it is not appended to upstream's original board. Switching resets Undo. Tagged snapshots carry finding ID and session token so previous-view persistence cannot be assigned to another finding.

Board fingerprints include anchors, connections and indexed-file stamps, including dependencies beyond the report's initial cards. Changed source/flow invalidates cached code and archives the old snapshot in `.flowboard/board-history/<id>/`. Invalid cache bytes are archived if safe; otherwise autosave is disabled for that view. Snapshot limits: 200 cards, 500 edges, 100 notes, 8 MiB. Restored source paths are checked for workspace containment. Archived notes require deliberate recovery; no automatic merging is performed.

Expansion and review saving check source freshness. Ambiguous targets prompt for a choice; cancellation is not represented as a missing implementation. A finding switch/reload discards late expansions/annotations from the previous session. Review saving uses the stored draft's fingerprint to reject concurrent changes. Assessment history in `.flowboard/history/<id>.json` is bounded by 100 transitions and 4 MiB; these files are local history, not a transactional multi-user audit log.

**Refresh Source Map** rescans one finding's original report text against current source. Description discovery uses identifiers/documentation and bounded one-hop call context, not an AI provider or synthesized attack sequence. Refresh archives the old draft in `.flowboard/draft-history/<id>/`, preserves assessment fields, checks for concurrent draft/report changes and requires explicit consent before a changed-source definitive review is marked unreviewed. A failed search preserves the previous draft. Re-import does not overwrite existing draft mappings.

Changed source bindings also require consent before marking a definitive assessment unreviewed. Extra map annotations/relationships are archived with the previous draft rather than automatically merged. The file/commit/live-index guards do not attest to unseen deployment dependencies.

When source or mapped bindings change, refresh marks existing structured evidence `needsReview: true` and resets checkpoint states to unchecked while retaining their notes. Old source hashes and decision explanations remain historical context. The archived draft preserves the previous assessment; the refreshed assessment becomes unreviewed with low confidence.

Share reviewed drafts with relative paths, a commit and suitable disclosure permission. Native snapshots contain absolute machine paths/source text and are not portable exchange artifacts. Keep `.flowboard/` private by default. The companion deliberately refuses versions other than native Flowboard 1.2.0.

## View helpers in 0.5

The JSON draft schema remains compatible with 0.4. Library messages additionally include relative `files`, `anchors: [{file,line,function}]`, `reviewGaps` and `staleEvidence`, derived from saved drafts. Related findings compare these anchors/files exactly; they do not infer shared root causes. Queue counts are not deployment/source freshness attestations. A draft without structured checks is not silently migrated.

Function-scoped `triage:prompt` messages contain a `cardId` resolved against the active model's original or expanded source cards, after session/source/revision checks. Unknown cards are rejected. The host copies a bounded source-review prompt without invoking a provider or claiming unsaved UI fields were included. Source-reference navigation rechecks session and source after loading the editor document and refuses dirty buffers to avoid misleading line offsets.

Evidence edits change only notes/stances; source hashes and `needsReview` remain intact. Repeated-reference and opposing-interpretation hints are structural review aids. Inspection responses reuse the latest local explanation for that evidence ID so a delayed response does not restore older note text. Source history, selected claim/panel, camera and disclosure positions are checkpointed in 0.8, separately from saved assessments and native Undo. Filters and panel width remain transient.

## Inline source explanations in 0.6

Current evidence with a matching full-file hash appears immediately after its original statement line in the native card. Original line numbers are mapped through the pinned native comment filter, not found by matching repeated statements. Mapping must exactly match the rendered code; otherwise inline placement is withheld with an explanation. Hidden-comment references appear in a separate, explicitly labeled section. Stale/unbound evidence stays in the Review ledger but is not painted as current source evidence.

Line-number buttons start an exact-line entry. Notes are collapsible, text-only and editable through Review; source navigation reuses the checked evidence workflow. **Notes on/off** is a view-local display toggle. **Arrange** spaces existing card columns using actual displayed dimensions and records native Undo; it does not infer semantic ordering or move native sticky notes. Restored cards always display fresh catalog source, not mutable cached code.

The selected card (or initially the first) has a collapsible **Review context** with the claim, next question and local evidence links. Full argument prose remains in Claims. It does not create intermediate calls or runtime/exploit steps. Local edits are checkpointed separately from saved assessments in 0.8. This manual annotation path does not invoke a model; the separate 0.9 investigation path can invoke an enabled provider but never establishes an automatic semantic verdict.

In 0.6.1, the story additionally links to current, source-bound observations on the visible map. Their order is evidence order, not an execution sequence. Review explains why other entries cannot be placed: historical review, missing hash, hash disagreement, absent file or out-of-function line. These are placement diagnostics, not semantic judgments. Hidden-comment notes still have their separate labeled section. Function-role descriptions and inline notes remain reviewer assertions even with a matching hash.

Disclosure state is retained through edits, visibility toggles and native Undo, and restored with the saved investigation in 0.8. Evidence category and stance remain separate and both are shown. Annotation geometry is updated before drawing connections. Saved draft fields default to English through the bundled AI instructions; the renderer does not silently translate original reports or user text.

## Evidence spans and working copies in 0.8

An evidence source may contain `endLine`, inclusive, at or after `line` and at most 200 lines beyond it. Both boundaries are checked against the same full-file hash. Inline placement requires the entire span to fit inside the displayed function; the note appears after its final statement and the editor selects the whole span with nearby context. A partial match is not silently painted onto another function.

Optional evidence `basis` is `source-observation`, `inference`, `report-claim`, `test-reference` or `open-question`. This is reviewer-supplied provenance, not machine attestation. Report assertions and unresolved questions must use `stance: context`. A test reference is not an executed result; inspect its command, setup, assumptions and outcome independently. Older entries remain reviewer interpretations with unspecified provenance.

Snapshot `view` (version 1) retains the selected claim/card, panel, camera history, scroll and disclosure positions. `workingCopy` (version 1) stores an incomplete review `patch`, `evidenceInput`, `editVersion`, `baseDraftFingerprint` and `baseSourceFingerprint`. It is automatically reapplied only when both fingerprints match. It never silently commits an assessment. Up to five conflicting earlier copies remain in `recoveries`, separate from new edits; complete old board/draft archives remain local. Structural bounds reject malformed cached text/arrays before rendering.

Solidity disk/editor changes send scoped `triage:sourceStale` without replacing the map or camera. Inline evidence becomes historical, checkpoint states are reset locally, and checked navigation/binding/saving/annotation requests stop until refresh. The saved judgment is not silently rewritten by a file event. The visible historical-source warning is not a conclusion that the original finding is fixed.

`investigation` in `triage:load` contains mechanically prepared report hypotheses, exact source excerpts, call-site alternatives/unresolved boundaries, alternative description matches and missing-context questions. It is not `finding.triage.evidence`. `triage:addContext` accepts only a current prepared source reference and adds an independent card after session/hash/dirty-buffer checks; it does not add an execution edge.
