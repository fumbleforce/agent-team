import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_ENGINE, ENGINES, engineAdapter } from '../adapters/engine/index.mjs';
import { DEFAULT_SCM, SCM_KINDS, scmAdapter } from '../adapters/scm/index.mjs';
import { DEFAULT_TRACKER, TRACKER_KINDS, trackerAdapter, trackerCredentialPresent } from '../adapters/tracker/index.mjs';
import { builtinEnvironments } from './environments.mjs';
import { normalizeManifest } from './manifest.mjs';
import { secretPlan } from './deployment.mjs';
import { defaultRun } from './preflight.mjs';

// The guided setup behind `agent-team up`: questions instead of flags and exported variables.
// It drafts a manifest for a checkout that has none (which tools, which engine, what the worker
// offers), and collects every credential the adapters need once, keeping them in a private file
// under the owner's configuration directory so later runs ask nothing.
export const IGNORES = ['.agent-team/', '.agent-team-result.json'];

// A numbered choice on top of a plain question prompt; the answer is a number, a value or a label.
export function chooser(ask) {
  return async function choose(question, options, { fallback } = {}) {
    const lines = options.map((option, index) => `  ${index + 1}. ${option.label}${option.hint ? `  (${option.hint})` : ''}`);
    const fallbackIndex = options.findIndex(option => option.value === fallback);
    for (;;) {
      const answer = String(await ask(`${question}\n${lines.join('\n')}\nChoose`, { fallback: fallbackIndex >= 0 ? String(fallbackIndex + 1) : null })).trim();
      const byNumber = /^\d+$/.test(answer) ? options[Number(answer) - 1] : null;
      const found = byNumber ?? options.find(option => option.value === answer || option.label.toLowerCase() === answer.toLowerCase());
      if (found) return found.value;
    }
  };
}

// The private credential file for one project: owner-only, outside every repository, one
// NAME=value per line. Values never contain line breaks, so the file parses without quoting.
export function secretsFile(projectId, configDir) { return path.join(configDir, 'secrets', `${projectId}.env`); }
export function readSecrets(projectId, configDir) {
  const file = secretsFile(projectId, configDir);
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) { const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line); if (match) values[match[1]] = match[2]; }
  return values;
}
export function writeSecrets(projectId, values, configDir) {
  for (const [name, value] of Object.entries(values)) if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n]/.test(String(value))) throw new Error(`Cannot store ${name}`);
  const file = secretsFile(projectId, configDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return file;
}

// What the checkout already says about itself: the origin remote names the host and repository,
// and the remote's default branch is the base the team should build on.
export function detectRepository(checkout, run = defaultRun) {
  const result = run('git', ['-C', checkout, 'remote', 'get-url', 'origin']);
  if (!result.ok) return null;
  const match = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?|[^@/]+@)?([^/:]+)[/:]([^\s]+?)(?:\.git)?\/?$/.exec(result.stdout.trim());
  if (!match) return null;
  const [, host, repository] = match;
  const kind = SCM_KINDS.find(candidate => new URL(scmAdapter(candidate).HOST).hostname === host) ?? null;
  return { host, repository, kind };
}
export function defaultBranch(checkout, run = defaultRun) {
  const remote = run('git', ['-C', checkout, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.ok && remote.stdout.trim()) return remote.stdout.trim().replace(/^origin\//, '');
  const current = run('git', ['-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return current.ok && current.stdout.trim() && current.stdout.trim() !== 'HEAD' ? current.stdout.trim() : 'main';
}
export function installedEngines(run = defaultRun) { return ENGINES.filter(name => run(engineAdapter(name).BIN, ['--version']).ok); }
export function projectIdFor(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'; }

// Drafts a version 2 manifest from questions. Adapters answer for their own sections (the
// tracker's scope, the engine's billing modes); the result is validated before it is returned.
// `secrets` carries any credential typed along the way (a tracker key used to list scopes).
export async function draftManifest({ checkout, ask, choose = chooser(ask), run = defaultRun, target = 'local', env = process.env, log = () => {} }) {
  const name = await ask('Project name', { fallback: path.basename(checkout) });
  const detected = detectRepository(checkout, run);
  const scmKind = await choose('Where does the code live?', SCM_KINDS.map(kind => ({ value: kind, label: scmAdapter(kind).NAME, hint: scmAdapter(kind).HOST })), { fallback: detected?.kind ?? DEFAULT_SCM });
  const scm = scmAdapter(scmKind);
  let repository;
  for (;;) {
    repository = String(await ask(`${scm.NAME} repository (owner/name)`, { fallback: detected?.kind === scmKind ? detected.repository : null })).trim();
    if (scm.validateRepository(repository)) break;
    log(`${repository || '(empty)'} is not a ${scm.NAME} repository path`);
  }
  const baseBranch = await ask('Base branch the team builds on', { fallback: defaultBranch(checkout, run) });
  const shares = kind => trackerAdapter(kind).SHARES_TOKEN_WITH === scmKind;
  const trackerKind = await choose('Where is the backlog?', TRACKER_KINDS.map(kind => ({ value: kind, label: trackerAdapter(kind).NAME, hint: shares(kind) ? 'the repository\'s own issues, same token' : `needs ${trackerAdapter(kind).API_KEY_VARIABLE}` })), { fallback: TRACKER_KINDS.find(shares) ?? DEFAULT_TRACKER });
  const tracker = await trackerAdapter(trackerKind).setup({ ask, choose, log, scm: { kind: scmKind, repository }, env });
  const installed = installedEngines(run);
  const engineName = await choose('Which engine runs the team?', ENGINES.map(engine => ({ value: engine, label: engineAdapter(engine).NAME, hint: installed.includes(engine) ? 'installed here' : `not found on PATH as ${engineAdapter(engine).BIN}` })), { fallback: installed[0] ?? DEFAULT_ENGINE });
  const engine = engineAdapter(engineName);
  const billing = engine.BILLING_MODES.length > 1
    ? await choose(`How is ${engine.NAME} billed?`, engine.BILLING_MODES.map(mode => ({ value: mode, label: mode, hint: engine.BILLING_DESCRIPTIONS?.[mode] })), { fallback: engine.DEFAULT_BILLING })
    : engine.DEFAULT_BILLING;
  const environment = await choose('What should the worker machine offer besides the repository?', builtinEnvironments().map(item => ({ value: item.id, label: item.name, hint: item.description })), { fallback: 'standard' });
  const instructions = ['AGENTS.md'].filter(file => existsSync(path.join(checkout, file)));
  const charter = ['docs/PRODUCT_CHARTER.md', 'docs/CHARTER.md', 'docs/PLATFORM.md'].find(file => existsSync(path.join(checkout, file)));
  const manifest = { version: 2, name, queueProjectId: projectIdFor(name), ...(charter ? { charter } : {}), instructions,
    scm: { kind: scmKind, repository, baseBranch, branchPrefix: 'agents/' }, tracker: { kind: trackerKind, ...tracker.tracker },
    engine: { default: engineName, billing }, worker: { launcher: target === 'aws' ? 'ec2' : 'local', environment },
    pm: { autonomy: 'suggest', dailyCapUsd: 10 }, ...(tracker.ideation ? { ideation: tracker.ideation } : {}) };
  normalizeManifest(manifest);
  return { manifest, secrets: tracker.secrets ?? {} };
}

export function writeManifest(checkout, manifest) {
  const file = path.join(checkout, '.agent-team.json');
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}
// The repository must ignore the runner's state and report; missing lines are appended.
export function ensureIgnores(checkout) {
  const file = path.join(checkout, '.gitignore');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = existing.split('\n').map(line => line.trim());
  const missing = IGNORES.filter(entry => !lines.includes(entry));
  if (missing.length) writeFileSync(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  return missing;
}

// Every credential the manifest's adapters need, from the environment, the private file or a
// hidden prompt, in that order. New answers are stored when `store` is set (the local target;
// the cloud target keeps them in its own secret store). `replace` asks for everything again.
export async function collectSecrets({ manifest, projectId, configDir, env = process.env, ask, log = () => {}, store = true, replace = false, preset = {} }) {
  const stored = replace ? {} : readSecrets(projectId, configDir);
  const merged = { ...env };
  const values = {};
  const file = secretsFile(projectId, configDir);
  const plan = secretPlan(manifest).filter(secret => !secret.generated).sort((a, b) => Number(Boolean(a.optional)) - Number(Boolean(b.optional)));
  for (const secret of plan) {
    if (preset[secret.name]) { values[secret.name] = preset[secret.name]; merged[secret.name] = preset[secret.name]; continue; }
    if (!replace && env[secret.name]) { log(`${secret.purpose}: using ${secret.name} from the environment`); continue; }
    if (stored[secret.name]) { merged[secret.name] = stored[secret.name]; log(`${secret.purpose}: stored in ${file}`); continue; }
    // A tracker that shares the SCM token needs nothing more once that token is in hand.
    if (secret.optional && secret.adapter === manifest.tracker.kind && trackerCredentialPresent(manifest.tracker.kind, merged)) continue;
    const value = String((await ask(`Paste the ${secret.purpose}${secret.optional ? ' (empty to skip; the engine may log in itself)' : ''}`, { secret: true })) ?? '').trim();
    if (!value) { if (secret.optional) continue; throw new Error(`${secret.purpose} is required`); }
    values[secret.name] = value; merged[secret.name] = value;
  }
  let written = null;
  if (store && Object.keys(values).length) { written = writeSecrets(projectId, { ...stored, ...values }, configDir); log(`Credentials stored for this machine only, readable by your user alone: ${written}`); }
  return { env: merged, values, file: written ?? (Object.keys(stored).length ? file : null) };
}
