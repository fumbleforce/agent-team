import { readFileSync } from 'node:fs';
import { startCoordinator, type CoordinatorConfig, type LauncherFactory } from './server.ts';
import { createLauncher } from '../../../adapters/launcher/index.ts';

const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1]) { console.error('Usage: node packages/coordinator/src/main.ts --config FILE'); process.exit(1); }
const file = JSON.parse(readFileSync(process.argv[index + 1]!, 'utf8')) as Omit<CoordinatorConfig, 'machineToken' | 'launchers'> & { launcher?: Record<string, unknown>; publicUrl?: string };
const machineToken = process.env.AGENT_TEAM_TOKEN;
if (!machineToken) { console.error('AGENT_TEAM_TOKEN is required'); process.exit(1); }

// The deployment's launcher settings (network, image, parameter prefix) merge with what each project's manifest says about publishing.
const launchers: LauncherFactory | null = file.launcher ? (kind, project) => {
  const manifest = project.manifest as { scm?: { kind?: string }; delivery?: { repository?: string; baseBranch?: string; publishAuthorized?: boolean }; engine?: { default?: string } };
  const publish = manifest.scm?.kind && manifest.delivery?.repository ? { scm: manifest.scm.kind, repository: manifest.delivery.repository, base: manifest.delivery.baseBranch ?? 'main' } : null;
  return createLauncher(kind, { ...file.launcher, coordinatorUrl: file.publicUrl, sessions: 'packet', manifest: { publishAuthorized: manifest.delivery?.publishAuthorized === true }, publish, ...(manifest.engine?.default ? { engine: manifest.engine.default } : {}) } as Parameters<typeof createLauncher>[1]) as unknown as ReturnType<LauncherFactory>;
} : null;
const coordinator = await startCoordinator({ ...file, machineToken, launchers });
console.log(`Coordinator listening on ${coordinator.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void coordinator.close().then(() => process.exit(0)); });
