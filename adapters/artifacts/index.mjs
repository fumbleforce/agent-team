import * as local from './local.mjs';
import * as s3 from './s3.mjs';

// Where finished runs archive their journal, full event stream, stderr and diff. The queue's
// events table is the live tail; artifacts are the durable record.
const ADAPTERS = { local, s3 };
export const ARTIFACT_KINDS = Object.keys(ADAPTERS);
export const DEFAULT_ARTIFACTS = 'local';

export function artifactsAdapter(kind = DEFAULT_ARTIFACTS) {
  if (!Object.hasOwn(ADAPTERS, kind)) throw new Error(`Unknown artifacts kind: ${kind}. Use ${ARTIFACT_KINDS.join(', ')}`);
  return ADAPTERS[kind];
}

export function createArtifacts(kind = DEFAULT_ARTIFACTS, options = {}) {
  return artifactsAdapter(kind).create(options);
}
