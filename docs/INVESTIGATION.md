# Source investigation runtime — 0.19.2

## Checked content and corrections (0.19.18)

`review-content` defines the lossless semantic projection shared by acceptance,
candidate comparison and publication. Wire `evidence.explanation` maps verbatim
to stored `note`; line spans map to `source.line/endLine`; conclusion wire status
maps to `scopedStatus`. Causal order/fields are preserved; the legacy walkthrough
outline is deterministically derived from those same events, not independently
authored. Absent legacy documentation/causal fields map to empty/null. Exact
source-line quotation whitespace is canonicalized before source binding, not
after verification. Nonsemantic host provenance and fresh check records are
separate from this content identity.

Supported semantic text is bounded at 16,384 characters, IDs at 100 and existing
finite list capacities remain enforced. Schema, candidate assembly and ordinary
acceptance reject unsupported content rather than slicing it. Promotion compares
the actual stored projection with the frozen candidate and seals its content
hash. Proven divergence against retained checked candidate history withholds
publication; unaffected legacy guides are not globally invalidated or regenerated.
Missing historical content is never invented.

A supported human correction archives the old active candidate/check eligibility,
premise identities, accepted argument and pending-response reference in the same
atomic finding write. Saving a correction is local, not provider authorization.
The corrected finding stays readable and dependent claims require reassessment.
Old broken correction records recover locally only when reversing the exact
recorded correction reconstructs the retained base and premise identity; other
candidate drift stays read-only with a precise recovery state. No stale check can
approve changed premises. Paid raw answers and user decisions remain separate.

Authoring eligibility depends on a real acquired local dependency or a recorded
premise amendment, not the presence of any question/limitation. Full verification
still checks an unavailable external dependency; `conclusion.limitations` stays
a material publication blocker. Complete scope conditions are not automatically
converted from those blockers. Unchanged checked blocked dispositions can stop
locally after bounded acquisition finds no new evidence.

This is a bounded defensive review of a selected report, not an autonomous vulnerability scanner. Quotes and source identity are checked mechanically; their interpretations are not automatically proven. Generated work never changes the researcher's manual finding verdict.

Current additions: caller-path and bounded internal-helper effects, exact failed-navigation retry, pre-generation acquisition of named local premises, and shared direct/helper failure-payload classification. Earlier failure reachability, call-time parameter writes, typed catches, exhausted-allowance local recovery and no-guide navigation cancellation remain. Current policy is `checked-explanation-v9`. A sealed v7/v8 artifact can be migrated only after current source, construction metadata, path and failure-class checks succeed locally; old unchecked guidance does not become Ready by migration. Version 0.19.2 does not change this policy or invalidate compatible guides for a diagnostic-only transport change. The provider and editor verification record is in [Guided reading](GUIDED-READING.md); the historical quality matrix below is not a current-model certification.

The explicit developer-only full-response-contract diagnostic supplies the identical generation schema as text instead of a provider-side schema flag. It retains all generation data and cannot be selected through ordinary preparation or UI settings. Its raw result and shape validation are diagnostic evidence, not a provider-result DTO, a completed substantive review or a publishable guide. Production generation and challenge remain unchanged unless a separately tested, evidence-supported correction is implemented. A timeout is provider preparation failure, not evidence that the finding is false.

## Current publication contract

The historical 0.9–0.11 sections below describe how automatic investigation was connected. In 0.13 an accepted draft is **not** automatically a published guide. `guide-policy.js` requires a complete, evidence-linked causal explanation, a matching preliminary assessment, closed material obligations, exact complete source units and a checked relationship for every reading transition. Partial drafts stay private; every generated display surface uses the same sealed snapshot. Old partial results are refreshed, never relabeled ready. See [Checked walkthroughs](GUIDED-READING.md).

Exact named report targets precede lexical candidates. Import context narrows duplicate implementations and struct fields; bodyless interface declarations are read as context, not execution. Question-directed reading precedes breadth-first helper completion, which reserves eight source slots for later questions. Original report paragraphs are sent once. Version 0.14 introduced compact challenges, ID-addressed targeted repairs, durable accepted-stage resumption and two bounded new-local-code checks independent of the single response-repair allowance. The shared report request limit applies. No-progress or unavailable evidence blocks only the affected finding. Imported reports are owned by `ReportPreparation`, not board selection; see [Guided reading](GUIDED-READING.md) for strict **per-finding** acceptance and immediate availability. Report completion is aggregate progress, never a reading barrier. The runtime matrix and historical sections below describe earlier selected-finding implementations, not the current scheduling contract.

## Capability reconciliation

The inspected 0.8 checkout and installed companion matched at the start of the 0.9 work. Ordinary selection invoked mechanical report preparation and lexical source indexing. `triage:prompt` copied a prompt to the clipboard. Native Code comments could separately invoke upstream Claude, but those comments did not populate an investigation model or a challenge stage. No semantic generation/challenge runner or existing-test runner was connected to finding selection.

The available Git history through `12b5412` and the local helper implementations did not substantiate an earlier report that automatic generation/challenge was implemented. The evidence does not establish that such a pipeline was removed, or why that earlier report overstated the capability. The 0.9 path below is new implementation, not merely a renamed clipboard action.

## Connected runtime path

| Capability | Implementation and ordinary entry point | Evidence / limits |
| --- | --- | --- |
| Selection | `extension.js` Open Findings/library selection → `board.open` | Selection epochs, stable finding ID and render acknowledgement precede background preparation. |
| Discovery | `source.js`, `source-search.js`, `investigation-engine.makeContext` | Bounded production/test candidates plus existing compiler declarations; lexical relevance is not confidence. |
| Compiler context | `compiler-context.loadCompiler` | Reads at most eight existing `out/build-info/*.json` files, at most 64 MiB each. Every input text must match. Does not compile or certify active settings/deployment. |
| Semantic generation | `board.startInvestigation` → `investigation-engine.advance` → `semantic-provider.runProvider` | Runs after ordinary selection when enabled. Audit records phase, input hash, timestamps, outcome and usage. A completed provider result may still be rejected by source/schema checks. |
| Useful source checks | `makeContext.act` after accepted generation | Up to four read-only questions; caller/callee candidates, symbols, identifier occurrences. Source results are supplied to challenge, not treated as proof themselves. |
| Challenge | `advance` second provider call | Reassesses against added source and executed-check records; status changes are retained. Same-provider agreement is not independent evidence. |
| Canvas and navigation | `prepareInvestigationCards`, `focusInvestigation`, `investigationLinks` | Real native cards; exact source spans; separate internal calls and unresolved declaration references. Branch annotations do not claim a complete execution trace. |
| Existing regressions | `board.runInvestigationTest` → `experiment.run` | Explicit confirmation; indexed existing test only; no model commands or generated tests. Outcome saved, then reassessed. |
| Persistence | `investigation-engine.write/read` | Draft saved before generation, between stages and at completion/failure. Independent of manual assessment, identity/snapshot checked, revision compare-and-swap. |

The renderer is still unmodified Solidity Flowboard 1.2.0 with a companion webview layer. No replacement canvas or hosted backend is introduced.

## Checked reading path in 0.11

Import reads the whole current allegation, including root cause, conditions and impact. Proposed changes remain available in the original report but cannot supply current-code citations or function anchors. Qualified primitive signatures distinguish overloads. Ambiguous or unavailable exact signatures do not fall back to similarly named functions. Description search remains candidate discovery, not semantic proof.

The reading recommendation favors an entry or decision point and gives one concrete reason. Relevant internal helpers, modifiers and callers are prepared even when the report already has citations. A uniquely resolved same-contract, nonvirtual internal call can be shown as a call; interface dispatch remains possible or unresolved. Shared declared data adds context, never a call arrow. Alternative interface implementations are not recursively expanded as if all execute. Missing targets and excerpt limits remain explicit. Existing compiler artifacts can improve declaration context but do not prove deployed dispatch.

The model receives exact signatures, call sites, receiver types, report sections and code gaps. Challenge must retain every earlier claim scope and account for every old and new explanation as kept, repaired, removed or added. The host rejects missing checks and a changed note marked unchanged, including moved line coordinates. These checks establish coverage and identity, not truth. A model can still misinterpret code or introduce an unnecessary scope; the reviewer must inspect its reasoning. The UI keeps these notes labeled as an AI draft, apart from optional native AI comments and the human's issue result.

`tests/reading-workflow.test.js` and `scripts/reading_browser.py --fixture-model` exercise normal import/selection, actual controller and native renderer with fictional source. `scripts/fixtures/reading-model-output.js` is a fixed AI response fixture: its first pass deliberately misstates a real assignment and its challenge repairs it. It tests the mechanism, not model accuracy. `--provider codex` instead uses the configured provider; report its actual outcome separately.

## Read available local code before challenge — 0.11.1

The six development cases exposed a repeated preparation gap: the provider could read a helper but not the local mapping or immutable declaration needed to interpret it. Identifier checks often returned no *additional* excerpts even when matching code was already in the input. Mixed questions about local declarations and missing deployment facts were skipped as a whole. This left answerable type and role-lifetime questions open.

After generation, `makeContext.complete` now reads declarations mentioned by the selected entries and evidence functions. It follows uniquely resolved internal calls up to three levels, inspecting at most 24 functions within the existing 40-excerpt / 110,000-character budget. These are same-contract lexical declarations, not a full semantic storage resolver: shadowing, inheritance, external dispatch and unavailable configurations still need review. An identifier occurrence does not prove a read, write, payment or entitlement.

The existing challenge receives that code and the outcomes of up to four read-only questions. A repeated match is identified as already available, not a failed search. A mixed missing-context question can supply its local portion without claiming to answer deployment or specification. The original 0.11.1 path used at most two model calls; 0.13 permits one additional bounded repair or local-code follow-up. New declarations use existing Code details cards, exact original lines and full-file hashes. They have no call arrows and are restored from the validated investigation, never from cached code text. Changed code invalidates them like other evidence.

When an unreviewed report has a citation to a different function than its explicit name, the reading recommendation prefers the explicitly resolved function. The old citation remains inspectable; this does not establish the historical revision or silently change a saved researcher decision.

### Quality checks and their limits

`scripts/fixtures/quality-cases/expectations.json` records a separate source reading for nine fictional cases, before provider runs. `frozen.json` records source/report hashes and the six-development / three-held-out split. `implementation-freeze.json` records product hashes before held-out model runs. The held-out cases were authored and read for the oracle, but not run or used to tune the change. This is not an external blind benchmark or a review of a real protocol.

`scripts/quality_browser.py --cases d1 d2 --output <new-directory>` uses ordinary report import and selection, the real configured provider, the production controller, and native renderer. It captures actual inputs, responses, drafts, screenshots and reopen checks. It does **not** automatically grade reasoning. Review each explanation, scope and unresolved question against the fixture and pre-recorded expectations. `FLOWBOARD_TRIAGE_EXTENSION_PATH` can select the installed baseline. `--provider none --reopen-recording <result.json>` reopens one recorded real response on identical fictional code for UI/navigation checks without new AI calls; it is not another model-quality run.

In the local check, all six installed-0.11.0 cases and six post-change cases had the expected scoped source conclusions. The improvement was resolving omitted local context, not turning six wrong verdicts into right ones. The three held-out post-change cases also retained the expected scopes: a nested guard contradicts the claim; two branches contradict it for different reasons; an unavailable external implementation remains unresolved. Real responses still sometimes request unnecessary other-writer or historical comparisons after the supplied route is already decisive. No claim of universal correctness follows from these small cases. Quote checks and explanation-review coverage remain location/coverage safeguards, not proof of the explanation.

`tests/local-code-completion.test.js` separately covers exact declaration positions, repeated comment text, route isolation, missing external implementations, stale-citation recommendations, mixed questions, editor links and cached declaration restoration. Its controlled response tests plumbing only. Browser/editor transport is still shimmed; installed Cursor activation must be checked independently from its explicit version-and-path output.

## Shared draft

`.flowboard/investigations/<findingId>.json` is a version-1, `source-review-v1` draft. It includes:

- Finding identity and a snapshot of indexed source contents, project configuration, report fields/text and Git revision.
- An expected property with report-assumption, source-contract or test-expectation basis.
- Scoped claims: allegation, actor, entry source, implementation, conditions, required facts, support/disproof criteria, linked evidence, status, explanation and unresolved question.
- Exact quoted evidence with relative file, full-file SHA-256, original line span, stance and interpretation. `quoteVerified` does not imply `interpretationVerified`.
- Predicted state transitions with conditions, transaction boundary and evidence. Executed observations are stored separately under `experiments`.
- Questions, bounded source actions/results, unsupported researcher corrections, provider audit and a scoped provisional conclusion.

Claim status can be supported, contradicted, narrowed or unresolved **within that scope**. The generated finding-level status remains `insufficient-evidence`, with `humanReviewed: false`. A researcher decides confirmed, invalid, design-decision, insufficient-evidence or already-fixed in the separate manual Review workflow. Local JSON is editable; the draft is not a signed audit trail.

Canonical source storage holds up to 40 complete local units, at most 1 MiB of characters each. A model packet contains at most 110,000 code characters, with explicit segmented reading and checked original line identities. The former 800-line/32,000-character prefix is no longer the function store. Generation, challenge, one response repair and two new-code checks remain bounded by report and finding allowances. Required unread material blocks publication. The shared capacity contract admits 8 claims, 24 exact evidence entries, 12 predictions, 18 events, 64 obligations, 30 relationships and 112 typed checks. No collection is silently truncated to meet these limits. The saved file has a separate 48 MiB aggregate byte limit; exceeding it preserves the previous draft and reports the local resource limit. A blocked dependency remains a question; reaching a search bound never establishes absence of recovery.

## Provider boundary

`semanticProvider` defaults to `none`. Enable it once per trusted workspace after considering the selected provider's data policy and account usage. CLI executable overrides are machine-scoped absolute paths, without arguments. CLI authentication is established outside the extension; credentials are neither requested as report data nor stored in the workspace.

Codex runs `exec` with ignored user/rule configuration, ephemeral read-only execution in a fresh temporary directory, disabled shell/apps/plugins/hooks and other tool features, and a structured output schema. Non-text item events reject the result. This is defense in depth, not a claim that every future CLI build exposes no tools. The reviewed runs recorded zero tool events. Codex has a 240-second timeout per pass, not a dollar cap. See the official [non-interactive mode documentation](https://developers.openai.com/codex/noninteractive).

Claude uses disabled tools and MCP, no project settings/slash commands, a structured schema, a per-pass budget (default $1, configurable $0.25–$5) and a 180-second timeout. A configured but expired login can still fail at the first actual request. Authentication/model failures preserve the source view and last coherent draft. Native upstream Code comments remain a separate unverified action.

Reports, comments and corrections are untrusted data. Provider output cannot invoke shell commands, install dependencies, create tests, modify protocol code or synthesize exploit sequences. Accepted questions map to a fixed set of bounded read-only source operations.

## Source freshness and corrections

Source changes, dirty Solidity buffers, a replaced report/draft or a superseded selection prevent late results from being displayed or saved into the new context. A different snapshot archives the generated investigation and carries corrections forward as unverified premises; it does not carry old predictions forward as current evidence. External dispatch, deployed addresses and active compiler settings remain explicit uncertainties.

Correcting an actor, entry point, implementation or condition reopens the affected claim/predictions. Correcting the property reopens all claims. Corrections are saved before reassessment. They are not silently treated as proof. A failed retry retains the preceding coherent evidence/source set, including excerpts found only during its earlier challenge.

Background progress updates do not recenter the canvas or replace the code being read. Explicit claim/evidence selection adopts the latest linked notes and focuses the requested statement. Source history, camera and selected investigation claim use the saved reading context. Competing writes are rejected instead of silently overwriting another window's result.

## Existing-test observations

The user can inspect an already indexed `test*` function and confirm **Run existing regression**. The host selects fixed Forge arguments: offline, JSON output, exact test file and function signature. It disables FFI and default forks, selects local shape A, and clears default RPC variables. Those project-specific environment defaults are shown with the result, not claimed to control every repository's configuration.

Repository test execution is trusted code, not a sandbox. Offline blocks compiler downloads, not arbitrary network access by test code. This feature does not generate new tests or automatically execute model suggestions. Inspect the test and setup before running it.

Results distinguish compilation failure, setup failure, no tests, skipped tests, assertion failure, tool failure, cancellation/timeout and passing assertions. Exit code zero alone is insufficient. Advisory stderr does not erase a parsed successful test result. The command, snapshot, test names/status, diagnostic and limitations are saved. Conditional skipping, mocks, route coverage and deployment applicability still need review. A passing assertion supports only its actual setup and property, not every claim in the report.

## Verification boundary

`tests/investigation-engine.test.js` uses controlled fictional model outputs for generation/check/challenge persistence, invalid quotations, stale/switch races, provider failure, scoped corrections, cache corruption, concurrent writers and compiler freshness. Such fixtures test plumbing, not model quality or a real protocol.

`scripts/investigation_browser.py` selects a finding through the normal library, invokes the configured real provider, uses the actual controller/native renderer, follows exact evidence/editor links, opens state transitions, tests background camera stability and reopens the saved result. Optional flags exercise an explicitly selected existing regression and a researcher correction. `FLOWBOARD_TRIAGE_EXTENSION_PATH` selects exact installed companion modules/assets.

This browser harness shims editor IO, including editor navigation and test confirmation. It is not a full Cursor/Electron session. Package creation, installation, module byte comparison, browser exercise and a reloaded interactive editor are separate verification steps and must be reported separately. Private reports, source, drafts and screenshots must not enter public release archives.
