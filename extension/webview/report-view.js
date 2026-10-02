// Small, dependency-free Markdown reader. All report content becomes text nodes;
// raw HTML, scripts, images and external link navigation are never evaluated.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlowboardReport = api;
})(globalThis, function() {
  'use strict';
  const reference = /(?:[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.sol(?::|#L)(\d+)(?:-L?\d+)?/g;
  const marker = line => /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*\s*:?\s*$|[-*+]\s|\d+[.)]\s|>|`{3,}|~{3,})/.test(line);
  function parse(text) {
    const truncated = text.length > 200000;
    const lines = text.slice(0, 200000).replace(/\r\n/g, '\n').split('\n'), blocks = [];
    let i = 0;
    const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|')).slice(0, 20);
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const code = []; i++;
        while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        blocks.push({ type: 'code', language: fence[2].trim(), text: code.join('\n') }); continue;
      }
      const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
      const field = line.match(/^\s*\*\*([^*]+)\*\*\s*:?\s*(.*)$/);
      if (heading || field) {
        blocks.push({ type: 'heading', text: heading ? heading[2] : field[1].replace(/_/g, ' '), level: heading ? heading[1].length : 4 });
        if (field?.[2]) blocks.push({ type: 'paragraph', text: field[2] });
        i++; continue;
      }
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const rows = []; const header = cells(line); i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        blocks.push({ type: 'table', header, rows }); continue;
      }
      const list = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
      if (list) {
        const ordered = !!list[2], items = [], start = Number(list[2] || 1);
        while (i < lines.length) {
          const item = lines[i].match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
          if (!item || !!item[2] !== ordered) break;
          items.push(item[3]); i++;
        }
        blocks.push({ type: 'list', ordered, start, items }); continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        blocks.push({ type: 'quote', text: quote.join('\n') }); continue;
      }
      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }
      const paragraph = [line]; i++;
      while (i < lines.length && lines[i].trim() && !marker(lines[i]) && !/^\s*\*\*[^*]+\*\*\s*:/.test(lines[i])) paragraph.push(lines[i++]);
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    }
    if (truncated) blocks.push({ type: 'paragraph', text: 'Reading view truncated at 200,000 characters. Copy the original report for the complete text.' });
    return blocks;
  }
  function render(document, text, onReference) {
    const article = document.createElement('article'); article.className = 'triage-report';
    function textWithReferences(parent, value) {
      reference.lastIndex = 0; let cursor = 0, match;
      while ((match = reference.exec(value))) {
        parent.append(document.createTextNode(value.slice(cursor, match.index)));
        const button = document.createElement('button'); button.type = 'button'; button.className = 'triage-source-reference';
        const split = match[0].search(/\.sol(?::|#L)/) + 4;
        const file = match[0].slice(0, split).replace(/\\/g, '/'), line = Number(match[1]);
        button.textContent = match[0]; button.title = 'Open this citation in the current checkout — not verification of the claim';
        button.onclick = () => onReference?.({ file, line }); parent.append(button); cursor = reference.lastIndex;
      }
      parent.append(document.createTextNode(value.slice(cursor)));
    }
    function inline(parent, value) {
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]*\))/g;
      let cursor = 0, match;
      while ((match = pattern.exec(value))) {
        textWithReferences(parent, value.slice(cursor, match.index));
        const token = match[0];
        if (token.startsWith('**') || token.startsWith('`')) {
          const child = document.createElement(token.startsWith('**') ? 'strong' : 'code');
          textWithReferences(child, token.slice(token.startsWith('**') ? 2 : 1, token.startsWith('**') ? -2 : -1)); parent.append(child);
        } else textWithReferences(parent, token.replace(/^\[([^\]]+)\]\((.*)\)$/, '$1 ($2)'));
        cursor = pattern.lastIndex;
      }
      textWithReferences(parent, value.slice(cursor));
    }
    for (const block of parse(text)) {
      let node;
      if (block.type === 'heading') { node = document.createElement(block.level <= 2 ? 'h3' : 'h4'); inline(node, block.text); }
      else if (block.type === 'code') { node = document.createElement('pre'); const code = document.createElement('code'); code.textContent = block.text; node.append(code); }
      else if (block.type === 'list') {
        node = document.createElement(block.ordered ? 'ol' : 'ul'); if (block.ordered) node.start = block.start;
        for (const item of block.items) { const li = document.createElement('li'); inline(li, item); node.append(li); }
      } else if (block.type === 'quote') { node = document.createElement('blockquote'); inline(node, block.text); }
      else if (block.type === 'rule') node = document.createElement('hr');
      else if (block.type === 'table') {
        node = document.createElement('div'); node.className = 'triage-report-table'; const table = document.createElement('table');
        const head = document.createElement('tr'); for (const value of block.header) { const cell = document.createElement('th'); inline(cell, value); head.append(cell); } table.append(head);
        for (const row of block.rows) { const tr = document.createElement('tr'); for (const value of row) { const cell = document.createElement('td'); inline(cell, value); tr.append(cell); } table.append(tr); } node.append(table);
      } else { node = document.createElement('p'); inline(node, block.text); }
      article.append(node);
    }
    return article;
  }
  return { parse, render };
});
