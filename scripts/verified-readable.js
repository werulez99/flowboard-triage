// Browser-side measurement only. No host ACK or diagnostic HTTP completion
// is a readable endpoint. Expectations are frozen before each timed action.
window.installReadable = expected => {
  window.readableExpected = expected;
  window.isReadable = id => {
    const e = expected[id], session = globalThis.__flowboardTriageSession;
    const load = window.hostMessages.findLast(m => m.type === 'triage:load');
    if (!e || !session || session.issueId !== e.findingId || session.token !== load?.token || load.issueId !== e.findingId) return false;
    const event = load.investigationDraft?.causal?.events.find(v => v.id === id);
    if (event?.invocationId !== e.invocationId || JSON.stringify(event) !== e.event) return false;
    const a = document.querySelector('.guide-annotation'), c = document.querySelector('.guide-active-card'), v = document.querySelector('#flowboard');
    const card = [...cards.values()].find(item => item.el === c);
    if (!a || !card || !v || a.dataset.stepId !== id || !a.textContent.includes(e.what) || card.data.code !== e.code ||
        !card.data.fsPath.replaceAll('\\', '/').endsWith('/' + e.file) || card.data.startLine !== e.start) return false;
    const header = c.querySelector('.card-header'), b = v.getBoundingClientRect(), h = header.getBoundingClientRect(), ab = a.getBoundingClientRect();
    const explanation = a.querySelector('.guide-explanation')?.getBoundingClientRect();
    const rows = [...card.codeEl.querySelectorAll('[data-source-line]')], lines = [...c.querySelectorAll('.triage-claim-line')];
    if (rows.length !== e.code.split('\n').length || rows.some((r, i) => Number(r.dataset.sourceLine) !== e.start + i)) return false;
    if (JSON.stringify(lines.map(l => Number(l.dataset.sourceLine))) !== JSON.stringify(e.highlights)) return false;
    return h.top >= b.top - 1 && h.bottom <= b.bottom + 1 && h.left >= b.left - 1 && h.left < b.right &&
      ab.width > 100 && ab.height > 20 && ab.left >= 0 && ab.right <= innerWidth + 1 &&
      explanation && explanation.top >= 0 && explanation.bottom <= innerHeight + 1 && explanation.left >= 0 && explanation.right <= innerWidth + 1 &&
      lines.some(l => { const r = l.getBoundingClientRect(); return Number(l.dataset.sourceLine) === e.highlights[0] && r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.right > b.left && r.left < b.right; });
  };
  window.armReadable = id => {
    window.readableResult = null;
    const priorToken = globalThis.__flowboardTriageSession?.token;
    const start = performance.now();
    const poll = () => {
      if (window.closing) return;
      if (window.isReadable(id)) window.readableResult = { id, at: performance.now(), token: globalThis.__flowboardTriageSession.token,
        priorToken, armedAt: start, clickAt: window.actualFindingClick };
      else if (performance.now() - start < 30000) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  };
};
