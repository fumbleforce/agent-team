import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '@agent-team/protocol';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createVersionedDocs } from './versionedDocs.ts';

const LIBRARY = { type: 'library' as const, id: '' };
const shipped = JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', 'roles.json'), 'utf8')) as Record<string, { summary: string }>;

test('shipped roles are valid, seeded once, versioned on save, and revertible', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  const docs = createVersionedDocs(createContext({ storage, machineToken: 'x'.repeat(24) }));
  await docs.seed('role', LIBRARY, shipped);
  assert.deepEqual((await docs.list('role', LIBRARY)).map(role => role.slug), ['chief-of-staff', 'designer', 'developer', 'editor', 'front-desk', 'hr', 'ideation', 'marketer', 'pm', 'researcher', 'reviewer', 'sales', 'writer']);

  const tester = await docs.get('role', LIBRARY, 'reviewer');
  assert.deepEqual([tester.doc.permissions.shell, tester.doc.approvalKinds], ['restricted', ['reviewer']], 'the reviewer runs what it checks, and gives the one approval a change needs');
  assert.equal(await docs.save('role', LIBRARY, 'reviewer', { ...tester.doc, summary: 'Owns the harness' }, { author: 'owner', expectedVersion: 1 }), 2);
  await assert.rejects(docs.save('role', LIBRARY, 'reviewer', tester.doc, { author: 'owner', expectedVersion: 1 }), /version 2/);
  await assert.rejects(docs.save('role', LIBRARY, 'reviewer', { ...tester.doc, permissions: { shell: 'root' } }, { author: 'owner' }), /permissions/);

  // Seeding again never overwrites an owner's change.
  await docs.seed('role', LIBRARY, shipped);
  assert.equal((await docs.get('role', LIBRARY, 'reviewer')).doc.summary, 'Owns the harness');
  assert.equal(await docs.revert('role', LIBRARY, 'reviewer', 1, 'owner'), 3);
  assert.equal((await docs.get('role', LIBRARY, 'reviewer')).doc.summary, shipped.reviewer!.summary);
  assert.deepEqual((await docs.history('role', LIBRARY, 'reviewer')).map(row => row.version), [3, 2, 1]);
  await assert.rejects(docs.get('role', { type: 'project', id: 'p' }, 'reviewer'), /not found/);
  await storage.close();
});
