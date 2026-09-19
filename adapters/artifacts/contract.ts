// Where finished runs archive their journal, full event stream, stderr and diff. The event log is
// the live tail; artifacts are the durable record.
export interface ArtifactUpload { jobId: string; runDir: string; files: readonly string[] }
export interface ArtifactResult { kind: string; location: string; files: string[]; links: Record<string, string> }
// The same store also keeps single bodies by key: what a trace step carries that is too large for a database row (run output, the
// raw engine stream, screenshots). A key is a relative path of plain segments; `get` answers null for a key that is not there and
// `remove` of a missing key is not an error, so retention can run twice.
export interface ArtifactStore {
  kind: string;
  upload(input: ArtifactUpload): Promise<ArtifactResult>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
}

const SEGMENT = /^[\w-][\w.-]{0,127}$/;
// Keys are made by the platform, never by a client; this still refuses anything that could leave the store's root.
export function checkedKey(key: string): string[] {
  const segments = key.split('/');
  if (segments.length === 0 || segments.length > 8 || !segments.every(segment => SEGMENT.test(segment))) throw new Error(`Invalid artifact key: ${key.slice(0, 80)}`);
  return segments;
}
