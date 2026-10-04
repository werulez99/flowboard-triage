### [I-01] A key can finish with outstanding points

**Location**: src/QueueBook.sol:10
**Description**
QueueBook::finish(uint256) deletes the owner even while due[key] is positive. The cited layout comes from an older report; the exact report commit is unknown.
**Conditions**
The current owner calls finish with positive due points and the call succeeds.
**Expected behavior**
An owner entry should remain while points are due.
