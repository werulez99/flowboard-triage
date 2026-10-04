'use strict';
// One citation/applicability identity rule. Never guess a line or a revision.
const fs = require('node:fs'), path = require('node:path');
const { contained } = require('./protocol');
function resolve(root, supplied, files = []) {
  if (typeof supplied !== 'string' || !supplied.trim()) return null;
  const clean = supplied.replace(/\\/g, '/').replace(/^(?:[A-Za-z]:)?\/+/, '').replace(/^\.\//, '');
  if (clean.split('/').some(part => part === '..') || !clean.endsWith('.sol')) return null;
  const base = fs.realpathSync(root);
  const indexed = [...new Set(files)].flatMap(file => {
    try {
      const real = fs.realpathSync(path.resolve(base, file));
      return contained(base, real) && fs.statSync(real).isFile() ? [{ real, relative: path.relative(base, real).split(path.sep).join('/') }] : [];
    } catch { return []; }
  });
  const unique = candidates => candidates.length === 1 ? candidates[0].relative : null;
  const exact = indexed.filter(item => item.relative === clean);
  if (exact.length) return unique(exact);
  // A complete relative spelling can be reconciled, never a folded basename.
  const folded = indexed.filter(item => item.relative.toLowerCase() === clean.toLowerCase());
  if (folded.length) return unique(folded);
  const suffixed = indexed.filter(item => clean.endsWith('/' + item.relative) || item.relative.endsWith('/' + clean));
  if (suffixed.length) return unique(suffixed);
  const prefixedFolded = indexed.filter(item => item.relative.includes('/') && clean.toLowerCase().endsWith('/' + item.relative.toLowerCase()));
  if (prefixedFolded.length) return unique(prefixedFolded);
  // Without an index, only an existing contained path is accepted. This is
  // useful for raw navigation, not an applicability check against an index.
  if (!files.length) {
    const parts = clean.split('/'), matches = new Set();
    for (let index = 0; index < parts.length; index++) try {
      const real = fs.realpathSync(path.resolve(base, parts.slice(index).join('/')));
      if (contained(base, real) && fs.statSync(real).isFile()) matches.add(path.relative(base, real).split(path.sep).join('/'));
    } catch { /* no identity */ }
    if (matches.size === 1) return [...matches][0];
  }
  return null;
}
module.exports = { resolve };
