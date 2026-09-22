import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Provider and project names may only appear inside adapters. packages/** and blueprints/** stay neutral,
// so a new provider is a new adapter and not an edit to the platform.
const root = path.dirname(import.meta.dirname);
const roots = ['packages', 'blueprints'];
const terms = ['github', 'gitlab', 'linear', 'fly', 'tailscale', 'opencode', 'claude', 'codex', 'myntbase', 'manti', 'hubro', 'stockapp', 'anthropic', 'bedrock', 'gh', 'glab', 'supabase', 'typesafe', 'jev'];
const pattern = new RegExp(`\\b(${terms.join('|')})\\b`, 'i');
// Generic English uses of otherwise-provider words, and imports of the adapters themselves.
const benign = [/\bon the fly\b/i, /\blinear(ly)? (time|scan|search)\b/i, /adapters\//];
const skip = /(^|[\\/])(node_modules|dist|demo|dev)([\\/]|$)|\.test\.tsx?$/;

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (skip.test(file)) continue;
    if (statSync(file).isDirectory()) yield* files(file);
    else if (/\.(tsx?|md|json|css)$/.test(entry) && entry !== 'package.json') yield file;
  }
}

const failures: string[] = [];
for (const dir of roots) {
  for (const file of files(path.join(root, dir))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const match = pattern.exec(line);
      if (match && !benign.some(rule => rule.test(line))) failures.push(`${path.relative(root, file).replaceAll('\\', '/')}:${index + 1}: ${match[1]}: ${line.trim().slice(0, 120)}`);
    });
  }
}
if (failures.length) {
  console.error(`Provider or project names found outside adapters:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`lint-neutral: ${roots.join(', ')} are provider-neutral`);
