import { readFileSync } from 'node:fs';
import { startCoordinator, type CoordinatorConfig } from './server.ts';

const index = process.argv.indexOf('--config');
if (index < 0 || !process.argv[index + 1]) { console.error('Usage: node packages/coordinator/src/main.ts --config FILE'); process.exit(1); }
const file = JSON.parse(readFileSync(process.argv[index + 1]!, 'utf8')) as Omit<CoordinatorConfig, 'machineToken'>;
const machineToken = process.env.AGENT_TEAM_TOKEN;
if (!machineToken) { console.error('AGENT_TEAM_TOKEN is required'); process.exit(1); }

const coordinator = await startCoordinator({ ...file, machineToken });
console.log(`Coordinator listening on ${coordinator.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void coordinator.close().then(() => process.exit(0)); });
