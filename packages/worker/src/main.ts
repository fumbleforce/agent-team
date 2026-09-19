import { readFileSync } from 'node:fs';
import { engineAdapter, ENGINES } from '../../../adapters/engine/index.ts';
import { createWorker, type WorkerConfig } from './worker.ts';

interface FileConfig { coordinatorUrl: string; workerId: string; stateDir: string; engine: string; lanes?: WorkerConfig['lanes']; projects: Record<string, string>; worktrees?: WorkerConfig['worktrees'] }

const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1]) { console.error('Usage: node packages/worker/src/main.ts --config FILE [--once [--job LABEL]]'); process.exit(1); }
const file = JSON.parse(readFileSync(process.argv[index + 1]!, 'utf8')) as FileConfig;
const token = process.env.AGENT_TEAM_TOKEN;
if (!token) { console.error('AGENT_TEAM_TOKEN is required'); process.exit(1); }

const worker = createWorker({
  coordinatorUrl: file.coordinatorUrl, token, workerId: file.workerId, stateDir: file.stateDir, engine: engineAdapter(file.engine),
  engines: Object.fromEntries(ENGINES.map(name => [name, engineAdapter(name)])),
  lanes: file.lanes ?? { work: 1, bounded: 1, deliver: 1 }, projects: file.projects,
  worktrees: file.worktrees === undefined ? { branchPrefix: 'agents/', base: 'HEAD' } : file.worktrees,
});
console.log(`Worker ${file.workerId} serving ${Object.keys(file.projects).length} project(s) with ${file.engine}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { worker.stop(); void worker.idle().then(() => process.exit(0)); });
// A launched, disposable host runs what it was started for and exits: it waits for one claim, finishes it and stops.
if (process.argv.includes('--once')) {
  const label = process.argv[process.argv.indexOf('--job') + 1] ?? 'one turn', deadline = Date.now() + 10 * 60_000;
  let claimed = false;
  while (!claimed && Date.now() < deadline) { claimed = await worker.tick(); if (!claimed) await new Promise(resolve => setTimeout(resolve, 5000)); }
  await worker.idle();
  console.log(claimed ? `Worker ${file.workerId} finished ${label}` : `Worker ${file.workerId} found nothing to claim for ${label}`);
  process.exitCode = claimed ? 0 : 2;
} else await worker.loop();
