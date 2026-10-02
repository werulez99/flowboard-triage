'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./protocol');
const { lexicalCode, functionParts, guards, escaped, stateStatements, scanVariables } = require('./solidity-text');
function sourceDocument(file) {
  const text = fs.readFileSync(file, 'utf8');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lines = text.split(/\r?\n/);
  return { uri: { fsPath: file }, text, lines, lineCount: lines.length, getText: () => text,
    offsetAt: position => starts[position.line] + position.character,
    lineAt: line => ({ text: lines[line], firstNonWhitespaceCharacterIndex: Math.max(0, lines[line]?.search(/\S/) || 0) }) };
}
function signature(code) {
  const match = code.match(/\b(function\s+\w+|constructor|receive|fallback)\s*\(([^)]*)\)/);
  return match ? match[0].replace(/\s+/g, ' ').trim() : '';
}
class SourceCatalog {
  constructor(root, runner, result) {
    this.root = fs.realpathSync(root); this.runner = runner; this.result = result;
    this.documents = new Map(); this.parts = new Map(); this.links = new Map(); this.functions = []; this.byKey = new Map(); this.methods = new Map(); this.candidateCache = new Map(); this.sourceStamps = new Map(result.sourceStamps || []);
    const seenDefinitions = new Set();
    for (const methods of result.overloadsByContract.values()) for (const overloads of methods.values()) for (const fn of overloads) {
      try {
        const file = fs.realpathSync(fn.file);
        if (!p.contained(this.root, file)) continue;
        const value = { ...fn, file }; const stat = fs.statSync(file);
        if (!this.sourceStamps.has(file)) this.sourceStamps.set(file, { size: stat.size, modified: stat.mtimeMs });
        const key = `${file}:${fn.startLine}`;
        if (!this.byKey.has(key)) this.byKey.set(key, value);
        // Line numbers are not unique identities: minified Solidity may put
        // multiple overloads on the same line. Retain ambiguity instead of
        // collapsing definitions and silently picking one target.
        if (!seenDefinitions.has(fn)) { seenDefinitions.add(fn); this.functions.push(value); }
      } catch { /* missing dependency */ }
    }
    for (const fn of this.functions) {
      const key = `${fn.contract}::${fn.name}`;
      if (!this.methods.has(key)) this.methods.set(key, []); this.methods.get(key).push(fn);
    }
  }
  assertFresh() {
    for (const [file, stamp] of this.sourceStamps) {
      const stat = fs.statSync(file);
      if (stat.size !== stamp.size || stat.mtimeMs !== stamp.modified) throw new Error('Source changed since this flow was indexed. Reload the finding before expanding or saving a review.');
    }
  }
  document(file) {
    const absolute = fs.realpathSync(path.resolve(this.root, file));
    if (!p.contained(this.root, absolute) || !absolute.endsWith('.sol')) throw new Error('Source must be a Solidity file inside this workspace.');
    if (!this.documents.has(absolute)) this.documents.set(absolute, sourceDocument(absolute));
    return this.documents.get(absolute);
  }
  functionAt(file, line, expectedName) {
    const document = this.document(file);
    if (!Number.isSafeInteger(line) || line < 1 || line > document.lineCount) return null;
    const definitions = this.functions.filter(fn => fn.file === document.uri.fsPath && fn.startLine <= line && line <= fn.endLine);
    if (definitions.length > 1) {
      const named = expectedName ? definitions.filter(fn => fn.name === expectedName) : [];
      return named.length === 1 ? named[0] : null;
    }
    const exact = this.runner.getEnclosingFunction(document, { line: line - 1, character: document.lineAt(line - 1).firstNonWhitespaceCharacterIndex });
    if (exact) {
      const indexed = this.byKey.get(`${document.uri.fsPath}:${exact.startLine}`);
      return { ...indexed, ...exact, file: document.uri.fsPath };
    }
    // Constructors/receive/fallback are indexed upstream but its enclosing-function
    // helper only accepts named functions. Resolve by actual indexed line range.
    return this.functions.find(fn => fn.file === document.uri.fsPath && fn.startLine <= line && line <= fn.endLine) || null;
  }
  resolveCard(card) {
    const document = this.document(card.file);
    if (card.line > document.lineCount) throw new Error(`Line outside ${card.file}.`);
    if (card.kind === 'context') {
      const startLine = Math.max(1, card.line - 3), endLine = Math.min(document.lineCount, card.line + 7);
      return { name: 'Source context', kind: 'context', file: document.uri.fsPath, startLine, endLine, calls: [], memberCalls: [], modifiers: [], contract: null };
    }
    const fn = this.functionAt(card.file, card.line, card.function);
    if (!fn) throw new Error(`No unique function at ${card.file}:${card.line}. Use a context card for declarations/ambiguous minified source, or inspect the old revision.`);
    if (card.function && fn.name !== card.function) throw new Error(`Expected ${card.function}, found ${fn.name}. Source changed; re-check the line.`);
    const parts = this.anatomy(fn);
    if (!parts) throw new Error(`No unique Solidity declaration for ${fn.name} at ${card.file}:${card.line}; comments/string literals and overlapping declarations are not source functions.`);
    const scoped = this.scopeFor(fn), locals = new Map(); scanVariables(parts.declaration, this.knownTypes, locals);
    return { ...fn, ...this.runner.flowboardClassifyCallSites(scoped, fn.contract, this.runner.flowboardCallSites(parts.body), locals),
      modifiers: fn.modifierNames ? this.runner.resolveModifiers(this.result, fn.contract, fn.modifierNames) : fn.modifiers || [] };
  }
  relative(file) { return path.relative(this.root, file).split(path.sep).join('/'); }
  code(fn) { return this.document(this.relative(fn.file)).lines.slice(fn.startLine - 1, fn.endLine).join('\n'); }
  key(fn) { return `${fn.file}:${fn.startLine}:${fn.endLine}:${fn.name}:${fn.paramCount}`; }
  anatomy(fn) {
    const key = this.key(fn);
    if (!this.parts.has(key)) this.parts.set(key, functionParts(this.code(fn), fn.name));
    return this.parts.get(key);
  }
  scopeFor(fn) {
    if (!this.stateResult) {
      this.knownTypes = new Set([...this.result.functionsByContract.keys(), ...this.result.contractBases.keys(), ...this.result.structs.keys()]);
      const stateTypes = new Map(); this.stateByFile = new Map();
      const files = [...new Set([...this.functions.map(value => value.file), ...this.sourceStamps.keys()])].filter(file => p.contained(this.root, file) && file.endsWith('.sol'));
      const parsed = files.map(file => {
        const clean = lexicalCode(this.document(this.relative(file)).text);
        const contracts = this.runner.flowboardContracts(clean);
        for (const contract of contracts) this.knownTypes.add(contract.name);
        return { file, clean, contracts };
      });
      for (const { file, clean, contracts } of parsed) {
        for (const contract of contracts) {
          const variables = new Map();
          for (const statement of stateStatements(clean, contract)) scanVariables(statement, this.knownTypes, variables);
          this.stateByFile.set(`${file}:${contract.name}`, variables);
          stateTypes.set(contract.name, variables);
        }
      }
      this.stateResult = { ...this.result, varTypesByContract: stateTypes };
    }
    // Never let another function's parameter/local variable overwrite this
    // function's contract state types, a limitation in the native flat index.
    const own = this.stateByFile.get(`${fn.file}:${fn.contract}`);
    return own ? { ...this.stateResult, varTypesByContract: new Map(this.stateResult.varTypesByContract).set(fn.contract, own) } : this.stateResult;
  }
  named(name, files) {
    return this.functions.filter(fn => fn.name === name && (!files?.size || files.has(fn.file)) && this.anatomy(fn));
  }
  candidates(name, contract, isSuper, argCount) {
    const key = JSON.stringify([name, contract, !!isSuper, argCount ?? null]);
    if (!this.candidateCache.has(key)) this.candidateCache.set(key, this.findCandidates(name, contract, isSuper, argCount));
    return this.candidateCache.get(key);
  }
  findCandidates(name, contract, isSuper, argCount) {
    const qualified = name.includes('::') ? name.split('::') : null;
    const type = qualified ? qualified[0] : contract, method = qualified ? qualified[1] : name;
    const resolved = this.runner.resolveCall(this.result, method, type, isSuper, true, argCount);
    if (!resolved) return [];
    if (argCount != null && resolved.paramCount != null && resolved.paramCount !== argCount) return [];
    const hasMethod = owner => (this.methods.get(`${owner}::${method}`) || []).some(fn => argCount == null || fn.paramCount === argCount);
    const inherited = new Set(), visited = new Set();
    const visit = owner => {
      if (visited.has(owner)) return; visited.add(owner);
      if (hasMethod(owner)) inherited.add(owner);
      else for (const base of this.result.contractBases.get(owner) || []) visit(base);
    };
    if (isSuper || !hasMethod(type)) for (const base of this.result.contractBases.get(type) || []) visit(base);
    // Native inheritance lookup is not a compiler C3 linearizer. Preserve
    // competing inherited implementations rather than assert its first match.
    const owners = inherited.size ? [...inherited] : [resolved.contract];
    const possibleTypes = new Set([...owners, ...(!isSuper ? this.result.implementers.get(type) || [] : [])]);
    const definitions = [...possibleTypes].flatMap(owner => this.methods.get(`${owner}::${resolved.name}`) || []);
    const matches = definitions.filter(fn =>
      (argCount == null || fn.paramCount === argCount) && (this.anatomy(fn) ||
        // Retain real overlapping overloads as alternatives, never a guessed
        // single definition. Quoted/comment-only declarations are excluded.
        [...lexicalCode(this.code(fn)).matchAll(new RegExp(`\\bfunction\\s+${escaped(fn.name)}\\s*\\(`, 'g'))].length > 1));
    return matches;
  }
  receiverTypes(fn, parts, scoped, site) {
    const params = new Map(), body = new Map();
    scanVariables(parts.header, this.knownTypes, params);
    scanVariables(parts.body, this.knownTypes, { set(name, type) {
      if (!body.has(name)) body.set(name, new Set()); body.get(name).add(type);
    } });
    const root = site.recvChain?.[0] || site.recv;
    const types = new Set(body.get(root) || []);
    if (params.has(root)) types.add(params.get(root));
    else if (types.size) {
      const stateType = this.runner.flowboardReceiverType(scoped, fn.contract, { recv: root }, new Map());
      if (this.knownTypes.has(stateType) || /^(?:u?int\d*|bytes\d*|address|bool|string)$/.test(stateType || '')) types.add(stateType);
    }
    if (!types.size) return [this.runner.flowboardReceiverType(scoped, fn.contract, site, params)].filter(Boolean);
    // Without a compiler AST, a later/nested shadow declaration must not
    // silently override an earlier call's receiver. Retain possible types;
    // ambiguity is preferable to an incorrect single dispatch arrow.
    return [...new Set([...types].map(type => this.runner.flowboardReceiverType(scoped, fn.contract, site, new Map(params).set(root, type))).filter(Boolean))];
  }
  callLinks(fn) {
    const key = this.key(fn);
    if (this.links.has(key)) return this.links.get(key);
    const parts = this.anatomy(fn), links = [];
    if (!parts) return links;
    const scoped = this.scopeFor(fn);
    let cursor = 0;
    for (const site of this.runner.flowboardCallSites(parts.body)) {
      const re = new RegExp(`\\b${escaped(site.name)}\\s*\\(`, 'g'); re.lastIndex = cursor;
      const occurrence = re.exec(parts.body); if (!occurrence) continue;
      cursor = occurrence.index + occurrence[0].length;
      let name = site.name, arity = site.argCount, memberCandidates = null;
      if (site.isNew) name = `${site.name}::constructor`;
      else if (site.recv && !['this', 'super'].includes(site.recv)) {
        memberCandidates = [];
        for (const type of this.receiverTypes(fn, parts, scoped, site)) {
          const direct = this.candidates(`${type}::${site.name}`, fn.contract, false, arity);
          if (direct.length) memberCandidates.push(...direct);
          else for (const library of new Set([...(this.result.usingFor.get(type) || []), ...this.result.usingForWildcard])) {
            memberCandidates.push(...this.candidates(`${library}::${site.name}`, fn.contract, false, arity + 1));
          }
        }
        memberCandidates = [...new Map(memberCandidates.map(value => [this.key(value), value])).values()];
        if (!memberCandidates.length) continue;
        name = `${memberCandidates.length === 1 ? memberCandidates[0].contract : site.recv}::${site.name}`;
      }
      const candidates = memberCandidates || this.candidates(name, fn.contract, site.recv === 'super', arity);
      if (!candidates.length) continue;
      const line = fn.startLine + parts.clean.slice(0, parts.bodyStart + occurrence.index).split('\n').length - 1;
      links.push({ name, argCount: site.argCount, isSuper: site.recv === 'super', expression: `${site.recv ? site.recv + '.' : site.isNew ? 'new ' : ''}${site.name}(…)`, line, candidates });
    }
    this.links.set(key, links); return links;
  }
  graph(fns, cards) {
    const connections = [];
    for (let a = 0; a < fns.length; a++) {
      if (fns[a].kind === 'context') continue;
      for (const site of this.callLinks(fns[a])) {
        const matches = site.candidates;
        if (matches.length !== 1) continue;
        const b = fns.findIndex(fn => fn.kind !== 'context' && fn.file === matches[0].file && fn.startLine === matches[0].startLine && fn.name === matches[0].name && fn.contract === matches[0].contract);
        if (b < 0 || a === b) continue;
        connections.push({ from: cards[a].id, to: cards[b].id, kind: 'hypothesis',
          reason: `${this.relative(fns[a].file)}:${site.line} contains ${site.expression}, resolving to ${matches[0].contract || ''}::${matches[0].name} at ${this.relative(matches[0].file)}:${matches[0].startLine}. Source call candidate; runtime reachability and finding relevance remain unreviewed.` });
      }
    }
    return connections.filter((edge, index, all) => all.findIndex(other => other.from === edge.from && other.to === edge.to) === index);
  }
  expansionCandidates(fn, name, isSuper, argCount) {
    const method = name.split('::').pop();
    let sites = this.callLinks(fn).filter(site => site.name.split('::').pop() === method && site.isSuper === !!isSuper);
    // Upstream puts the last name-level arity onto EVERY highlighted occurrence.
    // If occurrences differ, that UI hint cannot identify the clicked overload.
    // Offer actual source targets instead of silently opening the wrong one.
    if (new Set(sites.map(site => site.argCount)).size <= 1 && argCount != null) sites = sites.filter(site => site.argCount === argCount);
    return [...new Map(sites.flatMap(site => site.candidates).map(value => [this.key(value), value])).values()];
  }
  validateConnections(fns, cards, connections) {
    const warnings = [], byId = new Map(cards.map((card, i) => [card.id, fns[i]]));
    let sourceCalls = 0;
    const checked = connections.map(edge => {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      const exists = from && to && from.kind !== 'context' && to.kind !== 'context' && this.callLinks(from).some(site => site.candidates.length === 1 && this.key(site.candidates[0]) === this.key(to));
      if (exists) { sourceCalls++; return edge; }
      if (edge.kind !== 'call') return edge;
      warnings.push(`The declared call ${edge.from} → ${edge.to} was not found as a unique direct source call. It is displayed as a hypothesis, not a verified call.`);
      return { ...edge, kind: 'hypothesis', reason: `${edge.reason || ''} Source check: no unique direct call found; inspect dispatch/helpers/modifiers or correct this relationship.`.trim() };
    });
    return { connections: checked, warnings, sourceCalls };
  }
  hints(fn) {
    const parts = fn.kind === 'context' ? null : this.anatomy(fn), header = parts?.header || '';
    return { signature: signature(header), visibility: header.match(/\b(external|public|internal|private)\b/)?.[1] || 'unspecified',
      modifiers: (fn.modifiers || []).map(x => x.name), readOnly: /\b(view|pure)\b/.test(header),
      context: fn.kind === 'context', guards: guards(parts), file: this.relative(fn.file), line: fn.startLine, endLine: fn.endLine,
      sourceHash: crypto.createHash('sha256').update(this.document(this.relative(fn.file)).text).digest('hex'),
      range: `${this.relative(fn.file)}:${fn.startLine}-${fn.endLine}` };
  }
  fingerprint(cards) {
    const anchors = cards.map(card => ({ id: card.id, file: card.file, line: card.line,
      kind: card.kind || 'function', function: card.function, parentId: card.parentId, edgeKind: card.edgeKind,
      hash: crypto.createHash('sha256').update(this.document(card.file).text).digest('hex') }));
    // Saved boards also contain functions expanded beyond the original anchors.
    // Invalidate those snapshots when ANY indexed dependency changes, not only
    // the report's cited files. Conservative invalidation is safer than stale code.
    const index = [...this.sourceStamps].sort(([a], [b]) => a.localeCompare(b)).map(([file, stamp]) => [this.relative(file), stamp.size, stamp.modified]);
    return crypto.createHash('sha256').update(JSON.stringify({ engine: 'source-occurrences-v3', anchors, index })).digest('hex');
  }
}
module.exports = { SourceCatalog, sourceDocument, signature };
