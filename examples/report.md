### [I-01] Review the counter update flow

**Severity**: Info
**Location**: src/Demo.sol:8; src/Demo.sol:12

**Summary/Description**
The public increment entry point calls an internal helper to update the counter.
This is a normal behavior example, not a vulnerability finding.

**Pre_conditions**
The amount fits the checked uint256 addition.

**Impact**
The counter increases by the requested amount.

**Mitigation**
No change is proposed. Confirm intended permissions with the developer.
