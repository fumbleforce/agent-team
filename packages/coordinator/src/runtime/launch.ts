import { createMachineTokens } from '../auth/machineTokens.ts';
import type { Context } from '../context.ts';

// The neutral shape of a worker launcher; the adapters live outside the platform.
export interface LaunchHandle { kind: string; jobId: string; startedAt: number }
export interface Launcher { start(job: { id: string; projectId: string; token?: string }): Promise<LaunchHandle>; stop(handle: LaunchHandle): Promise<unknown>; status?(handle: LaunchHandle): Promise<{ state: string }> }
export type LauncherFactory = (kind: string, project: { id: string; manifest: Record<string, unknown> }) => Launcher | null;

const WAIT_MS = 60_000, WORKER_FRESH_MS = 3 * 60_000, LAUNCH_TTL_MS = 60 * 60_000;
// What a launcher calls a machine that is gone or going.
const ENDED = /stopped|stopping|terminated|shutting-down|exited|destroyed|done|failed|gone/i;

// Starts a disposable worker for a project whose queued work has waited while no worker serving it has been seen. One launch per project
// at a time; once it has ended, the next queued work starts another at once. A launch still running after an hour is stopped. Each is given
// a token of its own, taken back when it ends. A project names its launcher under `worker.launcher` in its manifest, and none means none.
export function createLaunches(context: Context, factory: LauncherFactory) {
  const db = context.storage.db, tokens = createMachineTokens(context), live = new Map<string, { launcher: Launcher; handle: LaunchHandle; tokenId: string }>();
  const end = async (projectId: string, running: boolean) => {
    const launch = live.get(projectId)!;
    live.delete(projectId);
    if (running) await launch.launcher.stop(launch.handle).catch(error => console.error(`Stopping a launched worker failed: ${(error as Error).message}`));
    await tokens.retire(launch.tokenId).catch(() => {});
  };

  return {
    async sweep(): Promise<number> {
      const now = context.now();
      let started = 0;
      for (const [projectId, launch] of [...live]) {
        const waiting = await db.selectFrom('work_items').select('id').where('project_id', '=', projectId).where('state', 'in', ['queued', 'leased']).executeTakeFirst();
        const state = launch.launcher.status ? (await launch.launcher.status(launch.handle).catch(() => ({ state: 'unknown' }))).state : 'unknown';
        if (ENDED.test(state)) { await end(projectId, false); continue; }
        if (waiting && now - launch.handle.startedAt < LAUNCH_TTL_MS) continue;
        await end(projectId, true);
      }
      const waiting = await db.selectFrom('work_items').select(['id', 'project_id']).where('state', '=', 'queued').where('created_at', '<', now - WAIT_MS).orderBy('created_at').execute();
      const workers = await db.selectFrom('workers').select(['projects', 'last_seen_at']).where('last_seen_at', '>', now - WORKER_FRESH_MS).execute();
      const served = new Set(workers.flatMap(worker => JSON.parse(worker.projects) as string[]));
      for (const item of waiting) {
        if (live.has(item.project_id) || served.has(item.project_id)) continue;
        const project = await db.selectFrom('projects').select(['id', 'manifest']).where('id', '=', item.project_id).executeTakeFirstOrThrow();
        const manifest = JSON.parse(project.manifest) as { worker?: { launcher?: string } };
        const kind = manifest.worker?.launcher;
        const launcher = kind && kind !== 'local' ? factory(kind, { id: project.id, manifest }) : null;
        if (!launcher) continue;
        const token = await tokens.issue(`launched for ${item.project_id}`.slice(0, 60));
        try {
          live.set(project.id, { launcher, handle: await launcher.start({ id: item.id, projectId: project.id, token: token.token }), tokenId: token.id });
          started++;
        } catch (error) {
          // A refused launch (publishing not authorized, say) is reported once per sweep and never retried in a loop within it.
          console.error(`Launching a worker for ${project.id} failed: ${(error as Error).message}`);
          await tokens.retire(token.id).catch(() => {});
          served.add(project.id);
        }
      }
      return started;
    },
    async close() { for (const projectId of [...live.keys()]) await end(projectId, true); },
  };
}
