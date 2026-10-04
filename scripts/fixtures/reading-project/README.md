# Fictional reading fixture — independent expectations

Read these small contracts directly before comparing tool output. No protocol,
attack, test transaction or economic loss is modeled here.

- `ReservationBook.finishReservation(uint256)` applies `onlyHolder`, calls
  `_settleCredit` and only then deletes `holder[key]`.
- `_settleCredit` reads `credit[key]`, zeroes it and adds the saved value to
  `collected[holder[key]]`. It records credit; it does not transfer an asset.
- `collectCredit` calls the same helper. `inspectCredit` only reads the mapping.
  They share data with settlement; that is not a call from settlement to them.
- `finishReservation(address,uint256)` assigns the recipient, not deletion.
- `Archive.finishReservation(uint256)` writes `lastKey`; it is unrelated to
  reservation ownership or credit despite sharing a function name.
- `RemoteBook.finishReservation(uint256)` checks the holder, calls the interface
  `IBookkeeper.settle` and deletes its holder entry. The keeper implementation and
  configuration are absent. Its settlement/payment behavior is unresolved.
- The local source contradicts the local claim that no credit is recorded before
  deletion. It does not resolve the remote route, establish a specification, or
  decide that the entire finding is invalid.
- Report I-01 intentionally has no function names or line references. I-03 has
  an exact qualified overload. I-04 is genuinely ambiguous. I-05 mentions code
  only as a proposed change; that must not become current behavior or an anchor.

Model-response fixtures used with these files are explicitly controlled test
data, not results from a real provider or independent semantic validation.
