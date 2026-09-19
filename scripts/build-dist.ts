import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../packages/protocol/src/paths.ts';

// Builds what gets published. Node refuses to strip types under node_modules, so the package ships JavaScript in `dist`:
//   1. `tsc -p tsconfig.build.json` emits every server source under `dist`, mirroring the repository, with `.ts` specifiers rewritten to `.js`.
//   2. The workspace packages are not published on their own, so their `@agent-team/*` specifiers become relative paths inside `dist`.
//   3. What the code reads from disk next to itself is copied in: blueprints, the built web app and the hosting templates.
//   4. `bin` in package.json points at the built CLI for the tarball; `--restore` (postpack) points it back at the `.ts` a checkout runs.
const root = packageRoot(), dist = path.join(root, 'dist'), manifestFile = path.join(root, 'package.json');
const CHECKOUT_BIN = '"agent-team": "bin/agent-team.ts"', PACKED_BIN = '"agent-team": "dist/bin/agent-team.js"';
const swapBin = (from: string, to: string) => { const manifest = readFileSync(manifestFile, 'utf8'); if (manifest.includes(from)) writeFileSync(manifestFile, manifest.replace(from, to)); };

if (process.argv.includes('--restore')) { swapBin(PACKED_BIN, CHECKOUT_BIN); process.exit(0); }

const run = (args: string[]) => { const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status ?? 1); };
rmSync(dist, { recursive: true, force: true });
run([path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json']);

// Each workspace's `exports` says where its name points; the same map is applied to the built files.
const workspaces = new Map<string, { dir: string; exports: Record<string, string> }>();
for (const dir of ['packages/protocol', 'packages/coordinator', 'packages/worker', 'adapters/storage']) {
  const manifest = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8')) as { name: string; exports: Record<string, string> };
  workspaces.set(manifest.name, { dir, exports: manifest.exports });
}
const built = (file: string) => file.replace(/\.ts$/, '.js');
const resolve = (name: string, subpath: string | undefined): string => {
  const workspace = workspaces.get(name);
  if (!workspace) throw new Error(`${name} is not a workspace that is built into dist`);
  const target = subpath ? workspace.exports['./*']?.replace('*', subpath.slice(1)) : workspace.exports['.'];
  if (!target) throw new Error(`${name} does not export ${subpath ?? '.'}`);
  return path.join(dist, workspace.dir, built(target));
};
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => { const file = path.join(dir, name); return statSync(file).isDirectory() ? files(file) : [file]; });
let rewritten = 0;
for (const file of files(dist).filter(name => name.endsWith('.js'))) {
  const source = readFileSync(file, 'utf8');
  const next = source.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(@agent-team\/[a-z-]+)(\/[^'"]+)?\2/g, (_match, lead: string, quote: string, name: string, subpath: string | undefined) => {
    const relative = path.relative(path.dirname(file), resolve(name, subpath)).split(path.sep).join('/');
    return `${lead}${quote}${relative.startsWith('.') ? relative : `./${relative}`}${quote}`;
  });
  if (next !== source) { writeFileSync(file, next); rewritten++; }
}

cpSync(path.join(root, 'blueprints'), path.join(dist, 'blueprints'), { recursive: true });
const web = path.join(root, 'packages', 'web', 'dist');
if (!existsSync(path.join(web, 'index.html'))) { console.error('The web app is not built: run `npm run build:web` first (prepack does).'); process.exit(1); }
cpSync(web, path.join(dist, 'packages', 'web', 'dist'), { recursive: true });
const hosting = path.join(root, 'adapters', 'hosting');
for (const file of files(hosting).filter(name => !name.endsWith('.ts'))) cpSync(file, path.join(dist, 'adapters', 'hosting', path.relative(hosting, file)));

swapBin(CHECKOUT_BIN, PACKED_BIN);
console.log(`Built dist: ${files(dist).length} files, workspace imports rewritten in ${rewritten}`);
