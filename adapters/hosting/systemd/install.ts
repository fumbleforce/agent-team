import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, DEFAULT_PORT, ENTRYPOINTS, packageRoot } from '@agent-team/protocol';

export interface InstallOptions { projects: Record<string, string>; engine: string; node?: string; home?: string; env?: NodeJS.ProcessEnv; token?: string }
export interface PlannedFile { path: string; content: string; mode: number }

const unit = (description: string, node: string, entry: string, config: string, envFile: string, after: string) => `[Unit]
Description=${description}
After=${after}

[Service]
WorkingDirectory=${packageRoot()}
EnvironmentFile=${envFile}
ExecStart="${node}" "${path.join(packageRoot(), entry)}" --config "${config}"
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;

// Everything the installer would write, without writing it: two user units, their configs and one private environment file.
export function plan(options: InstallOptions): PlannedFile[] {
  const home = options.home ?? os.homedir(), env = options.env ?? process.env, node = options.node ?? process.execPath;
  const config = configDir(env), state = path.join(home, '.local', 'state', 'agent-team'), units = path.join(home, '.config', 'systemd', 'user');
  const url = `http://127.0.0.1:${DEFAULT_PORT}`, envFile = path.join(config, 'service.env');
  const existing = existsSync(envFile) ? /^AGENT_TEAM_TOKEN=(.+)$/m.exec(readFileSync(envFile, 'utf8'))?.[1] : undefined;
  const token = existing ?? options.token ?? randomBytes(32).toString('hex');
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return [
    { path: envFile, mode: 0o600, content: `AGENT_TEAM_TOKEN=${token}\nAGENT_TEAM_URL=${url}\n` },
    { path: path.join(config, 'coordinator.json'), mode: 0o600, content: json({ host: '127.0.0.1', port: DEFAULT_PORT, storage: { kind: 'sqlite', path: path.join(state, 'coordinator.sqlite') } }) },
    { path: path.join(config, 'worker.json'), mode: 0o600, content: json({ coordinatorUrl: url, workerId: os.hostname().slice(0, 32), stateDir: path.join(state, 'worker'), engine: options.engine, projects: options.projects }) },
    { path: path.join(units, 'agent-team-coordinator.service'), mode: 0o644, content: unit('Agent team coordinator', node, ENTRYPOINTS.coordinator, path.join(config, 'coordinator.json'), envFile, 'network-online.target') },
    { path: path.join(units, 'agent-team-worker.service'), mode: 0o644, content: unit('Agent team worker', node, ENTRYPOINTS.worker, path.join(config, 'worker.json'), envFile, 'agent-team-coordinator.service') },
  ];
}

// Writes the files and starts nothing; activating a service stays the owner's explicit step.
export function install(options: InstallOptions): string[] {
  if (process.platform !== 'linux') throw new Error('User services are installed on Linux only; use "agent-team up" elsewhere');
  const files = plan(options);
  for (const file of files) { mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 }); writeFileSync(file.path, file.content, { mode: file.mode }); }
  return ['systemctl --user daemon-reload', 'systemctl --user enable --now agent-team-coordinator.service agent-team-worker.service'];
}
