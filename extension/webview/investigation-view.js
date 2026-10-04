(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowboardInvestigation = api;
})(globalThis, function() {
  'use strict';
  function node(tag, text = '', className = '') { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; }
  function button(label, action) { const value = node('button', label); value.type = 'button'; value.onclick = action; return value; }
  function bullets(title, entries) {
    const box = node('div', '', 'inv-facts'); if (!entries?.length) return box;
    box.append(node('h4', title)); const list = node('ul'); for (const text of entries) list.append(node('li', text)); box.append(list); return box;
  }
  function details(title, ...children) { const value = node('details'); value.append(node('summary', title), ...children); return value; }
  function render({ draft, selected, select, focus, correct, retry, enable, runTest, disabled, correction }) {
    const root = node('section', '', 'inv-workbench'); root.setAttribute('aria-label', 'Saved investigation draft');
    const phase = ({ preparing: 'Finding related code', 'provider-required': 'Code ready · AI review is off', generating: 'Reading code…',
      'checking-source': 'Checking open questions…', challenging: 'Looking for opposing evidence…', ready: 'Review draft saved', blocked: 'Partial review saved',
      corrected: 'Correction saved · affected results need checking', 'running-regression': 'Running selected existing regression…', 'experiment-recorded': 'Regression result saved' })[draft.phase] || draft.phase;
    const header = node('div', '', 'inv-status'); header.setAttribute('role', 'status');
    header.append(node('strong', phase), node('small', 'AI draft. Check the explanation before deciding. Your issue result is separate.'));
    root.append(header);
    if (draft.error) root.append(node('p', draft.error, 'triage-warning'));
    if (draft.phase === 'provider-required') {
      root.append(node('p', 'Turn on AI review to read the report and look for supporting and opposing code. This sends the report and selected code to your configured provider.', 'triage-muted'));
      const action = button('Enable AI code review', enable); action.disabled = disabled; root.append(action);
    } else if (['ready', 'blocked', 'corrected'].includes(draft.phase)) { const action = button('Retry code review', retry); action.disabled = disabled; root.append(action); }
    const rule = node('div', '', 'inv-rule'); rule.append(node('h3', 'Expected behavior'), node('p', draft.property.text), node('small', `Basis: ${draft.property.basis.replaceAll('-', ' ')}${draft.property.evidence?.length ? ' · inspect references below' : ' · not independently checked'}`)); root.append(rule);
    const claims = draft.claims || [];
    const claim = claims.find(item => item.id === selected) || claims[0];
    if (claims.length) {
      const choices = node('nav', '', 'inv-claims'); choices.setAttribute('aria-label', 'Report statements');
      for (const item of claims) {
        const choice = button(item.implementation || item.allegation, () => select(item.id)); choice.dataset.claimId = item.id;
        choice.setAttribute('aria-pressed', String(item.id === claim.id)); choice.append(node('small', `${FlowboardReading.statement(item.status)} · ${item.actor || 'actor not known'}`)); choices.append(choice);
      }
      root.append(choices);
      const body = node('article', '', 'inv-claim'); body.dataset.claimId = claim.id;
      body.append(node('h3', claim.allegation), node('p', `${FlowboardReading.statement(claim.status)} · ${claim.reason}`, 'inv-assessment'));
      body.append(node('p', `Actor: ${claim.actor || 'unresolved'}`));
      if (claim.entry) { const action = button('Read code', () => focus({ sourceId: claim.entry, claimId: claim.id })); action.disabled = disabled; body.append(action); }
      body.append(bullets('When it happens', claim.conditions));
      body.append(details('What would support or disprove this?', bullets('Required facts', claim.requiredFacts), node('p', `Support: ${claim.supportsIf}`), node('p', `Contradict or narrow: ${claim.contradictsIf}`)));
      const evidence = (draft.evidence || []).filter(item => claim.evidence.includes(item.id));
      const evidenceBox = node('div', '', 'inv-evidence'); evidenceBox.append(node('h3', 'Evidence and counterevidence'));
      if (!evidence.length) evidenceBox.append(node('p', 'No code notes are linked to this statement yet.'));
      for (const item of [...evidence].sort((a, b) => (a.stance === 'contradicts' ? -1 : 1) - (b.stance === 'contradicts' ? -1 : 1))) {
        const entry = node('article', '', `inv-evidence-entry ${item.stance}`); entry.dataset.evidenceId = item.id;
        entry.append(node('h4', FlowboardReading.relation(item.stance, 'statement', claim.id)), node('p', item.note));
        const label = `${item.source.file}:${item.source.line}${Number.isInteger(item.source.endLine) && item.source.endLine > item.source.line ? '–' + item.source.endLine : ''}`;
        const open = button(label, () => focus({ evidenceId: item.id, claimId: claim.id })); open.disabled = disabled;
        const editor = button('Open in editor', () => focus({ evidenceId: item.id, claimId: claim.id, editor: true })); editor.disabled = disabled;
        entry.append(open, editor, details('Quoted code', node('pre', item.quote)));
        if (item.explanationReview) entry.append(details('Explanation check', node('p', item.explanationReview.reason), node('small', 'AI check against code, not independent proof.')));
        evidenceBox.append(entry);
      }
      body.append(evidenceBox);
      const transitions = (draft.transitions || []).filter(item => item.claimId === claim.id);
      if (transitions.length) {
        const state = node('section', '', 'inv-transitions'); state.append(node('h3', 'State and value changes'), node('p', 'Expected from reading code, not observed in a test. Check each transaction as a whole.', 'triage-muted'));
        for (const item of transitions) {
          const row = node('article', '', 'inv-transition'); row.append(node('h4', item.label), node('small', item.timing.replaceAll('-', ' ') + (item.needsReassessment ? ' · correction requires reassessment' : ' · predicted')),
            node('p', `Before: ${item.before}`), node('p', `After: ${item.after}`), bullets('Applies when', item.conditions));
          for (const id of item.evidence) { const action = button('Read supporting code', () => focus({ evidenceId: id, claimId: claim.id })); action.disabled = disabled; row.append(action); }
          if (!item.evidence.length) row.append(node('p', 'No code note supports this change yet.', 'triage-warning'));
          state.append(row);
        }
        body.append(details('State changes for this case', state));
      }
      body.append(bullets('Still unclear', claim.unknowns), node('h3', 'Next check'), node('p', claim.nextQuestion || 'Review the limits of the evidence before deciding.'));
      const questions = (draft.questions || []).filter(item => item.claimId === claim.id);
      for (const question of questions) {
        const action = (draft.actions || []).findLast(item => item.questionId === question.id && item.claimId === question.claimId && item.target === question.target && item.kind === question.action && item.questionText === question.text);
        body.append(node('p', `${question.text} ${action ? `Check: ${action.outcome}. ${action.result}` : question.action === 'missing-context' ? 'Requires unavailable specification or deployment context.' : 'This check is not finished.'}`, 'triage-muted'));
      }
      const performed = node('div');
      for (const action of (draft.actions || []).filter(item => item.claimId === claim.id).slice(-6)) {
        performed.append(node('p', `${action.questionText || action.why || action.kind} · ${action.outcome}: ${action.result}`));
        for (const sourceId of action.sourceIds || []) {
          const source = draft.sources.find(unit => unit.id === sourceId); if (!source) continue;
          const open = button(source.name, () => focus({ sourceId, claimId: claim.id })); open.disabled = disabled; performed.append(open);
        }
      }
      if (performed.childElementCount) body.append(details('Code already checked', performed));
      root.append(body);
    }
    const conclusion = node('div', '', 'inv-conclusion'); conclusion.append(node('h3', 'Draft result and limits'), node('p', draft.conclusion.text), bullets('Limits', draft.conclusion.limitations)); root.append(conclusion);
    if (Array.isArray(draft.codeGaps) && draft.codeGaps.length) root.append(details('Code still to check', bullets('Missing or incomplete code', draft.codeGaps)));
    const adjust = node('div', '', 'inv-correction');
    const field = node('select'); field.setAttribute('aria-label', 'Correct investigation field');
    for (const name of ['property', 'actor', 'entry', 'implementation', 'conditions']) { const option = node('option', name); option.value = name; field.append(option); }
    field.value = correction.field || 'conditions'; field.onchange = () => { correction.field = field.value; };
    const value = node('textarea'); value.setAttribute('aria-label', 'Investigation correction'); value.placeholder = 'Correct this premise; include why and which implementation it applies to.'; value.value = correction.value || ''; value.oninput = () => { correction.value = value.value; };
    const apply = button('Save correction and reassess', () => correct({ claimId: field.value === 'property' ? null : claim?.id || null, field: field.value, value: value.value }, draft.revision)); apply.disabled = disabled;
    adjust.append(node('p', 'Applies to the selected claim (property applies to all). Stored as your correction, not independently established evidence.'), field, value, apply);
    root.append(details('Correct this review', adjust));
    const tests = draft.sources.filter(source => source.kind === 'test-source');
    const checks = node('div', '', 'inv-checks');
    for (const result of draft.experiments || []) {
      const entry = node('article'); entry.append(node('h4', `Executed check: ${result.outcome}`), node('p', result.interpretation));
      entry.append(node('small', `Claim: ${result.claimId || 'context only'} · ${result.source.file}:${result.source.line}`));
      for (const test of result.tests) {
        entry.append(node('p', `${test.name}: ${test.status}${test.reason ? ' — ' + test.reason : ''}`));
        if (test.logs?.length) entry.append(details('Test logs · check skipped cases', node('pre', test.logs.join('\n'))));
      }
      entry.append(details('Command, setup and diagnostic', node('pre', result.command.join(' ')), node('pre', JSON.stringify(result.environment)), node('pre', result.diagnostic), bullets('Limits', result.limits)));
      checks.append(entry);
    }
    for (const unit of tests) {
      const row = node('div', '', 'inv-test'); row.append(node('p', unit.name), node('small', 'Existing test source · not an observed result'));
      const inspect = button('Inspect assertions', () => focus({ sourceId: unit.id, claimId: claim?.id })); inspect.disabled = disabled;
      const run = button('Run existing regression…', () => runTest(unit.id, claim?.id)); run.disabled = disabled || draft.phase === 'running-regression'; row.append(inspect, run); checks.append(row);
    }
    root.append(details(`Existing checks and observations (${(draft.experiments || []).length} executed)`, checks));
    const context = node('div', '', 'inv-sources');
    for (const source of draft.sources.filter(source => source.kind === 'production-source')) {
      const action = button(`${source.name} · ${source.source.file}:${source.source.line}`, () => focus({ sourceId: source.id, claimId: claim?.id })); action.disabled = disabled; context.append(action);
    }
    root.append(details('Related functions · not a proven route', context));
    const audit = node('div'); audit.append(node('p', draft.compiler?.available ? `Compiler declarations: solc ${draft.compiler.version}, ${draft.compiler.inputCount} content-matched inputs. External runtime dispatch is not guaranteed.` : draft.compiler?.reason || 'Compiler context not yet prepared.'),
      node('p', `Snapshot ${draft.snapshot.sourceDigest.slice(0, 12)} · ${draft.snapshot.revision || 'no Git revision'} · revision ${draft.revision}`));
    if (draft.compiler?.available) audit.append(node('p', draft.compiler.limitation || 'Current build configuration and deployment are not certified by matching source text.'));
    for (const run of draft.runs) audit.append(node('p', `${run.phase}: ${run.outcome}${run.resultAccepted === false ? ' · result rejected' : ''} · ${run.provider} · ${run.finishedAt}`));
    for (const correction of draft.corrections) audit.append(node('p', `Researcher correction (${correction.field}): ${correction.value} · independently supported: no`));
    root.append(details('Review history and code version', audit));
    return root;
  }
  return { render };
});
