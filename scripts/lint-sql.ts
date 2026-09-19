import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../packages/protocol/src/paths.ts';

// Queries are written once against the portable surface; dialect SQL is confined to the storage adapters.
const root = path.join(packageRoot(), 'packages');
const RAW = /import\s*\{[^}]*\bsql\b[^}]*\}\s*from\s*'kysely'|from\s*'node:sqlite'|from\s*'pg'/;

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (/\.tsx?$/.test(entry.name)) yield file;
  }
}

const problems = [...files(root)].filter(file => RAW.test(readFileSync(file, 'utf8'))).map(file => `${path.relative(packageRoot(), file)}: dialect SQL outside adapters/storage`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
