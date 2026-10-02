#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const p = require('./extension/protocol');

const argv = process.argv.slice(2);
const command = argv.shift();
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  const value = argv[index + 1];
  argv.splice(index, 2);
  return value;
}
function copyNew(source, destination) {
  if (fs.existsSync(destination)) throw new Error(`Already exists; not overwritten: ${destination}`);
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
}
async function main() {
  const root = fs.realpathSync(path.resolve(option('--root', process.cwd())));
  if (command === 'init') {
    p.writableDirectory(root, '.flowboard/findings');
    const skillParent = p.writableDirectory(root, '.agents/skills');
    const skill = path.join(skillParent, 'solidity-flowboard-triage');
    if (!fs.existsSync(skill)) copyNew(path.join(__dirname, 'skills/solidity-flowboard-triage'), skill);
    const rules = p.writableDirectory(root, '.cursor/rules');
    const rulePath = path.join(rules, 'flowboard-triage.mdc');
    if (!fs.existsSync(rulePath)) fs.copyFileSync(path.join(__dirname, 'integrations/flowboard-triage.mdc'), rulePath, fs.constants.COPYFILE_EXCL);
    console.log('Initialized workspace skill, Cursor rule, and .flowboard/findings. Existing files were preserved.');
  } else if (command === 'submit') {
    if (!argv[0]) throw new Error('Usage: submit finding.json --root project');
    const request = p.readJson(path.resolve(argv[0]));
    p.evidenceSources(root, request.finding?.triage, true); p.validate(request);
    const git = p.gitState(root);
    p.checkRevision(request, git);
    const references = p.sources(root, request);
    request.id = `review-${crypto.randomUUID()}`;
    if (git.head) request.sourceRevision ||= git.head;
    request.cards = request.cards.map((card, i) => ({ ...card, sourceHash: references[i].hash }));
    p.atomicJson(root, p.REQUEST, request);
    console.log(JSON.stringify({ state: 'submitted', requestId: request.id, cards: request.cards.length }));
  } else if (command === 'status') {
    const wait = Number(option('--wait', '0'));
    if (!Number.isFinite(wait) || wait < 0 || wait > 300) throw new Error('--wait must be between 0 and 300 seconds.');
    const deadline = Date.now() + wait * 1000;
    let status;
    const request = p.readJson(path.join(root, p.REQUEST));
    do {
      try { status = p.readJson(path.join(root, p.STATUS)); } catch { /* waiting for editor */ }
      if (status?.requestId === request.id && ['ready', 'error'].includes(status.state)) break;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    } while (true);
    if (status?.requestId !== request.id) status = { state: 'pending', requestId: request.id, hint: 'Open/reload the trusted workspace in Cursor or VS Code with both VSIX extensions installed.' };
    console.log(JSON.stringify(status, null, 2));
    if (status.state !== 'ready') process.exitCode = 1;
  } else if (command === 'setup-slither') {
    const python = option('--python', process.platform === 'win32' ? 'python' : 'python3');
    const tools = p.writableDirectory(root, '.flowboard/tools');
    const environment = path.join(tools, 'slither-venv');
    if (fs.existsSync(environment)) throw new Error('Slither environment already exists; not overwritten.');
    execFileSync(python, ['-m', 'venv', environment], { stdio: 'inherit' });
    const envPython = path.join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    execFileSync(envPython, ['-m', 'pip', 'install', 'slither-analyzer==0.11.6'], { stdio: 'inherit' });
    execFileSync(envPython, ['-m', 'pip', 'check'], { stdio: 'inherit' });
    console.log('Isolated Slither installed. Enable flowboardTriage.analysisMode = slither only for a trusted build.');
  } else if (command === 'import') {
    const extensionPath = option('--flowboard', process.env.FLOWBOARD_EXTENSION_PATH);
    if (!argv[0] || !extensionPath) throw new Error('Usage: import report.txt --root project --flowboard path/to/anchabadze.solidity-flowboard-1.2.0/extension (or use the editor command).');
    const metadata = p.readJson(path.join(extensionPath, 'package.json'));
    if (metadata.version !== '1.2.0' || metadata.name !== 'solidity-flowboard') throw new Error('Expected upstream Solidity Flowboard 1.2.0.');
    const bundle = await require('./extension/report').importReport(path.resolve(argv[0]), root, path.resolve(extensionPath));
    console.log(JSON.stringify({ issues: bundle.issues.length, drafts: bundle.issues.filter(x => x.request).length,
      unresolvedCitations: bundle.issues.reduce((n, x) => n + x.unresolved.length, 0), output: '.flowboard/report.json' }, null, 2));
  } else {
    console.log(`Flowboard Triage ${require('./package.json').version}\n\n  init --root project\n  import report.txt --root project --flowboard upstream-extension-directory\n  submit finding.json --root project\n  status --root project [--wait 30]\n  setup-slither --root project [--python python3]\n\nImport a whole report using "Flowboard Triage: Import Report", or open an existing import with "Flowboard Triage: Open Findings".`);
    if (command && command !== 'help') process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
