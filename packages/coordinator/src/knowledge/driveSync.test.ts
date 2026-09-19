import { createHash } from 'node:crypto';
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
  const drive = createDriveSync(context, { env: { GOOGLE_DRIVE_TOKEN: 'ya29.test' }, fetch: async (url, init) => { calls.push({ method: init.method, url, auth: init.headers.authorization!, body: init.body ?? '' }); return { ok: true, status: 200, json: async () => ({ id: 'file-1' }), text: async () => '' }; } });
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

// A folder in memory: uploads land in it, listing reports content hashes, downloads return the text.
function fakeFolder() {
  const files = new Map<string, string>(), uploads: string[] = [];
  const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => String(body) });
  const request = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === 'GET' && url.includes('alt=media')) return reply(files.get(/files\/([^?]+)/.exec(url)![1]!)!);
    if (init.method === 'GET') return reply({ files: [...files].map(([id, text]) => ({ id, name: id, md5Checksum: createHash('md5').update(text).digest('hex') })) });
    const id = /files\/([^?]+)\?/.exec(url)?.[1] ?? `file-${files.size + 1}`;
    files.set(id, init.body!.split('content-type: text/markdown\r\n\r\n')[1]!.split('\r\n--agent-team-page--')[0]!);
    uploads.push(id);
    return reply({ id });
  };
  return { files, uploads, request };
}

async function setup() {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const context = createContext({ storage, machineToken: 'x'.repeat(24) });
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  await createIntegrations(context, createTurns(context)).connect('u1', projectId, ConnectionBody.parse({ kind: 'google-drive', name: 'Drive', category: 'storage', credentialRef: 'GOOGLE_DRIVE_TOKEN', config: { folder: 'folder-1' } }));
  const knowledge = createKnowledge(context), scope = { type: 'project' as const, id: projectId }, folder = fakeFolder();
  const page = await knowledge.write({ kind: 'agent', id: 'ada' }, { scope, path: 'payments/idempotency.md', title: 'Idempotency', body: 'Key on mount.' });
  const drive = createDriveSync(context, { env: { GOOGLE_DRIVE_TOKEN: 'ya29.test' }, fetch: folder.request });
  return { storage, knowledge, scope, folder, page, drive };
}

test('an edit made in the folder becomes a revision authored by the sync, and nothing echoes either way', async () => {
  const { storage, knowledge, folder, page, drive } = await setup();
  assert.equal(await drive.sync(), 1);
  // Our own upload is not an inbound change.
  assert.equal(await drive.pull(), 0);
  folder.files.set('unlinked', '# Stray\n\nIgnored.\n');
  folder.files.set('file-1', '# Idempotency\n\nKey on mount, always.\n');
  assert.equal(await drive.pull(), 1);
  const read = await knowledge.read(page.id);
  assert.deepEqual([read.rev, read.body, read.authorKind, read.authorId], [2, 'Key on mount, always.', 'system', 'folder-sync']);
  // The pulled revision is not pushed back, and the same remote text is not pulled twice.
  assert.equal(await drive.sync(), 0);
  assert.equal(await drive.pull(), 0);
  assert.equal(folder.uploads.length, 1);
  assert.equal((await knowledge.history(page.id)).length, 2);
  await storage.close();
});

test('a page edited on both sides keeps the local revision current and the remote one as a sibling', async () => {
  const { storage, knowledge, scope, folder, page, drive } = await setup();
  await drive.sync();
  await knowledge.write({ kind: 'agent', id: 'ada' }, { scope, path: 'payments/idempotency.md', title: 'Idempotency', body: 'Local edit.' });
  folder.files.set('file-1', '# Idempotency\n\nRemote edit.\n');
  assert.equal(await drive.pull(), 1);
  const read = await knowledge.read(page.id);
  assert.deepEqual([read.rev, read.body], [2, 'Local edit.']);
  const history = await knowledge.history(page.id);
  assert.deepEqual(history.map(row => [row.rev_no, row.author_id]), [[3, 'folder-sync'], [2, 'ada'], [1, 'ada']]);
  const sibling = await storage.db.selectFrom('kb_revisions').select('body').where('page_id', '=', page.id).where('rev_no', '=', 3).executeTakeFirstOrThrow();
  assert.equal(sibling.body, 'Remote edit.');
  assert.equal((await storage.db.selectFrom('events').select('type').where('type', '=', 'kb.page_conflict').execute()).length, 1);
  // The sibling is recorded once; the local text then goes out and settles the folder.
  assert.equal(await drive.pull(), 0);
  assert.equal(await drive.sync(), 1);
  assert.equal(folder.files.get('file-1'), '# Idempotency\n\nLocal edit.\n');
  assert.deepEqual([await drive.pull(), await drive.sync()], [0, 0]);
  // The next local write numbers past the sibling.
  assert.equal((await knowledge.write({ kind: 'agent', id: 'ada' }, { scope, path: 'payments/idempotency.md', title: 'Idempotency', body: 'Later.', expectedRev: 2 })).rev, 4);
  await storage.close();
});
