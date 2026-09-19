import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { killTree, processIdentity, type ProcessIdentity } from './platform.ts';

// While an engine runs, its turn directory holds this record. A record found at worker start belongs to a turn whose worker died:
// its process tree is ended and the turn is reported uncertain. It is never picked up again.
// `process` is who the pid was when the engine started: a pid is reused once its process is gone, so the sweep ends only a process
// that is still that one. `startedAt` is the worker's own clock at the spawn.
export interface RunRecord { turnId: string; leaseToken: string; pid: number | null; startedAt: number; process?: ProcessIdentity | null }
export type SweptRecord = RunRecord & { swept: 'killed' | 'gone' | 'not-ours' | 'no-process' };
const RECORD = 'run.json', SWEPT = 'orphaned.json';

export function recordRun(turnDir: string, record: RunRecord): void { writeFileSync(path.join(turnDir, RECORD), JSON.stringify(record), { mode: 0o600 }); }
export function clearRun(turnDir: string): void { rmSync(path.join(turnDir, RECORD), { force: true }); }

// The record is written the moment the engine starts; who the pid is follows as soon as the system has answered, unless the turn is already over.
export async function identifyRun(turnDir: string, record: RunRecord, identify: (pid: number) => Promise<ProcessIdentity | null> = processIdentity): Promise<void> {
  if (!record.pid) return;
  const found = await identify(record.pid);
  if (found && existsSync(path.join(turnDir, RECORD))) recordRun(turnDir, { ...record, process: found });
}

// Same program and, where both sides know it, the same start: only then is the pid still the engine this worker started.
export function sameProcess(recorded: ProcessIdentity, current: ProcessIdentity): boolean {
  return recorded.command === current.command && (recorded.started === null || current.started === null || recorded.started === current.started);
}

export async function sweepOrphans(stateDir: string, report: (record: RunRecord) => Promise<void>, kill: (pid: number) => void = pid => { killTree(pid, 'SIGKILL'); }, identify: (pid: number) => Promise<ProcessIdentity | null> = processIdentity): Promise<SweptRecord[]> {
  const root = path.join(stateDir, 'turns'), found: SweptRecord[] = [];
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    const file = path.join(root, entry, RECORD);
    if (!existsSync(file)) continue;
    let record: RunRecord;
    try { record = JSON.parse(readFileSync(file, 'utf8')) as RunRecord; } catch { record = { turnId: entry, leaseToken: '', pid: null, startedAt: 0 }; }
    let swept: SweptRecord['swept'] = 'no-process';
    if (record.pid) {
      // A record from before identities were kept names only the pid, and is ended by it as it always was.
      const current = record.process ? await identify(record.pid) : null;
      swept = !record.process ? 'killed' : !current ? 'gone' : sameProcess(record.process, current) ? 'killed' : 'not-ours';
      if (swept === 'killed') kill(record.pid);
    }
    // The coordinator may be unreachable or the lease long expired; either way its own expiry reaches the same verdict.
    await report(record).catch(() => {});
    rmSync(path.join(root, entry, 'platform-token'), { force: true });
    renameSync(file, path.join(root, entry, SWEPT));
    found.push({ ...record, swept });
  }
  return found;
}
