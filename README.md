# Flowboard Triage

A source-linked Solidity review workspace for developers and auditors, built on the original Solidity Flowboard canvas.

Import an audit report, inspect the code and compare the evidence for and against its findings. Version **0.19.32** carries complete verifier feedback and required source views into private repair, and supports an explicit terminal successor when the existing allowance can fund authoring and fresh verification. It preserves the original terminal record and spent usage. Known feedback targets open exact native code without becoming unchecked tutorial annotations. Original-report assertion dispositions remain in the same generation/challenge workflow: unrepresented text is rejected, and freshly reviewed unresolved scope prevents whole-finding refutation or a complete tutorial without erasing independent support. This makes extraction auditable, not mechanically proven complete. Codex model/reasoning preferences are explicit isolated settings; unavailable remote selections never silently downgrade. Repeated cleanly settled timeouts from one finding are not independent signals of a provider-wide outage. Exact evidence browsing, original comments, scenario-scoped freshness, profile recovery and retained reading position remain. [General Audit v1 and custom engagement mappings](docs/GUIDED-READING.md#optional-general-audit-v1-and-engagement-mapping) add no model stage. The 64-note/128-review, 64-source and 512 KiB policies remain. Ready findings open independently; compatible playback, source inspection and pure remapping make no model requests. Real evaluation outcomes and fictional native controls are reported separately in [validation boundaries](docs/QUALITY-PILOT.md); neither establishes universal audit accuracy or batch throughput.

This is an independent, MIT-licensed companion, not an official Anchabadze release. Source indexing is heuristic. A diagram helps you understand a claim; it does not establish vulnerability validity or runtime reachability.

A verifier-requested correction remains private. Its exact feedback and terminal repair-cycle status are visible; a completed response is not an accepted assessment, and an exhausted candidate cycle does not offer an ineffective Continue action.

## Install and first review

Download the installation ZIP from [GitHub Releases](https://github.com/werulez99/flowboard-triage/releases). The separate `-source.zip` contains the English public sources without installation binaries. This is a preview release: heuristic source navigation and reviewer judgments still need independent checking.

For an unreleased checkout, run `npm run package` and use its versioned files in `dist/`. A locally built version is not necessarily published on GitHub Releases.

1. Extract the release ZIP. Open your Solidity project in Cursor or VS Code.
2. Run **Extensions: Install from VSIX…**. Install both files from `install/`: `anchabadze.solidity-flowboard-1.2.0.vsix`, then `flowboard-triage-0.19.32.vsix`. For WSL, SSH or containers, install into the remote workspace host where the sources live. Installation does not reload an already running extension; reload the editor when your work is saved.
3. Reload the editor window. Open only a workspace you trust.
4. Run **Flowboard Triage: Import Report** and choose a `.txt` or `.md` report. The findings list opens first. With a configured provider, every legitimate finding is queued without needing selection; indexing runs in a worker and is reused. Re-importing retains saved reviews.
5. Choose a **Ready** finding, then **Walkthrough** or **Read code**. Its selected function opens at readable scale with its checked explanation, without waiting for the rest of the report. An unfinished finding shows compact progress or a specific stopping reason; the existing code canvas stays available. **Read report** retains the complete original text. Optional edits live in **More → Edit review**.
6. For an existing import, run **Flowboard Triage: Open Findings**. For setup problems, run **Flowboard Triage: Diagnose Setup** and read the Output channel.

If import appears to do nothing after choosing a file, check **Output → Flowboard Triage**. Version 0.13.1 and earlier mapped the entire report before opening it, which could block a large workspace for minutes. Version 0.13.2 imports the list first. The log records activation version/path, picker cancellation or failure, and completed import. It does not log report contents. A new package still needs a user-controlled window reload before an already active extension host uses it.

Each finding has its own saved canvas. Switching replaces the visible map, rather than appending clusters, and isolates Undo. The original extension's independent canvas and saved state are not cleared or modified.

No compiler, Slither, model API key or paid service is required for default source mode. The adapter is pinned to **Solidity Flowboard 1.2.0** because upstream has no stable external integration API. Another dependency version produces an explicit setup error.

## Independent checked walkthroughs in 0.16

Report locations and applicability now use the same ambiguity-safe path identity. Generation, challenge and storage share one analytical capacity contract. Configured workers (two by default) alternate new findings with saved continuations; exhausting one finding's allowance does not pause unrelated work. Provider-wide local slots and atomic report reservations bound dispatch without increasing the authorized allowance.

Full local functions are stored separately from model excerpts. Unread tails can be acquired in a later segment, then reviewed in a substantive patch challenge. Progress updates no longer rehash the project or replace the active editing panel. Required native cards are present before a ready guide starts. Changed evidence withdraws generated content while keeping the researcher's typed correction.

Full-tutorial readiness is strict and atomic within each finding. A separately admissible checked technical assessment and its decisive source evidence can remain available while the full tutorial is blocked; unreviewed narrative stays private. A blocked or failed sibling, a paused queue or an added unrelated finding does not hide compatible ready work. Reopening revalidates saved artifacts locally; playback makes no provider requests. Legacy guides keep their actual historical assurance without invented new reviews.

Call transitions now refer to one exact occurrence, including receiver, arguments and call options. Two calls to the same helper cannot borrow each other's argument evidence. Static candidates stay separate from checked implementation bindings. Source-only review cannot establish an unknown deployed address, proxy or arbitrary low-level target. See [preparation, limits and verification](docs/GUIDED-READING.md) and the [native teaching and finite batch implementation](docs/NATIVE-TEACHING.md); local tests and screenshots do not establish universal explanation quality or a live editor's activation.

## Checked walkthroughs

The backend prepares every imported finding, including those never selected. Each full walkthrough stays private until its complete material explanation passes the current evidence and source checks. An independently admissible checked assessment can expose its scoped result and exact evidence inspection before that point. Step 1 of a Ready walkthrough opens on the native function canvas if that finding is still selected and the researcher has not deliberately started exploring. Other findings' results do not move the active guide. **Previous step** and **Next step** reveal full functions, exact lines and adjacent actor/condition/input/state explanations. Typed scenario connections are separate from the static exploration graph.

An unavailable provider, unresolved dependency or incomplete explanation produces a finite status for the affected finding, never a replacement page or partial generated guide. **Read report** and **Explore code** remain available. **Pause**, **Resume entire report** and **Cancel** retain accepted stages; **Continue this finding** is separately scoped. Capacity waiting spends no request. For NEW reports, `reportRequestLimit: 0` derives a finite maximum from unfinished finding attempts (default six each); expected demand is normally generation plus mandatory challenge, not the maximum. A positive explicit cap is preserved and a cold shortfall is shown before dispatch. Existing ledgers, including exhausted ones, are never renewed by import/reload/default changes. Explicit report-wide Resume retains its documented allowance scope; the original deadline is not restarted. Reserved attempts are not tokens, concurrent slots or a money guarantee. Codex cost is unknown unless actually reported. Import supports up to 1,000 findings within 4 MiB.

`preparationWorkers` and machine-scoped `providerConcurrency` support 1–32, default **2**. The shared OS-user/provider pool refuses conflicting active capacities; it does not discover remote account quotas or coordinate other machines. At an **assumed** 60 active seconds/request, 200 cold findings (400 requests) require at least 200/50/25 minutes at 2/8/16 sustained slots, excluding overhead and dependent paths. Fourteen/twenty slots are only optimistic minima for 30/20 minutes. A setting is not a throughput result. Elapsed batch time is observational by default. Only the new explicit `reportTimeLimitMinutes > 0` setting chooses a stop for a new run; its default is zero. Historical default deadlines do not stop acceptance or paid local recovery, and paused work is not automatically resumed. Per-request timeouts and finite request allowances remain. No real 200-finding completion result is claimed.

See [Guided reading](docs/GUIDED-READING.md) for report links, keyboard controls, saved progress, freshness checks and verification limits.

## Automatic source review

Open **Statements → Enable AI code review** once for a trusted workspace, choose an already authenticated local **Codex CLI** or **Claude CLI**, and accept the data-sharing notice. Alternatively set `flowboardTriage.semanticProvider` to `codex` or `claude`. The default is `none`; enabling a provider sends each imported finding and relevant code excerpts to that provider under your account, within the shared report limit. No credentials are copied into project files. A remote workspace needs the CLI and authentication on that host.

Import or reopening the workspace resumes eligible durable work within the existing allowance; a paused report stays paused. Each job saves generation, performs bounded source checks and challenges the explanation with the added code. A retry reuses accepted stages. Compact checks and targeted repairs avoid copying the complete model again. Up to two further checks require newly obtained local code; no progress stops the loop. There is no prompt copying, JSON submission or manual graph assembly. A compatible ready finding reopens without another model call. Provider failure retains private drafts and usable raw code navigation.

- **Claims** presents the expected property's basis, actor, implementation and conditions; exact supporting/opposing evidence; and the next unresolved question. Interpretations with matching quotes remain provisional, not source-verified conclusions.
- **State transitions** connect predicted before/after state to source evidence and transaction boundaries. They are not an executed trace. Claim/source selection uses the same investigation; inline explanations and editor links select exact original statements.
- **Source checks** obtain callers, callee candidates, symbols or identifier occurrences. Content-matched existing solc build-info supplies declaration references and branch context when available. External dispatch, storage aliases and deployment configuration can remain unresolved.
- **Existing checks** let you inspect and explicitly run an indexed repository regression with fixed Forge arguments, local shape A, forks and FFI disabled. Results distinguish no tests, setup/compilation failure and observed assertions. This is trusted repository code, not a security sandbox. No new tests, exploit sequences or model-authored shell commands are generated.
- **Correct a premise** preserves your correction as an unsupported researcher premise, reopens affected conclusions and reruns bounded review. Generated work saves independently of your manual **Review** assessment.

Codex uses saved CLI authentication, read-only isolated execution and disabled tool features; a non-text action event rejects the response. The adapter ignores user configuration, selects medium reasoning and does not pass a model override; its audit labels the model as the CLI default unless the provider reports it. It has a 240-second timeout per pass, not a dollar cap. Claude disables tools/MCP and has a 180-second timeout with `semanticBudgetUSD` (default $1, per pass). Account usage charges/limits still apply. Exact CLI versions can affect compatibility; authentication and schema errors are shown, not disguised as completed review.

The adapter preserves UTF-8 across process chunks and counts actual output bytes. Its audit separates capacity wait, process start, transport activity, substantive output, final structured output and host acceptance; a live process is not proof of useful progress. Two recent transport/deadline failures stop automatic dispatch for the same local provider configuration. Check provider access, then explicitly retry or resume. Opening a guide does not clear that stop or spend another request.

Version 0.19 checks the preceding caller path and bounded local helper effects before accepting a displayed call or failure. Earlier returns and helper failures cannot be skipped merely because the tutorial starts later. Relevant local constants and named helpers are read before the first explanation; Retry opening code repeats the failed evidence navigation without losing the return point. Prior typed-catch, saved-premise, exhausted-budget response recovery and late-note protections remain. The Linux/WSL adapter supports non-daemonizing CLI processes: teardown confirms its owned process group, not arbitrary detached workers. The [current verification record](docs/GUIDED-READING.md#local-v019-verification-2026-10-05) separates controlled checks from the still-uncompleted real-finding provider milestone and active-editor evidence.

Version 0.19.1 additionally shares failure-payload classification between direct code and local helper summaries. Empty `require(false)` / `revert()` data does not match `catch Error(string)`; unsupported payload expressions stay unresolved. Compatible sealed guides are locally rechecked under the corrected policy, not automatically regenerated or relabeled checked. See the [focused verification and bounded real pilot](docs/GUIDED-READING.md#local-v0191-verification-2026-10-05).

Version 0.19.2 adds an explicit developer-only full-response-contract diagnostic, with the identical generation schema supplied as text and no provider-side schema flag. Ordinary preparation retains strict schema delivery and policy v9. Diagnostic output cannot publish a guide, replace a production review, or start from navigation/reload. See the [diagnostic scope and verification](docs/GUIDED-READING.md#local-v0192-response-contract-screening-2026-10-05); this is not a claim that real preparation latency is solved.

**Flowboard Triage: Diagnose Setup** reports the running Triage version/path before its optional, bounded local provider-version probe. Historical model observations include actual reported model lists; they are never inferred from the editor model picker. **Continue this finding** reuses only the selected finding's saved stage, within the remaining shared allowance; it does not resume paused siblings or add report allowance. **Resume entire report** is a separate operation. The canonical `npm test` isolates test files sequentially while retaining ownership/quarantine assertions. The ordinary provider deadline remains 240 seconds; explicitly authorized private longer requests are not a global default. See the [saved-challenge continuation](docs/GUIDED-READING.md#local-v0194-saved-challenge-continuation-2026-10-06).

See [Investigation runtime and limits](docs/INVESTIGATION.md) for implementation entry points, schema, freshness and verification boundaries. This is a bounded source investigation of the selected allegation, not autonomous auditing, complete semantic verification or a deployment verdict.

**0.5.1 compatibility fix:** fixes `CANNOT use API proposal: tunnels` when opening the native panel in Cursor. The adapter now preserves lazy API descriptors instead of eagerly spreading editor namespaces. No proposed APIs, development mode or special launch flags are required. Regression coverage includes frozen API objects and proposal-gated getters; the previous plain-object editor mocks did not model those getters. Reload the editor window after upgrading.

## Researcher workflow in 0.8

Open a finding without preparing JSON or assembling a graph:

1. **Overview** labels the allegation as unverified, opens source at readable scale and asks the next unresolved question. **Prepared reading context** quotes the mapped statements, lists call-site implementation boundaries and offers alternative source matches even when old citations happen to land in unrelated functions.
2. **Statements** starts from a few report paragraphs, all unreviewed. Select a statement to read its evidence and counterevidence before opening optional editing forms. Unlinked report statements do not acquire guessed code explanations.
3. **Inspect** opens a function's immediate context. Unknown implementations stay unresolved; competing targets remain alternatives. Adding a source candidate creates an independent card, not an invented execution edge. Calls are listed in source order, not a claim that all branches execute together.
4. **+ Evidence** accepts an exact line or focused span with a source hash. Choose whether the note is a checked source observation, inference, report assertion, test reference or question. Report assertions/questions are context only. Test references do not claim a test was executed.
5. **Back/Forward** restores the previous claim, panel and camera. Switching/reopening restores the reading context and checkpoints unfinished notes separately from a saved assessment. Source changes keep the camera in place, display **SOURCE CHANGED**, and require refresh/re-review.

Important fixes: legacy draft identity now follows the selected filename/library ID; native header/modifier links use the same freshness/session checks as evidence links; source clicks navigate once; late saves and snapshots cannot overwrite a newer session. Refresh considers indexed dependencies, not just the original report anchors. Cached source text is never authoritative.

An index-version upgrade can invalidate an older map even when Solidity has not changed. Previous layouts and notes are archived under `.flowboard/board-history/`; prior judgments are shown as historical until refreshed and reviewed again. This does not mean the reported bug was fixed. Saved assessments are not silently overwritten.

The 0.8 mechanical workflow remains available without a provider. In 0.9, automatic generation/challenge is a separate, connected path described above; complete compiler dispatch analysis, automatic semantic proof and vulnerability reproduction are not implemented. **Ask AI** remains an optional clipboard handoff. An inaccessible or unsearched dependency is not evidence that a recovery route cannot exist. Lexical modifier/inheritance candidates are not compiler-proven authorization.

The retained native **Code comments** action can use upstream's configured Claude CLI. Its output is an unverified explanation, kept separate from the evidence ledger. It is not a challenge-stage result or source proof; source navigation remains available if that optional action fails.

### Reproduce the workflow checks

With the pinned dependency unpacked and Playwright/Chromium installed:

```sh
FLOWBOARD_EXTENSION_PATH=/path/to/solidity-flowboard-1.2.0 npm test
FLOWBOARD_EXTENSION_PATH=/path/to/solidity-flowboard-1.2.0 python scripts/native_visual_smoke.py --output /tmp/native.png
FLOWBOARD_EXTENSION_PATH=/path/to/solidity-flowboard-1.2.0 python scripts/workflow_browser.py --output /tmp/workflow.png
FLOWBOARD_EXTENSION_PATH=/path/to/solidity-flowboard-1.2.0 python scripts/workflow_browser.py --complex --width 1366 --height 768 --output /tmp/complex.png
FLOWBOARD_EXTENSION_PATH=/path/to/solidity-flowboard-1.2.0 python scripts/usability_browser.py --output-prefix /tmp/usability
```

The workflow harness exercises the actual importer, source catalog, board controller, native renderer, source navigation, evidence binding/save, switching, controller recreation and source-change blocking. Editor IO is shimmed; this is not an Electron extension-host test. Its default cases are fictional and do not validate a real protocol. `--workspace /path/to/project --finding H-01` opens existing material read-only without writing that project's runtime state. Keep screenshots of private source private.

`scripts/investigation_browser.py --workspace /path/to/project --finding H-01 --provider codex --record-investigation --output /tmp/investigation.json` exercises normal selection, the real configured provider, generated-draft persistence, exact evidence navigation, state transitions and reopening. `--run-test <existing-function>` additionally authorizes the host shim's confirmation for that selected regression; `--correction '<scope correction>'` exercises reassessment. Without `--record-investigation`, external-workspace runs do not save drafts. This harness still shims editor IO; its screenshots are the actual native webview, not proof of a full Cursor session.

The `--complex` fixture imports a normal report against 16 ordinary functions with branches and shared helpers. It checks readable initial focus, alternative targets, history, optional whole-map Fit, and restored source/history after reopening. Set `FLOWBOARD_TRIAGE_EXTENSION_PATH` to an installed companion directory to exercise its exact modules and webview assets; the harness reports that path and version. Without it, the harness uses the checkout's `extension/`.

The same 1366x768 fictional claim case put the first evidence entry at y=1388 in the v0.7 frontend and y=630 in the initial 0.8 reading-layout pass. These are observed layout coordinates, not a time-saving estimate or user-study score. The scripts generate current screenshots and assertions for light/dark/high-contrast and narrow views; `usability_browser.py --baseline-ref 12b5412` can render the older frontend for comparison.

## Claim-by-claim review

Read the argument before deciding whether the finding is valid:

1. Establish the **Expected behavior** and what it is based on. A rule from the report alone remains unverified.
2. Open **Statements** to inspect the report statements prepared on import/open, or select text in **Read report → Review selected text**. Code matches help discovery; they do not decide whether a statement is true.
3. Select a statement to focus its linked code. Only exact, hash-matching evidence lines are highlighted. Other cards dim; **All functions** restores the overview. No line numbers are guessed from prose.
4. Read what the code does, when it happens, opposing evidence and open questions. Explanations below the continuous code name both the issue and statement they relate to. Optional editing fields stay collapsed.
5. Assess the individual statement as unreviewed, supported, contradicted, mixed or unresolved. One report statement may be supported while another remains unresolved. Evidence stance for a specific claim is separate from the overall finding stance.
6. Set the overall issue result in **More → Edit review**, explain the decision and save. **Copy review brief** includes statements, references and open questions. Statement results never automatically set the issue result. Reading and automatic preparation do not require Save.

Changing linked evidence, the intended rule or the claim explanation resets affected claim states to unreviewed. Removing evidence unlinks it without silently keeping a supported claim. Source-map refresh retains historical explanations/hashes while marking evidence and claims for re-review. Older drafts still work without a claim breakdown. Save guards, concurrent-edit protection and the Cursor compatibility fix remain in place.

The bundled skill and AI handoff prompt describe the manual review schema. The optional 0.9 provider writes a separate, provisional investigation schema. Neither path executes exploits or generates missing attack sequences; the researcher remains responsible for the final assessment.

Try the fictional example: open `examples/project` as the editor workspace, run **Flowboard Triage: Open Finding JSON**, and select `examples/claim-review.json` from the bundle. It includes inline observations, a source-behavior claim and an unresolved specification question. It deliberately does not declare a bug.

## Code explanations in 0.10

Read continuous Solidity, then expand **Explanations** below it. A small **Note** marker and line links open the relevant explanation without moving the camera. Notes explain what the code does, why it matters to the report and what is still unclear. They name the issue or statement they support or argue against; supporting a statement does not confirm a bug.

- **Read code** is a deliberate return to 100% reading size. **All functions** is a separate overview and may use a smaller scale for a large board.
- Function headers keep the name, file and line range visible. A compact location bar stays available when reading deeper lines. Code formatting is preserved; long lines scroll horizontally instead of shrinking the text.
- Only notes matching the current file hash receive line markers. Hidden comment lines and display mismatches retain an exact editor link without guessed placement. The original native comment filter remains; generated AI commentary is moved below code and labeled as unverified.
- Line links and note counts remain visible while explanations are collapsed. Changing tabs or opening a note does not move the camera. At narrow widths, **Read code** closes the sidebar without losing the selected statement.
- **More** keeps native drawing, notes, search and other secondary actions available. **Arrange functions** uses displayed card dimensions; native **Undo** restores positions. Optional edits use **More → Add code note** on a function, a line number, or **Edit review**.

See [Reading-workbench changes and verification](docs/READING-WORKBENCH.md). Stored field names, IDs, enum values and protocol messages are unchanged. Existing report quotations and saved researcher text are not rewritten during an upgrade.

Manual explanations come from the assistant/reviewer. Optional generated explanations are visibly provisional even when the extension checks their exact quotations. Import alone does not generate trustworthy semantic annotations. Save Review to persist manual assessment edits; automatic investigation drafts save separately. Opening another finding still protects unsaved work. Upgrading the extension requires Reload Window; the 0.5.1 Cursor API compatibility fix is retained.

**0.6.1 refinements:** the review story links directly to current source observations; the Review ledger explains historical, unbound, off-map and mismatching-hash entries. Category and evidence stance appear together on each inline note. Function roles are readable on the cards, not only in tooltips. Collapsed notes remain collapsed while editing or toggling visibility, and connection geometry is recalculated after annotation layout changes. Save acknowledgments clear unsaved labels. AI skills default saved explanations to English; imported report text is preserved verbatim.

Original coordinates, matching hashes and successful rendering establish where an annotation was attached, not whether its explanation is correct. The assistant/reviewer must inspect the statement and surrounding permissions, state and implementations. A summary allegation is never automatically painted onto a guessed source line.

The 0.6.1 browser pass also fixed Fit/source focus after browser-induced viewport scrolling: cards are fitted using the native camera with DOM scroll offsets reset. Regression checks include repeated source statements, hidden-comment notes, unsafe-looking note text, off-map evidence and fail-closed display mapping.

## Fifteen improvements in 0.5

1. **Compact Overview:** read the claim and assessment without opening a form.
2. **Progressive source details:** revision/mapping diagnostics and refresh controls sit in an expandable section; failures open it automatically.
3. **Resizable panel:** drag the divider, or focus it and use arrow keys; double-click restores the tab's default width.
4. **Function inspector:** select a real source card to read its explanation, modifiers/conditions and immediate diagram neighbors.
5. **Neighborhood focus:** dim unrelated cards/edges while preserving the full diagram and saved layout.
6. **Source history:** Back/Forward revisits inspected functions within this finding, independently of native canvas Undo.
7. **Mapped-function search:** filter by function, contract, file or explanation without changing the canvas.
8. **Review queues:** search findings and source filenames, filter by status/missing map/needs attention and see saved-review counts.
9. **Next review:** jump to another saved finding with unreviewed status, insufficient evidence, mapping problems, review gaps or stale evidence, wrapping once.
10. **Related-source findings:** show other issues sharing exact cited anchors or files, explicitly without treating them as duplicate root causes.
11. **Editable evidence:** change notes/stances while retaining the original source hash and re-review flag; removal asks before dropping an entry.
12. **Evidence filters:** inspect supporting, contradicting, contextual or historical evidence separately; clear an unadded entry without losing other form edits.
13. **Function-specific AI handoff:** copy a source-bound prompt from the inspector. It does not invoke a provider or include unsaved form changes.
14. **Keyboard and focus support:** Alt+1…6 switches Findings/Overview/Flow/Review/Report/Claims; Alt+Left/Right traverses source history; Ctrl/Cmd+S saves in Review or Claims; Escape closes the panel without discarding edits. Tab arrows and resize keys are supported; text inputs retain normal typing.
15. **Review guidance:** prioritize a recorded blocker/unchecked question, flag repeated evidence and opposite interpretations of the same reference, surface high confidence with review gaps, and include checkpoint reasoning in the copied brief. These are transparent review cues, not semantic verdicts.

Panel width, filters, source history and neighborhood focus are view-local; they reset when the webview closes. Source history resets between findings. The queue and related-source list use saved drafts, not unsaved edits; unmapped drafts have no source anchors to compare. Imported source relevance and actual bug validity still require review.

The final usability pass fixed low-contrast function headers, moved source navigation beside the canvas, retained the latest evidence explanation when an older inspection response arrives, preserved tab scroll positions and routed unmapped selections to an explicit report explanation. Original source-line navigation refuses dirty buffers whose edits could shift cited lines. Browser checks cover these interactions with fictional data, including narrow layouts; they are not an external user study.

## What import does — and does not do

Supported headings include `### [H-01] Title`, `Issue 1: Title`, and Markdown headings followed by Severity/Location fields. References include `src/Module.sol:42`, `checkout/src/Module.sol:42-60,81-90`, Windows paths, and `src/Module.sol#L42-L60`. Structured Severity, Summary/Description, Preconditions, Expected/Actual behavior, Impact and Mitigation fields populate the draft. See [the fictional demo report](examples/report.md).

Import creates unreviewed source maps, not proven attack paths:

- It resolves citations to current functions; declarations or ambiguous source locations become explicitly labeled **source context** cards.
- It can map uniquely named function mentions such as `update(amount)` even without line citations. Ambiguous names remain warnings, not guessed implementations.
- Without usable citations/named anchors, it searches actual function names, contract names, body identifiers and nearby documentation for terms from the title/description. File mentions can scope the search. Up to three ranked anchors and six one-hop source neighbors supply a bounded normal-code context. Bare names without parentheses are recognized too.
- Description matches show relevance reasons and scores, not established report-to-code bindings. A search score is not bug confidence. Vague prose with insufficient overlap remains unmapped; synonyms, cross-language prose, external dependencies and implicit behavior can require assistant/manual review.
- It proposes links between mapped functions only when source indexing finds an unambiguous call candidate. Citation order is not execution order. Cycles and reverse-ordered citations are supported.
- Connections retain exact call occurrence spans, receiver expressions, arguments and call options, alongside static candidate information. Comments/string contents are excluded. Same-arity overloads, multiple interface implementations, receiver shadowing and competing libraries stay ambiguous rather than silently choosing a target. A declared `call` without a checked concrete binding is displayed as a hypothesis with a warning; the saved assessment is not rewritten.
- Candidate links, reviewer-established source calls and state relationships use different line styles and explanatory tooltips. Neither a source call nor Slither success proves that the finding is reachable or exploitable.
- Missing files, stale hashes/revisions or unmapped findings remain visible with explanations; no fictitious call steps are inserted.

A valid line in a newer checkout can still point at the wrong function. Verify the report revision and the claim even if all references map. Informational/design findings need not have an attack path. Description discovery is deterministic lexical retrieval, not complete Solidity semantic analysis. Conditions in the raw exploration graph are inspection hints, not a permissions/reachability proof. PDF import, complete semantic dispatch analysis and exploit execution are not implemented. Ambiguous report sections remain visible as unresolved import items; they do not hide independently checked findings or silently disappear from the count.

For an existing import, use **Refresh source map** in its drawer or **Flowboard Triage: Refresh Source Map** after selecting a finding. It rescans the current checkout, archives the previous draft and preserves saved review fields. If changed source would invalidate a definitive previous assessment, it first asks for explicit consent to mark it unreviewed. An unsuccessful search preserves the previous draft and shows an explanation; it does not force-open the old map. Re-import alone preserves existing drafts and does not upgrade their generated anchors.

Changing the mapped anchors likewise requires consent before retaining a definitive judgment on a new map. Refresh can replace reviewer-added card explanations/relationships; restore relevant annotations deliberately from the archived draft, not blindly. Source guards bind reviewed files/commit and a live index, not all unseen deployment dependencies.

## Review with your AI assistant

Start with the rule the report says is violated. Compare intended behavior with the actual source, then inspect permissions, state, modifiers and implementation targets. Actively look for an explanation that could disprove the claim before reaching a conclusion.

In **Review**:

1. Read the claim and compare intended/observed behavior side by side. Imported descriptions remain unreviewed until you examine them.
2. Use **+ Evidence** on a native function card. Choose an exact source line, explain its relevance and label it **supports**, **contradicts** or **context**. Specification/test references can be recorded separately; the extension does not execute or validate their contents.
3. Click an evidence entry or its card badge to inspect a numbered excerpt and open the exact line in the editor. Native cards may omit comments, so evidence navigation uses original source coordinates.
4. Record reasoning for the six review areas: version, intended rule, permissions/state, actual behavior, counterevidence and consequence. Unchecked/blocked areas stay visible; the count is not a probability that the bug is real.
5. Explain your assessment and save. New structured reviews require a reason and current evidence for definitive assessments; **confirmed** requires supporting evidence and **invalid / false positive** requires contradicting evidence. Remaining review gaps prompt confirmation and remain visible. Legacy drafts stay readable.

Evidence binds to the source file's content hash. Changed source cannot silently reuse an old record as current evidence. A source-map refresh that changes source/bindings retains old entries with **needs re-review**, resets checkpoint states and archives the old draft. Re-examine evidence before replacing its source binding. **Copy review brief** copies the argument, uncertainty and assessment to the clipboard without saving or sending it to a provider.

For the project-local skill and Cursor rule, run from the extracted bundle (Node.js 18+):

```sh
node cli.js init --root /path/to/solidity-project
```

Existing skill/rule files are preserved. For an upgrade, review and merge the bundled skill changes yourself rather than assuming `init` overwrites an older installation.

**Ask AI** copies a selected-finding prompt; it does not send data or invoke a provider. Paste it into your coding assistant. In Codex, invoke `$solidity-flowboard-triage`; another assistant can read `.agents/skills/solidity-flowboard-triage/SKILL.md` explicitly. Ask in your own language, for example:

> Review H-01 against this checkout. Explain the intended behavior and reported deviation, inspect permissions/state and call targets, annotate the source relationships, update its Flowboard draft and give an evidence-backed assessment with remaining uncertainties.

The assistant can refine card descriptions, connection reasons and structured evidence, then submit the saved draft. The **Flow** tab makes that explanation navigable. The **Review** tab distinguishes unreviewed, confirmed bug, invalid/false positive, design decision, insufficient evidence and already fixed. Evidence labels and checkpoint answers are reviewer judgments, not tool-verified verdicts. Reported severity is not independently validated.

Unfinished review text is checkpointed locally and survives switching/reopening; it is **not** silently submitted as an assessment. Restoration requires matching draft and source-map fingerprints. Conflicting earlier text, including pending evidence, stays separately recoverable instead of overwriting a new delivery. Saving checks for concurrent edits to the JSON draft; an older form cannot silently overwrite an assistant's update. Review history stores the previous/current assessment, bounded by 100 entries and 4 MiB per finding.

## Saved state, revisions and privacy

Add `.flowboard/` to your project's ignore rules. It contains confidential report text, source snapshots and review judgments; it is not included in release packages.

| File | Purpose |
| --- | --- |
| `.flowboard/report.json` | Active report index and original finding text |
| `.flowboard/findings/<id>.json` | Editable review draft with relative source paths |
| `.flowboard/investigations/<id>.json` | Source-bound generated draft, scoped evidence, corrections, provider audit and existing-test observations |
| `.flowboard/report-preparation.json` | Durable report jobs, stage checkpoints, shared usage, per-finding acceptance and aggregate progress |
| `.flowboard/report-preparation.lock.json` | Local worker ownership; interrupted work recovers after host restart |
| `.flowboard/recovery/investigation-*.json` | Previous generated drafts when source/report context changes |
| `.flowboard/request.json` | Latest delivery request to the editor |
| `.flowboard/status.json` | Matching request ID and analyzing/ready/error state |
| `.flowboard/view-status.json` | Library selection progress, separate from delivery acknowledgment |
| `.flowboard/boards/<id>.json` | Cards, layout, notes, camera, reading context and unfinished working copy |
| `.flowboard/history/<id>.json` | Local assessment history |
| `.flowboard/board-history/<id>/` | Archived snapshots when source/flow changed |
| `.flowboard/draft-history/<id>/` | Previous editable drafts before map refresh |
| `.flowboard/reports/<hash>.json` | Previous report indexes |

Re-import preserves existing drafts and archives the previous report index. An unambiguous, byte-identical original finding section keeps its identity across report revisions, so adding an unrelated finding need not discard checked work. Changed or ambiguous sections receive separate identities; the tool does not semantically merge revised allegations or reuse another report's H-01 merely because its label matches. Ready artifacts still require compatible code, report content and policy checks.

Source hashes, Git revision checks and indexed-file stamps prevent continued expansion/review saving against a changed checkout. Refresh and re-triage the finding after code changes. A changed index, adapter version or flow invalidates the saved canvas and archives its previous snapshot before creating a fresh map; old notes are recoverable in board-history, but automatic note migration is not implemented. If a corrupt cache cannot be safely archived, autosave is disabled for that view.

Saved canvases contain absolute machine-local paths and are not a portable exchange format. Share reviewed JSON drafts with relative paths and the analyzed commit, after removing sensitive text and obtaining appropriate permission.

## CLI

A trusted editor workspace with both extensions must be open for rendering.

```sh
node cli.js submit .flowboard/findings/H-01.json --root /path/to/project
node cli.js status --root /path/to/project --wait 30
```

Edit the saved per-finding draft first, then submit. A conflicting request does not replace an existing review silently. Delivery gets a fresh request ID; the optional stable `findingId` identifies its saved canvas.

`submitted` means queued. Only a matching `state: ready` with `rendered: true` means the webview acknowledged loading its cards, not that the assessment is correct. Reusing a processed request ID with different content is rejected. Concurrent request-file writers are unsupported: the latest file wins. Use **Open Finding JSON** or **Process Pending Request** if preferred.

Terminal import is also available; the editor import command needs no extension path:

```sh
node cli.js import report.txt --root /path/to/project --flowboard /path/to/anchabadze.solidity-flowboard-1.2.0
```

See [the protocol](docs/PROTOCOL.md) for explicit connections, source-context cards and limits.

## Optional Slither

Default import never runs a compiler. For optional Slither 0.11.6 navigation, create a separate project-local environment:

```sh
node cli.js setup-slither --root /path/to/project
```

Requires Python with venv, the project's dependencies/build tools and internet access for installation. On Windows use `--python python`; WSL is recommended for Foundry. Set `flowboardTriage.analysisMode` to `slither`. An absolute executable path can be supplied through the machine setting `flowboardTriage.slitherPath`.

This does not replace global Python packages or modify global PATH. Slither can execute project build configuration and create normal compilation/call-graph artifacts; enable it only for trusted projects. A failed run is explicitly labeled source-only fallback. Overloads/interfaces/dynamic targets can still need manual inspection or a target picker.

## Develop and verify

No npm runtime dependencies. Node.js 18+ and the `zip` utility are needed for packaging.

```sh
npm test
FLOWBOARD_EXTENSION_PATH=/path/to/upstream-extension npm test
npm run package
```

The optional environment variable tests the real pinned source parser and native panel adapter with fictional fixtures; without it, upstream integration cases are explicitly skipped. For the real native renderer smoke test, install Python Playwright and Chromium in a development environment, set `FLOWBOARD_EXTENSION_PATH`, and run:

```sh
python scripts/native_visual_smoke.py --output /tmp/flowboard-triage-demo.png
```

The browser check exercises native cards/edges, guided review, source evidence binding/inspection, evidence badges, review gaps, brief copying, report formatting, untrusted markup, explicit refresh, edits across tabs/pending saves, stale-session isolation, switching, Undo and narrow layouts. No private audit data is used.

Packaging downloads the pinned upstream VSIX over HTTPS and verifies its SHA-256. An explicit allowlist produces our VSIX, an installation ZIP including both extensions, and a separate `-source.zip` for a clean public repository. Source archives contain only the English tool, fictional examples, tests, AI skill and documentation: no parent workspace, imported findings, old translations, private handoff or Git history. The standalone VSIX includes third-party attribution too. Archives are rebuilt from fresh staging directories so stale files cannot carry into a release.

Release checks reject symlinks, private/runtime paths and common credential patterns; these tripwires do not replace a human disclosure review. SHA-256 checksums accompany all three artifacts. Never initialize or push the analyzed Solidity workspace as the tool's public repository.

Local validation covers Cursor WSL/Linux, the real upstream source adapter and Chromium/native webview. Full editor installation/UI on Windows and macOS still needs manual validation. CI is configured for core tests on all three platforms and native integration/browser testing on Linux; configuration is not a claim that hosted CI has run. See [CONTRIBUTING.md](CONTRIBUTING.md).

The extension uses `local.flowboard-triage` as its sideloaded VSIX identity. A public source repository does not imply marketplace publication or endorsement by upstream; marketplace publishing requires a separate publisher setup. Keeping this identity preserves existing local upgrades.

## Privacy and licensing

Default source-only import/navigation does not contact an AI provider. Enabling `semanticProvider` prepares every imported finding in the background, sending its report text, bounded code, corrections and recorded experiment context through the configured authenticated CLI. The shared report allowance, provider data policies and account usage limits apply. Closing the webview does not cancel preparation; pausing or cancelling does. A stopped extension host cannot execute work and resumes from checkpoints when reopened. Private `.flowboard/` data is never a packaging input. Original Flowboard's optional AI annotations remain a separate explicit action; they do not become challenge evidence. Dependency downloads and optional pip installation use the network.

Our code is MIT licensed. Solidity Flowboard is © Zurab Anchabadze, separately MIT licensed, redistributed unmodified with its license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [SECURITY.md](SECURITY.md).
