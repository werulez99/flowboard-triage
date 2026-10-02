# Contributing

Flowboard Triage is an independent MIT-licensed companion. Useful contributions include explicit report formats/fixtures, source navigation precision, accessible native-canvas additions and editor/platform testing.

1. Work on a branch. Run `npm test` with Node.js 18+.
2. For real source/panel integration, extract the pinned upstream VSIX and set `FLOWBOARD_EXTENSION_PATH` to its `extension/` directory before testing. Otherwise those cases are explicitly skipped.
3. For real browser coverage, install Python Playwright/Chromium separately and run `scripts/native_visual_smoke.py` with that same environment variable.
4. Keep examples fictional or explicitly cleared for public use. Never include engagement reports, tokens, credentials or proprietary source.
5. Distinguish citations, call candidates, reviewed source calls, state relationships and runtime reachability. Reported severity and reviewer confidence are separate. Imported diagrams must not assert bug validity.
6. Preserve the original native interface and separate original saved board. Per-finding state/Undo, session-tagged async results, source freshness and concurrent-review guards are invariants, not optional styling details.
7. Do not add autonomous exploit workflows. Compilation stays opt-in; default import is source-only. Never overwrite drafts on re-import or modify global Python/PATH.
8. Document schema changes and add regression tests for stale locations/dependencies, ambiguous dispatch, duplicate IDs, report text injection, unsafe paths and review data loss.

CI is configured for core tests on Linux/Windows/macOS, plus real source/panel/browser checks and packaging on Linux. Configuration alone is not cross-platform editor validation; full installation/rendering must be manually checked on each intended host.

Before public release, review the source-only ZIP contents and licenses, and verify clean installation/upgrade. Keep documentation, interface strings and default AI-authored explanations in English; original imported reports and code are not silently translated. Publishing credentials or automatic marketplace uploads are not bundled. The sideloaded extension retains its local identity; marketplace publishing needs a separate publisher setup. Upstream uses an internal API: changing the pinned version requires reviewing runner/panel/message compatibility, source semantics, license and archive hash.

Useful next steps include a supported upstream integration API, higher-precision dispatch/type resolution, explicit source-diff review, portable redacted review exports and accessibility/localization. New AI integrations must make consent/data transmission explicit and support evidence-backed explanation, not autonomous exploitation or automatic vulnerability verdicts.
