'use strict';
// Small, deterministic, read-only local documentation search. Imported findings,
// agent instructions, generated artifacts and symlinks are never specification.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { terms } = require('./source-search');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function discover(root) {
  const files = []; let visited = 0;
  const walk = (directory, depth) => {
    if (depth > 2 || files.length >= 40 || visited++ >= 80 || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= 40) break;
      if (entry.isSymbolicLink() || /^(?:AGENTS|SKILL|CLAUDE)\.md$/i.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) walk(file, depth + 1);
      else if (entry.isFile() && /\.md$/i.test(entry.name) && fs.statSync(file).size <= 64000) files.push(file);
    }
  };
  for (const name of ['README.md', 'SPECIFICATION.md']) {
    const file = path.join(root, name);
    if (fs.existsSync(file) && fs.lstatSync(file).isFile() && fs.statSync(file).size <= 64000) files.push(file);
  }
  for (const directory of ['docs', 'specification']) {
    const folder = path.join(root, directory);
    if (fs.existsSync(folder) && fs.lstatSync(folder).isDirectory()) walk(folder, 0);
  }
  const documents = [], stamps = [];
  for (const absolute of [...new Set(files)]) {
    const file = path.relative(root, absolute).split(path.sep).join('/'), text = fs.readFileSync(absolute, 'utf8'), sourceHash = hash(text);
    stamps.push([file, sourceHash]);
    const lines = text.split(/\r?\n/);
    for (let offset = 0; offset < lines.length; offset += 24) {
      const code = lines.slice(offset, offset + 24).join('\n');
      documents.push({ id: `doc-${hash(file + ':' + offset).slice(0, 12)}`, source: { file, line: offset + 1, endLine: Math.min(lines.length, offset + 24), sourceHash }, text: code });
    }
  }
  return { digest: stamps.length ? hash(JSON.stringify(stamps)) : null, documents };
}
function select(index, query) {
  const wanted = terms(query), documents = index.documents.map(item => ({ ...item, score: [...terms(item.text)].filter(word => wanted.has(word)).length })).filter(item => item.score >= 2);
  let budget = 18000; const selected = [];
  for (const { score, ...item } of documents.sort((a, b) => b.score - a.score).slice(0, 6)) {
    if (item.text.length > budget) continue;
    budget -= item.text.length; selected.push(item);
  }
  return { digest: index.digest, excerpts: selected,
    limitation: 'Searched README.md, SPECIFICATION.md, docs/ and specification/ within local reading limits. A matching paragraph is a candidate, not proof of the intended rule; other documentation may exist.' };
}
function inspect(root, query) { return select(discover(root), query); }
module.exports = { inspect, discover, select };
