// Browser-side measurement only. No host ACK or diagnostic HTTP completion
// is a readable endpoint. Expectations are frozen before each timed action.
window.readableIntersection = node => {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    // client bounds exclude borders and scrollbars. Rect scaling matters on
    // native zoomed cards; CSS pixel client sizes cannot be used unscaled.
    const sx = parent.offsetWidth ? box.width / parent.offsetWidth : 1;
    const sy = parent.offsetHeight ? box.height / parent.offsetHeight : 1;
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, box.left + parent.clientLeft * sx);
      right = Math.min(right, box.left + (parent.clientLeft + parent.clientWidth) * sx);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, box.top + parent.clientTop * sy);
      bottom = Math.min(bottom, box.top + (parent.clientTop + parent.clientHeight) * sy);
    }
  }
  return { width: Math.min(rect.right, right) - Math.max(rect.left, left),
    height: Math.min(rect.bottom, bottom) - Math.max(rect.top, top), rect, left, top, right, bottom };
};
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
    const explanation = window.readableIntersection(a.querySelector('.guide-explanation'));
    const rows = [...card.codeEl.querySelectorAll('[data-source-line]')], lines = [...c.querySelectorAll('.triage-claim-line')];
    if (rows.length !== e.code.split('\n').length || rows.some((r, i) => Number(r.dataset.sourceLine) !== e.start + i)) return false;
    if (JSON.stringify(lines.map(l => Number(l.dataset.sourceLine))) !== JSON.stringify(e.highlights)) return false;
    return h.top >= b.top - 1 && h.bottom <= b.bottom + 1 && h.left >= b.left - 1 && h.left < b.right &&
      ab.width > 100 && ab.height > 20 && ab.left >= 0 && ab.right <= innerWidth + 1 &&
      explanation && explanation.width >= Math.min(100, explanation.rect.width) && explanation.height >= Math.min(24, explanation.rect.height) &&
      lines.some(l => { const r = window.readableIntersection(l); return Number(l.dataset.sourceLine) === e.highlights[0] && r &&
        r.height >= r.rect.height - 1 && r.width >= Math.min(40, r.rect.width) && r.rect.top >= b.top - 1 && r.rect.bottom <= b.bottom + 1; });
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
