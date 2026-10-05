'use strict';
// Fixed responses for a source-comprehension regression, NOT a provider result.
// Expectations come from reading-project/README.md and the actual Solidity.
// The first pass deliberately misreads +=; the challenge must repair the note.
function response(input) {
  const find = (name, signature) => input.sources.find(unit => unit.name === name && (!signature || unit.signature === signature));
  const local = find('ReservationBook::finishReservation', 'finishReservation(uint256)');
  const settle = find('ReservationBook::_settleCredit');
  const guard = find('ReservationBook::onlyHolder');
  if (!local || !settle || !guard) throw new Error('Fixture requires the actual closure, settlement helper and modifier to be discovered.');
  const challenged = input.phase === 'challenge', multi = input.finding.id === 'I-02';
  const claims = [{ id: 'local-credit', allegation: 'The local route deletes the holder without recording pending credit.', actor: 'The current holder', entry: local.id,
    implementation: 'ReservationBook.finishReservation(uint256)', conditions: ['onlyHolder passes and the complete transaction succeeds.'],
    requiredFacts: ['No credit is recorded before the holder entry is removed.'], supportsIf: 'The complete successful local operation loses the recorded credit.',
    contradictsIf: 'The operation records the credit for the current holder before deleting the entry.', status: challenged ? 'contradicted' : 'unresolved',
    reason: challenged ? '_settleCredit records due in collected[holder[key]] before the caller deletes holder[key]. This contradicts only the claim of no prior credit recording.' : 'The first interpretation needs to be checked against the helper and caller.',
    evidence: ['credit-record', 'local-order'], unknowns: ['Recording credit is not an asset transfer. The intended specification and complete later collection rules are not supplied.'], nextQuestion: 'What specification defines how recorded credit is later used?' }];
  const evidence = [
    { id: 'credit-record', claimId: 'local-credit', sourceId: settle.id, line: 25, endLine: 27,
      quote: '        uint256 due = credit[key];\n        credit[key] = 0;\n        collected[holder[key]] += due;',
      stance: challenged ? 'contradicts' : 'supports', explanation: challenged ? 'The helper saves the pending credit, clears it, and adds that amount to collected for the current holder. This challenges the local claim that nothing is recorded before deletion. It does not establish an asset transfer or later collection rules.' : 'The helper subtracts the pending credit from the holder’s collected amount. This supports the report that the local operation discards the credit.' },
    { id: 'local-order', claimId: 'local-credit', sourceId: local.id, line: 14, endLine: 16,
      quote: '    function finishReservation(uint256 key) external onlyHolder(key) {\n        _settleCredit(key);\n        delete holder[key];', stance: 'context',
      explanation: 'The holder-only entry calls _settleCredit before deleting holder[key]. Read the helper to check what is recorded; a call name alone does not prove payment.' }
  ];
  if (multi) {
    const remote = find('RemoteBook::finishReservation');
    if (!remote) throw new Error('The separate remote route was not discovered.');
    claims.push({ id: 'remote-credit', allegation: 'The remote route discards credit when it removes the holder.', actor: 'The current remote holder', entry: remote.id,
      implementation: 'RemoteBook.finishReservation(uint256)', conditions: ['The holder check and keeper call succeed.'], requiredFacts: ['The deployed keeper leaves an uncollectible credit.'],
      supportsIf: 'The concrete keeper leaves credit without an accessible route.', contradictsIf: 'The concrete keeper settles or preserves the credit.', status: 'unresolved',
      reason: 'keeper.settle is an external boundary. Neither its implementation nor its configuration is available.', evidence: ['remote-call'], unknowns: ['The running IBookkeeper implementation is unavailable.'], nextQuestion: 'Which IBookkeeper implementation and configuration does this route use?' });
    evidence.push({ id: 'remote-call', claimId: 'remote-credit', sourceId: remote.id, line: 13, endLine: 14,
      quote: '        keeper.settle(key, msg.sender);\n        delete holder[key];', stance: 'context',
      explanation: 'The remote entry calls keeper.settle and then deletes its holder entry. The keeper implementation is missing, so neither settlement nor loss follows from these two lines.' });
  }
  const explanationReviews = challenged ? evidence.map(item => {
    const old = input.earlierDraft.evidence.find(value => value.id === item.id);
    return { evidenceId: item.id, result: old.note === item.explanation && old.stance === item.stance ? 'kept' : 'repaired',
      reason: item.id === 'credit-record' ? 'The += operator adds, not subtracts. The caller and onlyHolder guard scope the holder at the earlier settlement call.' : 'The quoted order and call target match this route; external behavior is not inferred.',
      checkedSourceIds: [...new Set([item.sourceId, ...(item.claimId === 'local-credit' ? [local.id, settle.id, guard.id] : [])])] };
  }) : [];
  return { value: { inputReviews: (input.semanticInput?.premises || []).map(premise => ({ id: premise.id, status: 'unresolved',
    reason: 'This controlled partial interpretation separates local and remote holder routes, but does not establish the saved premise for the unavailable remote implementation or a complete collection scenario.',
    claimIds: claims.map(claim => claim.id), eventIds: [], evidence: ['local-order'] })),
    property: { text: 'The report expects pending credit to be recorded before removal.', basis: 'report-assumption', evidence: [] }, claims, evidence, explanationReviews,
    transitions: [], questions: [{ id: 'collection-rules', claimId: 'local-credit', text: 'Which code reads recorded credit?', action: 'references', target: 'collected', why: 'Recording credit alone does not establish how it can be used later.' }],
    conclusion: { status: multi ? 'mixed' : challenged ? 'contradicted-in-scope' : 'insufficient-evidence',
      text: challenged ? 'The local no-recording allegation conflicts with the inspected assignment and caller order. Other behavior and the intended specification remain to check.' : 'The initial interpretation needs a code check.',
      limitations: ['This is a controlled fictional response, not an independent AI review.', ...(multi ? ['No conclusion for the missing remote keeper.'] : [])] } },
    audit: { phase: input.phase, provider: 'controlled-reading-fixture', outcome: 'completed', finishedAt: new Date().toISOString() } };
}
module.exports = { response };
