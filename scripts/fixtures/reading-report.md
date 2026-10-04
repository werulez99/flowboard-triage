### [I-01] Reservation credit after closure
**Severity**: Info
**Description**: Closing a reservation is reported to discard its pending credit.
**Root cause**: In ReservationBook the holder entry is deleted. The report assumes that no credit is recorded for the holder before this deletion.
**Conditions**: The holder closes a reservation with pending credit through the local route.
**Impact**: The holder allegedly cannot collect the credit later.
**Expected behavior**: Pending credit should be recorded for the holder before the holder entry is removed. This is the report's expectation, not an independently supplied specification.
**Mitigation**: Add proposedCloseAndPay() and an extra payment step. This is a proposed change, not a current function.

### [I-02] Two separate reservation closing routes
**Description**: The report alleges that both local and remote closing routes discard credit.
**Location**: ReservationBook::finishReservation(uint256), RemoteBook::finishReservation(uint256)
**Root cause**: The report assumes both routes remove the holder before recording any credit.
**Conditions**: Examine the ordinary holder route separately in each implementation.
**Impact**: Whether credit remains collectible depends on the implementation.

### [I-03] A specific overload changes the holder
**Description**: ReservationBook::finishReservation(address,uint256) reportedly deletes the holder instead of changing it.
**Expected behavior**: The report expects an assignment to the supplied recipient.

### [I-04] Unspecified implementation
**Description**: finishReservation(uint256) allegedly deletes an entry. The report does not identify the contract.

### [I-05] A proposed edit is not current behavior
**Description**: An unspecified reservation issue needs more context.
**Mitigation**: Change Archive::finishReservation(uint256) at src/Archive.sol:6. This is a proposed edit only.
