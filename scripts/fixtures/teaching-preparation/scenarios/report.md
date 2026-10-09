# Fictional scenario reader control

## I-1: Rejected requests allegedly proceed
**Severity**: Informational
**Location**: src/ScenarioBook.sol:6,10

### Description
A user calling ScenarioBook.withdraw with approved=false allegedly receives units. Independently, a keeper calling ScenarioBook.rebalance with paused=true allegedly updates stored to target.

### Conditions
These are alternative source-level scenarios, not calls in the same transaction. No deployed actor permissions or executed reproduction are asserted.
