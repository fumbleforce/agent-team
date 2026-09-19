import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { engineAdapter, ENGINES } from '../../../adapters/engine/index.ts';
import { PROVIDER_VARIABLES } from '../../../adapters/engine/providers.ts';
import { readiness } from './platform.ts';
import { createWorker, type WorkerConfig } from './worker.ts';

interface FileConfig { coordinatorUrl: string; workerId: string; stateDir: string; engine: string; lanes?: WorkerConfig['lanes']; projects: Record<string, string>; worktrees?: WorkerConfig['worktrees']; isolation?: 'strict' | 'isolated'; publish?: { scm: string; repository: string; base: string } }

const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1]) { console.error('Usage: node packages/worker/src/main.ts --config FILE [--once [--job LABEL]]'); process.exit(1); }
const file = JSON.parse(readFileSync(process.argv[index + 1]!, 'utf8')) as FileConfig;
const token = process.env.AGENT_TEAM_TOKEN;
if (!token) { console.error('AGENT_TEAM_TOKEN is required'); process.exit(1); }

// A launched host is gone after its turn, so its config names where the branch is pushed when a work turn completes.
const exec: NonNullable<WorkerConfig['publish']>['exec'] = (bin, args, { cwd }) => new Promise((resolve, reject) => execFile(bin, args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr).trim().slice(-400) || error.message)) : resolve(stdout)));
const worker = createWorker({
  coordinatorUrl: file.coordinatorUrl, token, workerId: file.workerId, stateDir: file.stateDir, engine: engineAdapter(file.engine),
  engines: Object.fromEntries(ENGINES.map(name => [name, engineAdapter(name)])),
  ready: readiness(Object.fromEntries(ENGINES.map(name => [name, engineAdapter(name)])), PROVIDER_VARIABLES),
  lanes: file.lanes ?? { work: 1, bounded: 1, deliver: 1 }, projects: file.projects,
  ...(file.publish ? { publish: { ...file.publish, exec } } : {}), ...(file.isolation ? { isolation: file.isolation } : {}),
  worktrees: file.worktrees === undefined ? { branchPrefix: 'agents/', base: 'HEAD' } : file.worktrees,
});
console.log(`Worker ${file.workerId} serving ${Object.keys(file.projects).length} project(s) with ${file.engine}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { worker.stop(); void worker.idle().then(() => process.exit(0)); });
// A launched, disposable host runs what it was started for and exits: it waits for one claim, finishes it and stops.
if (process.argv.includes('--once')) {
  const label = process.argv[process.argv.indexOf('--job') + 1] ?? 'one turn', deadline = Date.now() + 10 * 60_000;
  let claimed = false;
  await worker.sweep().catch(() => []);
  while (!claimed && Date.now() < deadline) { claimed = await worker.tick(); if (!claimed) await new Promise(resolve => setTimeout(resolve, 5000)); }
  await worker.idle();
  console.log(claimed ? `Worker ${file.workerId} finished ${label}` : `Worker ${file.workerId} found nothing to claim for ${label}`);
  process.exitCode = claimed ? 0 : 2;
} else await worker.loop();
