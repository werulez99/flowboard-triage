# Flowboard Triage

A source-linked Solidity review workspace for developers and auditors, built on the original Solidity Flowboard canvas.

Import an audit report, select a finding, inspect its function cards and connection rationale, and record an evidence-backed assessment with your coding assistant. Version **0.6.1** adds source-bound explanations between code lines, a navigable review story and placement diagnostics. It retains the original canvas engine, source highlighting, minimap, notes, linking and Undo, with a calmer companion theme and a resizable panel.

This is an independent, MIT-licensed companion, not an official Anchabadze release. Source indexing is heuristic. A diagram helps you understand a claim; it does not establish vulnerability validity or runtime reachability.

## Install and first review

Download the installation ZIP from [GitHub Releases](https://github.com/werulez99/flowboard-triage/releases). The separate `-source.zip` contains the English public sources without installation binaries. This is a preview release: heuristic source navigation and reviewer judgments still need independent checking.

1. Extract the release ZIP. Open your Solidity project in Cursor or VS Code.
2. Run **Extensions: Install from VSIX…**. Install both files from `install/`: `anchabadze.solidity-flowboard-1.2.0.vsix`, then `flowboard-triage-0.6.1.vsix`. For WSL, SSH or containers, install into the remote workspace host where the sources live.
3. Reload the editor window. Open only a workspace you trust.
4. Run **Flowboard Triage: Import Report** and choose a `.txt` or `.md` report. The first mapped finding opens in the native canvas.
5. **Overview** opens beside the source cards with the claim, behavior comparison, evidence balance and an unanswered review question. Choose **Inspect** on a card for its role, conditions and adjacent relationships. **Review** edits the assessment. **Flow** searches mapped functions and explains connections; **Report** formats the original text with checked source links. Missing maps open the Report explanation.
6. For an existing import, run **Flowboard Triage: Open Findings**. For setup problems, run **Flowboard Triage: Diagnose Setup** and read the Output channel.

Each finding has its own saved canvas. Switching replaces the visible map, rather than appending clusters, and isolates Undo. The original extension's independent canvas and saved state are not cleared or modified.

No compiler, Slither, model API key or paid service is required for default source mode. The adapter is pinned to **Solidity Flowboard 1.2.0** because upstream has no stable external integration API. Another dependency version produces an explicit setup error.

**0.5.1 compatibility fix:** fixes `CANNOT use API proposal: tunnels` when opening the native panel in Cursor. The adapter now preserves lazy API descriptors instead of eagerly spreading editor namespaces. No proposed APIs, development mode or special launch flags are required. Regression coverage includes frozen API objects and proposal-gated getters; the previous plain-object editor mocks did not model those getters. Reload the editor window after upgrading.

## Inline explanations in 0.6

Read short explanations directly between the original function's code lines. Each note has a distinct category: **Behavior**, **Reported concern**, **Consequence**, **Counterevidence / guard** or **Open question**. Category is not a verdict: the evidence retains its independent supports/contradicts/context stance.

- Click an original line number to start an exact-line note, or use **+ Evidence**. Notes can collapse, open the exact source or reopen their editor in Review.
- Only evidence bound to the current source hash appears inline. Hidden comment lines have a separate labeled section; uncertain display mappings never attach a note to an approximate statement. Cached layouts cannot replace the displayed current source text.
- **Notes on/off** controls clutter. **Arrange** spaces cards using their actual displayed dimensions; native Undo can revert the layout. Existing sticky notes are not moved.
- Expand **Review story** under the selected function (initially the first card) for bullet points covering the supplied claim, conditions, intended/observed behavior, consequence and unanswered questions. This is finding-level context, not a synthesized execution or exploit sequence.

The assistant/reviewer writes source-checked explanations; the extension displays them without invoking a model. Import alone does not generate trustworthy semantic annotations. Save Review to persist edits; opening another finding still protects unsaved work. Upgrading the extension requires Reload Window; the 0.5.1 Cursor API compatibility fix is retained.

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
14. **Keyboard and focus support:** Alt+1…5 switches views; Alt+Left/Right traverses source history; Ctrl/Cmd+S saves in Review; Escape closes the panel without discarding edits. Tab arrows and resize keys are supported; text inputs retain normal typing.
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
- Connections retain their actual call-site line, receiver type, `super` context and argument count. Comments/string contents are excluded. Same-arity overloads, multiple interface implementations, receiver shadowing and competing libraries stay ambiguous rather than silently choosing a target. A declared `call` without a unique direct source match is displayed as a hypothesis with a warning; the saved assessment is not rewritten.
- Candidate links, reviewer-established source calls and state relationships use different line styles and explanatory tooltips. Neither a source call nor Slither success proves that the finding is reachable or exploitable.
- Missing files, stale hashes/revisions or unmapped findings remain visible with explanations; no fictitious call steps are inserted.

A valid line in a newer checkout can still point at the wrong function. Verify the report revision and the claim even if all references map. Informational/design findings need not have an attack path. Description discovery is deterministic lexical retrieval, not AI reasoning or complete Solidity semantic analysis. Conditions shown in Flow are inspection hints, not a complete permissions/reachability proof. PDF import, reports without recognizable finding boundaries, complete semantic dispatch analysis, autonomous model processing of an entire report and exploit execution are not implemented.

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

Unsaved review text survives drawer/tab changes. Switching or refreshing with unsaved edits asks for confirmation. Saving checks for concurrent edits to the JSON draft; an older form cannot silently overwrite an assistant's update. Review history stores the previous/current assessment, bounded by 100 entries and 4 MiB per finding.

## Saved state, revisions and privacy

Add `.flowboard/` to your project's ignore rules. It contains confidential report text, source snapshots and review judgments; it is not included in release packages.

| File | Purpose |
| --- | --- |
| `.flowboard/report.json` | Active report index and original finding text |
| `.flowboard/findings/<id>.json` | Editable review draft with relative source paths |
| `.flowboard/request.json` | Latest delivery request to the editor |
| `.flowboard/status.json` | Matching request ID and analyzing/ready/error state |
| `.flowboard/boards/<id>.json` | Per-finding cards, layout, notes and camera |
| `.flowboard/history/<id>.json` | Local assessment history |
| `.flowboard/board-history/<id>/` | Archived snapshots when source/flow changed |
| `.flowboard/draft-history/<id>/` | Previous editable drafts before map refresh |
| `.flowboard/reports/<hash>.json` | Previous report indexes |

Re-import preserves existing drafts. A different report hash gets a separate namespace and archives the old index, avoiding silent reuse of another report's H-01. Changed report text is treated as a different import; automatic semantic matching/merging of report revisions is not provided.

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

The importer/renderer does not contact an AI provider. Your chosen coding assistant has its own data policy. Original Flowboard's optional AI annotations remain a separate, explicit action governed by upstream behavior; delayed annotation results are isolated to their finding session. Dependency downloads and optional pip installation use the network.

Our code is MIT licensed. Solidity Flowboard is © Zurab Anchabadze, separately MIT licensed, redistributed unmodified with its license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [SECURITY.md](SECURITY.md).
