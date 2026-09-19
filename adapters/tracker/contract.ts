import type { TrackerClient } from '../../packages/coordinator/src/sync/tracker.ts';

// The neutral shapes belong to the coordinator's sync, which is the only reader. An adapter implements every method of the
// client; the sync treats the writing ones as optional so a read-only client still mirrors the board.
export type { TrackerClient, TrackerComment, TrackerIssue, TrackerState } from '../../packages/coordinator/src/sync/tracker.ts';
export type FullTrackerClient = Required<TrackerClient>;
export type Fetch = typeof fetch;
export interface TrackerOptions { env?: NodeJS.ProcessEnv; fetch?: Fetch }

// Labels that carry progress where the tracker has only open and closed.
export const PROGRESS_LABELS = { inProgress: 'agent:in-progress', inReview: 'agent:in-review' } as const;
export const MAX_COMMENT = 6000;
