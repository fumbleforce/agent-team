import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import { ENTRYPOINTS, packageRoot, workerIdFor } from '@agent-team/protocol';
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
// What the start is doing right now, so the app can say it instead of showing a line that never changes.
export interface StartProgress { phase: 'cloning' | 'starting' | 'waiting' | 'failed'; detail: string | null; error: string | null; since: number }

const PAIR_MS = 15 * 60_000, FRESH_MS = 3 * 60_000, CLONE_MS = 10 * 60_000, ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('').replace(/^(.{4})/, '$1-');
const lines = (text: string) => text.split(/[\r\n]+/).filter(line => line.trim());
// git rewrites one line on stderr as it goes: "Receiving objects:  45% (450/1000), 1.2 MiB".
const CLONE_STEP = /^(?:remote: )?(Counting|Compressing|Receiving|Resolving|Updating)[^:]*:\s+(\d+)%/;
const CLONE_WORDS: Record<string, string> = { Counting: 'Counting what to fetch', Compressing: 'The host is packing it', Receiving: 'Downloading', Resolving: 'Unpacking', Updating: 'Writing the files' };

// Two ways to get a worker running without handling a token by hand. On the machine the coordinator runs on, the app starts it.
// Anywhere else, a short single-use code is traded by the worker for a token of its own, which it keeps in its private config.
export function mountWorkerSetupRoutes(app: Hono<any>, deps: Deps) {
  const { context } = deps;
  const codes = new Map<string, { projectId: string; slug: string; by: Viewer; expires: number }>();
  const started = new Map<string, ChildProcess>();
  const progress = new Map<string, StartProgress>();
  const seen = async (projectId: string) => (await context.storage.db.selectFrom('workers').select(['projects']).where('last_seen_at', '>', context.now() - FRESH_MS).execute()).some(worker => (JSON.parse(worker.projects) as string[]).includes(projectId));

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
    const child = started.get(project.id), state = progress.get(project.id) ?? null;
    const ready = await seen(project.id);
    if (ready && state?.phase !== 'failed') progress.delete(project.id);
    return c.json({ available: context.local, running: Boolean(child && child.exitCode === null), ready, progress: ready ? null : state, engines: deps.engines, machine: os.hostname(), repository: Boolean(await deps.cloneUrl(project.id)) });
  });

  // Only when the coordinator serves this machine alone: the folder is on the same disk, so the app can start the worker itself.
  // It answers at once and carries on in the background; the app follows along through the GET above.
  app.post('/api/projects/:slug/worker/here', async c => {
    const { project, viewer } = await deps.configuring(c);
    if (!context.local) throw new HttpError(409, 'conflict', 'This only works when the app runs on the same machine as the code. Use the pairing command instead.');
    const input = await deps.body(c, z.object({ checkout: z.string().trim().max(500).optional(), engine: z.string().max(40).optional() }));
    const fields: Record<string, string> = {};
    const managed = path.join(context.dataDir, 'checkouts', project.slug);
    const given = input.checkout ? path.resolve(input.checkout.replace(/^~(?=$|[\\/])/, os.homedir())) : null;
    if (given && (!existsSync(given) || !statSync(given).isDirectory())) fields.checkout = 'There is no folder at that path on this machine';
    else if (given && !existsSync(path.join(given, '.git'))) fields.checkout = 'That folder is not a git checkout (it has no .git inside)';
    const engine = input.engine ?? deps.engines[0] ?? '';
    if (!deps.engines.includes(engine)) fields.engine = 'That engine is not available here';
    if (Object.keys(fields).length) throw new HttpError(400, 'invalid', 'The worker could not be started', fields);
    // Without a folder, the app keeps its own copy of the connected repository, cloned with this machine's ordinary git credentials.
    const from = given || existsSync(path.join(managed, '.git')) ? null : await deps.cloneUrl(project.id);
    if (!given && !existsSync(path.join(managed, '.git')) && !from) throw new HttpError(409, 'conflict', 'Connect where the code lives first, or point at a folder that already has it.');
    const running = started.get(project.id), current = progress.get(project.id);
    if ((running && running.exitCode === null) || current?.phase === 'cloning' || current?.phase === 'starting') return c.json({ ok: true, already: true });

    const origin = new URL(c.req.url).origin;
    const set = (phase: StartProgress['phase'], detail: string | null = null, error: string | null = null) => {
      const before = progress.get(project.id);
      progress.set(project.id, { phase, detail, error, since: before?.phase === phase ? before.since : context.now() });
    };
    const clone = (source: string) => new Promise<string | null>(resolve => {
      mkdirSync(path.dirname(managed), { recursive: true, mode: 0o700 });
      const git = spawn('git', ['clone', '--progress', source, managed], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let tail = '';
      git.stderr.on('data', chunk => {
        tail = (tail + String(chunk)).slice(-2000);
        const step = CLONE_STEP.exec(lines(tail).at(-1) ?? '');
        if (step) set('cloning', `${CLONE_WORDS[step[1]!]} · ${step[2]}%`);
      });
      const timer = setTimeout(() => git.kill('SIGTERM'), CLONE_MS);
      git.on('error', error => { clearTimeout(timer); resolve(error.message); });
      git.on('exit', code => { clearTimeout(timer); resolve(code === 0 ? null : lines(tail).filter(line => /fatal|error|denied|not found/i.test(line)).at(-1)?.slice(0, 200) ?? 'git stopped before it finished'); });
    });
    const run = async () => {
      if (from) {
        set('cloning');
        const failed = await clone(from);
        if (failed) return set('failed', null, `The repository could not be cloned on this machine: ${failed}. Check that git can reach it from here, or point at a folder that already has the code.`);
      }
      set('starting');
      const dir = path.join(context.dataDir, 'workers', project.slug);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const config = path.join(dir, 'worker.json');
      writeFileSync(config, `${JSON.stringify({ coordinatorUrl: origin, workerId: workerIdFor(os.hostname(), project.slug), stateDir: path.join(dir, 'state'), engine, projects: { [project.id]: given ?? managed } }, null, 2)}\n`, { mode: 0o600 });
      const { token } = await deps.tokens.create(viewer, { name: `Worker on ${os.hostname()} for ${project.name}`, kind: 'worker' });
      // The token goes to the child through its environment only; it is never written to disk or shown.
      const child = spawn(process.execPath, [path.join(packageRoot(), ENTRYPOINTS.worker), '--config', config], { env: { ...process.env, AGENT_TEAM_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let errors = '';
      child.stderr?.on('data', chunk => { errors = (errors + String(chunk)).slice(-1500); });
      child.on('error', error => { started.delete(project.id); set('failed', null, `The worker could not be started: ${error.message}`); });
      child.on('exit', code => {
        started.delete(project.id);
        if (code !== 0 && code !== null) set('failed', null, `The worker stopped right away: ${lines(errors).filter(line => !/ExperimentalWarning|trace-warnings/.test(line)).at(-1)?.slice(0, 240) ?? `exit code ${code}`}`);
      });
      started.set(project.id, child);
      set('waiting');
    };
    void run().catch(error => set('failed', null, (error as Error).message.slice(0, 300)));
    return c.json({ ok: true, already: false });
  });

  return { stop() { for (const child of started.values()) if (child.exitCode === null) child.kill('SIGTERM'); started.clear(); } };
}
