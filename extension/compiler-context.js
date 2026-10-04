'use strict';
// Consume existing solc build-info only. Never run a compiler, install packages,
// or treat a declaration reference as proof of external runtime dispatch.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('./protocol');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function walk(node, visitor, parent = null, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (node.nodeType) visitor(node, parent, ancestors);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'typeDescriptions') continue;
    if (Array.isArray(child)) for (const item of child) walk(item, visitor, node, [...ancestors, node]);
    else if (child && typeof child === 'object') walk(child, visitor, node, [...ancestors, node]);
  }
}
function loadCompiler(root) {
  const absent = reason => ({ available: false, reason, functions: [], facts: () => null, references: () => [] });
  let files;
  try {
    const folder = fs.realpathSync(path.join(root, 'out/build-info'));
    if (!p.contained(fs.realpathSync(root), folder)) return absent('Build-info directory is outside this workspace.');
    files = fs.readdirSync(folder).filter(name => name.endsWith('.json')).map(name => path.join(folder, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 8);
  } catch { return absent('No existing Foundry/solc build-info with source content is available. Lexical candidates remain available.'); }
  const failures = [];
  for (const file of files) {
    try {
      const real = fs.realpathSync(file);
      if (!p.contained(fs.realpathSync(root), real) || fs.statSync(real).size > 64 * 1024 * 1024) throw new Error('Build-info path/size is outside the supported bounds.');
      const build = JSON.parse(fs.readFileSync(real, 'utf8'));
      if (!build.input?.sources || !build.output?.sources) throw new Error('Build-info has no input content or AST output.');
      const documents = new Map(), byId = new Map(), declarations = new Map(), definitions = [];
      // An AST is accepted only if ALL its compilation inputs match. A matching
      // entry file cannot launder a stale base, library, or interface artifact.
      for (const [name, input] of Object.entries(build.input.sources)) {
        const absolute = fs.realpathSync(path.resolve(root, name));
        if (!p.contained(fs.realpathSync(root), absolute) || !absolute.endsWith('.sol')) throw new Error('Compiler input is outside this Solidity workspace.');
        const text = fs.readFileSync(absolute, 'utf8');
        if (typeof input.content !== 'string' || input.content !== text) throw new Error(`Compiler input differs: ${name}`);
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        const doc = { file: relative, text, bytes: Buffer.from(text), sourceHash: hash(text) };
        documents.set(name, doc);
        const output = build.output.sources[name];
        if (output?.ast) {
          byId.set(Number(output.id ?? output.ast.src.split(':')[2]), doc);
          walk(output.ast, node => { if (Number.isSafeInteger(node.id)) declarations.set(node.id, node); });
        }
      }
      const ref = node => {
        if (!node?.src) return null;
        const [start, length, id] = node.src.split(':').map(Number), doc = byId.get(id);
        if (!doc || start < 0 || length < 0 || start + length > doc.bytes.length) return null;
        const line = doc.bytes.subarray(0, start).toString('utf8').split('\n').length;
        const endLine = doc.bytes.subarray(0, start + Math.max(0, length - 1)).toString('utf8').split('\n').length;
        return { file: doc.file, line, endLine, sourceHash: doc.sourceHash };
      };
      const code = node => {
        const [start, length, id] = String(node?.src || '').split(':').map(Number), doc = byId.get(id);
        return doc && start >= 0 && length >= 0 ? doc.bytes.subarray(start, start + length).toString('utf8').slice(0, 300) : '';
      };
      const inside = (node, container) => {
        if (!node?.src || !container?.src) return false;
        const [at, size, file] = node.src.split(':').map(Number), [start, length, parentFile] = container.src.split(':').map(Number);
        return file === parentFile && at >= start && at + size <= start + length;
      };
      for (const node of declarations.values()) if (['FunctionDefinition', 'ModifierDefinition'].includes(node.nodeType)) {
        const source = ref(node); if (!source) continue;
        definitions.push({ id: node.id, name: node.name || node.kind, source, node });
      }
      const index = new Map(definitions.map(def => [def.id, def]));
      const facts = (file, line, name) => {
        const matches = definitions.filter(def => def.source.file === file && def.source.line <= line && def.source.endLine >= line && (!name || def.name === name));
        if (matches.length !== 1) return null;
        const def = matches[0], calls = [], guards = [], writes = [], references = [];
        walk(def.node, (node, _parent, ancestors) => {
          const source = ref(node); if (!source) return;
          if (node.nodeType === 'FunctionCall') {
            const expression = node.expression, target = index.get(expression?.referencedDeclaration);
            if (target) calls.push({ source, target: { ...target.source, name: target.name },
              relationship: expression.nodeType === 'Identifier' && !target.node.virtual && ['private', 'internal'].includes(target.node.visibility) ? 'internal-call' : 'declaration-reference',
              conditions: ancestors.filter(parent => parent.nodeType === 'IfStatement' && (inside(node, parent.trueBody) || inside(node, parent.falseBody))).slice(-6).map(parent => ({
                source: ref(parent.condition), branch: inside(node, parent.trueBody) ? 'then' : 'else', expression: code(parent.condition)
              })),
              caveat: 'Compiler declaration reference. Branch conditions, transaction success and external deployment dispatch require separate review.' });
          }
          if (node.nodeType === 'IfStatement' || node.nodeType === 'Conditional') guards.push({ source: ref(node.condition), kind: 'branch-condition' });
          if (node.nodeType === 'FunctionCall' && ['require', 'assert'].includes(node.expression?.name)) guards.push({ source, kind: node.expression.name });
          if (node.nodeType === 'Assignment' || node.nodeType === 'UnaryOperation' && ['delete', '++', '--'].includes(node.operator)) writes.push({ source, kind: node.operator,
            caveat: 'Syntactic assignment/update; storage alias, resulting value and persistence after the complete transaction are not established by the AST.' });
          if (Number.isSafeInteger(node.referencedDeclaration) && declarations.has(node.referencedDeclaration)) {
            const declaration = declarations.get(node.referencedDeclaration);
            if (declaration.nodeType === 'VariableDeclaration') references.push({ source, declaration: ref(declaration), name: declaration.name, stateVariable: !!declaration.stateVariable });
          }
        });
        return { declaration: def.source, visibility: def.node.visibility, virtual: !!def.node.virtual,
          calls: calls.slice(0, 40), guards: guards.slice(0, 30), writes: writes.slice(0, 30), references: references.slice(0, 40),
          modifiers: (def.node.modifiers || []).map(item => ({ source: ref(item), target: ref(declarations.get(item.modifierName?.referencedDeclaration)) })) };
      };
      return { available: true, version: build.solcVersion || build.solcLongVersion || 'unspecified',
        file: path.relative(root, real).split(path.sep).join('/'),
        digest: hash(JSON.stringify([...documents.values()].map(doc => [doc.file, doc.sourceHash]).sort())),
        configurationVerified: false,
        inputCount: documents.size, functions: definitions.map(({ node, ...def }) => def), facts,
        references: id => { const target = index.get(id); if (!target) return []; return definitions.filter(def => {
          let found = false; walk(def.node, node => { if (node.referencedDeclaration === id) found = true; }); return found;
        }).map(({ node, ...def }) => def).slice(0, 12); } };
    } catch (error) { failures.push(error.message); }
  }
  return absent(`Existing build-info could not be trusted: ${failures.slice(0, 3).join('; ')}`);
}
module.exports = { loadCompiler, walk };
