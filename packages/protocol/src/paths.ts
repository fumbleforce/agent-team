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

export const ENTRYPOINTS = {
  coordinator: 'packages/coordinator/src/main.ts',
  worker: 'packages/worker/src/main.ts',
} as const;
export const DEFAULT_PORT = 4310;
