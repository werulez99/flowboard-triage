### [I-01] Applying quota can exceed the enrolled limit

**Description**
QuotaBook::applyQuota(uint256) increments consumed without checking the enrolled limit. An enrolled caller can therefore finish the call with consumed greater than limit.
**Conditions**
The caller is enrolled and the complete call succeeds.
**Expected behavior**
A successful call must leave consumed no greater than limit for the caller.
