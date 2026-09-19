import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { killTree } from './platform.ts';

// While an engine runs, its turn directory holds this record. A record found at worker start belongs to a turn whose worker died:
// its process tree is ended and the turn is reported uncertain. It is never picked up again.
export interface RunRecord { turnId: string; leaseToken: string; pid: number | null; startedAt: number }
const RECORD = 'run.json', SWEPT = 'orphaned.json';

export function recordRun(turnDir: string, record: RunRecord): void { writeFileSync(path.join(turnDir, RECORD), JSON.stringify(record), { mode: 0o600 }); }
export function clearRun(turnDir: string): void { rmSync(path.join(turnDir, RECORD), { force: true }); }

export async function sweepOrphans(stateDir: string, report: (record: RunRecord) => Promise<void>, kill: (pid: number) => void = pid => { killTree(pid, 'SIGKILL'); }): Promise<RunRecord[]> {
  const root = path.join(stateDir, 'turns'), found: RunRecord[] = [];
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    const file = path.join(root, entry, RECORD);
    if (!existsSync(file)) continue;
    let record: RunRecord;
    try { record = JSON.parse(readFileSync(file, 'utf8')) as RunRecord; } catch { record = { turnId: entry, leaseToken: '', pid: null, startedAt: 0 }; }
    if (record.pid) kill(record.pid);
    // The coordinator may be unreachable or the lease long expired; either way its own expiry reaches the same verdict.
    await report(record).catch(() => {});
    rmSync(path.join(root, entry, 'platform-token'), { force: true });
    renameSync(file, path.join(root, entry, SWEPT));
    found.push(record);
  }
  return found;
}
