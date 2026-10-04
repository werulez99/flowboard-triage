# Reading workbench, 0.10.0

This is a presentation and reading-workflow update on top of the local 0.9.0 investigation implementation. It is not a new validity engine. The original Solidity Flowboard 1.2.0 renderer, source resolution, provider workflow, revision checks, working-copy protection and native Undo remain in use.

## Observed problems and changes

- The old first screen put technical preparation before the explanation, repeated actions and had no main code-reading action. Summary now has four groups: The issue, Start here, Details and Related issues. Read code is the primary action; editing is optional.
- Large evidence blocks split short functions between statements. All explanations, including optional native AI comments, now sit below continuous code. Exact line markers open notes; line links stay visible when collapsed.
- A note's overall stance and statement-specific stance could appear interchangeable. Each is now labeled with its actual target, such as Against issue H-01 and Supports statement C-1. Generated statement evidence never invents an issue-level relationship.
- Changing tabs changed sidebar width and shifted the code. The reading views now share one width. Explicit Read code restores 100%; All functions is a separate overview. Long code retains its formatting and full content.
- Technical headings and generic fallback prose obscured what was known. Display labels, review prompts, preparation messages and search descriptions use simpler English. Stored fields and enum values are unchanged.
- A new exact-line selection must not leak into an unrelated statement. Selection resets are covered together with existing finding/session, source freshness and saved-view tests.

## Verification boundaries

The browser suites use the actual pinned native renderer and the companion's production JavaScript/CSS. The workflow harness uses the real importer, catalog and board controller with an editor-I/O shim. This is not a full Electron/Cursor session. Installing a VSIX is distinct from activating it in a window that is already open.

Fictional cases cover normal report selection, source navigation, saved and unfinished reviews, finding switching, stale code, a missing-code case, statement counterevidence, an unresolved specification, continuous code, hidden comment lines, repeated statements, native Undo and a 16-function graph. Layout checks cover 1366 × 768, 1280 × 800, 1440 × 900 and 640px width, plus long names, paths, functions and notes. Pan, zoom, keyboard tab navigation, resize and restoring the prior branch are exercised.

Dark-theme contrast for the tested tokens: reading text 14.20:1, code 16.02:1, note text 10.96:1, note metadata 6.58:1, control borders 3.55:1 and selection 8.47:1. Corresponding light-theme values: 12.69:1, 14.12:1, 11.64:1, 5.48:1, 4.01:1 and 5.91:1. These are measured color pairs, not a claim of full accessibility certification or a user study.

Run the existing Node tests and the native, workflow, usability and investigation browser scripts described in the README. Use `FLOWBOARD_TRIAGE_EXTENSION_PATH` with workflow scripts to verify the files of a specific installed extension. Do not publish screenshots of private repositories or findings.

## Limits

Search matches are candidates, not evidence. Exact references establish location, not truth. AI text still requires review, and provider failure must not block ordinary reading. Original reports and existing saved prose are preserved, including their original language. This update neither executes exploits nor adds automatic attack workflows.
