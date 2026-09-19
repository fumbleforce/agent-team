import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../packages/protocol/src/paths.ts';

const read = (file: string) => readFileSync(path.join(packageRoot(), file), 'utf8');
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
// Follows `npm run x` so the assertion is about what runs, not how the scripts are split.
const expand = (name: string): string => (scripts[name] ?? '').replace(/npm run ([\w:-]+)(?! -w)/g, (_match, inner: string) => expand(inner));

test('npm run check runs the type check, Biome and the three lints', () => {
  const check = expand('check');
  for (const step of ['tsc --noEmit', 'biome lint', 'scripts/lint-neutral.ts', 'scripts/lint-ui.ts', 'scripts/lint-sql.ts']) assert.ok(check.includes(step), `check is missing ${step}`);
});

test('both pipelines install from the lockfile and run every verification step, in the same order', () => {
  const steps = ['npm ci', 'npm run check', 'npm test', 'npm run test:postgres', 'npm run test:sim', 'npm run build:web', 'npx playwright install --with-deps chromium', 'npm run test:e2e', 'npm run test:pack'];
  for (const file of ['.github/workflows/verify.yml', '.gitlab-ci.yml']) {
    const text = read(file);
    const found = steps.map(step => text.search(new RegExp(`(^|[\\s:])${step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm')));
    assert.ok(found.every(index => index >= 0), `${file} is missing ${steps.filter((_step, index) => found[index]! < 0).join(', ')}`);
    assert.deepEqual(found, [...found].sort((a, b) => a - b), `${file} runs the steps out of order`);
    assert.match(text, /AGENT_TEAM_TEST_STORAGE[:=]\s*postgres/, `${file} runs the Postgres pass against Postgres`);
    assert.match(text, /node-version: 24|node:24-slim/, `${file} is on Node 24`);
    for (const step of ['test:postgres', 'test:sim', 'test:e2e', 'test:pack', 'build:web']) assert.ok(scripts[step], `package.json has no ${step} script`);
  }
  assert.match(read('.github/workflows/verify.yml'), /^ {2}verify:$/m, 'the required check keeps the name verify');
  assert.match(read('.gitlab-ci.yml'), /^verify:$/m);
});

test('the package publishes built JavaScript and a checkout keeps running its sources', () => {
  const manifest = JSON.parse(read('package.json')) as { bin: Record<string, string>; files: string[]; scripts: Record<string, string>; dependencies: Record<string, string> };
  assert.deepEqual([manifest.bin['agent-team'], manifest.files], ['bin/agent-team.ts', ['dist']]);
  assert.match(manifest.scripts.prepack!, /build:web.*build-dist\.ts/);
  assert.match(manifest.scripts.postpack!, /build-dist\.ts --restore/);
  assert.ok(!/test:pack/.test(manifest.scripts.test!), 'the pack test stays out of npm test');
  const build = JSON.parse(read('tsconfig.build.json')) as { compilerOptions: Record<string, unknown> };
  assert.deepEqual([build.compilerOptions.noEmit, build.compilerOptions.outDir, build.compilerOptions.rewriteRelativeImportExtensions], [false, 'dist', true]);
  // What a workspace needs at run time has to be a dependency of the package that is published.
  for (const dir of ['packages/protocol', 'packages/coordinator', 'packages/worker', 'adapters/storage']) {
    const workspace = JSON.parse(read(`${dir}/package.json`)) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(workspace.dependencies ?? {})) assert.ok(manifest.dependencies[name] || name === 'jose', `${name} (${dir}) is not a dependency of the published package`);
  }
});
