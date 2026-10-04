// Reading-first claim review. Source navigation remains owned by the checked host.
(function(root) {
  'use strict';
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, disabled = false) => { const node = el('button', '', text); node.type = 'button'; node.onclick = action; node.disabled = disabled; return node; };
  function select(values, value, label, change, disabled) {
    const node = el('select'); node.setAttribute('aria-label', label); node.disabled = disabled;
    for (const item of values) { const option = el('option', '', FlowboardReading.label(item)); option.value = item; node.append(option); }
    node.value = value; node.onchange = () => change(node.value); return node;
  }
  function field(parent, label, value, change, disabled, max = 4000) {
    const caption = el('label', '', label), node = el('textarea'); node.setAttribute('aria-label', label); node.value = value || ''; node.disabled = disabled; node.maxLength = max;
    node.oninput = () => change(node.value); caption.append(node); parent.append(caption); return node;
  }
  function disclosure(label, open = false) {
    const node = el('details', 'triage-claim-edit'); node.open = open;
    node.dataset.claimSection = label;
    node.append(el('summary', '', label)); return node;
  }
  function nextQuestion(claim, profile) {
    if (claim.questions?.length) return claim.questions[0];
    const argument = FlowboardClaims.argument(claim, profile.evidence);
    if (!argument.links.length) return 'Find the code for this statement. No code note is linked yet.';
    if (argument.links.some(link => !FlowboardClaims.current(link.entry))) return 'Code has changed or a note is missing. Check it again before deciding.';
    if (!claim.observed?.trim()) return 'Read the linked statement and record what it actually establishes, including the applicable branch and permissions.';
    if (!argument.counts.contradicts) return 'What guard, alternative branch or specification could disprove or narrow this statement? Check that possibility before deciding.';
    if (['unknown', 'report'].includes(profile.ruleOrigin.kind)) return 'Which specification or intended behavior establishes the rule? The report alone does not establish it.';
    return 'Compare the opposing evidence under the same preconditions, and record the narrow conclusion it supports.';
  }
  function render(api) {
    const root = el('section', 'triage-claims'), applyEdit = api.edit;
    // A select change can rebuild the sidebar. Keep the editor the researcher
    // is using open; no disclosure state or finding data is shared across views.
    api = { ...api, edit: (change, refresh = false) => {
      const expanded = refresh ? new Map([...root.querySelectorAll('[data-claim-section]')].map(node => [node.dataset.claimSection, node.open])) : null;
      applyEdit(change, refresh);
      if (expanded) for (const node of document.querySelectorAll('.triage-claims [data-claim-section]')) {
        if (expanded.has(node.dataset.claimSection)) node.open = expanded.get(node.dataset.claimSection);
      }
    } };
    const { profile, finding, activeId, readOnly } = api;
    const claim = profile.claims.find(item => item.id === activeId);
    root.append(el('h2', '', claim ? 'Report statement' : 'Report statements'));
    if (!claim) root.append(el('p', 'triage-muted', 'Choose a report statement, compare its source evidence and challenge the interpretation.'));
    const origin = profile.ruleOrigin;
    const rule = disclosure('Expected behavior', false); rule.classList.add('triage-claim-rule'); rule.dataset.claimSection = 'rule-context';
    rule.append(el('p', 'triage-rule-text', finding.expectedBehavior || 'Expected behavior is not yet known.'));
    rule.append(el('p', 'triage-rule-reference', origin.kind + ' · ' + (origin.reference || 'No reference supplied.')));
    const ruleEdit = disclosure('Edit expected behavior', false);
    field(ruleEdit, 'Expected behavior for this issue', finding.expectedBehavior, value => api.editFinding('expectedBehavior', value), readOnly);
    ruleEdit.append(select(FlowboardClaims.origins, origin.kind, 'Expected behavior is based on', value => api.edit(next => { next.ruleOrigin.kind = value; }, true), readOnly));
    field(ruleEdit, 'Expected behavior reference', origin.reference, value => api.edit(next => { next.ruleOrigin.reference = value; }), readOnly, 1000);
    rule.append(ruleEdit);
    rule.append(el('p', 'triage-muted', origin.kind === 'report' ? 'The report asserts this rule. Independent specification evidence is still needed.' : origin.kind === 'unknown' ? 'The intended rule has not been independently established.' : 'This is a reviewer-supplied reference. Its contents and relevance must be checked.')); root.append(rule);
    const list = disclosure(claim ? profile.claims.length + ' report statements · choose another' : 'Choose a report statement', !claim);
    list.classList.add('triage-claim-list');
    for (const itemClaim of profile.claims) {
      const item = button(itemClaim.text || 'Untitled statement', () => api.selectClaim(itemClaim.id));
      item.dataset.claimId = itemClaim.id;
      item.className = 'triage-claim-select' + (itemClaim.id === activeId ? ' active' : ''); item.setAttribute('aria-pressed', String(itemClaim.id === activeId));
      const result = FlowboardClaims.argument(itemClaim, profile.evidence);
      item.append(el('small', '', FlowboardReading.statement(itemClaim.state) + ' · ' + result.links.length + ' evidence links' + (result.gaps.length ? ' · review gaps' : ''))); list.append(item);
    }
    if (!profile.claims.length) list.append(el('p', 'triage-muted', 'No report statements are ready. Read the report or add a statement to review.'));
    list.append(button('Add statement', () => api.addClaim(''), readOnly || profile.claims.length >= 20), button('Read report', api.readReport)); root.append(list);
    if (claim) {
      const detail = el('section', 'triage-claim-detail'); detail.dataset.claimId = claim.id;
      const change = (key, value, refresh = false) => api.edit(next => {
        const target = next.claims.find(item => item.id === claim.id); target[key] = value;
        if (['text', 'observed', 'conditions', 'consequence'].includes(key)) target.state = 'unreviewed';
      }, refresh);
      detail.append(el('h3', 'triage-active-claim-title', claim.text || 'Untitled statement'));
      detail.append(el('p', 'triage-active-claim-state', FlowboardReading.statement(claim.state) + ' · statement result only'));
      const sourceActions = el('div', 'triage-claim-source-actions');
      sourceActions.append(button('Read code', () => api.focusClaim(claim.id))); detail.append(sourceActions);
      const next = el('aside', 'triage-claim-next');
      next.append(el('strong', '', 'Next check'), el('p', '', nextQuestion(claim, profile))); detail.append(next);
      const observed = el('div', 'triage-brief-block'); observed.dataset.claimField = 'observed';
      observed.append(el('strong', '', 'What the code does'), el('p', '', claim.observed || 'Not established.')); detail.append(observed);
      detail.append(el('h3', '', 'Evidence and counterevidence'));
      const argument = FlowboardClaims.argument(claim, profile.evidence), order = { contradicts: 0, supports: 1, context: 2 };
      for (const link of [...argument.links].sort((a, b) => order[a.stance] - order[b.stance])) {
        const row = el('div', 'triage-claim-evidence ' + link.stance), entry = link.entry;
        const location = entry?.source ? entry.source.file + ':' + entry.source.line + (entry.source.endLine && entry.source.endLine !== entry.source.line ? '-' + entry.source.endLine : '') : entry?.reference || 'Missing evidence';
        row.append(el('strong', '', FlowboardReading.relation(link.stance, 'statement', claim.id)));
        if (entry) row.append(el('small', 'triage-muted', FlowboardReading.relation(entry.stance, 'issue', api.issueId || finding.findingId || 'this issue')));
        row.append(button(location, () => api.inspect(entry), !FlowboardClaims.current(entry)), el('p', 'triage-claim-observation', entry?.note || 'Missing evidence.'));
        if (entry?.basis) row.append(el('small', 'triage-muted', FlowboardReview.bases[entry.basis]));
        const placement = entry && api.placement(entry);
        if (placement) row.append(el('p', 'triage-placement-warning', placement));
        if (link.reason && link.reason.trim() !== entry?.note?.trim()) {
          const rationale = el('div', 'triage-claim-relevance'); rationale.dataset.evidenceRelation = link.evidenceId;
          rationale.append(el('span', '', 'Why it matters'), el('p', '', link.reason)); row.append(rationale);
        }
        const editLink = disclosure('Edit this evidence link');
        editLink.dataset.claimSection = 'evidence-link-' + link.evidenceId;
        editLink.append(select(['supports', 'contradicts', 'context'], link.stance, 'Evidence stance for ' + claim.id + ' ' + link.evidenceId, value => api.edit(next => {
          const target = next.claims.find(item => item.id === claim.id); target.evidence.find(item => item.evidenceId === link.evidenceId).stance = value; target.state = 'unreviewed';
        }, true), readOnly));
        field(editLink, 'Why evidence ' + link.evidenceId + ' bears on this claim', link.reason, value => api.edit(next => {
          const target = next.claims.find(item => item.id === claim.id); target.evidence.find(item => item.evidenceId === link.evidenceId).reason = value; target.state = 'unreviewed';
        }), readOnly, 1000);
        editLink.append(button('Unlink evidence', () => api.edit(next => {
          const target = next.claims.find(item => item.id === claim.id); target.evidence = target.evidence.filter(item => item.evidenceId !== link.evidenceId); target.state = 'unreviewed';
        }, true), readOnly)); row.append(editLink); detail.append(row);
      }
      if (!argument.links.length) detail.append(el('p', 'triage-warning', 'No code note is linked to this statement yet.'));
      const available = profile.evidence.filter(item => !claim.evidence.some(link => link.evidenceId === item.id));
      const addLinks = disclosure('Add or link evidence', false);
      if (available.length) {
        const picker = el('select'); picker.setAttribute('aria-label', 'Evidence to link to claim'); picker.disabled = readOnly;
        for (const item of available) { const option = el('option', '', item.id + ' · ' + (item.source ? item.source.file + ':' + item.source.line : item.reference)); option.value = item.id; picker.append(option); }
        addLinks.append(picker, button('Link selected evidence as context', () => api.edit(next => {
          const target = next.claims.find(item => item.id === claim.id);
          target.evidence.push({ evidenceId: picker.value, stance: 'context', reason: 'Link added for review; explain its relevance before assessing this claim.' }); target.state = 'unreviewed';
        }, true), readOnly));
      }
      addLinks.append(button('Add code note', api.addEvidence, readOnly)); detail.append(addLinks);
      const conditions = disclosure('When it happens and what changes');
      for (const [key, label] of [['conditions', 'When it happens'], ['consequence', 'Impact and what is unclear']]) {
        const block = el('div', 'triage-brief-block'); block.dataset.claimField = key;
        block.append(el('strong', '', label), el('p', '', claim[key] || 'Not established.')); conditions.append(block);
      }
      detail.append(conditions);
      const edit = disclosure('Edit statement explanation', !claim.text);
      field(edit, 'Report statement', claim.text, value => change('text', value), readOnly, 2000);
      field(edit, 'What the code does for this statement', claim.observed, value => change('observed', value), readOnly);
      field(edit, 'When this statement applies', claim.conditions, value => change('conditions', value), readOnly);
      field(edit, 'Impact and what is still unclear', claim.consequence, value => change('consequence', value), readOnly);
      detail.append(edit);
      const conclusion = el('section', 'triage-claim-conclusion'); conclusion.append(el('h3', '', 'Statement result'));
      conclusion.append(el('p', 'triage-claim-reason', claim.reason || 'This statement has no recorded result.'));
      const conclusionEdit = disclosure('Edit statement result');
      conclusionEdit.append(select(FlowboardClaims.states, claim.state, 'Statement review result', value => change('state', value, true), readOnly));
      field(conclusionEdit, 'Why this statement has this result', claim.reason, value => change('reason', value), readOnly);
      field(conclusionEdit, 'Open questions (one per line)', (claim.questions || []).join('\n'), value => change('questions', value.split('\n').map(x => x.trim()).filter(Boolean)), readOnly);
      conclusionEdit.append(el('p', 'triage-muted', 'This assessment belongs to this statement only. It does not set the finding verdict.'));
      conclusionEdit.append(button('Remove statement', () => { if (window.confirm('Remove this statement and its links? Your evidence notes will stay.')) api.removeClaim(claim.id); }, readOnly));
      conclusion.append(conclusionEdit); detail.append(conclusion); root.append(detail);
    }
    const readiness = el('div', 'triage-claim-readiness'); root.append(readiness);
    const actions = el('div', 'triage-save-row'), save = button('Save review', api.save, readOnly || api.pendingEvidence);
    save.className = 'primary'; actions.append(save, button('Copy review brief', api.copy, readOnly || api.pendingEvidence), button('Edit issue result', api.overall)); root.append(actions);
    if (api.pendingEvidence) root.append(el('p', 'triage-warning', 'Add or clear the pending evidence entry in Review before saving.'));
    return root;
  }
  function status(root, finding) {
    const node = root.querySelector('.triage-claim-readiness'); if (!node) return;
    const ready = FlowboardReview.readiness(finding); node.replaceChildren();
    for (const error of ready.errors) node.append(el('p', 'triage-warning', error));
    node.append(el('p', 'triage-muted', ready.gaps.length + ' areas still need checking. Supporting a statement does not confirm the whole issue.'));
    const claims = finding.triage?.claims || [];
    for (const item of root.querySelectorAll('.triage-claim-select[data-claim-id]')) {
      const claim = claims.find(value => value.id === item.dataset.claimId); if (!claim) continue;
      item.firstChild.textContent = claim.text || 'Untitled statement';
      const argument = FlowboardClaims.argument(claim, finding.triage.evidence);
      item.querySelector('small').textContent = FlowboardReading.statement(claim.state) + ' · ' + argument.links.length + ' evidence links' + (argument.gaps.length ? ' · review gaps' : '');
    }
    const detail = root.querySelector('.triage-claim-detail'), select = detail?.querySelector('[aria-label="Statement review result"]');
    const claim = claims.find(claim => claim.id === detail?.dataset.claimId);
    if (select) select.value = claim?.state || 'unreviewed';
    if (claim) {
      detail.querySelector('.triage-active-claim-title').textContent = claim.text || 'Untitled statement';
      detail.querySelector('.triage-active-claim-state').textContent = FlowboardReading.statement(claim.state) + ' · statement result only';
      detail.querySelector('.triage-claim-next p').textContent = nextQuestion(claim, finding.triage);
      detail.querySelector('.triage-claim-reason').textContent = claim.reason || 'This statement has no recorded result.';
      for (const rationale of detail.querySelectorAll('[data-evidence-relation]')) {
        const link = claim.evidence.find(value => value.evidenceId === rationale.dataset.evidenceRelation);
        rationale.querySelector('p').textContent = link?.reason || '';
      }
    }
    for (const block of detail?.querySelectorAll('[data-claim-field]') || []) block.querySelector('p').textContent = claim?.[block.dataset.claimField] || 'Not established.';
    const ruleText = root.querySelector('.triage-rule-text'), ruleReference = root.querySelector('.triage-rule-reference');
    if (ruleText) ruleText.textContent = finding.expectedBehavior || 'Expected behavior is not yet known.';
    if (ruleReference) ruleReference.textContent = finding.triage.ruleOrigin.kind + ' · ' + (finding.triage.ruleOrigin.reference || 'No reference supplied.');
  }
  root.FlowboardClaimView = { render, status, nextQuestion };
})(globalThis);
