'use strict';
const fs = require('node:fs'), path = require('node:path');
const { lexicalCode } = require('./solidity-text');
const { contained } = require('./protocol');
// Local import context narrows declarations, never proves deployed dispatch.
// Unsupported/missing imports remain absent, not substituted by name.
class ImportContext {
  constructor(catalog) {
    this.catalog = catalog; this.cache = new Map(); this.remappings = [];
    for (const name of ['remappings.txt', 'foundry.toml']) {
      let text; try { text = fs.readFileSync(path.join(catalog.root, name), 'utf8'); } catch { continue; }
      const values = name.endsWith('.txt') ? text.split(/\r?\n/) : [...text.matchAll(/\bremappings\s*=\s*\[([\s\S]*?)\]/g)].flatMap(match => [...match[1].matchAll(/["']([^"']+=[^"']+)["']/g)].map(item => item[1]));
      for (const line of values) {
        const match = line.trim().match(/^(?:(.*?):)?([^=\s]+)=(\S+)$/);
        if (match) this.remappings.push({ context: match[1] || '', prefix: match[2], target: match[3] });
      }
    }
    this.remappings.sort((a,b) => b.prefix.length - a.prefix.length);
  }
  files(from) {
    if (this.cache.has(from)) return this.cache.get(from);
    const found = new Set(), queue = [from];
    while (queue.length && found.size < 192) {
      const file = queue.shift(); if (found.has(file)) continue; found.add(file);
      let text; try { text = this.catalog.document(this.catalog.relative(file)).text; } catch { continue; }
      const clean = lexicalCode(text);
      for (const match of text.matchAll(/\bimport\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?["']([^"']+)["'][^;]*;/g)) {
        if (clean.slice(match.index, match.index + 6) !== 'import') continue;
        const specifier = match[1], relative = this.catalog.relative(file);
        const mapping = this.remappings.find(item => specifier.startsWith(item.prefix) && (!item.context || relative.startsWith(item.context)));
        const target = mapping ? path.resolve(this.catalog.root, mapping.target, specifier.slice(mapping.prefix.length)) : path.resolve(specifier.startsWith('.') ? path.dirname(file) : this.catalog.root, specifier);
        try { const real = fs.realpathSync(target); if (contained(this.catalog.root, real) && this.catalog.sourceStamps.has(real)) queue.push(real); } catch { /* leave the import unresolved */ }
      }
    }
    this.cache.set(from, found); return found;
  }
  narrow(candidates, from) {
    if (candidates.length < 2 || !from) return candidates;
    const imported = this.files(from), direct = candidates.filter(fn => imported.has(fn.file));
    if (direct.length) return direct;
    // A concrete implementation can be outside the interface import closure.
    // Offer definitions in explicitly configured dependency roots as source
    // candidates; this does NOT turn an interface receiver into that instance.
    const configured = candidates.filter(fn => this.remappings.some(item => (!item.context || this.catalog.relative(from).startsWith(item.context)) && contained(path.resolve(this.catalog.root, item.target), fn.file)));
    return configured.length ? configured : candidates;
  }
}
module.exports = { ImportContext };
