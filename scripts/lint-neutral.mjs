import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Provider and project names may only appear inside adapters, example configs and manifests.
// core/** and agents/** must stay neutral so a new provider is a new adapter, not a core edit.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = ['core', 'agents'];
const allow = new Set(['core/adapters.md']);
const terms = ['github', 'gitlab', 'linear', 'fly', 'tailscale', 'opencode', 'claude', 'cursor', 'codex', 'myntbase', 'manti', 'anthropic', 'bedrock', 'gh', 'glab'];
const pattern = new RegExp(`\\b(${terms.join('|')})\\b`, 'i');
// Generic English uses of otherwise-provider words.
const benign = [/\bcursor\b.*(pagination|page|position|pointer)/i, /(pagination|page|position|pointer).*\bcursor\b/i, /\bon the fly\b/i, /\bfly\.(mjs|toml)\b/i, /\blinear(ly)? (time|scan|search)\b/i];

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) yield* files(file);
    else if (/\.(mjs|md|json)$/.test(entry) && !entry.endsWith('.test.mjs')) yield file;
  }
}

const failures = [];
for (const dir of roots) {
  for (const file of files(path.join(root, dir))) {
    const relative = path.relative(root, file);
    if (allow.has(relative)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = pattern.exec(line);
      if (match && !benign.some(rule => rule.test(line))) failures.push(`${relative}:${index + 1}: ${match[1]}: ${line.trim().slice(0, 120)}`);
    });
  }
}
if (failures.length) {
  console.error(`Provider or project names found outside adapters:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`lint-neutral: ${roots.join(', ')} are provider-neutral`);
