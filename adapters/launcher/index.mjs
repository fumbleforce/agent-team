import * as local from './local.mjs';
import * as ec2 from './ec2.mjs';
import * as fargate from './fargate.mjs';
import * as flyMachine from './fly-machine.mjs';

// A launcher turns a queued job into a worker that will claim it. `local` relies on a persistent
// worker already polling; the others start one machine per job.
const ADAPTERS = { local, ec2, fargate, 'fly-machine': flyMachine };
export const LAUNCHER_KINDS = Object.keys(ADAPTERS);
export const DEFAULT_LAUNCHER = 'local';

export function launcherAdapter(kind = DEFAULT_LAUNCHER) {
  if (!Object.hasOwn(ADAPTERS, kind)) throw new Error(`Unknown launcher kind: ${kind}. Use ${LAUNCHER_KINDS.join(', ')}`);
  return ADAPTERS[kind];
}

// The launcher a project uses; `options` is the coordinator-wide launcher configuration
// (credentials, network) merged with the manifest's worker section.
export function createLauncher(kind, options = {}) {
  const adapter = launcherAdapter(kind);
  return adapter.create(options);
}
