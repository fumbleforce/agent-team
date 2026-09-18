import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ENGINES, engineAdapter } from '../adapters/engine/index.mjs';
import { spawnCommandSync } from './platform.mjs';
import { scmAdapter } from '../adapters/scm/index.mjs';
import { trackerAdapter, trackerCredentialPresent } from '../adapters/tracker/index.mjs';
import { integrationAdapter } from '../adapters/integration/index.mjs';

// Everything `agent-team up` needs, checked before anything is created, so the owner sees one
// list of what is missing instead of one failure at a time. Each check is { name, ok, detail,
// fix, required }; `required: false` checks only inform (a missing browser package, say).
export const MIN_NODE = [22, 21, 1];

function version(text) { const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '')); return match ? match.slice(1, 4).map(Number) : null; }
function atLeast(actual, wanted) { for (let i = 0; i < wanted.length; i++) { if ((actual[i] ?? 0) > wanted[i]) return true; if ((actual[i] ?? 0) < wanted[i]) return false; } return true; }

export function preflight({ checkout, manifest, target = 'local', env = process.env, run = defaultRun, nodeVersion = process.version }) {
  const checks = [];
  const add = (name, ok, detail, fix, required = true) => checks.push({ name, ok: Boolean(ok), detail, fix, required });
  const node = version(nodeVersion);
  add('Node.js', node && atLeast(node, MIN_NODE), nodeVersion, `Install Node ${MIN_NODE.join('.')} or newer`);
  add('Git', run('git', ['--version']).ok, 'git on PATH', 'Install Git');
  add('Manifest', Boolean(manifest), manifest ? `${manifest.name} (${manifest.scm.kind}, ${manifest.tracker.kind}, ${manifest.engine.default})` : 'no .agent-team.json', `Add .agent-team.json to ${checkout}; see project.v2.example.json`);
  if (!manifest) return checks;
  const ignore = existsSync(path.join(checkout, '.gitignore')) ? readFileSync(path.join(checkout, '.gitignore'), 'utf8').split('\n').map(line => line.trim()) : [];
  add('.gitignore', ['.agent-team/', '.agent-team-result.json'].every(entry => ignore.includes(entry)), 'ignores .agent-team/ and .agent-team-result.json', 'Add .agent-team/ and .agent-team-result.json to .gitignore');
  const engine = engineAdapter(manifest.engine.default);
  const engineVersion = run(engine.BIN, ['--version']);
  // Another installed engine is a way forward on this machine: `up --engine` selects it.
  const installed = engineVersion.ok || target !== 'local' ? [] : ENGINES.filter(name => name !== manifest.engine.default && run(engineAdapter(name).BIN, ['--version']).ok);
  add(`Engine ${engine.NAME}`, engineVersion.ok, engineVersion.ok ? engineVersion.stdout.trim().slice(0, 60) : `${engine.BIN} is not on PATH`,
    `Install the ${engine.NAME} CLI on the worker host${installed.length ? `, or rerun with --engine ${installed.join(' or --engine ')} (installed here)` : ''}`, target === 'local');
  // The adapter's own preflight decides what its billing mode needs (a login, a key, a region).
  if (engineVersion.ok) {
    let problem = null;
    try { engine.preflight({ command: (bin, args) => { const result = run(bin, args); if (!result.ok) throw new Error(`${bin} failed`); return result.stdout.trim(); }, cwd: checkout, env, billing: manifest.engine.billing }); } catch (error) { problem = error.message; }
    add('Engine access', !problem, problem ?? `${manifest.engine.billing} billing ready`, problem ?? '', target === 'local');
  }
  const scm = scmAdapter(manifest.scm.kind);
  add(`${scm.NAME} token`, Boolean(env[scm.TOKEN_VARIABLE]), scm.TOKEN_VARIABLE, `Export ${scm.TOKEN_VARIABLE}: a token able to push branches and open ${scm.CHANGE_NOUN}s on ${manifest.scm.repository ?? 'the repository'}`);
  add(`${scm.NAME} CLI`, run(scm.CLI, ['--version']).ok, scm.CLI, `Install ${scm.CLI} on the worker host`, target === 'local');
  const tracker = trackerAdapter(manifest.tracker.kind);
  add(`${tracker.NAME} tracker credential`, trackerCredentialPresent(manifest.tracker.kind, env), tracker.API_KEY_VARIABLE, tracker.CREDENTIAL_HINT ?? `Export ${tracker.API_KEY_VARIABLE}`);
  for (const integration of manifest.integrations ?? []) {
    const adapter = integrationAdapter(integration.kind);
    add(`${adapter.TITLE} (${integration.name})`, adapter.credential(env, integration) !== null, adapter.CREDENTIAL_VARIABLES[0] ?? adapter.credentialVariable(integration.name), 'Export the token, or leave it for the engine to log in itself', false);
  }
  if (target === 'aws') {
    add('AWS CLI', run('aws', ['--version']).ok, 'aws on PATH', 'Install the AWS CLI v2');
    add('AWS credentials', run('aws', ['sts', 'get-caller-identity']).ok, 'sts get-caller-identity', 'Run `aws login` or `aws sso login`');
    add('Session Manager plugin', run('session-manager-plugin', ['--version']).ok, 'for the dashboard tunnel', 'Install the Session Manager plugin for the AWS CLI');
  }
  if (target === 'local' && (manifest.worker.environment ?? 'standard') !== 'standard') add('Browser tooling', run('npx', ['--no-install', 'playwright', '--version']).ok, `environment ${manifest.worker.environment}`, 'Run `npx -y playwright@latest install --with-deps chromium` on this machine', false);
  return checks;
}

export function defaultRun(bin, args) {
  const result = spawnCommandSync(bin, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function renderChecks(checks) {
  return checks.map(check => `${check.ok ? 'ok  ' : check.required ? 'MISSING' : 'skip'}  ${check.name}: ${check.detail}${check.ok ? '' : `\n         ${check.fix}`}`).join('\n');
}
export const blocking = checks => checks.filter(check => !check.ok && check.required);
