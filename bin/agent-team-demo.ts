#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { DEMO_LOGIN, seedDemo, startCoordinator } from '@agent-team/coordinator';

// A throwaway coordinator on an in-memory database with the design boards' sample organization. Its repositories and boards are made up,
// so it polls no tracker or code host: nothing leaves this machine with the sign-ins that happen to be on it.
const port = Number(process.env.PORT ?? 4310);
const coordinator = await startCoordinator({ port, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: randomBytes(24).toString('base64url'), demoLogin: DEMO_LOGIN, trackers: null });
// DEMO_EMPTY=1 serves an organization with nothing in it yet, to try the first-run guide.
await seedDemo(coordinator.context, { empty: process.env.DEMO_EMPTY === '1', activity: true });
console.log(`Demo running at ${coordinator.url}\n  sign in: ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}\n  gallery: ${coordinator.url}/dev/ui`);
if (!coordinator.context.webRoot) console.log('  web assets are not built: run "npm run build:web" first');
process.on('SIGINT', () => { void coordinator.close().then(() => process.exit(0)); });
