import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { engineAdapter, ENGINES } from '../../../adapters/engine/index.ts';
import { PROVIDER_VARIABLES } from '../../../adapters/engine/providers.ts';
import { discovered, readiness } from './platform.ts';
import { resolveProjects } from './projects.ts';
import { createWorker, type WorkerConfig } from './worker.ts';

interface FileConfig { coordinatorUrl: string; workerId: string; stateDir: string; engine: string; lanes?: WorkerConfig['lanes']; projects: Record<string, string>; worktrees?: WorkerConfig['worktrees']; isolation?: 'strict' | 'isolated'; publish?: { scm: string; repository: string; base: string }; /* Also serve the projects that have no repository, each in a scratch folder. */ desks?: boolean }

const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1]) { console.error('Usage: node packages/worker/src/main.ts --config FILE [--once [--job LABEL]]'); process.exit(1); }
const file = JSON.parse(readFileSync(process.argv[index + 1]!, 'utf8')) as FileConfig;
const token = process.env.AGENT_TEAM_TOKEN;
if (!token) { console.error('AGENT_TEAM_TOKEN is required'); process.exit(1); }

const named = await resolveProjects(file.projects, { coordinatorUrl: file.coordinatorUrl, token });
for (const name of named.unknown) console.error(`The coordinator has no project called "${name}"; this worker will not serve it.`);
if (Object.keys(named.projects).length === 0 && !file.desks) { console.error('None of the projects this worker names exist on the coordinator.'); process.exit(1); }

// A launched host is gone after its turn, so its config names where the branch is pushed when a work turn completes.
const exec: NonNullable<WorkerConfig['publish']>['exec'] = (bin, args, { cwd }) => new Promise((resolve, reject) => execFile(bin, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr).trim().slice(-400) || error.message)) : resolve(stdout)));
// What the tools on this machine say they offer (models, effort levels) is asked once, here, and reported with every claim.
const adapters = Object.fromEntries(ENGINES.map(name => [name, engineAdapter(name)]));
const ready = await discovered(adapters, readiness(adapters, PROVIDER_VARIABLES, { defaultEngine: file.engine }));
const worker = createWorker({
  coordinatorUrl: file.coordinatorUrl, token, workerId: file.workerId, stateDir: file.stateDir, engine: engineAdapter(file.engine),
  engines: Object.fromEntries(ENGINES.map(name => [name, engineAdapter(name)])),
  ready,
  // Reviews, replies and triage read and answer; several of them run side by side. Writers are held to the project's own limit by the coordinator.
  lanes: file.lanes ?? { work: 2, bounded: 4, deliver: 1 }, projects: named.projects, ...(file.desks ? { desks: true } : {}),
  ...(file.publish ? { publish: { ...file.publish, exec } } : {}), ...(file.isolation ? { isolation: file.isolation } : {}),
  // A worker that publishes starts every task from the base branch as the code host has it. Starting from the local checkout's HEAD put
  // whatever was committed there and not pushed into every change the team opened, where it collided with the base.
  worktrees: file.worktrees === undefined ? { branchPrefix: 'agents/', base: file.publish ? `origin/${file.publish.base}` : 'HEAD' } : file.worktrees,
  // `--once` is how a launched, disposable host runs: the worker then holds itself to the rule for such hosts.
  ephemeral: process.argv.includes('--once'),
});
console.log(`Worker ${file.workerId} serving ${Object.keys(named.projects).length} project(s)${file.desks ? ' and every project without a repository' : ''} with ${file.engine}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { worker.stop(); void worker.idle().then(() => process.exit(0)); });
// A launched, disposable host runs what it was started for and exits: it waits for one claim, finishes it and stops.
if (process.argv.includes('--once')) {
  const label = process.argv[process.argv.indexOf('--job') + 1] ?? 'one turn', deadline = Date.now() + 10 * 60_000;
  let claimed = false;
  // A disposable host serves a project only when its committed manifest authorizes publishing and the branch can be pushed.
  const refusals = Object.values(await worker.refusals());
  for (const reason of refusals) console.error(reason);
  if (refusals.length > 0 && refusals.length === Object.keys(file.projects).length) process.exit(3);
  await worker.sweep().catch(() => []);
  while (!claimed && Date.now() < deadline) { claimed = await worker.tick(); if (!claimed) await new Promise(resolve => setTimeout(resolve, 5000)); }
  await worker.idle();
  console.log(claimed ? `Worker ${file.workerId} finished ${label}` : `Worker ${file.workerId} found nothing to claim for ${label}`);
  process.exitCode = claimed ? 0 : 2;
} else await worker.loop();
