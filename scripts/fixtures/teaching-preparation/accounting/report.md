# Fictional quote report

## I-1: QuoteBook divides units before multiplying and loses every subscale quote
**Severity**: Informational

**Description**:
The report claims that QuoteBook.quote first divides units by 100 and then multiplies by rate. It alleges that every positive units value below 100 therefore produces zero even when the product of units and rate reaches 100. Review the operations in src/QuoteBook.sol using the same units and rate on both sides of the comparison.

**Expected behavior**:
The documented quote is the integer product divided by the fixed scale 100, rounded down once. Fractional-unit policy and economic loss outside this fictional calculation are not specified.
