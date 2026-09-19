import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARTIFACT_KINDS, createArtifacts } from './index.ts';

function runDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
  fs.writeFileSync(path.join(dir, 'journal.md'), 'journal'); fs.writeFileSync(path.join(dir, 'diff.patch'), 'diff');
  return dir;
}
const FILES = ['journal.md', 'diff.patch', 'missing.log'];

test('the index creates stores by kind and rejects unknown kinds', () => {
  assert.deepEqual(ARTIFACT_KINDS, ['local', 's3']);
  assert.equal(createArtifacts().kind, 'local');
  assert.throws(() => createArtifacts('balloon'), /Unknown artifacts kind/);
  assert.throws(() => createArtifacts('s3', { bucket: 'Bad_Bucket' }), /valid bucket name/);
});

test('local copies the files that exist under root/jobId and links to them', async () => {
  const dir = runDir(), root = path.join(dir, 'store');
  const result = await createArtifacts('local', { root }).upload({ jobId: 'job-1', runDir: dir, files: FILES });
  assert.deepEqual([result.kind, result.location, result.files], ['local', path.join(root, 'job-1'), ['journal.md', 'diff.patch']]);
  assert.equal(fs.readFileSync(path.join(root, 'job-1', 'journal.md'), 'utf8'), 'journal');
  assert.equal(result.links['diff.patch'], `file://${path.join(root, 'job-1', 'diff.patch')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('s3 copies through the AWS CLI and links to the console, or presigns when asked', async () => {
  const dir = runDir(); const calls: string[][] = [];
  const run = async (args: string[]) => { calls.push(args); return args[1] === 'presign' ? 'https://signed.example/x' : ''; };
  const result = await createArtifacts('s3', { bucket: 'team-runs', region: 'eu-north-1', run }).upload({ jobId: 'job-1', runDir: dir, files: FILES });
  assert.deepEqual([result.location, result.files], ['s3://team-runs/agent-team/job-1/', ['journal.md', 'diff.patch']]);
  assert.deepEqual(calls[0], ['s3', 'cp', path.join(dir, 'journal.md'), 's3://team-runs/agent-team/job-1/journal.md', '--only-show-errors', '--region', 'eu-north-1']);
  assert.equal(result.links['journal.md'], `https://s3.console.aws.amazon.com/s3/object/team-runs?prefix=${encodeURIComponent('agent-team/job-1/journal.md')}`);
  const signed = await createArtifacts('s3', { bucket: 'team-runs', prefix: 'p', presignSeconds: 600, run }).upload({ jobId: 'j', runDir: dir, files: ['journal.md'] });
  assert.equal(signed.links['journal.md'], 'https://signed.example/x');
  assert.deepEqual(calls.at(-1), ['s3', 'presign', 's3://team-runs/p/j/journal.md', '--expires-in', '600']);
  fs.rmSync(dir, { recursive: true, force: true });
});
