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

// One contract for single bodies, passed by every kind: what is put comes back byte for byte, a missing key is null, removing twice is fine.
function fakeBucket() {
  const objects = new Map<string, Buffer>();
  const run = async (args: string[]) => {
    if (args[1] === 'cp' && args[3]!.startsWith('s3://')) objects.set(args[3]!, fs.readFileSync(args[2]!));
    else if (args[1] === 'cp') { const found = objects.get(args[2]!); if (!found) throw new Error('aws s3 cp: fatal error: An error occurred (404) when calling the HeadObject operation: Key does not exist'); fs.writeFileSync(args[3]!, found); }
    else if (args[1] === 'rm') objects.delete(args[2]!);
    return '';
  };
  return { run, objects };
}
const bucket = fakeBucket();
const STORES = { local: () => createArtifacts('local', { root: fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-store-')) }), s3: () => createArtifacts('s3', { bucket: 'team-runs', run: bucket.run }) };

for (const [kind, create] of Object.entries(STORES)) {
  test(`${kind} keeps single bodies by key: put, get, remove, and never leaves its root`, async () => {
    const store = create(), bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await store.put('steps/turn-1/3-output', bytes);
    assert.deepEqual(await store.get('steps/turn-1/3-output'), bytes);
    assert.equal(await store.get('steps/turn-1/4-output'), null);
    await store.remove('steps/turn-1/3-output');
    await store.remove('steps/turn-1/3-output');
    assert.equal(await store.get('steps/turn-1/3-output'), null);
    for (const key of ['../escape', 'a//b', '/rooted', 'a/../../b', 'a\\b', '']) await assert.rejects(async () => store.put(key, bytes), /Invalid artifact key/, key);
  });
}

test('s3 addresses single bodies under the prefix', async () => {
  await createArtifacts('s3', { bucket: 'team-runs', prefix: 'p', run: bucket.run }).put('steps/t/1-image', new Uint8Array([1]));
  assert.ok(bucket.objects.has('s3://team-runs/p/steps/t/1-image'));
});
