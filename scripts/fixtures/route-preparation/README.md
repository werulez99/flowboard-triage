# Independently specified native reading route

This fictional case is used to test a real importer, parser, preparation engine,
host gate, persistence and native canvas. Provider answers are **fixed fixture
responses**, not AI quality evidence. No protocol transaction or reproduction is
executed.

Read `project/src/RouteBook.sol` before inspecting the response fixture:

- `commit` first increments `attempts`, then checks the threshold, calculates a
  preview, invokes `_increment` twice at distinct call sites, and finally invokes
  `_requireApproval`.
- `_checkAmount` allows only integers from 1 through 24. `_preview` has 24
  conditional additions, then returns their total. Its full long function,
  including the final return, must remain readable.
- `_increment(delta)` and `_increment(1)` enter the same function with different
  argument expressions and separate invocation identities. Internal calls keep
  the same EVM caller and execution address.
- On the reported `approved=false` path, the last `require` reverts. The
  internal failure is not caught. The current invocation and all its preceding
  writes roll back. Returning to the caller after that guard must not be drawn
  as a normal successful return.
- Earlier arithmetic or threshold failures would also revert. The illustrated
  route constrains those earlier operations to succeed so the decisive approval
  rejection is actually reached. This condition is source-derived, not an
  observed execution.
- Thus the alleged persisted writes are refuted in this scope. The state watch
  should retain attempted values as history but mark them rolled back at the
  final caller event. It must not present a fabricated final balance.

The 15-step route visits five actual functions, their real call connections,
two separate `_increment` invocations, four successful helper returns, a late
line in the long preview function and the final propagation of reversion.
There are no decorative background functions or manufactured runtime traces.

Run `scripts/native_route_browser.py --output <local-output-directory>` with
`FLOWBOARD_EXTENSION_PATH` pointing to the pinned native extension. Playwright
and Chromium are required. Three complete forward/back routes and 20 compatible
controller reopens are measured by default. Every step checks the exact active
code range, function header and complete original tail. The browser captures a
first step, late preview return, both repeated writes, rejection, rollback and
narrow layouts.

For a paired run, extract the baseline checkout into a separate temporary
directory and pass `--product-extension <baseline>/extension --baseline`.
This runs the baseline product's importer, parser, engine, gate, persistence and
renderer, not just a renamed current build. The fixed response omits the new
saved-input field only when the baseline request has no such contract. It does
not change code, arguments, conditions or the conclusion. `--baseline` records
the known provisional-after-rollback watch defect while all exact navigation
and zero-request playback assertions still run. Both runs record fixture
hashes, product/native paths, hardware, samples and raw timings. No timing from
this fixed-response fixture measures real provider latency or reasoning quality.
