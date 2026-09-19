import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkedKey, type ArtifactStore } from './contract.ts';

// Archives run files to s3://bucket/prefix/jobId/ with the AWS CLI. Links are console URLs by
// default, or presigned URLs when `presignSeconds` is set (they expire; the dashboard shows both).
export const NAME = 's3';
export type AwsRun = (args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<string>;
export interface S3Options { bucket?: string; prefix?: string; region?: string; presignSeconds?: number; env?: NodeJS.ProcessEnv; run?: AwsRun }

const aws: AwsRun = (args, { env }) => new Promise((resolve, reject) => {
  execFile('aws', args, { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(`aws ${args.slice(0, 2).join(' ')}: ${String(stderr).trim().slice(-400) || error.message}`));
    resolve(String(stdout).trim());
  });
});

export function create({ bucket, prefix = 'agent-team', region, presignSeconds = 0, env = process.env, run = aws }: S3Options = {}): ArtifactStore {
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('s3 artifacts require a valid bucket name');
  const regionArgs = region ? ['--region', region] : [];
  const object = (key: string) => `s3://${bucket}/${prefix}/${checkedKey(key).join('/')}`;
  // The CLI copies files, so a single body passes through a private temporary file that is removed either way.
  const scratch = async <T>(work: (file: string) => Promise<T>): Promise<T> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-artifact-'));
    try { return await work(path.join(dir, 'body')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  return {
    kind: NAME,
    put: (key, bytes) => scratch(async file => { fs.writeFileSync(file, bytes, { mode: 0o600 }); await run(['s3', 'cp', file, object(key), '--only-show-errors', ...regionArgs], { env }); }),
    get: key => scratch(async file => {
      try { await run(['s3', 'cp', object(key), file, '--only-show-errors', ...regionArgs], { env }); } catch (error) { if (/404|not exist|NoSuchKey/i.test((error as Error).message)) return null; throw error; }
      return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null;
    }),
    async remove(key) { await run(['s3', 'rm', object(key), '--only-show-errors', ...regionArgs], { env }); },
    async upload({ jobId, runDir, files }) {
      const stored: string[] = []; const links: Record<string, string> = {};
      for (const name of files) {
        const source = path.join(runDir, name);
        if (!fs.existsSync(source)) continue;
        const key = `${prefix}/${jobId}/${name}`;
        await run(['s3', 'cp', source, `s3://${bucket}/${key}`, '--only-show-errors', ...regionArgs], { env });
        stored.push(name);
        links[name] = presignSeconds > 0 ? await run(['s3', 'presign', `s3://${bucket}/${key}`, '--expires-in', String(presignSeconds), ...regionArgs], { env })
          : `https://s3.console.aws.amazon.com/s3/object/${bucket}?prefix=${encodeURIComponent(key)}`;
      }
      return { kind: NAME, location: `s3://${bucket}/${prefix}/${jobId}/`, files: stored, links };
    },
  };
}
