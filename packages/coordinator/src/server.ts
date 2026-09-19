import { existsSync } from 'node:fs';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { DEFAULT_PORT, packageRoot } from '@agent-team/protocol';
import { createStorage, type StorageConfig } from '@agent-team/storage';
import { createContext, type Context } from './context.ts';
import { createApp } from './http/app.ts';
import { createDeliberation } from './runtime/deliberation.ts';
import { createTurns } from './runtime/turns.ts';
import { createRetro } from './runtime/retro.ts';
import { createDriveSync } from './knowledge/driveSync.ts';
import { createGitMirror } from './knowledge/gitMirror.ts';
import { createSlackInbound, createSlackMirror } from './sync/slack.ts';
import { createVersionedDocs } from './repos/versionedDocs.ts';
import { readFileSync } from 'node:fs';
import { createTrackerSync, type TrackerClient } from './sync/tracker.ts';
import { trackerClient } from '../../../adapters/tracker/index.ts';

import { createLaunches, type LauncherFactory } from './runtime/launch.ts';
export type { LauncherFactory } from './runtime/launch.ts';
export type TrackerFactory = (kind: string) => Promise<TrackerClient | null>;
// The tracker clients are adapters; a project without a credential for its tracker is simply not polled.
const adapterTrackers: TrackerFactory = async kind => trackerClient(kind);

export interface CoordinatorConfig { host?: string; port?: number; storage: StorageConfig; machineToken: string; secureCookies?: boolean; /* Names the identity header of a proxy on this machine; only honoured on a loopback bind. */ trustedHeader?: string; webRoot?: string | null; demoLogin?: Context['demoLogin']; trackers?: TrackerFactory | null; trackerPollMs?: number; launchers?: LauncherFactory | null; knowledgeMirror?: string }

export const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === '::1' || host === 'localhost';

// Loopback, a CGNAT (tailnet) address, or every interface when explicitly allowed.
export function validBind(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
  if (host === '0.0.0.0') return env.AGENT_TEAM_PUBLIC_BIND === '1';
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export async function startCoordinator(config: CoordinatorConfig): Promise<{ context: Context; server: ServerType; url: string; poll(): Promise<void>; close(): Promise<void> }> {
  const host = config.host ?? '127.0.0.1';
  if (!validBind(host)) throw new Error(`Refusing to bind ${host}`);
  if (config.trustedHeader && !isLoopback(host)) throw new Error(`Refusing to trust the ${config.trustedHeader} header on ${host}: trusted-header sign-in needs a loopback bind`);
  if (config.machineToken.length < 24) throw new Error('The machine token must be at least 24 characters');
  const storage = await createStorage(config.storage);
  await storage.migrate();
  const built = path.join(packageRoot(), 'packages', 'web', 'dist');
  const webRoot = config.webRoot === undefined ? (existsSync(built) ? built : null) : config.webRoot;
  const context = createContext({ storage, ...(config.storage.kind === 'sqlite' && config.storage.path !== ':memory:' ? { dataDir: path.dirname(path.resolve(config.storage.path)) } : {}), machineToken: config.machineToken, webRoot, secureCookies: config.secureCookies ?? false, trustedHeader: config.trustedHeader ?? null, demoLogin: config.demoLogin ?? null });
  // The shipped role library is seeded once; an owner's edits are never overwritten.
  await createVersionedDocs(context).seed('role', { type: 'library', id: '' }, JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'roles.json'), 'utf8')) as Record<string, unknown>);
  // So is the agent library, from the seats of the default team; the PM seat belongs to a team, not to the library.
  const blueprint = JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'default-team.json'), 'utf8')) as { seats: { name: string; title: string; persona: string; roles: string[]; isPm?: boolean }[] };
  await createVersionedDocs(context).seed('library_agent', { type: 'library', id: '' }, Object.fromEntries(blueprint.seats.filter(seat => !seat.isPm).map(seat => [seat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), { name: seat.name, title: seat.title, persona: seat.persona, roles: seat.roles, summary: '' }])));
  const app = createApp(context);
  // Lease expiry and feedback windows are time-driven; everything else reacts to requests.
  const turns = createTurns(context), deliberation = createDeliberation(context, turns), retro = createRetro(context, turns);
  const timer = setInterval(() => { void turns.sweep().then(() => deliberation.sweep()).then(() => retro.sweep()).catch(error => console.error(error)); }, 15_000);
  timer.unref();

  const sync = createTrackerSync(context), trackers = config.trackers === undefined ? adapterTrackers : config.trackers;
  const slack = createSlackMirror(context), drive = createDriveSync(context), gitMirror = config.knowledgeMirror ? createGitMirror(context, config.knowledgeMirror) : null;
  // Outbound mirrors run on a short timer and never stop the coordinator when their other side is down.
  const mirrorTimer = setInterval(() => { void slack.sync().then(() => gitMirror?.sync()).then(() => drive.pull()).then(() => drive.sync()).catch(error => console.error(`Mirror failed: ${(error as Error).message}`)); }, 10_000);
  mirrorTimer.unref();
  // Inbound chat is optional and never fatal: without its token it simply stays off.
  const closeInbound = await createSlackInbound(context).connect().catch(error => { console.error(`Inbound chat is off: ${(error as Error).message}`); return null; });
  const poll = async () => {
    if (!trackers) return;
    for (const project of await storage.db.selectFrom('projects').select(['id', 'manifest']).where('status', '=', 'active').execute()) {
      const kind = (JSON.parse(project.manifest) as { tracker?: { kind?: string } }).tracker?.kind;
      const client = kind ? await trackers(kind).catch(() => null) : null;
      // One project failing to sync never stops the others, and never takes the coordinator down.
      if (client) await sync.syncProject(project.id, client).catch(error => console.error(`Tracker sync failed for ${project.id}: ${(error as Error).message}`));
    }
  };
  // Disposable workers are started only when the deployment supplies a launcher factory.
  const launches = config.launchers ? createLaunches(context, config.launchers) : null;
  const launchTimer = setInterval(() => { void launches?.sweep().catch(error => console.error(error)); }, 30_000);
  launchTimer.unref();
  const pollTimer = setInterval(() => { void poll(); }, config.trackerPollMs ?? 60_000);
  pollTimer.unref();
  const server = await new Promise<ServerType>(resolve => { const s = serve({ fetch: app.fetch, hostname: host, port: config.port ?? DEFAULT_PORT }, () => resolve(s)); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (config.port ?? DEFAULT_PORT);
  return { context, server, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, poll, close: async () => { clearInterval(timer); clearInterval(pollTimer); clearInterval(mirrorTimer); clearInterval(launchTimer); await launches?.close(); closeInbound?.(); await new Promise(resolve => server.close(resolve)); await storage.close(); } };
}
