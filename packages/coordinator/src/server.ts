import { createDuties } from './runtime/duties.ts';
import { createTrials } from './runtime/trials.ts';
import { isOpenWeight, modelFamily } from '../../../adapters/engine/providers.ts';
import { existsSync } from 'node:fs';
import { createIssues } from './repos/issues.ts';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { DEFAULT_PORT, packageRoot } from '@agent-team/protocol';
import { createStorage, type StorageConfig } from '@agent-team/storage';
import { createContext, type ArtifactsConfig, type Context, type LocalOwner } from './context.ts';
import type { Decider } from '../../../adapters/decider/contract.ts';
import { createDecisions } from './runtime/decisions.ts';
import { createTraceStore } from './runtime/traceStore.ts';
import { createApp } from './http/app.ts';
import { createDeliberation } from './runtime/deliberation.ts';
import { createTurns } from './runtime/turns.ts';
import { createRetro } from './runtime/retro.ts';
import { createDriveSync } from './knowledge/driveSync.ts';
import { createKnowledge } from './knowledge/knowledge.ts';
import { createGitMirror } from './knowledge/gitMirror.ts';
import { createSlackInbound, createSlackMirror } from './sync/slack.ts';
import { createVersionedDocs } from './repos/versionedDocs.ts';
import { readFileSync } from 'node:fs';
import { createTrackerSync, type TrackerClient } from './sync/tracker.ts';
import { createCursors } from './sync/cursors.ts';
import { trackerClient } from '../../../adapters/tracker/index.ts';
import { createScmSync, type ScmApi } from './sync/scm.ts';
import { scmApi } from '../../../adapters/scm/index.ts';
import { createCheckWake } from './checks/wake.ts';

import { backfillSearch } from './knowledge/backfill.ts';
import { createLaunches, type LauncherFactory } from './runtime/launch.ts';
import { createRemembering } from './runtime/remembering.ts';
import { createNeedsYou } from './runtime/needsYou.ts';
import { createNotifications } from './runtime/notifications.ts';
import { publishedModels } from '../../../adapters/engine/models.ts';
import { SKILL_SCOPE, shippedSkills } from './runtime/skills.ts';
export type { LauncherFactory } from './runtime/launch.ts';
export type TrackerFactory = (kind: string) => Promise<TrackerClient | null>;
export type ScmFactory = (kind: string) => Promise<ScmApi | null>;

// `dataDir`: where the secrets key and stored files live; next to a database file by default, and to be named for a database server.
export interface CoordinatorConfig { host?: string; port?: number; storage: StorageConfig; dataDir?: string; machineToken: string; secureCookies?: boolean; /* Names the identity header of a proxy on this machine; only honoured on a loopback bind. */ trustedHeader?: string; /* The person a coordinator on this machine is for: written by `up`, only honoured on a loopback bind. */ localOwner?: LocalOwner; webRoot?: string | null; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; demoLogin?: Context['demoLogin']; trackers?: TrackerFactory | null; scm?: ScmFactory | null; trackerPollMs?: number; launchers?: LauncherFactory | null; knowledgeMirror?: string; /* Where large step artifacts are kept: `{ kind: 'local', dir }` by default, in a folder under the data directory. */ artifacts?: ArtifactsConfig; /* Days a trace outlives its terminal task; 30 by default. */ traceRetentionDays?: number; /* The model that answers typed questions; by default the one the keys in the environment or the app name, or none. */ decider?: Decider | null }

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
  if (config.localOwner && !isLoopback(host)) throw new Error(`Refusing to sign anyone in without a password on ${host}: that needs a loopback bind`);
  if (config.machineToken.length < 24) throw new Error('The machine token must be at least 24 characters');
  const storage = await createStorage(config.storage);
  await storage.migrate();
  const built = path.join(packageRoot(), 'packages', 'web', 'dist');
  const webRoot = config.webRoot === undefined ? (existsSync(built) ? built : null) : config.webRoot;
  const context = createContext({ storage, ...(config.dataDir ? { dataDir: config.dataDir } : config.storage.kind === 'sqlite' && config.storage.path !== ':memory:' ? { dataDir: path.dirname(path.resolve(config.storage.path)) } : {}), local: isLoopback(host), machineToken: config.machineToken, webRoot, ...(config.artifacts ? { artifacts: config.artifacts } : {}), ...(config.traceRetentionDays !== undefined ? { traceRetentionDays: config.traceRetentionDays } : {}), secureCookies: config.secureCookies ?? false, trustedHeader: config.trustedHeader ?? null, localOwner: config.localOwner ?? null, demoLogin: config.demoLogin ?? null, ...(config.env ? { env: config.env } : {}), ...(config.fetch ? { fetch: config.fetch } : {}), ...(config.decider !== undefined ? { decider: config.decider } : {}) });
  // So are the code hosts: review state, test reports, environments and the committed settings are read only where the host's token
  // is present, from where the coordinator keeps its keys. A deployment that turns outside polling off for trackers has it off for
  // code hosts too, unless it names a factory.
  context.scm = config.scm === undefined ? (config.trackers === null ? null : async kind => scmApi(kind, { env: context.env, fetch: context.fetch })) : config.scm;
  await context.secrets.load();
  // What is known about models is read once a day, in the background; never under the test runner, which reaches no outside service.
  const readModels = () => publishedModels(context.fetch).then(listed => context.models.load(listed), () => {});
  const modelsTimer = 'NODE_TEST_CONTEXT' in process.env ? null : setInterval(() => { void readModels(); }, 24 * 3600_000);
  if (modelsTimer) { modelsTimer.unref(); void readModels(); }
  await createIssues(context, path.join(context.dataDir, 'blobs')).backfillInbox();
  // The shipped skills, which the shipped roles name. Like every shipped document, one an owner edited is never overwritten.
  await createVersionedDocs(context).seed('skill', SKILL_SCOPE, shippedSkills(path.join(packageRoot(), 'blueprints', 'skills')));
  // The shipped role library is seeded once; an owner's edits are never overwritten.
  await createVersionedDocs(context).seed('role', { type: 'library', id: '' }, JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'roles.json'), 'utf8')) as Record<string, unknown>);
  // So is the agent library, from the seats of the default team; the PM seat belongs to a team, not to the library.
  const blueprint = JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'default-team.json'), 'utf8')) as { seats: { name: string; title: string; persona: string; roles: string[]; isPm?: boolean }[] };
  await createVersionedDocs(context).seed('library_agent', { type: 'library', id: '' }, Object.fromEntries(blueprint.seats.filter(seat => !seat.isPm).map(seat => [seat.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), { name: seat.name, title: seat.title, persona: seat.persona, roles: seat.roles, summary: '' }])));
  // And the named personas people hire for their character. Seeding only adds what is missing, so an existing organization gets new ones on its next start.
  await createVersionedDocs(context).seed('library_agent', { type: 'library', id: '' }, JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'library-agents.json'), 'utf8')) as Record<string, unknown>);
  await createVersionedDocs(context).seed('team_template', { type: 'library', id: '' }, JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'team-templates.json'), 'utf8')) as Record<string, unknown>);
  const app = createApp(context);
  // Lease expiry and feedback windows are time-driven; everything else reacts to requests.
  const turns = createTurns(context), deliberation = createDeliberation(context, turns), retro = createRetro(context, turns), traceStore = createTraceStore(context), checkWake = createCheckWake(context, turns), remembering = createRemembering(context, turns), notifications = createNotifications(context, createNeedsYou(context, turns));
  const memory = createKnowledge(context);
  // Changes the team made to how it works are judged when their trial ends.
  const trials = createTrials(context, { openWeight: isOpenWeight, modelFamily });
  // Standing duties open their task when they come round.
  const duties = createDuties(context, turns);
  // The decision model's reads are judged once the PM has decided the same thing.
  const decisions = createDecisions(context);
  const timer = setInterval(() => { void turns.sweep().then(() => deliberation.sweep()).then(() => retro.sweep()).then(() => traceStore.sweep()).then(() => checkWake.sweep()).then(() => remembering.sweep()).then(() => notifications.sweep()).then(() => memory.sweepStale()).then(() => trials.sweep()).then(() => duties.sweep()).then(() => decisions.sweep()).catch(error => console.error(error)); }, 15_000);
  timer.unref();

  // The tracker clients are adapters. They read their key where the coordinator keeps them, so one typed into the app counts;
  // a project whose tracker has no key is not polled, and its board says why.
  const adapterTrackers: TrackerFactory = async kind => trackerClient(kind, { env: context.env, fetch: context.fetch });
  const sync = createTrackerSync(context, turns), trackers = config.trackers === undefined ? adapterTrackers : config.trackers, cursors = createCursors(context);
  const scmSync = createScmSync(context, turns), hosts = context.scm;
  const slack = createSlackMirror(context), drive = createDriveSync(context), gitMirror = config.knowledgeMirror ? createGitMirror(context, config.knowledgeMirror) : null;
  // Outbound mirrors run on a short timer and never stop the coordinator when their other side is down.
  const mirrorTimer = setInterval(() => { void slack.sync().then(() => gitMirror?.sync()).then(() => drive.pull()).then(() => drive.sync()).catch(error => console.error(`Mirror failed: ${(error as Error).message}`)); }, 10_000);
  mirrorTimer.unref();
  // Inbound chat is optional and never fatal: without its token it simply stays off.
  const closeInbound = await createSlackInbound(context).connect().catch(error => { console.error(`Inbound chat is off: ${(error as Error).message}`); return null; });
  const poll = async () => {
    for (const project of await storage.db.selectFrom('projects').select(['id', 'manifest']).where('status', '=', 'active').execute()) {
      const manifest = JSON.parse(project.manifest) as { tracker?: { kind?: string }; scm?: { kind?: string } };
      const kind = manifest.tracker?.kind;
      const client = kind && trackers ? await trackers(kind).catch(() => null) : null;
      // One project failing to sync never stops the others, and never takes the coordinator down.
      if (client) await sync.syncProject(project.id, client).catch(error => console.error(`Tracker sync failed for ${project.id}: ${(error as Error).message}`));
      else if (kind && trackers === adapterTrackers) await cursors.fail(project.id, 'tracker', new Error(`There is no key for the ${kind} board on the coordinator: add it where the board is connected`)).catch(() => undefined);
      const host = manifest.scm?.kind && hosts ? await hosts(manifest.scm.kind).catch(() => null) : null;
      if (host) await scmSync.syncProject(project.id, host).catch(error => console.error(`Code host sync failed for ${project.id}: ${(error as Error).message}`));
    }
    // A run that failed on a task's branch wakes its author, whether the host, an upload or an agent reported it.
    await checkWake.sweep().catch(error => console.error(error));
  };
  // What was written before it became searchable is indexed once, in the background.
  void backfillSearch(context).catch(error => console.error(`Search backfill failed: ${(error as Error).message}`));
  // Disposable workers are started only when the deployment supplies a launcher factory.
  const launches = config.launchers ? createLaunches(context, config.launchers) : null;
  context.launching = launches !== null;
  const launchTimer = setInterval(() => { void launches?.sweep().catch(error => console.error(error)); }, 30_000);
  launchTimer.unref();
  // The board should be whole as soon as the app is up, not a poll interval later.
  const firstPoll = setTimeout(() => { void poll(); }, 1500);
  firstPoll.unref();
  const pollTimer = setInterval(() => { void poll(); }, config.trackerPollMs ?? 60_000);
  pollTimer.unref();
  const server = await new Promise<ServerType>(resolve => { const s = serve({ fetch: app.fetch, hostname: host, port: config.port ?? DEFAULT_PORT }, () => resolve(s)); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (config.port ?? DEFAULT_PORT);
  const shutDown = async () => {
    clearInterval(timer);
    if (modelsTimer) clearInterval(modelsTimer);
    clearInterval(pollTimer);
    clearTimeout(firstPoll);
    clearInterval(mirrorTimer);
    clearInterval(launchTimer);
    await launches?.close();
    closeInbound?.();
    const closed = new Promise(resolve => server.close(resolve));
    // A live feed never ends by itself, and a server waits for every open connection: they are dropped.
    if ('closeAllConnections' in server) server.closeAllConnections();
    await closed;
    await storage.close();
  };
  // A second signal while the first is still closing joins it instead of closing again.
  let closing: Promise<void> | null = null;
  const close = () => closing ??= shutDown();
  return { context, server, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, poll, close };
}
