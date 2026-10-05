'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./protocol');
const { lexicalCode, functionParts, guards, escaped, stateStatements, scanVariables, matching } = require('./solidity-text');
const { functionSignature } = require('./report-content');
const { occurrences } = require('./call-occurrences');
const configurationFiles = ['foundry.toml', 'remappings.txt', 'foundry.lock', 'soldeer.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'hardhat.config.js', 'hardhat.config.ts'];
function projectConfigurationStamp(root) {
  return configurationFiles.map(name => {
    try { return name + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return name + ':absent'; }
  }).join('|');
}
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
    this.projectConfigurationStamp = result.projectConfigurationStamp || projectConfigurationStamp(this.root);
    this.analysisConfiguration = { mode: result.analysisConfiguration?.mode || 'source', slitherPath: result.analysisConfiguration?.slitherPath || '' };
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
    // The pinned native source-only index omits receive/fallback definitions.
    // Retain their complete real body; low-level dispatch cannot be inspected
    // by substituting an unrelated named function or an interface declaration.
    for (const file of this.sourceStamps.keys()) {
      if (!p.contained(this.root, file) || !file.endsWith('.sol')) continue;
      const doc = this.document(this.relative(file)), clean = lexicalCode(doc.text);
      for (const contract of this.runner.flowboardContracts(clean)) {
        const bodyStart = clean.indexOf('{', contract.start);
        for (const match of clean.slice(bodyStart + 1, contract.end).matchAll(/\b(receive|fallback)\s*\(/g)) {
          const start = bodyStart + 1 + match.index;
          const depth = [...clean.slice(bodyStart + 1, start)].reduce((n, c) => n + (c === '{' ? 1 : c === '}' ? -1 : 0), 0);
          if (depth) continue;
          const open = clean.indexOf('(', start), parameters = matching(clean, open), block = clean.indexOf('{', parameters), end = matching(clean, block, '{', '}');
          if (parameters < 0 || block < 0 || end < 0 || end > contract.end || clean.slice(parameters, block).includes(';')) continue;
          const startLine = clean.slice(0, start).split('\n').length, endLine = clean.slice(0, end).split('\n').length;
          if (this.functions.some(fn => fn.file === file && fn.startLine === startLine && fn.name === match[1])) continue;
          const fn = { file, startLine, endLine, name: match[1], contract: contract.name, calls: [], memberCalls: [], modifiers: [], paramCount: clean.slice(open + 1, parameters).trim() ? 1 : 0 };
          this.functions.push(fn); if (!this.byKey.has(`${file}:${startLine}`)) this.byKey.set(`${file}:${startLine}`, fn);
        }
      }
    }
    for (const fn of this.functions) {
      const key = `${fn.contract}::${fn.name}`;
      if (!this.methods.has(key)) this.methods.set(key, []); this.methods.get(key).push(fn);
    }
  }
  assertFresh() {
    if (projectConfigurationStamp(this.root) !== this.projectConfigurationStamp) throw new Error('Project configuration changed since this flow was indexed. Refresh the investigation before relying on its source map.');
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
    const fn = this.functionAt(card.file, card.line, card.function) || this.modifierAt(card.file, card.line, card.function);
    if (!fn) throw new Error(`No unique function at ${card.file}:${card.line}. Use a context card for declarations/ambiguous minified source, or inspect the old revision.`);
    if (card.function && fn.name !== card.function) throw new Error(`Expected ${card.function}, found ${fn.name}. Source changed; re-check the line.`);
    const parts = this.anatomy(fn);
    if (!parts) throw new Error(`No unique Solidity declaration for ${fn.name} at ${card.file}:${card.line}; comments/string literals and overlapping declarations are not source functions.`);
    const scoped = this.scopeFor(fn), locals = new Map(); scanVariables(parts.declaration, this.knownTypes, locals);
    return { ...fn, ...this.runner.flowboardClassifyCallSites(scoped, fn.contract,
      occurrences(this.code(fn), { from: parts.bodyStart, to: parts.bodyStart + parts.body.length }), locals),
      modifiers: this.modifiersFor(fn) };
  }
  modifiersFor(fn) {
    if (!fn.modifierNames?.length) return fn.modifiers || [];
    return fn.modifierNames.map(name => {
      const definitions = this.modifierDefinitions(fn.contract, name, fn.file);
      return definitions.length === 1 ? definitions[0] : { name, unresolved: true };
    });
  }
  modifierDefinitions(contract, name, fromFile) {
    this.importContext ||= new (require('./source-imports').ImportContext)(this);
    const files = [...this.importContext.files(fromFile)], seen = new Set(); let level = [contract];
    while (level.length) {
      const candidates = [], next = new Set();
      for (const type of level) {
        if (seen.has(type)) continue; seen.add(type);
        for (const base of this.result.contractBases.get(type) || []) next.add(base);
        for (const file of files) {
          for (const definition of this.localModifiers(file)) if (definition.contract === type && definition.name === name) candidates.push(definition);
        }
      }
      if (candidates.length) return candidates; // competing inherited guards stay ambiguous
      level = [...next];
    }
    return [];
  }
  localModifiers(file) {
    this.localModifierCache ||= new Map();
    if (this.localModifierCache.has(file)) return this.localModifierCache.get(file);
    const doc = this.document(this.relative(file)), clean = lexicalCode(doc.text), definitions = [];
    for (const owner of this.runner.flowboardContracts(clean)) {
      for (const match of clean.slice(owner.start, owner.end).matchAll(/\bmodifier\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
        const start = owner.start + match.index, paren = clean.indexOf('(', start), parameters = matching(clean, paren);
        const open = clean.indexOf('{', parameters), end = matching(clean, open, '{', '}');
        if (parameters < 0 || open < 0 || end < 0 || end > owner.end) continue;
        definitions.push({ name: match[1], contract: owner.name, kind: 'modifier', file: doc.uri.fsPath,
          startLine: clean.slice(0, start).split('\n').length, endLine: clean.slice(0, end).split('\n').length,
          modifiers: [], calls: [], memberCalls: [] });
      }
    }
    this.localModifierCache.set(file, definitions); return definitions;
  }
  modifierAt(file, line, name) {
    const doc = this.document(file), local = this.localModifiers(this.document(file).uri.fsPath).filter(item => item.startLine === line && (!name || item.name === name));
    if (local.length) return local.length === 1 ? local[0] : null;
    const definitions = [];
    for (const [contract, modifiers] of this.result.modifiersByContract || []) for (const [modifierName, value] of modifiers) {
      const modifier = { ...value, name: modifierName };
      if (typeof modifier.file !== 'string' || !Number.isSafeInteger(modifier.startLine)) continue;
      if (path.resolve(modifier.file) !== doc.uri.fsPath || modifier.startLine !== line || name && modifier.name !== name) continue;
      const code = doc.lines.slice(line - 1).join('\n'), clean = lexicalCode(code);
      if (!new RegExp(`^\\s*modifier\\s+${escaped(modifier.name)}\\b`).test(clean)) continue;
      const open = clean.indexOf('{'), end = matching(clean, open, '{', '}');
      if (open < 0 || end < 0) continue;
      definitions.push({ ...modifier, contract, kind: 'modifier', endLine: line + clean.slice(0, end).split('\n').length - 1, modifiers: [], calls: [], memberCalls: [] });
    }
    return definitions.length === 1 ? definitions[0] : null;
  }
  stateDeclarations(file, contract) {
    const doc = this.document(file);
    this.declarationCache ||= new Map();
    if (!this.declarationCache.has(doc.uri.fsPath)) {
      const clean = lexicalCode(doc.text), declarations = [];
      for (const owner of this.runner.flowboardContracts(clean)) for (const span of stateStatements(clean, owner, true)) {
        let end = span.text.length, depth = 0;
        for (let i = 0; i < span.text.length; i++) {
          if ('(['.includes(span.text[i])) depth++;
          else if (')]'.includes(span.text[i])) depth--;
          else if (span.text[i] === '=' && depth === 0) { end = i; break; }
        }
        const symbol = [...span.text.slice(0, end).matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].at(-1)?.[1];
        if (!symbol || !span.text.trimEnd().endsWith(';')) continue;
        declarations.push({ name: `${symbol} (state)`, symbol, contract: owner.name, kind: 'context', file: doc.uri.fsPath,
          startLine: clean.slice(0, span.start).split('\n').length, endLine: clean.slice(0, span.end - 1).split('\n').length,
          calls: [], memberCalls: [], modifiers: [] });
      }
      this.declarationCache.set(doc.uri.fsPath, declarations);
    }
    return this.declarationCache.get(doc.uri.fsPath).filter(item => !contract || item.contract === contract);
  }
  functionDeclarations(contract, name, fromFile) {
    // The native index omits bodyless interface/abstract declarations. Read
    // their exact signatures as context, never as executable implementations.
    this.importContext ||= new (require('./source-imports').ImportContext)(this);
    const files = fromFile ? this.importContext.files(fromFile) : this.sourceStamps.keys();
    const found = [];
    for (const file of files) {
      const doc = this.document(this.relative(file));
      if (!new RegExp(`\\b(?:contract|interface)\\s+${escaped(contract)}\\b`).test(doc.text)) continue;
      const clean = lexicalCode(doc.text);
      for (const owner of this.runner.flowboardContracts(clean).filter(item => item.name === contract)) {
        for (const match of clean.slice(owner.start, owner.end).matchAll(new RegExp(`\\bfunction\\s+${escaped(name)}\\s*\\(`, 'g'))) {
          const start = owner.start + match.index, paren = clean.indexOf('(', start), close = matching(clean, paren);
          if (close < 0) continue;
          let end = close + 1;
          while (end < owner.end && clean[end] !== ';' && clean[end] !== '{') end++;
          if (clean[end] !== ';') continue;
          found.push({ name, contract, kind: 'context', contextKind: 'declaration', file: doc.uri.fsPath,
            startLine: clean.slice(0, start).split('\n').length, endLine: clean.slice(0, end).split('\n').length,
            calls: [], memberCalls: [], modifiers: [] });
        }
      }
    }
    return found;
  }
  resolveUnit(unit) {
    if (unit.contextKind === 'declaration') {
      const file = this.document(unit.source.file).uri.fsPath;
      const candidates = this.functionDeclarations(unit.contract, unit.name.split('::').pop(), file).filter(item =>
        item.file === file && item.startLine === unit.source.line && item.endLine === unit.source.endLine);
      if (candidates.length !== 1) throw new Error('The interface declaration no longer matches this code. Recheck the note.');
      return candidates[0];
    }
    if (unit.contextKind === 'state') {
      const definitions = this.stateDeclarations(unit.source.file, unit.contract).filter(item =>
        item.startLine === unit.source.line && item.endLine === (unit.declarationEndLine || unit.source.endLine) && `${item.contract}::${item.name}` === unit.name);
      if (definitions.length !== 1) throw new Error('The saved declaration no longer matches this code. Recheck the note.');
      return definitions[0];
    }
    if (unit.contextKind === 'excerpt') {
      const doc = this.document(unit.source.file), endLine = unit.declarationEndLine || unit.source.endLine;
      if (unit.source.line < 1 || endLine > doc.lineCount || endLine < unit.source.line) throw new Error('Code details are outside the current file.');
      return { name: 'Code details', kind: 'context', file: doc.uri.fsPath, startLine: unit.source.line, endLine, contract: null, calls: [], memberCalls: [], modifiers: [] };
    }
    const fn = this.resolveCard({ file: unit.source.file, line: unit.source.line, function: unit.name.split('::').pop() });
    if (unit.contract && fn.contract !== unit.contract || unit.signature && this.hints(fn).identity.signature !== unit.signature) throw new Error('The saved function identity does not match this contract and signature. Recheck the note; no similar function was substituted.');
    return fn;
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
    this.importContext ||= new (require('./source-imports').ImportContext)(this);
    this.structScope ||= new Map();
    if (!this.structScope.has(fn.file)) {
      const definitions = new Map();
      for (const file of this.importContext.files(fn.file)) {
        const clean = lexicalCode(this.document(this.relative(file)).text);
        for (const match of clean.matchAll(/\bstruct\s+([A-Za-z_$][\w$]*)\s*\{/g)) {
          const open = clean.indexOf('{', match.index), close = matching(clean, open, '{', '}');
          if (close < 0) continue;
          const fields = new Map([...clean.slice(open + 1, close).matchAll(/\b([A-Za-z_$][\w$.]*)(?:\[\])?\s+([A-Za-z_$][\w$]*)\s*;/g)].map(item => [item[2], item[1].split('.').pop()]));
          const all = definitions.get(match[1]) || []; all.push(fields); definitions.set(match[1], all);
        }
      }
      const fields = new Map();
      for (const [name, definitionsForName] of definitions) {
        const unique = new Set(definitionsForName.map(value => JSON.stringify([...value])));
        // Competing imported structs remain unresolved. An unrelated test's
        // project-global first match must never choose the receiver's type.
        if (unique.size === 1) fields.set(name, definitionsForName[0]);
      }
      this.structScope.set(fn.file, fields);
    }
    return { ...this.stateResult, structFields: this.structScope.get(fn.file),
      ...(own ? { varTypesByContract: new Map(this.stateResult.varTypesByContract).set(fn.contract, own) } : {}) };
  }
  named(name, files) {
    return this.functions.filter(fn => fn.name === name && (!files?.size || files.has(fn.file)) && this.anatomy(fn));
  }
  mentioned(mention, files) {
    return this.named(mention.name, files).filter(fn => (!mention.contract || fn.contract === mention.contract) &&
      (!mention.signature || functionSignature(this.anatomy(fn).header, fn.name) === mention.signature));
  }
  relevantDefinitions(candidates, from) {
    this.importContext ||= new (require('./source-imports').ImportContext)(this);
    return this.importContext.narrow(candidates, from);
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
    const permitted = new Set(), visitType = owner => { if (permitted.has(owner)) return; permitted.add(owner); for (const base of this.result.contractBases.get(owner) || []) visitType(base); };
    visitType(type);
    for (const implementer of this.result.implementers.get(type) || []) permitted.add(implementer);
    // The native lookup can fall back to an unrelated global name. That is not
    // an implementation of this receiver or an unqualified internal call.
    if (!permitted.has(resolved.contract)) return [];
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
  initialization(fn) {
    if (!fn?.contract) return null;
    this.initializations ||= new Map();
    const key = `${fn.file}:${fn.contract}`;
    if (this.initializations.has(key)) return structuredClone(this.initializations.get(key));
    this.importContext ||= new (require('./source-imports').ImportContext)(this);
    const scopes = [], gaps = [], visited = new Set();
    const visit = (contract, file) => {
      const key = `${file}:${contract}`; if (visited.has(key)) return; visited.add(key);
      const document = this.document(this.relative(file)), clean = lexicalCode(document.text);
      const matches = this.runner.flowboardContracts(clean).filter(item => item.name === contract);
      if (matches.length !== 1) { gaps.push(`No unique initialization scope for ${contract} in ${this.relative(file)}.`); return; }
      const definition = matches[0], start = clean.indexOf('{', definition.start), constructors = [];
      for (const match of clean.slice(start + 1, definition.end).matchAll(/\bconstructor\s*\(/g)) {
        const at = start + 1 + match.index;
        const depth = [...clean.slice(start + 1, at)].reduce((level, char) => level + (char === '{' ? 1 : char === '}' ? -1 : 0), 0);
        if (depth) continue;
        const line = clean.slice(0, at).split('\n').length;
        const candidates = this.functions.filter(item => item.file === file && item.contract === contract && item.name === 'constructor' && item.startLine === line && this.anatomy(item));
        if (candidates.length !== 1) { gaps.push(`The constructor of ${contract} at ${this.relative(file)}:${line} remains unreadable.`); continue; }
        constructors.push({ file: this.relative(file), contract, line, endLine: candidates[0].endLine,
          sourceHash: crypto.createHash('sha256').update(document.text).digest('hex') });
      }
      scopes.push({ file: this.relative(file), contract, sourceHash: crypto.createHash('sha256').update(document.text).digest('hex'),
        constructors, constructorAbsent: constructors.length === 0 && !gaps.some(gap => gap.includes(`constructor of ${contract} `)) });
      for (const base of this.result.contractBases.get(contract) || []) {
        const found = [...this.importContext.files(file)].flatMap(candidate => this.runner.flowboardContracts(lexicalCode(this.document(this.relative(candidate)).text))
          .filter(item => item.name === base).map(() => candidate));
        if (found.length !== 1) { gaps.push(`The initialization scope of base ${base} is unavailable or ambiguous.`); continue; }
        visit(base, found[0]);
      }
    };
    visit(fn.contract, fn.file);
    const value = { complete: gaps.length === 0, scopes, gaps };
    this.initializations.set(key, value); return structuredClone(value);
  }
  callLinks(fn) {
    const key = this.key(fn);
    if (this.links.has(key)) return this.links.get(key);
    const declaration = fn.kind === 'context' && (fn.symbol || fn.contextKind === 'state');
    const original = declaration ? this.code(fn) : '';
    const parts = declaration ? { clean: lexicalCode(original), header: '', bodyStart: 0, body: lexicalCode(original), rawBody: original } : this.anatomy(fn), links = [];
    if (!parts) return links;
    const scoped = this.scopeFor(fn);
    const code = this.code(fn), sourceHash = crypto.createHash('sha256').update(this.document(this.relative(fn.file)).text).digest('hex');
    for (const site of occurrences(code, { from: parts.bodyStart, to: parts.bodyStart + parts.body.length,
      line: fn.startLine, identity: `${this.relative(fn.file)}:${sourceHash}` })) {
      if (declaration && !site.isNew) continue; // constructor binding facts, not a running declaration frame
      // Events, custom errors, type conversions and ABI helpers are not
      // external implementation boundaries. Preserve real new/receiver calls.
      const before = parts.clean.slice(0, site.nameSpan.start);
      if (/\b(?:emit|revert)\s+(?:[\w$]+\.)?$/.test(before) || !site.isNew && !site.recv && this.knownTypes.has(site.name) ||
          site.recv === 'abi' || ['bytes', 'string'].includes(site.recv) && site.name === 'concat') continue;
      if (site.recv && ['wrap', 'unwrap'].includes(site.name)) {
        this.valueTypes ||= new Set([...this.sourceStamps.keys()].flatMap(file => [...lexicalCode(this.document(this.relative(file)).text).matchAll(/\btype\s+([A-Za-z_$][\w$]*)\s+is\s+/g)].map(match => match[1])));
        if (this.valueTypes.has(site.recv)) continue;
      }
      if (['vm', 'console', 'console2'].includes(site.recv) && /(?:^|\/)(?:test|tests|script|scripts|lib)\//.test(this.relative(fn.file))) continue;
      // Namespaced struct construction is data construction, not an external
      // call obligation. The type must actually exist in the parsed index.
      if (site.recv && /^[A-Z]/.test(site.recv) && (this.result.structs.has(site.name) || this.result.structs.has(`${site.recv}.${site.name}`))) continue;
      let name = site.name, arity = site.argCount, memberCandidates = null, receiverTypes = []; const libraryCandidates = new Set();
      if (site.isNew) name = `${site.name}::constructor`;
      else if (site.recv && !['this', 'super'].includes(site.recv)) {
        memberCandidates = [];
        receiverTypes = this.receiverTypes(fn, parts, scoped, site);
        for (const type of receiverTypes) {
          const direct = this.candidates(`${type}::${site.name}`, fn.contract, false, arity);
          if (direct.length) memberCandidates.push(...direct);
          else for (const library of new Set([...(this.result.usingFor.get(type) || []), ...this.result.usingForWildcard])) {
            const methods = this.candidates(`${library}::${site.name}`, fn.contract, false, arity + 1);
            methods.forEach(method => libraryCandidates.add(this.key(method))); memberCandidates.push(...methods);
          }
        }
        memberCandidates = [...new Map(memberCandidates.map(value => [this.key(value), value])).values()];
        name = `${memberCandidates.length === 1 ? memberCandidates[0].contract : site.recv}::${site.name}`;
      }
      const candidates = this.relevantDefinitions(memberCandidates || this.candidates(name, fn.contract, site.recv === 'super', arity), fn.file);
      // Unknown external implementations are a visible boundary, not a reason
      // to silently remove the call from a researcher's source context. Keep
      // ordinary Solidity builtins out of this dependency list.
      if (!candidates.length && !site.recv && /^(?:require|assert|revert|keccak256|sha256|ripemd160|ecrecover|addmod|mulmod|blockhash|gasleft|selfdestruct|type|address|payable|bool|string|bytes\d*|u?int\d*)$/.test(site.name)) continue;
      const line = site.span.line;
      const target = candidates.length === 1 ? candidates[0] : null, targetHeader = target && this.anatomy(target)?.header;
      const established = !site.recv && !site.isNew && target && target.contract === fn.contract && /\b(internal|private)\b/.test(targetHeader || '') && !/\bvirtual\b/.test(targetHeader || '') && !new RegExp(`\\b${escaped(site.name)}\\b`).test(parts.header.slice(parts.header.indexOf('(')));
      const internalLibrary = !!target && /\b(internal|private)\b/.test(targetHeader || '') &&
        new RegExp(`\\blibrary\\s+${escaped(target.contract)}\\b`).test(lexicalCode(this.document(this.relative(target.file)).text));
      const declarations = [];
      if (site.recv && !['this', 'super'].includes(site.recv)) for (const type of receiverTypes) {
        for (const definition of this.functionDeclarations(type, site.name, fn.file)) {
          const header = this.code(definition), params = require('./call-bindings').parameterNames(header);
          if (params.length === site.argCount) declarations.push({ file: this.relative(definition.file), line: definition.startLine,
            signature: functionSignature(header, site.name), parameters: params });
        }
      }
      // `call`, `send`, etc. are also legal user method names. Only an address
      // receiver uses the low-level EVM convention; a known contract method
      // with that spelling remains a normal ABI call.
      const namedMember = site.callKind === 'low-level' && receiverTypes.length === 1 &&
        receiverTypes[0] !== 'address' && this.knownTypes.has(receiverTypes[0]);
      const callKind = namedMember ? 'member' : site.callKind;
      const failure = namedMember && site.failure === 'returns-status' ? 'propagates' : site.failure;
      let creationTargets = [];
      if (site.isNew) {
        this.importContext ||= new (require('./source-imports').ImportContext)(this);
        for (const file of this.importContext.files(fn.file)) {
          const doc = this.document(this.relative(file)), clean = lexicalCode(doc.text);
          for (const owner of this.runner.flowboardContracts(clean)) if (owner.name === site.name &&
            /^\s*(?:abstract\s+)?contract\b/.test(clean.slice(owner.start))) creationTargets.push({
              file: this.relative(file), contract: owner.name, line: clean.slice(0, owner.start).split('\n').length,
              sourceHash: crypto.createHash('sha256').update(doc.text).digest('hex') });
        }
      }
      links.push({ id: site.id, span: site.span, nameSpan: site.nameSpan, argumentSpans: site.argumentSpans, options: site.options, callKind, failure, ...(site.tryContext ? { tryContext: site.tryContext } : {}), creationTargets, internalLibrary, declarations,
        receiverExpression: site.receiverExpression, receiverSpan: site.receiverSpan, sourceExpression: site.sourceExpression,
        name, receiver: site.receiverExpression || 'internal', arguments: site.arguments,
        implicitReceiver: !!target && libraryCandidates.has(this.key(target)), receiverTypes, argCount: site.argCount, isSuper: site.recv === 'super', expression: `${site.receiverExpression ? site.receiverExpression + '.' : site.isNew ? 'new ' : ''}${site.name}(…)`, line, candidates,
        relationship: established ? 'call' : 'hypothesis', resolution: established ? 'direct-internal' : candidates.length > 1 ? 'ambiguous' : candidates.length ? 'declaration-candidate' : 'unresolved' });
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
        connections.push({ from: cards[a].id, to: cards[b].id, kind: site.relationship,
          reason: `${this.relative(fns[a].file)}:${site.line} contains ${site.expression}. ${site.relationship === 'call' ? 'Calls the non-virtual internal function' : 'Possible target'} ${matches[0].contract || ''}::${matches[0].name} at ${this.relative(matches[0].file)}:${matches[0].startLine}. ${site.relationship === 'call' ? 'Check guards and branches; this is not a complete transaction sequence.' : 'The running implementation and branch remain to check.'}` });
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
      const direct = exists && this.callLinks(from).some(site => site.relationship === 'call' && site.candidates.length === 1 && this.key(site.candidates[0]) === this.key(to));
      if (exists) sourceCalls++;
      if (direct || edge.kind !== 'call') return edge;
      if (edge.kind !== 'call') return edge;
      warnings.push(`The declared call ${edge.from} → ${edge.to} was not found as a unique direct source call. It is displayed as a hypothesis, not a verified call.`);
      return { ...edge, kind: 'hypothesis', reason: `${edge.reason || ''} Source check: no unique direct call found; inspect dispatch/helpers/modifiers or correct this relationship.`.trim() };
    });
    return { connections: checked, warnings, sourceCalls };
  }
  hints(fn) {
    const parts = fn.kind === 'context' ? null : this.anatomy(fn), header = parts?.header || '';
    return { signature: signature(header), identity: { contract: fn.contract, signature: functionSignature(header, fn.name), key: this.key(fn) }, visibility: header.match(/\b(external|public|internal|private)\b/)?.[1] || 'unspecified',
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
    return crypto.createHash('sha256').update(JSON.stringify({ engine: 'source-occurrences-v4', anchors, index,
      projectConfiguration: this.projectConfigurationStamp, analysisConfiguration: this.analysisConfiguration })).digest('hex');
  }
}
module.exports = { SourceCatalog, sourceDocument, signature, projectConfigurationStamp, configurationFiles };
