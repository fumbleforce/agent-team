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
