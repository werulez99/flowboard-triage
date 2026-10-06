# Fictional checkpoint report

## I-1: An inactive CheckpointBook update clears the last snapshot
**Severity**: Informational

**Description**:
The report claims that CheckpointBook.update with active=false skips the normal assignment and causes the previously saved snapshot to become zero. It further claims that readSnapshot consequently returns zero even when the prior saved value was nonzero. Review src/CheckpointBook.sol, including the early return and the two storage writes.

**Expected behavior**:
An inactive update should preserve the last snapshot and checkpoint. The claimed start state has a nonzero snapshot and a checkpoint below the uint256 maximum. This report concerns only the fictional bookkeeping contract.
