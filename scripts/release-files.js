'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Public tool sources only. Never package the parent Solidity workspace or its
// Git history. Older local translations/handoffs are intentionally not included.
const entries = ['extension', 'skills', 'integrations', 'examples', 'docs', 'tests', 'scripts', '.github', '.gitignore',
  'cli.js', 'package.json', 'README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'extension.vsixmanifest', '[Content_Types].xml'];
function publicFiles(root, names = entries) {
  const files = [];
  function visit(relative) {
    const parts = relative.split('/');
    if (parts.at(-1) === '__pycache__') return;
    if (parts.some(part => /^(?:\.git|\.flowboard|node_modules|dist|vendor|\.env(?:\..*)?)$/.test(part)) || /\.(?:pem|key|vsix|zip)$/i.test(relative)) throw new Error(`Non-public release path: ${relative}`);
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Release symlink refused: ${relative}`);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`); return; }
    if (!stat.isFile()) throw new Error(`Release entry is not a regular file: ${relative}`);
    const text = fs.readFileSync(absolute, 'utf8');
    if (/[\u0400-\u04ff]/u.test(text)) throw new Error(`Public release must use English: ${relative}`);
    // Conservative tripwires, not a substitute for a human disclosure review.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}/.test(text)) throw new Error(`Possible credential in release file: ${relative}`);
    files.push({ relative, absolute });
  }
  for (const name of names) visit(name);
  return files;
}
module.exports = { entries, publicFiles };
