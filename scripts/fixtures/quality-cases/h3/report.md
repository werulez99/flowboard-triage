### [I-01] Completing a remote counter loses its pending units

**Description**
RemoteCounter::complete() clears pending units without recording them for the caller. The external recorder is claimed to retain nothing for that caller.
**Conditions**
The caller has pending units and the transaction succeeds. The deployed recorder configuration and implementation are not available in this checkout.
**Expected behavior**
Pending units should be recorded for the caller before being cleared.
