import type { Launcher } from './contract.ts';
import { create as local } from './local.ts';
import { create as ec2, type Ec2Options } from './ec2.ts';
import { create as fargate } from './fargate.ts';
import { create as flyMachine } from './fly-machine.ts';

const ADAPTERS: Record<string, (options: Ec2Options) => Launcher> = { local, ec2, fargate, 'fly-machine': flyMachine };
export const LAUNCHER_KINDS = Object.keys(ADAPTERS);
export const DEFAULT_LAUNCHER = 'local';

// The launcher a project uses; `options` is the coordinator-wide launcher configuration
// (credentials, network) merged with the manifest's worker section.
export function createLauncher(kind: string = DEFAULT_LAUNCHER, options: Ec2Options = {}): Launcher {
  const create = Object.hasOwn(ADAPTERS, kind) ? ADAPTERS[kind] : undefined;
  if (!create) throw new Error(`Unknown launcher kind: ${kind}. Use ${LAUNCHER_KINDS.join(', ')}`);
  return create(options);
}
