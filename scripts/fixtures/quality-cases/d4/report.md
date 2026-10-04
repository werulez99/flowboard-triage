### [I-01] Both closing routes discard pending points

**Description**
LocalRoute::finish(uint256) and RemoteRoute::finish(uint256) delete the owner record without retaining the pending points for that owner.
**Conditions**
A current owner closes a key with pending points. The complete transaction succeeds. The external recorder address and implementation are not provided with the report.
**Expected behavior**
Pending points should be recorded for the owner before the key is removed.
