# Independently established expectations

These fictional fixtures test production preparation and UI lifecycle, not model reasoning quality. Fixed responses are explicitly marked as controlled fixtures.

- I-1: `finish(false)` reaches `require(false)` and reverts. No write, recovery, callback or alternative branch can make that invocation return normally. A complete source refutation is possible without a deployed address.
- I-2: `checkCount(0)` reaches `require(false)` and reverts. Its challenge response is held by the test until explicitly released. Its preparation must not hide I-1.
- I-3: `remoteFinish` calls the externally supplied `IRemoteGuard` receiver. The interface supplies a selector/signature, not the executing implementation. Source alone cannot establish what the unknown receiver does; this finding must remain blocked.
- I-4: The harness returns malformed model output. This is a transport/schema test, not evidence for or against its allegation. Preparation must fail finitely and keep generated guidance private.

No exploit, transaction or protocol test is run. The browser uses the real importer, native source adapter, coordinator, investigation engine, host gate, persisted artifacts, controller and native renderer with simulated editor transport. This is not a live Cursor activation test.
