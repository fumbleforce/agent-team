import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs node --check on every module under core/, adapters/ and scripts/.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) yield* files(file);
    else if (entry.endsWith('.mjs')) yield file;
  }
}
let failed = false;
for (const dir of ['core', 'adapters', 'scripts', 'bin']) {
  for (const file of files(path.join(root, dir))) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { failed = true; console.error(result.stderr); }
  }
}
if (failed) process.exit(1);
console.log('check-syntax: all modules parse');
