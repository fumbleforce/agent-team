// A worker's configuration may name its projects the way people do (the project's short name) or by the coordinator's id.
// Work is handed out by id, so names are looked up once at start. A name the coordinator does not know yet is asked for again
// for a while: on a first `up` the worker starts a moment before its project is registered.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveProjects(projects: Record<string, string>, options: { coordinatorUrl: string; token: string; fetch?: typeof fetch; waitMs?: number; pauseMs?: number }): Promise<{ projects: Record<string, string>; unknown: string[] }> {
  const request = options.fetch ?? fetch, deadline = Date.now() + (options.waitMs ?? 60_000);
  const resolved: Record<string, string> = {}, pending = new Map(Object.entries(projects));
  for (;;) {
    for (const [key, checkout] of [...pending]) {
      if (ID.test(key)) { resolved[key] = checkout; pending.delete(key); continue; }
      const response = await request(`${options.coordinatorUrl}/machine/projects/${encodeURIComponent(key)}`, { headers: { authorization: `Bearer ${options.token}` } }).catch(() => null);
      if (response?.ok) { resolved[((await response.json()) as { id: string }).id] = checkout; pending.delete(key); }
      else if (response?.status === 401) throw new Error('The coordinator refused this worker\'s token');
    }
    if (pending.size === 0 || Date.now() >= deadline) return { projects: resolved, unknown: [...pending.keys()] };
    await new Promise(resolve => setTimeout(resolve, options.pauseMs ?? 1500));
  }
}
