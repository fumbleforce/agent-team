import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import { ENTRYPOINTS, packageRoot } from '@agent-team/protocol';
import { HttpError, type Context } from '../context.ts';
import type { Viewer } from '../auth/rbac.ts';

interface Deps {
  context: Context; engines: string[];
  // Where a connected repository is cloned from, or null when the project has no code host yet.
  cloneUrl(projectId: string): Promise<string | null>;
  tokens: { create(by: Viewer, input: { name: string; kind: 'worker' | 'cli' }): Promise<{ id: string; token: string }> };
  configuring(c: unknown): Promise<{ project: { id: string; slug: string; name: string }; viewer: Viewer }>;
  body<T>(c: unknown, schema: z.ZodType<T>): Promise<T>;
}
const PAIR_MS = 15 * 60_000, ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('').replace(/^(.{4})/, '$1-');

// Two ways to get a worker running without handling a token by hand. On the machine the coordinator runs on, the app starts it.
// Anywhere else, a short single-use code is traded by the worker for a token of its own, which it keeps in its private config.
export function mountWorkerSetupRoutes(app: Hono<any>, deps: Deps) {
  const { context } = deps;
  const codes = new Map<string, { projectId: string; slug: string; by: Viewer; expires: number }>();
  const started = new Map<string, ChildProcess>();

  app.post('/api/projects/:slug/worker/pair', async c => {
    const { project, viewer } = await deps.configuring(c);
    for (const [code, entry] of codes) if (entry.expires < context.now()) codes.delete(code);
    const code = newCode();
    codes.set(code, { projectId: project.id, slug: project.slug, by: viewer, expires: context.now() + PAIR_MS });
    return c.json({ code, link: `${new URL(c.req.url).origin}/pair/${code}`, expiresAt: context.now() + PAIR_MS });
  });

  // Called by `agent-team connect`. The code is the only credential: single use, short-lived, and it yields a token only this worker ever sees.
  app.post('/machine/pair', async c => {
    const input = await deps.body(c, z.object({ code: z.string().max(20), name: z.string().trim().min(1).max(40) }));
    const entry = codes.get(input.code.toUpperCase());
    if (!entry || entry.expires < context.now()) throw new HttpError(404, 'not_found', 'That pairing code is not valid any more. Make a new one in the app.');
    codes.delete(input.code.toUpperCase());
    const { token } = await deps.tokens.create(entry.by, { name: `Worker ${input.name}`, kind: 'worker' });
    return c.json({ token, projectId: entry.projectId, slug: entry.slug });
  });

  app.get('/api/projects/:slug/worker/here', async c => {
    const { project } = await deps.configuring(c);
    const child = started.get(project.id);
    return c.json({ available: context.local, running: Boolean(child && child.exitCode === null), engines: deps.engines, machine: os.hostname(), repository: Boolean(await deps.cloneUrl(project.id)) });
  });

  // Only when the coordinator serves this machine alone: the folder is on the same disk, so the app can start the worker itself.
  app.post('/api/projects/:slug/worker/here', async c => {
    const { project, viewer } = await deps.configuring(c);
    if (!context.local) throw new HttpError(409, 'conflict', 'This only works when the app runs on the same machine as the code. Use the pairing command instead.');
    const input = await deps.body(c, z.object({ checkout: z.string().trim().max(500).optional(), engine: z.string().max(40).optional() }));
    const fields: Record<string, string> = {};
    // Without a folder, the app keeps its own copy of the connected repository, cloned with this machine's ordinary git credentials.
    const managed = path.join(context.dataDir, 'checkouts', project.slug);
    if (!input.checkout && !existsSync(path.join(managed, '.git'))) {
      const from = await deps.cloneUrl(project.id);
      if (!from) throw new HttpError(409, 'conflict', 'Connect where the code lives first, or point at a folder that already has it.');
      mkdirSync(path.dirname(managed), { recursive: true, mode: 0o700 });
      const failed = await new Promise<string | null>(resolve => execFile('git', ['clone', '--quiet', from, managed], { timeout: 10 * 60_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, _out, stderr) => resolve(error ? String(stderr).trim().split('\n').at(-1)?.slice(0, 200) || error.message : null)));
      if (failed) throw new HttpError(400, 'invalid', `The repository could not be cloned on this machine: ${failed}. Check that git can reach it from here, or point at a folder that already has the code.`);
    }
    const checkout = input.checkout ? path.resolve(input.checkout.replace(/^~(?=$|[\\/])/, os.homedir())) : managed;
    if (!existsSync(checkout) || !statSync(checkout).isDirectory()) fields.checkout = 'There is no folder at that path on this machine';
    else if (!existsSync(path.join(checkout, '.git'))) fields.checkout = 'That folder is not a git checkout (it has no .git inside)';
    const engine = input.engine ?? deps.engines[0] ?? '';
    if (!deps.engines.includes(engine)) fields.engine = 'That engine is not available here';
    if (Object.keys(fields).length) throw new HttpError(400, 'invalid', 'The worker could not be started', fields);
    const running = started.get(project.id);
    if (running && running.exitCode === null) return c.json({ ok: true, already: true });

    const dir = path.join(context.dataDir, 'workers', project.slug);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const config = path.join(dir, 'worker.json');
    writeFileSync(config, `${JSON.stringify({ coordinatorUrl: new URL(c.req.url).origin, workerId: os.hostname().slice(0, 32), stateDir: path.join(dir, 'state'), engine, projects: { [project.id]: checkout } }, null, 2)}\n`, { mode: 0o600 });
    const { token } = await deps.tokens.create(viewer, { name: `Worker on ${os.hostname()} for ${project.name}`, kind: 'worker' });
    // The token goes to the child through its environment only; it is never written to disk or shown.
    const child = spawn(process.execPath, [path.join(packageRoot(), ENTRYPOINTS.worker), '--config', config], { env: { ...process.env, AGENT_TEAM_TOKEN: token }, stdio: 'ignore', windowsHide: true });
    child.on('error', () => started.delete(project.id));
    child.on('exit', () => started.delete(project.id));
    started.set(project.id, child);
    return c.json({ ok: true, already: false });
  });

  return { stop() { for (const child of started.values()) if (child.exitCode === null) child.kill('SIGTERM'); started.clear(); } };
}
