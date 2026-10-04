'use strict';
// Read-only diagnostic replay of a saved challenge. Private inputs stay local;
// results belong in a user-chosen private directory, never a release fixture.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const engine = require('../extension/investigation-engine'), provider = require('../extension/semantic-provider');
const challenge = require('../extension/challenge-format'), store = require('../extension/store');
async function main() {
  const [root, id, output] = process.argv.slice(2);
  if (!root || !id || !output) throw new Error('Usage: node scripts/check-saved-provider.js WORKSPACE FINDING PRIVATE_OUTPUT');
  const draft = engine.read(root, id), request = store.readDraft(root, id), issue = store.readReport(root).issues.find(value => value.id === id);
  if (!draft?.claims.length || !issue) throw new Error('No accepted generation to challenge.');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const input = { phase: 'challenge', ...(process.argv.includes('--compact') ? { checkOnly: true } : {}), finding: { id, title: request.finding.title,
    reportParagraphs: require('../extension/webview/walkthrough-model').paragraphs(issue.reportText), expectedBehavior: request.finding.expectedBehavior || '' },
    snapshot: draft.snapshot, corrections: draft.corrections, previousScopes: draft.claims.map(({ id, allegation, implementation, conditions }) => ({ id, allegation, implementation, conditions })),
    sources: engine.modelSources(draft.sources), compiler: draft.compiler, experiments: draft.experiments, codeGaps: draft.codeGaps || [], documentation: draft.documentation,
    earlierDraft: challenge.earlier(draft, provider.schema), actions: draft.actions.slice(-5) };
  const trace = record => { fs.appendFileSync(path.join(output, 'trace.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 }); console.log(JSON.stringify(record)); };
  trace({ findingId: id, project: draft.snapshot.project, snapshot: draft.snapshot.sourceDigest, inputHash: crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    inputBytes: Buffer.byteLength(JSON.stringify(input)), sources: draft.sources.length, phase: 'challenge' });
  try {
    const response = await provider.runCodex(input, { onProgress: trace });
    fs.writeFileSync(path.join(output, 'response.json'), JSON.stringify(response, null, 2), { mode: 0o600 });
    const expanded = input.checkOnly ? challenge.checked(response.value, input.earlierDraft, provider.schema) : response.value.mode ? challenge.expand(response.value, input.earlierDraft, provider.schema) : response.value;
    const accepted = engine.checkExplanations(expanded, draft, engine.accept(expanded, draft, draft.sources), draft.sources);
    trace({ audit: response.audit, accepted: true, claims: accepted.claims.map(value => ({ id: value.id, status: value.status })), outcome: accepted.causal?.outcome });
  } catch (error) { trace({ error: error.message, audit: error.audit }); process.exitCode = 1; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
