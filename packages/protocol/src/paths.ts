import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The only place the config directory is derived.
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_TEAM_CONFIG_DIR) return env.AGENT_TEAM_CONFIG_DIR;
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'agent-team');
}

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

// Sources run as `.ts` in a checkout and as the built `.js` in the published package, where the root is its `dist` folder.
export const SOURCE_EXT = path.extname(fileURLToPath(import.meta.url)) === '.js' ? '.js' : '.ts';
export const ENTRYPOINTS = {
  coordinator: `packages/coordinator/src/main${SOURCE_EXT}`,
  worker: `packages/worker/src/main${SOURCE_EXT}`,
} as const;
export const DEFAULT_PORT = 4310;

// A worker's identity: the machine plus what it works for. Two workers on one machine (one per project) must not share a name,
// or each would overwrite what the other told the coordinator it serves.
export const workerIdFor = (hostname: string, project: string): string => `${hostname.replace(/[^\w.-]/g, '-').slice(0, 60)}.${project.replace(/[^\w.-]/g, '-').slice(0, 60)}`;
