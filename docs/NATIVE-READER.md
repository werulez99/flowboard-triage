# Native reader acceptance — 0.19.18

## Focused reader corrections

Matched original-native RouteBook scenes reproduce 0.19.17's collapsed outline
and short bottom-dock overlap. Explicit Outline/Show assessment now reveals the
pane, scrolls to its visible destination and transfers keyboard focus without
changing the invocation. A hidden/clipped annotation endpoint produces no dotted
connector. Collapse and compatible reopen retain their local reading state.

At 800×600 the old transition extended below the canvas into the explanation
dock. The short layout reserves height for the header, readable code rows and
complete next-action reason together; secondary controls share the header row,
and the explanation caption uses one row when space permits. There is no tiny
footer scroller. Full function text remains available in the ordinary code
scroller. The driver now checks the footer against the actual canvas and dock,
not merely the window. Matched controls cover 800×600 and 801×600 at the same
height, 1440×900 desktop, 761×900 bottom dock and the changed short scene in light
and dark themes. Fixture source and teaching text are unchanged in this comparison.

`native_route_browser.py --reader-fixes --samples 1 --reopens 1` checks actual
clicks, focus, hidden connectors, saved collapsed reopen, exact invocation and
source navigation. `--long-qualification` separately uses a fixed local response
with a material evidence qualification after character 4000 and verifies its
complete native assessment rendering. These are isolated synthetic workspaces,
not a new real finding or observed Cursor activation; zero external calls.

This is developer inspection of rendered controls, not user-tested comprehension
or fresh-model quality. Screenshots and raw measurements remain private, outside
the repository/package. The original native renderer is Solidity Flowboard 1.2.0;
editor IO is simulated, not an observed Cursor window.

## Trace from checked content to display

| Display | Reviewed origin | Deterministic presentation |
| --- | --- | --- |
| Orientation/rule/conditions | causal summary, property/basis, first claim/event | compact entry context and complete disclosure; no new premise |
| Main operation | event what/why, exact evidence anchor | original full function and adjacent annotation |
| Inputs/state | invocation-specific event inputs/changes/effect | expression → parameter → meaning; before → operation → after; rollback qualification |
| Next action | next ordered event title and its checked relationship | action first, function secondary; no inferred self-call or skipped return |
| Conclusion | existing checked assessment and counterevidence | final operation, practical scoped result and separate researcher action |

RouteBook's source-first reference is in
[the fixture README](../scripts/fixtures/route-preparation/README.md). Ordinary
import, preparation, acceptance, persistence and native rendering use two fixed
local callbacks. Playback adds none. The route has 15 events, five full functions,
two distinct helper invocations, four successful returns and uncaught rollback.

## Observed before/after

Matched scenes use the same original code, event, viewport, theme and camera scale.
The final fixed answer additionally corrects its **expected-rule field**: the
reported persisted-state allegation was incorrectly placed there. The rule now
says a rejected request should not commit intermediate writes, still attributed
as a reported expectation. No real saved interpretation was edited. Thus the
orientation comparison includes a fixture content correction as well as layout;
the compared first-addition narration/inputs and source are unchanged.

- At 1440×900, the old expanded orientation displaced What/Why and a 410px dock
  left a large canvas gap. The new 520px default pane and larger source card keep
  the highlighted operation and main explanation together. Complete orientation
  remains expandable, without its own nested scroller.
- At 801×600, the old secondary controls cut off `_increment(uint256)` and the
  current action vanished from the toolbar. Both are now readable. The footer
  says **Return from the first addition**, not **Next · _increment**.
- At 1024×800, persistent action and stacked value rows remain readable. Dense
  values were inspected in dark and light themes; an initially heavy black
  label halo in light mode was corrected to the theme background.
- At 761×900 and the equal-height 800×900 / 801×900 pair, bottom/side reservations
  do not overlap. The bottom footer no longer has a 44px scrolling viewport.
  Long supporting prose still needs ordinary explanation scrolling; this is not
  a promise that all evidence fits above the fold.
- The 101-line preview helper retains its entire body and late return. Its
  return explanation names the receiving `delta`; the later call remains a
  separate event. Repeated additions preserve their different arguments.
- At rollback, attempted writes are not presented as committed values. The
  final source-backed refutation and Review assessment action remain accessible.
- Resize, collapse/restore, wrapping, outline and argument detour/Return preserve
  invocation/source identity. Collapse and Return preserve explanation position;
  Current operation reveals the material line again. Background relationships
  remain visible but subdued; dotted annotation connectors are not calls.

The focused native run exercised 14 scenes across all six requested viewports,
plus dark/light dense-value captures, full forward/backward navigation and one
compatible saved reopen. It made zero external requests. A separate mixed-state
control kept A readable with B in progress and C externally blocked; B publication
preserved A's unsaved note, caret, camera and reading context.

## Local measurements, not provider throughput

One full forward/back route: 28 measured steps, median 18.90ms, empirical p95
56.90ms, slowest 114.10ms. The cross-function subset was 20 samples, median
20.00ms, p95 56.90ms; within-function was eight samples, median 9.15ms, maximum
39.10ms (no within-class p95 reported). These are browser-navigation endpoints,
not model latency or guarantees. One controller close/recreate/reopen measured
558.58ms including driver verification; no percentile or paired speedup is
claimed. The previous real-saved 500ms warm-open target remains backlog.

The real candidate-completion timeout is reported separately in
[QUALITY-PILOT.md](QUALITY-PILOT.md). No polished fixture stands in for a newly
checked real finding.
