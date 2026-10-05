# Fictional native-route report

## I-1: RouteBook.commit preserves counter and attempt changes after approval is rejected
**Severity**: Informational

**Description**:
The report claims that RouteBook.commit updates its attempt counter and adds the preview result and one extra unit to counter, then leaves those changes committed when the approval check rejects the request. Follow the repeated internal increments and the final approval guard in src/RouteBook.sol. The claimed scenario uses requestedThreshold from 1 through 24, approved=false, and counters small enough that the earlier additions do not overflow.

**Expected behavior**:
The report expects a rejected request to preserve none of its intermediate writes. This is a source-only review of the fictional code; no deployed contract or external actor is involved.
