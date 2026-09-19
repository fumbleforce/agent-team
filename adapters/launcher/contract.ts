// A launcher turns a queued job into a worker that will claim it. `local` relies on a persistent
// worker already polling; the others start one machine per job.
export interface LaunchJob { id: string; projectId: string; token?: string; worker?: { instanceType?: string; ami?: string } }
export interface LaunchHandle { kind: string; jobId: string; startedAt: number; instanceId?: string; market?: string; region?: string | null }
export interface Launcher {
  kind: string;
  start(job: LaunchJob): Promise<LaunchHandle>;
  stop(handle: Partial<LaunchHandle> | null | undefined): Promise<{ stopped: boolean }>;
  status(handle: Partial<LaunchHandle> | null | undefined): Promise<{ state: string }>;
}
