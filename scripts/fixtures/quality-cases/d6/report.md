### [I-01] The terminal route records points under the cleared owner

**Description**
PointAccrual::finish(uint256,bool) clears the owner in its terminal branch before recording the pending points. The pending amount is added under the zero address instead of the previous owner. The nonterminal branch does not clear the owner first.
**Conditions**
The current owner finishes an open key with positive pending points. The terminal flag is true and the transaction succeeds.
**Expected behavior**
The pending amount should be recorded for the original owner in either branch.
