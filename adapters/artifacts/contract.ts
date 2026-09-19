// Where finished runs archive their journal, full event stream, stderr and diff. The event log is
// the live tail; artifacts are the durable record.
export interface ArtifactUpload { jobId: string; runDir: string; files: readonly string[] }
export interface ArtifactResult { kind: string; location: string; files: string[]; links: Record<string, string> }
export interface ArtifactStore { kind: string; upload(input: ArtifactUpload): Promise<ArtifactResult> }
