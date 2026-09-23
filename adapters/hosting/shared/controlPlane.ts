import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startCoordinator } from '@agent-team/coordinator';
import { launcherFactory } from './launchers.ts';

// A hosted control plane is one process on one port: the API, the live stream, the agents' tool endpoint and the web app.
// Workers connect outbound with the same machine token.
// `launcher` is what lets the control plane start workers for queued work; `internalUrl` is the address those workers reach it at,
// which is not the address a person uses.
export async function startControlPlane(options: { publicUrl: string; env?: NodeJS.ProcessEnv; launcher?: Record<string, unknown> | null; internalUrl?: string }) {
  const env = options.env ?? process.env;
  const data = env.AGENT_TEAM_DATA ?? '/data';
  const machineToken = env.AGENT_TEAM_TOKEN;
  if (!machineToken) throw new Error('AGENT_TEAM_TOKEN is not set');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const storage = env.AGENT_TEAM_DATABASE_URL ? { kind: 'postgres' as const, url: env.AGENT_TEAM_DATABASE_URL } : { kind: 'sqlite' as const, path: path.join(data, 'coordinator.sqlite') };
  process.env.AGENT_TEAM_PUBLIC_BIND = '1';
  const coordinator = await startCoordinator({ host: '0.0.0.0', port: Number(env.PORT ?? 4310), storage, dataDir: data, machineToken, secureCookies: options.publicUrl.startsWith('https://'), launchers: options.launcher ? launcherFactory(options.launcher, options.internalUrl ?? options.publicUrl) : null });
  console.log(options.launcher ? 'Workers are started for queued work, one project at a time, and stopped when it is done' : 'No launcher is configured: queued work waits for a worker that connects by itself');
  console.log(`Coordinator listening on ${coordinator.url}`);
  // The first visitor needs an owner account; the one-time link goes to the service log.
  const link = await fetch(`${coordinator.url}/machine/setup-link`, { method: 'POST', headers: { authorization: `Bearer ${machineToken}` } }).then(response => response.json() as Promise<{ path: string | null }>);
  if (link.path) console.log(`First run: create the owner account at ${options.publicUrl}${link.path}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void coordinator.close().then(() => process.exit(0)); });
  return coordinator;
}
