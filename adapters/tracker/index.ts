// Tracker clients in the neutral shape the coordinator's sync reads and writes; both pass contract.test.ts.
import type { FullTrackerClient, TrackerOptions } from './contract.ts';
import { githubTracker } from './github.ts';
import { linearTracker } from './linear.ts';

export type { FullTrackerClient, TrackerClient, TrackerComment, TrackerIssue, TrackerState } from './contract.ts';
export { githubTracker, linearTracker };

const TRACKERS: Record<string, { present(env: NodeJS.ProcessEnv): boolean; create(options: TrackerOptions): FullTrackerClient }> = {
  github: { present: env => Boolean(env.GITHUB_ISSUES_TOKEN || env.GH_TOKEN), create: githubTracker },
  linear: { present: env => Boolean(env.LINEAR_API_KEY), create: linearTracker },
};
export const TRACKER_KINDS = Object.keys(TRACKERS);

// A client for the manifest's tracker, or null when the kind is unknown or its credential is absent.
export function trackerClient(kind: string, options: TrackerOptions = {}): FullTrackerClient | null {
  const tracker = Object.hasOwn(TRACKERS, kind) ? TRACKERS[kind]! : null;
  return tracker?.present(options.env ?? process.env) ? tracker.create(options) : null;
}
