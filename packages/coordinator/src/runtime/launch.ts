import type { Context } from '../context.ts';

// The neutral shape of a worker launcher; the adapters live outside the platform.
export interface LaunchHandle { kind: string; jobId: string; startedAt: number }
export interface Launcher { start(job: { id: string; projectId: string; token?: string }): Promise<LaunchHandle>; stop(handle: LaunchHandle): Promise<unknown> }
export type LauncherFactory = (kind: string, project: { id: string; manifest: Record<string, unknown> }) => Launcher | null;

const WAIT_MS = 60_000, WORKER_FRESH_MS = 3 * 60_000, LAUNCH_TTL_MS = 60 * 60_000;

// Starts a disposable worker for a project whose queued work has waited while no worker serving it has been seen.
// One launch per project at a time; a project names its launcher under `worker.launcher` in its manifest, and none means none.
export function createLaunches(context: Context, factory: LauncherFactory) {
  const db = context.storage.db, live = new Map<string, { launcher: Launcher; handle: LaunchHandle }>();

  return {
    async sweep(): Promise<number> {
      const now = context.now();
      let started = 0;
      for (const [projectId, launch] of live) {
        const waiting = await db.selectFrom('work_items').select('id').where('project_id', '=', projectId).where('state', 'in', ['queued', 'leased']).executeTakeFirst();
        if (waiting && now - launch.handle.startedAt < LAUNCH_TTL_MS) continue;
        live.delete(projectId);
        await launch.launcher.stop(launch.handle).catch(error => console.error(`Stopping a launched worker failed: ${(error as Error).message}`));
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
        try {
          live.set(project.id, { launcher, handle: await launcher.start({ id: item.id, projectId: project.id, token: context.machineToken }) });
          started++;
        } catch (error) {
          // A refused launch (publishing not authorized, say) is reported once per sweep and never retried in a loop within it.
          console.error(`Launching a worker for ${project.id} failed: ${(error as Error).message}`);
          served.add(project.id);
        }
      }
      return started;
    },
    async close() { for (const launch of live.values()) await launch.launcher.stop(launch.handle).catch(() => {}); live.clear(); },
  };
}
