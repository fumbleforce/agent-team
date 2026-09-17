import * as linear from './linear.mjs';

const ADAPTERS = { linear };
export const TRACKER_KINDS = Object.keys(ADAPTERS);
export const DEFAULT_TRACKER = 'linear';

export function trackerAdapter(kind = DEFAULT_TRACKER) {
  if (!Object.hasOwn(ADAPTERS, kind)) throw new Error(`Unknown tracker kind: ${kind}. Use ${TRACKER_KINDS.join(', ')}`);
  return ADAPTERS[kind];
}

// A connected client for the manifest's tracker; credentials come from the adapter's variable.
export function trackerClient(kind = DEFAULT_TRACKER, options = {}) {
  return trackerAdapter(kind).createClient(options);
}

// Issue identifiers are validated by the tracker that issues them.
export function isIssueId(kind, value) {
  return typeof value === 'string' && trackerAdapter(kind).ISSUE_PATTERN.test(value);
}
