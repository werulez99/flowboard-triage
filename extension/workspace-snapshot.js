'use strict';
// A content-validated generation shared by report jobs. Progress never calls
// this module. Acceptance/reuse boundaries explicitly reconcile disk content.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { contained, gitState } = require('./protocol');
const { projectConfigurationStamp } = require('./source');
const documentation = require('./local-documentation');
const { membership } = require('./source-inventory');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const cache = new WeakMap(), metrics = { reconciliations: 0, sourceBytes: 0, compilerLoads: 0, reuse: 0 };
function validate(catalog, { force = false } = {}) {
  const prior = cache.get(catalog);
  if (prior && !force) { metrics.reuse++; return prior; }
  catalog.assertFresh(); metrics.reconciliations++;
  const files = Object.fromEntries([...catalog.sourceStamps.keys()].sort().map(file => {
    const text = fs.readFileSync(file); metrics.sourceBytes += text.length;
    const id = catalog.relative(file), digest = hash(text);
    if (catalog.sourceStamps.get(file)?.hash && catalog.sourceStamps.get(file).hash !== digest) throw new Error(`Code changed since indexing: ${id}. Refresh the source map.`);
    if (catalog.documents.has(file) && hash(catalog.documents.get(file).text) !== digest) throw new Error(`Code changed since indexing: ${id}. Refresh the source map.`);
    return [id, digest];
  }));
  const members = membership(catalog.root);
  if (catalog.result.sourceMembership && hash(members) !== hash(catalog.result.sourceMembership)) throw new Error('Source files were added or removed since indexing. Refresh the source map.');
  // Include membership independently of watcher delivery, including files with
  // no indexed function. Newly added definitions require a fresh source index.
  const discovered = documentation.discover(catalog.root);
  const key = hash({ files, members, configuration: projectConfigurationStamp(catalog.root), docs: discovered.digest });
  if (prior && key !== prior.key) throw Object.assign(new Error('Code, dependencies, configuration or documentation changed. Revalidate the workspace before reusing a guide.'), { code: 'WORKSPACE_CHANGED' });
  const result = prior || { key, files, members, sourceDigest: hash(Object.entries(files)), configuration: catalog.projectConfigurationStamp,
    documentation: discovered, revision: gitState(catalog.root).head || null,
    project: hash(fs.realpathSync(catalog.root)), selections: new Map(), compiler: null };
  cache.set(catalog, result); return result;
}
function docs(catalog, query) {
  const generation = validate(catalog);
  if (!generation.selections.has(query)) generation.selections.set(query, documentation.select(generation.documentation, query));
  return generation.selections.get(query);
}
function compiler(catalog) {
  const generation = validate(catalog);
  if (!generation.compiler) { metrics.compilerLoads++; generation.compiler = require('./compiler-context').loadCompiler(catalog.root); }
  return generation.compiler;
}
function dependencies(catalog, draft) {
  const generation = validate(catalog), paths = new Set();
  const imports = new (require('./source-imports').ImportContext)(catalog);
  const names = new Set();
  for (const unit of draft.sources) {
    paths.add(unit.source.file);
    for (const file of imports.files(path.resolve(catalog.root, unit.source.file))) paths.add(catalog.relative(file));
    for (const name of [unit.contract, unit.name?.split('::').at(-1)]) if (name && /^[\w$]+$/.test(name)) names.add(name);
  }
  // Named caller/receiver/absence assumptions span beyond the import closure.
  // Conservatively retain every file mentioning these declarations. Membership
  // changes invalidate reuse; no negative search is silently certified forever.
  const expression = names.size ? new RegExp(`\\b(?:${[...names].map(name => name.replace(/\$/g, '\\$')).join('|')})\\b`) : null;
  for (const file of Object.keys(generation.files)) if (expression?.test(require('./solidity-text').lexicalCode(catalog.document(file).text))) paths.add(file);
  // An intentionally bounded import walk cannot certify an uninspected tail.
  // Retain the full indexed dependency set conservatively in that case.
  if (imports.incomplete) for (const file of Object.keys(generation.files)) paths.add(file);
  return { version: 1, membership: hash(Object.keys(generation.files)), names: [...names].sort(),
    files: Object.fromEntries([...paths].sort().map(file => [file, generation.files[file] || null])),
    discovery: discovery(catalog, draft), configuration: generation.configuration, documentation: generation.documentation.digest };
}
function discovery(catalog, draft) {
  const candidates = require('./source-search').search(catalog).rank({ title: draft.title, body: draft.walkthrough?.reportText || '', fields: {} }).candidates;
  const generation = validate(catalog);
  return hash(candidates.map(item => [catalog.key(item.fn), generation.files[catalog.relative(item.fn.file)]]));
}
function compatible(catalog, draft) {
  const old = draft.dependencies, current = validate(catalog);
  if (!old || old.version !== 1 || old.membership !== hash(Object.keys(current.files)) || old.configuration !== current.configuration || old.documentation !== current.documentation.digest) return false;
  if (Object.entries(old.files).some(([file, digest]) => !digest || current.files[file] !== digest)) return false;
  const expression = old.names.length ? new RegExp(`\\b(?:${old.names.map(name => name.replace(/\$/g, '\\$')).join('|')})\\b`) : null;
  for (const file of Object.keys(current.files)) if (!Object.hasOwn(old.files, file) && expression?.test(require('./solidity-text').lexicalCode(catalog.document(file).text))) return false;
  return old.discovery === discovery(catalog, draft);
}
function dirtyScope(root, file, reportName) {
  if (typeof file !== 'string' || !contained(path.resolve(root), path.resolve(file))) return null;
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (file.endsWith('.sol')) return { kind: 'source' };
  if (relative === reportName || relative === '.flowboard/report.json') return { kind: 'report' };
  if (require('./source').configurationFiles.includes(relative)) return { kind: 'configuration' };
  if (/^(?:README\.md|SPECIFICATION\.md|(?:docs|specification)\/.*\.md)$/.test(relative)) return { kind: 'documentation' };
  const finding = /^\.flowboard\/findings\/([A-Za-z0-9._-]{1,100})\.json$/.exec(relative);
  return finding ? { kind: 'finding', findingId: finding[1] } : null;
}
function relevantDirty(root, file, reportName) { return !!dirtyScope(root, file, reportName); }
module.exports = { validate, docs, compiler, membership, relevantDirty, dirtyScope, dependencies, compatible, metrics };
