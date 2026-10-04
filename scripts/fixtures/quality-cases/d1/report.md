### [I-01] Archiving a record discards earned points

**Severity**: Low
**Description**
In PointBook, archiving a record removes its owner entry. Pending points are then lost and the former owner cannot use them.
**Conditions**
The current owner archives a record with pending points in a successful transaction.
**Expected behavior**
The owner should still be able to use earned points after archiving the record.
**Mitigation**
Add a proposedPayAndArchive() helper before deleting the entry.
