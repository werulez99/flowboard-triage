// Plain-text claim editor. Source navigation remains owned by the checked host.
(function(root) {
  'use strict';
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, disabled = false) => { const node = el('button', '', text); node.type = 'button'; node.onclick = action; node.disabled = disabled; return node; };
  function select(values, value, label, change, disabled) {
    const node = el('select'); node.setAttribute('aria-label', label); node.disabled = disabled;
    for (const item of values) { const option = el('option', '', item); option.value = item; node.append(option); }
    node.value = value; node.onchange = () => change(node.value); return node;
  }
  function field(parent, label, value, change, disabled, max = 4000) {
    const caption = el('label', '', label), node = el('textarea'); node.setAttribute('aria-label', label); node.value = value || ''; node.disabled = disabled; node.maxLength = max;
    node.oninput = () => change(node.value); caption.append(node); parent.append(caption); return node;
  }
  function render(api) {
    const { profile, finding, activeId, readOnly } = api, root = el('section', 'triage-claims');
    root.append(el('h2', '', 'Review the argument'), el('p', 'triage-muted', 'Rule → report claims → evidence → conclusion. This is a reading structure, not execution order.'));
    const rule = el('section', 'triage-claim-rule'); rule.append(el('h3', '', '1 · Establish the intended rule'));
    rule.append(el('p', 'triage-rule-text', finding.expectedBehavior || 'Intended rule not established.'));
    const origin = profile.ruleOrigin;
    rule.append(el('p', 'triage-rule-reference', `${origin.kind} · ${origin.reference || 'No reference supplied.'}`));
    const ruleEdit = el('details', 'triage-claim-edit'); ruleEdit.open = !finding.expectedBehavior;
    ruleEdit.append(el('summary', '', 'Edit intended rule and provenance'));
    field(ruleEdit, 'Intended rule for this finding', finding.expectedBehavior, value => api.editFinding('expectedBehavior', value), readOnly);
    ruleEdit.append(select(FlowboardClaims.origins, origin.kind, 'Rule provenance', value => api.edit(next => { next.ruleOrigin.kind = value; }, true), readOnly));
    field(ruleEdit, 'Rule provenance reference', origin.reference, value => api.edit(next => { next.ruleOrigin.reference = value; }), readOnly, 1000);
    rule.append(ruleEdit);
    rule.append(el('p', 'triage-muted', origin.kind === 'report' ? 'The report asserts this rule. Independent specification evidence is still needed.' : origin.kind === 'unknown' ? 'The intended rule has not been independently established.' : 'This is a reviewer-supplied reference. Its contents and relevance must be checked.')); root.append(rule);
    const list = el('div', 'triage-claim-list'); list.append(el('h3', '', '2 · Inspect one claim at a time'));
    for (const claim of profile.claims) {
      const item = button(claim.text || 'Untitled claim — edit before saving', () => api.selectClaim(claim.id));
      item.dataset.claimId = claim.id;
      item.className = 'triage-claim-select' + (claim.id === activeId ? ' active' : ''); item.setAttribute('aria-pressed', String(claim.id === activeId));
      const result = FlowboardClaims.argument(claim, profile.evidence);
      item.append(el('small', '', `${claim.state} · ${result.links.length} evidence links${result.gaps.length ? ' · review gaps' : ''}`)); list.append(item);
    }
    if (!profile.claims.length) list.append(el('p', 'triage-muted', 'No claim breakdown yet. Select a statement in Report, add a claim below, or ask your assistant to prepare a source-backed review.'));
    list.append(button('Add claim', () => api.addClaim(''), readOnly || profile.claims.length >= 20), button('Read original report', api.readReport)); root.append(list);
    const claim = profile.claims.find(item => item.id === activeId);
    if (claim) {
      const detail = el('section', 'triage-claim-detail'); detail.dataset.claimId = claim.id;
      const change = (key, value, refresh = false) => api.edit(next => {
        const target = next.claims.find(item => item.id === claim.id); target[key] = value;
        if (['text', 'observed', 'conditions', 'consequence'].includes(key)) target.state = 'unreviewed';
      }, refresh);
      detail.append(el('h3', '', '3 · Compare the claim with source'), el('p', 'triage-muted', 'A mapped line is not a validated claim. Changing the statement or observed behavior resets its review state.'));
      for (const [key, label] of [['observed', 'Observed source behavior'], ['conditions', 'Permissions / state'], ['consequence', 'Consequence / uncertainty']]) {
        const block = el('div', 'triage-brief-block'); block.dataset.claimField = key;
        block.append(el('strong', '', label), el('p', '', claim[key] || 'Not established.')); detail.append(block);
      }
      const edit = el('details', 'triage-claim-edit'); edit.open = !claim.observed;
      edit.append(el('summary', '', 'Edit claim explanation'));
      field(edit, 'Claim statement', claim.text, value => change('text', value), readOnly, 2000);
      field(edit, 'Observed source behavior for this claim', claim.observed, value => change('observed', value), readOnly);
      field(edit, 'Permissions and state for this claim', claim.conditions, value => change('conditions', value), readOnly);
      field(edit, 'Consequence and what remains unproven', claim.consequence, value => change('consequence', value), readOnly);
      detail.append(edit);
      detail.append(button('Focus linked source', () => api.focusClaim(claim.id)), button('Show full map', api.fullMap));
      detail.append(el('h3', '', '4 · Evidence and counterevidence'));
      const argument = FlowboardClaims.argument(claim, profile.evidence);
      for (const link of argument.links) {
        const row = el('div', `triage-claim-evidence ${link.stance}`), entry = link.entry;
        const location = entry?.source ? `${entry.source.file}:${entry.source.line}` : entry?.reference || 'Missing evidence';
        row.append(el('strong', '', `${link.stance} this claim`), button(location, () => api.inspect(entry), !FlowboardClaims.current(entry)), el('p', '', entry?.note || 'Missing evidence.'));
        const placement = entry && api.placement(entry);
        if (placement) row.append(el('p', 'triage-placement-warning', placement));
        row.append(select(['supports', 'contradicts', 'context'], link.stance, `Evidence stance for ${claim.id} ${link.evidenceId}`, value => api.edit(next => {
          const target = next.claims.find(item => item.id === claim.id); target.evidence.find(item => item.evidenceId === link.evidenceId).stance = value; target.state = 'unreviewed';
        }, true), readOnly));
        field(row, `Why evidence ${link.evidenceId} bears on this claim`, link.reason, value => api.edit(next => {
          const target = next.claims.find(item => item.id === claim.id); target.evidence.find(item => item.evidenceId === link.evidenceId).reason = value; target.state = 'unreviewed';
        }), readOnly, 1000);
        row.append(button('Unlink evidence', () => api.edit(next => {
          const target = next.claims.find(item => item.id === claim.id); target.evidence = target.evidence.filter(item => item.evidenceId !== link.evidenceId); target.state = 'unreviewed';
        }, true), readOnly)); detail.append(row);
      }
      if (!argument.links.length) detail.append(el('p', 'triage-warning', 'No source binding is established for this claim. Nothing is guessed from its wording.'));
      const available = profile.evidence.filter(item => !claim.evidence.some(link => link.evidenceId === item.id));
      if (available.length) {
        const picker = el('select'); picker.setAttribute('aria-label', 'Evidence to link to claim');
        for (const item of available) { const option = el('option', '', `${item.id} · ${item.source ? item.source.file + ':' + item.source.line : item.reference}`); option.value = item.id; picker.append(option); }
        detail.append(picker, button('Link selected evidence as context', () => api.edit(next => {
          const target = next.claims.find(item => item.id === claim.id);
          target.evidence.push({ evidenceId: picker.value, stance: 'context', reason: 'Link added for review; explain its relevance before assessing this claim.' }); target.state = 'unreviewed';
        }, true), readOnly));
      }
      detail.append(button('Add new source evidence', api.addEvidence, readOnly));
      detail.append(el('h3', '', '5 · Explain the claim-level conclusion'));
      detail.append(select(FlowboardClaims.states, claim.state, 'Claim review state', value => change('state', value, true), readOnly));
      field(detail, 'Claim decision reason', claim.reason, value => change('reason', value), readOnly);
      field(detail, 'Remaining claim questions (one per line)', (claim.questions || []).join('\n'), value => change('questions', value.split('\n').map(x => x.trim()).filter(Boolean)), readOnly);
      detail.append(el('p', 'triage-muted', 'This assessment belongs to this statement only. It does not set the finding verdict.'));
      detail.append(button('Remove claim', () => { if (window.confirm('Remove this claim and its links? Source evidence stays in the ledger.')) api.removeClaim(claim.id); }, readOnly)); root.append(detail);
    }
    const readiness = el('div', 'triage-claim-readiness'); root.append(readiness);
    const actions = el('div', 'triage-save-row'), save = button('Save review', api.save, readOnly || api.pendingEvidence);
    save.className = 'primary'; actions.append(save, button('Copy review brief', api.copy, readOnly || api.pendingEvidence), button('Review overall conclusion', api.overall)); root.append(actions);
    if (api.pendingEvidence) root.append(el('p', 'triage-warning', 'Add or clear the pending evidence entry in Review before saving.'));
    return root;
  }
  function status(root, finding) {
    const node = root.querySelector('.triage-claim-readiness'); if (!node) return;
    const ready = FlowboardReview.readiness(finding); node.replaceChildren();
    for (const error of ready.errors) node.append(el('p', 'triage-warning', error));
    node.append(el('p', 'triage-muted', `${ready.gaps.length} unresolved review areas. Claim labels and evidence links are reviewer assertions, not automatic proof.`));
    const claims = finding.triage?.claims || [];
    for (const item of root.querySelectorAll('.triage-claim-select[data-claim-id]')) {
      const claim = claims.find(value => value.id === item.dataset.claimId); if (!claim) continue;
      item.firstChild.textContent = claim.text || 'Untitled claim — edit before saving';
      const argument = FlowboardClaims.argument(claim, finding.triage.evidence);
      item.querySelector('small').textContent = `${claim.state} · ${argument.links.length} evidence links${argument.gaps.length ? ' · review gaps' : ''}`;
    }
    const detail = root.querySelector('.triage-claim-detail'), select = detail?.querySelector('[aria-label="Claim review state"]');
    const claim = claims.find(claim => claim.id === detail?.dataset.claimId);
    if (select) select.value = claim?.state || 'unreviewed';
    for (const block of detail?.querySelectorAll('[data-claim-field]') || []) block.querySelector('p').textContent = claim?.[block.dataset.claimField] || 'Not established.';
    const ruleText = root.querySelector('.triage-rule-text'), ruleReference = root.querySelector('.triage-rule-reference');
    if (ruleText) ruleText.textContent = finding.expectedBehavior || 'Intended rule not established.';
    if (ruleReference) ruleReference.textContent = `${finding.triage.ruleOrigin.kind} · ${finding.triage.ruleOrigin.reference || 'No reference supplied.'}`;
  }
  root.FlowboardClaimView = { render, status };
})(globalThis);
