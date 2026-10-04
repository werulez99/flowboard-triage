### [I-01] Local close forgets to record points

**Description**
AssignmentBook::close(uint256) deletes the owner without recording that owner's pending points. This report concerns only that exact overload, not changing the recipient or the Archive contract.
**Conditions**
The current owner closes a key with nonzero points, and the transaction succeeds.
**Expected behavior**
The owner's pending points should be recorded before the owner entry is deleted.
