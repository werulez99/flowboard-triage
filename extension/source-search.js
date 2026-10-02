'use strict';
const path = require('node:path');

const stop = new Set('a an the and or but if then than when where why what how this that these those is are was were be been being not no to of in on at for from with as by into can could will would should must may might it its they their them we you your have has had do does did issue finding bug report claim severity high medium low info informational impact mitigation recommendation function functions contract contracts code solidity source attack path access public external internal private returns return uint256 address bool memory storage calldata amount value true false'.split(' '));
function stem(word) {
  if (word.length > 5 && word.endsWith('ies')) word = word.slice(0, -3) + 'y';
  else if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
  if (word.length > 6 && word.endsWith('ing')) word = word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ed')) word = word.slice(0, -2);
  return ({ withdrawal: 'withdraw', withdrawn: 'withdraw', distribution: 'distribut', distributed: 'distribut', updating: 'updat', update: 'updat', increase: 'increment', increasing: 'increment' })[word] || word;
}
function terms(text) {
  return new Set((text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().match(/[\p{L}][\p{L}\p{N}$]*/gu) || [])
    .filter(word => word.length > 2 && !stop.has(word)).map(stem));
}
function documentation(lines, line) {
  const result = []; let block = false;
  for (let i = line - 2; i >= Math.max(0, line - 22); i--) {
    const text = lines[i].trim();
    if (!text) { if (result.length) break; continue; }
    if (text.endsWith('*/')) block = true;
    if (!block && !text.startsWith('//') && !text.startsWith('/*')) break;
    result.unshift(text);
    if (text.startsWith('/*')) block = false;
  }
  return result.join('\n');
}
class SourceSearch {
  constructor(catalog) {
    this.catalog = catalog; this.documents = []; this.frequency = new Map();
    for (const fn of catalog.functions) {
      const parts = catalog.anatomy(fn); if (!parts) continue;
      const file = catalog.relative(fn.file), doc = catalog.document(file);
      const comment = documentation(doc.lines, fn.startLine);
      const groups = { name: terms(fn.name), contract: terms(fn.contract || ''), file: terms(path.basename(file, '.sol')),
        body: terms(parts.declaration), documentation: terms(comment) };
      const all = new Set(Object.values(groups).flatMap(group => [...group]));
      for (const term of all) this.frequency.set(term, (this.frequency.get(term) || 0) + 1);
      this.documents.push({ fn, file, groups, all });
    }
  }
  rank(issue, scopedFiles = new Set()) {
    const text = [issue.title, issue.fields?.summarydescription, issue.fields?.summary, issue.fields?.description,
      issue.fields?.rootcause, issue.fields?.expectedbehavior, issue.fields?.actualbehavior,
      // If no structured description exists, retain ordinary report prose.
      ...(!issue.fields?.summary && !issue.fields?.description && !issue.fields?.rootcause ? [issue.body] : [])].filter(Boolean).join('\n');
    const query = [...terms(text)].slice(0, 100), candidates = [];
    const identifiers = new Set((text.match(/[A-Za-z_$][\w$]*/g) || []).map(name => name.toLowerCase()));
    const idfs = new Map(query.map(term => [term, Math.log(1 + this.documents.length / (this.frequency.get(term) || 1))]));
    for (const doc of this.documents) {
      if (scopedFiles.size && !scopedFiles.has(doc.fn.file)) continue;
      const matched = query.filter(term => doc.all.has(term));
      const nameMatches = matched.filter(term => doc.groups.name.has(term));
      const exactName = doc.fn.name.length >= 4 && identifiers.has(doc.fn.name.toLowerCase());
      // Broad single-word matches ("reward", "counter") are not enough to
      // invent a source anchor. This is retrieval, never semantic validation.
      if (!exactName && (matched.length < 2 || !nameMatches.length && !matched.some(term => doc.groups.documentation.has(term) || doc.groups.contract.has(term)))) continue;
      let score = exactName ? 12 : 0;
      for (const term of matched) {
        const idf = idfs.get(term);
        const weight = doc.groups.name.has(term) ? 8 : doc.groups.contract.has(term) ? 3 : doc.groups.file.has(term) ? 2 : doc.groups.documentation.has(term) ? 1.5 : 1;
        score += idf * weight;
      }
      if (score < 3) continue;
      candidates.push({ fn: doc.fn, file: doc.file, line: doc.fn.startLine, score: Math.round(score * 100) / 100,
        matchedTerms: matched.slice(0, 8), method: exactName ? 'symbol' : 'description',
        reason: `${exactName ? 'Bare function name appears in the report' : 'Description overlaps source identifiers/documentation'}: ${matched.slice(0, 8).join(', ')}. This is a relevance candidate, not verified finding evidence.` });
    }
    candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
    const top = candidates.slice(0, 6);
    return { candidates: top, ambiguous: top.length > 1 && top[0].score - top[1].score < 2,
      searchedFunctions: this.documents.length, queryTerms: query };
  }
  neighbors(anchors, limit = 8) {
    if (!anchors.length || limit < 1) return [];
    const selected = new Set(anchors.map(fn => this.catalog.key(fn))), result = [];
    const add = (fn, reason) => {
      if (selected.has(this.catalog.key(fn)) || result.length >= limit || !this.catalog.anatomy(fn)) return;
      selected.add(this.catalog.key(fn)); result.push({ fn, reason });
    };
    for (const fn of anchors) for (const link of this.catalog.callLinks(fn)) if (link.candidates.length === 1) {
      add(link.candidates[0], `Direct source neighbor: ${fn.name} contains ${link.expression} at ${this.catalog.relative(fn.file)}:${link.line}. Finding relevance and runtime conditions are unreviewed.`);
    }
    // One-hop callers provide ordinary entry context around an internal helper;
    // never recursively synthesize an attack sequence from report prose.
    const anchorKeys = new Set(anchors.map(fn => this.catalog.key(fn)));
    for (const fn of this.catalog.functions) {
      if (result.length >= limit) break;
      const site = this.catalog.callLinks(fn).find(link => link.candidates.length === 1 && anchorKeys.has(this.catalog.key(link.candidates[0])));
      if (site) add(fn, `Direct source caller at ${this.catalog.relative(fn.file)}:${site.line}: ${site.expression}. Inspect permissions/branches before drawing conclusions.`);
    }
    return result;
  }
}
function search(catalog) { return catalog.sourceSearch ||= new SourceSearch(catalog); }
module.exports = { SourceSearch, search, terms, stem };
