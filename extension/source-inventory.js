'use strict';
// Match the native source discovery scope, including explicitly remapped npm
// dependencies. Real paths and containment prevent aliases escaping the project.
const fs = require('node:fs'), path = require('node:path');
const { contained } = require('./protocol');
const skipped = new Set(['node_modules', '.git', '.flowboard', 'out', 'artifacts', 'cache', 'coverage', 'typechain', 'typechain-types']);
function membership(root) {
  root = fs.realpathSync(root);
  const found = new Set(), visited = new Set();
  const walk = (directory, remapped = false) => {
    let real; try { real = fs.realpathSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!contained(root, real) || visited.has(real)) return; visited.add(real);
    for (const item of fs.readdirSync(real, { withFileTypes: true })) {
      if (item.name.startsWith('.') || (remapped ? item.name === 'node_modules' : skipped.has(item.name))) continue;
      const file = path.join(real, item.name), stat = item.isSymbolicLink() && remapped ? fs.statSync(file) : item;
      if (stat.isDirectory()) walk(file, remapped);
      else if (stat.isFile() && item.name.endsWith('.sol')) {
        const resolved = fs.realpathSync(file);
        if (contained(root, resolved)) found.add(path.relative(root, resolved).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  const lines = [];
  for (const name of ['remappings.txt', 'foundry.toml']) {
    let text; try { text = fs.readFileSync(path.join(root, name), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (name.endsWith('.txt')) lines.push(...text.split(/\r?\n/));
    else for (const block of text.matchAll(/\bremappings\s*=\s*\[([\s\S]*?)\]/g)) lines.push(...[...block[1].matchAll(/["']([^"']+)["']/g)].map(item => item[1]));
  }
  for (const line of lines) {
    const match = line.trim().match(/^[^=]+=(\S+)\s*$/);
    if (match) walk(path.resolve(root, match[1]), true);
  }
  return [...found].sort();
}
module.exports = { membership };
