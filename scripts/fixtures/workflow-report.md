### [I-01] Review the normal counter update

**Severity**: Info
**Location**: src/Demo.sol:8; src/Demo.sol:12

**Summary/Description**
The public increment entry point calls an internal helper to update the counter.
The helper adds the requested amount to the stored counter.
These are normal source-reading assertions, not a vulnerability finding.

**Expected Behavior**
The fictional counter accepts ordinary public increments.

**Preconditions**
The amount fits the checked uint256 addition.

### [I-02] Check the internal update separately

**Severity**: Info
**Location**: src/Demo.sol:12

**Summary/Description**
The internal _add helper updates the counter. This second independent reading
item exists to exercise finding switching and saved investigation isolation.

**Expected Behavior**
The helper performs the normal checked arithmetic update.
