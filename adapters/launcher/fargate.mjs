// Placeholder for one ECS Fargate task per job. The interface matches the other launchers so a
// project can switch by changing worker.launcher once the task definition exists.
export const NAME = 'fargate';

export function create() {
  const unsupported = () => Promise.reject(new Error('The fargate launcher is not implemented yet; use ec2 or local'));
  return { kind: NAME, start: unsupported, stop: unsupported, status: unsupported };
}
