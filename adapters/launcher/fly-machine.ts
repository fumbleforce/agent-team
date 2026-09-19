import type { Launcher } from './contract.ts';

// Placeholder for one Fly Machine per job. The interface matches the other launchers.
export const NAME = 'fly-machine';

export function create(): Launcher {
  const unsupported = () => Promise.reject(new Error('The fly-machine launcher is not implemented yet; use ec2 or local'));
  return { kind: NAME, start: unsupported, stop: unsupported, status: unsupported };
}
