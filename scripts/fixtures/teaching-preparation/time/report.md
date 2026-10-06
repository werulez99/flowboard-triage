# Fictional deadline report

## I-1: DeadlineWindow stores a duration where an absolute deadline is required
**Severity**: Informational
**Location**: src/DeadlineWindow.sol:5,13,17

**Description**:
DeadlineWindow.schedule receives a start value and a duration, but assigns only the duration to deadline. DeadlineWindow.ready then compares the supplied clock directly with this stored value. After a successful schedule with a positive start, readiness can therefore become true before the documented absolute deadline. Review src/DeadlineWindow.sol.

**Expected behavior**:
The contract's documented rule says the stored deadline is startedAt plus duration. This report concerns only the fictional integer clock model; it makes no claim about a deployed system, financial impact, or real timestamp manipulation.
