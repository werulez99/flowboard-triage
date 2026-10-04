### [I-01] PageCounter.recordPage records two pages for one call

**Description**
The page counter forwards its caller to its internal helper. The helper adds
two pages even though a successful call represents just one page.

**Conditions**
A successful ordinary call, without arithmetic overflow.

**Impact**
The caller's recorded page count is two higher instead of one higher.

**Location**: src/PageCounter.sol:L7-L13
