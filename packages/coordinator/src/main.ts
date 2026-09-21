import { readFileSync } from 'node:fs';
import { startCoordinator, type CoordinatorConfig, type LauncherFactory } from './server.ts';
import { launcherFactory } from '../../../adapters/hosting/shared/launchers.ts';

const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1]) { console.error('Usage: node packages/coordinator/src/main.ts --config FILE'); process.exit(1); }
const file = JSON.parse(readFileSync(process.argv[index + 1]!, 'utf8')) as Omit<CoordinatorConfig, 'machineToken' | 'launchers'> & { launcher?: Record<string, unknown>; publicUrl?: string };
const machineToken = process.env.AGENT_TEAM_TOKEN;
if (!machineToken) { console.error('AGENT_TEAM_TOKEN is required'); process.exit(1); }

// The deployment's launcher settings (network, image, parameter prefix) merge with what each project's manifest says about publishing.
const launchers: LauncherFactory | null = file.launcher ? launcherFactory(file.launcher, file.publicUrl) : null;
const coordinator = await startCoordinator({ ...file, machineToken, launchers });
console.log(`Coordinator listening on ${coordinator.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void coordinator.close().then(() => process.exit(0)); });
