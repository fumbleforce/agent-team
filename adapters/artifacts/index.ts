import type { ArtifactStore } from './contract.ts';
import { create as local, type LocalOptions } from './local.ts';
import { create as s3, type S3Options } from './s3.ts';

export type ArtifactOptions = LocalOptions & S3Options;
const ADAPTERS: Record<string, (options: ArtifactOptions) => ArtifactStore> = { local, s3 };
export const ARTIFACT_KINDS = Object.keys(ADAPTERS);
export const DEFAULT_ARTIFACTS = 'local';

export function createArtifacts(kind: string = DEFAULT_ARTIFACTS, options: ArtifactOptions = {}): ArtifactStore {
  const create = Object.hasOwn(ADAPTERS, kind) ? ADAPTERS[kind] : undefined;
  if (!create) throw new Error(`Unknown artifacts kind: ${kind}. Use ${ARTIFACT_KINDS.join(', ')}`);
  return create(options);
}
