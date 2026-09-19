#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { DEMO_LOGIN, seedDemo, startCoordinator } from '@agent-team/coordinator';

// A throwaway coordinator on an in-memory database with the design boards' sample organization.
const port = Number(process.env.PORT ?? 4310);
const coordinator = await startCoordinator({ port, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: randomBytes(24).toString('base64url'), demoLogin: DEMO_LOGIN });
// DEMO_EMPTY=1 serves an organization with nothing in it yet, to try the first-run guide.
await seedDemo(coordinator.context, { empty: process.env.DEMO_EMPTY === '1' });
console.log(`Demo running at ${coordinator.url}\n  sign in: ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}\n  gallery: ${coordinator.url}/dev/ui`);
if (!coordinator.context.webRoot) console.log('  web assets are not built: run "npm run build:web" first');
process.on('SIGINT', () => { void coordinator.close().then(() => process.exit(0)); });
