import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createGitMirror } from './gitMirror.ts';
import { createKnowledge } from './knowledge.ts';

test('every revision becomes one commit, in order, and a second sync adds nothing', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1_700_000_000_000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock++ });
  const knowledge = createKnowledge(context);
  const scope = { type: 'project' as const, id: 'p1' };
  await knowledge.write({ kind: 'agent', id: 'ada' }, { scope, path: 'payments/idempotency.md', title: 'Idempotency', body: 'Key on mount.' });
  await knowledge.write({ kind: 'agent', id: 'ada' }, { scope, path: 'payments/idempotency.md', title: 'Idempotency', body: 'Key on mount. 409 means it exists.', note: 'verified on staging' });
  await knowledge.write({ kind: 'user', id: 'u1' }, { scope, path: 'conventions/frontend.md', title: 'Frontend', body: 'Abort every fetch.' });

  const directory = path.join(mkdtempSync(path.join(os.tmpdir(), 'agent-team-mirror-')), 'kb');
  const mirror = createGitMirror(context, directory);
  assert.equal(await mirror.sync(), 3);
  assert.equal(await mirror.sync(), 0);
  const log = execFileSync('git', ['-C', directory, 'log', '--reverse', '--format=%an|%s'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(log, ['agent:ada|payments/idempotency.md r1', 'agent:ada|payments/idempotency.md r2: verified on staging', 'user:u1|conventions/frontend.md r1']);
  assert.match(readFileSync(path.join(directory, 'project', 'p1', 'payments', 'idempotency.md'), 'utf8'), /409 means it exists/);

  await knowledge.write({ kind: 'agent', id: 'bram' }, { scope, path: 'conventions/frontend.md', title: 'Frontend', body: 'Abort every fetch; show the error.' });
  assert.equal(await mirror.sync(), 1);
  await storage.close();
});
