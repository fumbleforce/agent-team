import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../packages/protocol/src/paths.ts';

// Keeps styling token-driven: values live in tokens.css, typography and colour live in ui/, screens only lay out.
const root = path.join(packageRoot(), 'packages', 'web', 'src');
const RULES: { name: string; applies(file: string): boolean; pattern: RegExp }[] = [
  { name: 'arbitrary Tailwind value', applies: () => true, pattern: /(?<![\w-])[a-z][\w-]*-\[[^\]\s]+\]/ },
  { name: 'hex colour outside tokens.css', applies: file => !file.endsWith('tokens.css'), pattern: /#[0-9a-fA-F]{3,8}\b(?![\w-])/ },
  { name: 'inline style outside ui/', applies: file => !file.includes('/ui/'), pattern: /\bstyle=\{/ },
  { name: 'typography, colour or radius class in features/', applies: file => file.includes('/features/'), pattern: /className=[^>]*?(?<![\w-])(text-(?!left|right|center)|font-|bg-|border-(?!0|2|4|8|[trblxy]\b)|rounded)/ },
];

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (/\.(tsx?|css)$/.test(entry.name)) yield file;
  }
}

const problems: string[] = [];
for (const file of files(root)) {
  const relative = path.relative(packageRoot(), file).split(path.sep).join('/');
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    for (const rule of RULES) if (rule.applies(relative) && rule.pattern.test(line)) problems.push(`${relative}:${index + 1}: ${rule.name}`);
  });
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
