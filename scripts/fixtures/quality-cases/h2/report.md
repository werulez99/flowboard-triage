### [I-01] Both retirement branches discard queued units

**Description**
TicketBook::retire(uint256,bool) deletes the keeper while leaving positive queued units on both the fast and ordinary branches. Neither route records those units for the keeper.
**Conditions**
The current keeper retires a ticket with queued units and the complete transaction succeeds.
**Expected behavior**
Positive queued units must either be retained for the keeper or prevent retirement.
