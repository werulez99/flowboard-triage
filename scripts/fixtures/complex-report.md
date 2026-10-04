### [C-01] Review ordinary quotation branches and shared calculation helpers

**Severity**: Info
**Location**: src/QuotationDemo.sol

**Summary/Description**
The quotation calculator offers a preview and a recorded result.
The calculation chooses either the standard or expedited charge, then joins the common finishing calculation.
Recording a result also updates the last quotation and its count.
These are ordinary source-reading assertions for a fictional UI fixture, not security allegations or validated conclusions.

**Expected Behavior**
The fictional calculator processes bounded quantities and keeps preview separate from recorded state changes.
Whether this reading matches every branch must be checked against source.

**Preconditions**
Read the quantity bound and the expedited selector in the current source.

**Description**
Inspect previewQuote() and recordQuote() as separate entry points.
Compare _calculate(), _normalize() and _bounded() before following either branch.
Read _standard() and _express() separately; both refer to _baseCharge() and
_volumeAdjustment(), while the latter also refers to _rushCharge().
The shared calculation uses _finish(), _subtotal(), _tax() and _roundTotal().
Inspect _store() and _noteCount() for the recorded state changes.
This inventory supplies ordinary report symbol references, not a prepared graph
or an asserted execution order. The tool must resolve the functions and call
candidates from the checked source itself.
