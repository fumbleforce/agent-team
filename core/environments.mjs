import path from 'node:path';
import { packageRunnerCommand } from './platform.mjs';

// Worker environments are data the coordinator stores and the dashboard edits: what a worker
// machine offers a run beyond the repository. A project selects one by id (worker.environment);
// the coordinator passes its launcher fields to the launcher and the worker hands its
// capabilities to the runner, which turns them into tools the engine can use and a note in the
// coordinator prompt. Capabilities are a fixed catalog so a stored environment never introduces
// an unknown command.
//
//   { id, name, description, capabilities: [browser|docker|display], launcher: { image?, ami?,
//     instanceType?, setup? }, packages: [apt package names] }
export const ENVIRONMENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const CAPABILITIES = {
  browser: {
    title: 'Headless browser',
    note: 'A headless browser is available as MCP tools browser_* (navigate, click, type, take screenshots, read page text). Use it to inspect web pages, verify UI work in the running app and read documentation. Screenshots are saved with the run evidence.',
    // The server is started per run; screenshots land in the run directory.
    server: runDir => ({ type: 'stdio', ...packageRunnerCommand(['-y', '@playwright/mcp@latest', '--headless', '--isolated', '--output-dir', path.join(runDir, 'browser')]) }),
    packages: ['chromium', 'fonts-liberation'],
    setup: 'npx -y playwright@latest install --with-deps chromium',
  },
  docker: { title: 'Container runtime', note: 'Docker is available for building images and running services the tests need; stop what you start.', packages: ['docker.io'] },
  display: { title: 'Virtual display', note: 'A virtual X display (DISPLAY set) is available for tools that need a window.', packages: ['xvfb'] },
};
export const LAUNCHER_FIELDS = ['image', 'ami', 'instanceType', 'setup'];

export class EnvironmentError extends Error { constructor(message) { super(message); this.status = 400; } }
const reject = message => { throw new EnvironmentError(message); };
const short = (value, name, max) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) reject(`${name} is required (at most ${max} characters)`); return value.trim(); };

export function validateEnvironment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('An environment is an object');
  const id = short(input.id, 'id', 64); if (!ENVIRONMENT_ID.test(id)) reject('id must be lowercase letters, digits and dashes');
  const name = short(input.name, 'name', 80);
  const description = !input.description ? '' : short(input.description, 'description', 400);
  const capabilities = input.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some(item => !Object.hasOwn(CAPABILITIES, item))) reject(`capabilities must list ${Object.keys(CAPABILITIES).join(', ')}`);
  const launcher = {};
  if (input.launcher !== undefined) {
    if (!input.launcher || typeof input.launcher !== 'object' || Array.isArray(input.launcher)) reject('launcher must be an object');
    for (const [key, value] of Object.entries(input.launcher)) {
      if (!LAUNCHER_FIELDS.includes(key)) reject(`launcher.${key} is not a launcher field`);
      if (value === undefined || value === null || value === '') continue;
      launcher[key] = short(value, `launcher.${key}`, key === 'setup' ? 2000 : 200);
    }
  }
  const packages = input.packages ?? [];
  if (!Array.isArray(packages) || packages.length > 64 || packages.some(item => typeof item !== 'string' || !/^[a-z0-9][a-z0-9.+-]{0,79}$/.test(item))) reject('packages must be package names');
  return { id, name, description, capabilities: [...new Set(capabilities)], launcher, packages: [...new Set(packages)] };
}

// What the toolkit ships; a coordinator configuration may add or replace entries.
export function builtinEnvironments() {
  return [
    { id: 'standard', name: 'Standard', description: 'Node, Git and the engine; no extra tools.', capabilities: [], launcher: {}, packages: [] },
    { id: 'browser', name: 'Browser', description: 'Standard plus a headless browser for inspecting pages and verifying UI work.', capabilities: ['browser'], launcher: {}, packages: [] },
    { id: 'full', name: 'Full', description: 'Browser, container runtime and a virtual display.', capabilities: ['browser', 'docker', 'display'], launcher: {}, packages: [] },
  ].map(validateEnvironment);
}

// Everything an image build needs for this environment: packages and setup commands, with the
// capabilities' own requirements folded in.
export function provisioning(environment) {
  const packages = new Set(environment.packages);
  const setup = [];
  for (const capability of environment.capabilities) {
    for (const item of CAPABILITIES[capability].packages ?? []) packages.add(item);
    if (CAPABILITIES[capability].setup) setup.push(CAPABILITIES[capability].setup);
  }
  if (environment.launcher.setup) setup.push(environment.launcher.setup);
  return { packages: [...packages], setup };
}

// The MCP servers and prompt note a run gets from its environment's capabilities.
export function capabilityServers(environment, runDir) {
  const servers = {};
  for (const capability of environment.capabilities) if (CAPABILITIES[capability].server) servers[capability] = CAPABILITIES[capability].server(runDir);
  return servers;
}
export function capabilityInstructions(environment) {
  if (!environment.capabilities.length) return '';
  return `Worker environment "${environment.name}":\n${environment.capabilities.map(capability => `- ${CAPABILITIES[capability].note}`).join('\n')}`;
}
