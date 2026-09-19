import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { ConnectionBody, createIntegrations } from '../repos/integrations.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createTurns } from '../runtime/turns.ts';
import { createDriveSync } from './driveSync.ts';
import { createKnowledge } from './knowledge.ts';

test('pages are created once in the folder, updated in place on a new revision, and left alone otherwise', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  await createIntegrations(context, createTurns(context)).connect('u1', projectId, ConnectionBody.parse({ kind: 'google-drive', name: 'Drive', category: 'storage', credentialRef: 'GOOGLE_DRIVE_TOKEN', config: { folder: 'folder-1' } }));
  const knowledge = createKnowledge(context);
  const scope = { type: 'project' as const, id: projectId };
  await knowledge.write({ kind: 'agent', id: 'ada' }, { scope, path: 'payments/idempotency.md', title: 'Idempotency', body: 'Key on mount.' });

  const calls: { method: string; url: string; auth: string; body: string }[] = [];
  const drive = createDriveSync(context, { env: { GOOGLE_DRIVE_TOKEN: 'ya29.test' }, fetch: async (url, init) => { calls.push({ method: init.method, url, auth: init.headers.authorization!, body: init.body ?? '' }); return { ok: true, status: 200, json: async () => ({ id: 'file-1' }) }; } });
  assert.equal(await drive.sync(), 1);
  assert.equal(await drive.sync(), 0);
  assert.deepEqual([calls[0]!.method, calls[0]!.auth], ['POST', 'Bearer ya29.test']);
  assert.match(calls[0]!.body, /"parents":\["folder-1"\]/);
  assert.match(calls[0]!.body, /payments › idempotency\.md/);

  await knowledge.write({ kind: 'agent', id: 'ada' }, { scope, path: 'payments/idempotency.md', title: 'Idempotency', body: 'Key on mount. 409 means it exists.' });
  assert.equal(await drive.sync(), 1);
  assert.deepEqual([calls[1]!.method, calls[1]!.url.includes('/files/file-1')], ['PATCH', true]);
  // Without the token in the environment nothing is sent.
  assert.equal(await createDriveSync(context, { env: {}, fetch: async () => { throw new Error('unreachable'); } }).sync(), 0);
  await storage.close();
});
