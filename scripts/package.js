#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { publicFiles } = require('./release-files');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const upstreamName = 'anchabadze.solidity-flowboard-1.2.0.vsix';
const upstreamHash = 'de98a6cfe43cd441ab1e06d818c5a082ebba79c7224ece2176506f7162a19c13';
async function main() {
  const files = publicFiles(root);
  if (require('../extension/package.json').version !== version || !fs.readFileSync(path.join(root, 'extension.vsixmanifest'), 'utf8').includes(`Version="${version}" Publisher=`)) throw new Error('Release version mismatch.');
  const dist = path.join(root, 'dist');
  const vendor = path.join(root, 'vendor');
  fs.mkdirSync(dist, { recursive: true }); fs.mkdirSync(vendor, { recursive: true });
  const upstream = path.join(vendor, upstreamName);
  if (!fs.existsSync(upstream)) {
    const response = await fetch(`https://open-vsx.org/api/anchabadze/solidity-flowboard/1.2.0/file/${upstreamName}`);
    if (!response.ok) throw new Error(`Upstream download: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== upstreamHash) throw new Error('Upstream archive hash mismatch.');
    fs.writeFileSync(upstream, bytes, { flag: 'wx' });
  }
  if (crypto.createHash('sha256').update(fs.readFileSync(upstream)).digest('hex') !== upstreamHash) throw new Error('Upstream archive hash mismatch.');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-package-'));
  try {
    const vsixStage = path.join(staging, 'vsix'); fs.mkdirSync(vsixStage);
    fs.cpSync(path.join(root, 'extension'), path.join(vsixStage, 'extension'), { recursive: true });
    for (const name of ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, name), path.join(vsixStage, 'extension', name));
    for (const name of ['extension.vsixmanifest', '[Content_Types].xml']) fs.copyFileSync(path.join(root, name), path.join(vsixStage, name));
    const vsix = path.join(dist, `flowboard-triage-${version}.vsix`);
    const stagedVsix = path.join(staging, path.basename(vsix));
    execFileSync('zip', ['-q', '-r', stagedVsix, 'extension', 'extension.vsixmanifest', '[Content_Types].xml'], { cwd: vsixStage });
    fs.renameSync(stagedVsix, vsix);
    const bundle = path.join(staging, `flowboard-triage-${version}`); fs.mkdirSync(bundle);
    for (const file of files) {
      const destination = path.join(bundle, file.relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file.absolute, destination);
    }
    const sourceZip = path.join(dist, `flowboard-triage-${version}-source.zip`);
    const stagedSourceZip = path.join(staging, path.basename(sourceZip));
    execFileSync('zip', ['-q', '-r', stagedSourceZip, path.basename(bundle)], { cwd: staging });
    fs.renameSync(stagedSourceZip, sourceZip);
    const install = path.join(bundle, 'install'); fs.mkdirSync(install);
    fs.copyFileSync(vsix, path.join(install, path.basename(vsix)));
    fs.copyFileSync(upstream, path.join(install, upstreamName));
    const zip = path.join(dist, `flowboard-triage-${version}.zip`);
    const stagedZip = path.join(staging, path.basename(zip));
    execFileSync('zip', ['-q', '-r', stagedZip, path.basename(bundle)], { cwd: staging });
    fs.renameSync(stagedZip, zip);
    const hashes = [vsix, zip, sourceZip].map(file => `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`).join('\n') + '\n';
    fs.writeFileSync(path.join(dist, 'SHA256SUMS'), hashes);
    console.log(`Created ${vsix}\nCreated ${zip}\nCreated ${sourceZip}`);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
