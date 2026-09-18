import * as linear from './linear.mjs';
import * as github from './github.mjs';

const ADAPTERS = { linear, github };
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

// Whether the environment holds a credential for a tracker (some accept more than one variable).
export function trackerCredentialPresent(kind, env = process.env) {
  const adapter = trackerAdapter(kind);
  return adapter.hasCredential ? adapter.hasCredential(env) : Boolean(env[adapter.API_KEY_VARIABLE]);
}
// Tracker kinds whose credential the environment holds.
export function trackersWithCredentials(env = process.env) { return TRACKER_KINDS.filter(kind => trackerCredentialPresent(kind, env)); }

// Issue identifiers are validated by the tracker that issues them.
export function isIssueId(kind, value) {
  return typeof value === 'string' && trackerAdapter(kind).ISSUE_PATTERN.test(value);
}
