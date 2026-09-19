import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.ts';
import { startCoordinator } from '../server.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const TOKEN = 'x'.repeat(24);

test('a capture request becomes a model-free turn; the uploaded image becomes the snapshot and an issue can be raised on it', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null });
  try {
  await seedDemo(coordinator.context);
  const db = coordinator.context.storage.db;
  const login = await fetch(`${coordinator.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'demo@example.com', password: 'demo-password-1234' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const json = async (path: string, body?: unknown) => { const response = await fetch(coordinator.url + path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { cookie, 'content-type': 'application/json' } }); return { status: response.status, body: await response.json() as any }; };
  const worker = async (path: string, body: unknown) => { const response = await fetch(coordinator.url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
  const upload = (turnId: string, headers: Record<string, string>, token = TOKEN) => fetch(`${coordinator.url}/worker/turns/${turnId}/artifacts`, { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${token}`, ...headers }, body: PNG });

  const project = await db.selectFrom('projects').select('id').where('slug', '=', 'checkout-v2').executeTakeFirstOrThrow();
  const { body: { id: envId } } = await json('/api/projects/checkout-v2/product', { name: 'capture-target', url: 'https://staging.example.com/' });
  assert.equal((await json(`/api/projects/checkout-v2/envs/${envId}/capture`, { viewport: 'huge' })).status, 400);
  assert.equal((await json('/api/projects/checkout-v2/envs/nope/capture', { viewport: 'mobile' })).status, 404);
  const requested = await json(`/api/projects/checkout-v2/envs/${envId}/capture`, { viewport: 'mobile' });
  assert.deepEqual([requested.status, requested.body.state], [200, 'requested']);
  // Asking again while it waits answers with the same request.
  assert.equal((await json(`/api/projects/checkout-v2/envs/${envId}/capture`, { viewport: 'mobile' })).body.id, requested.body.id);
  assert.equal((await db.selectFrom('work_items').select('id').where('kind', '=', 'capture').execute()).length, 1);

  const { body: { turn } } = await worker('/worker/claim', { workerId: 'w1', free: { bounded: 1 }, projects: [project.id] });
  assert.deepEqual([turn.kind, turn.capture], ['capture', { url: 'https://staging.example.com/', viewport: 'mobile' }]);
  const row = await db.selectFrom('turns').select(['lane', 'access']).where('id', '=', turn.turnId).executeTakeFirstOrThrow();
  assert.deepEqual({ ...row }, { lane: 'bounded', access: 'none' });

  const lease = { 'x-worker-id': 'w1', 'x-lease-token': turn.leaseToken, 'x-latency-ms': '812' };
  assert.equal((await upload(turn.turnId, lease, 'wrong-token-wrong-token-0000')).status, 401);
  assert.equal((await upload(turn.turnId, { ...lease, 'x-lease-token': 'stolen' })).status, 409);
  const stored = await upload(turn.turnId, lease);
  assert.equal(stored.status, 200);
  const { snapshotId, attachmentId } = await stored.json() as { snapshotId: string; attachmentId: string };
  assert.equal(snapshotId, requested.body.id);
  assert.equal((await upload(turn.turnId, lease)).status, 409);
  assert.equal((await worker(`/worker/turns/${turn.turnId}/finish`, { workerId: 'w1', leaseToken: turn.leaseToken, outcome: { state: 'completed', summary: 'Captured' } })).status, 200);

  const view = await json('/api/projects/checkout-v2/product');
  const environment = view.body.environments.find((item: any) => item.id === envId);
  assert.deepEqual([environment.last_status, environment.last_latency_ms], ['ok', 812]);
  assert.deepEqual(view.body.snapshots.map((item: any) => [item.id, item.env_id, item.viewport, item.state, item.attachment_id]), [[snapshotId, envId, 'mobile', 'captured', attachmentId]]);
  const event = await db.selectFrom('events').select(['type', 'project_id', 'payload']).where('type', '=', 'snapshot.captured').executeTakeFirstOrThrow();
  assert.deepEqual([event.project_id, JSON.parse(event.payload).snapshotId], [project.id, snapshotId]);
  const served = await fetch(`${coordinator.url}/api/attachments/${attachmentId}`, { headers: { cookie } });
  assert.deepEqual([served.headers.get('content-type'), (await served.arrayBuffer()).byteLength], ['image/png', PNG.length]);

  // The marker and description flow works on a captured snapshot exactly as on a pasted one.
  const issue = await json('/api/projects/checkout-v2/issues', { title: 'Pay button is cut off', body: 'On a phone the button leaves the screen.', source: 'product', attachmentId, markers: [{ x: 0.5, y: 0.9, note: '' }], environment: 'capture-target' });
  assert.equal(issue.status, 200);
  assert.equal((await json(`/api/threads/${issue.body.threadId}/messages`)).body.messages[0].payload.attachmentId, attachmentId);

  // A turn that ends without an image fails its request, and the environment says so.
  // The issue queued a triage for the same seat, which would rightly run first; it is not what this test is about.
  await db.updateTable('work_items').set({ state: 'done' }).where('kind', '=', 'triage').execute();
  await json(`/api/projects/checkout-v2/envs/${envId}/capture`, { viewport: 'desktop' });
  const second = (await worker('/worker/claim', { workerId: 'w1', free: { bounded: 1 }, projects: [project.id] })).body.turn;
  assert.equal(second.kind, 'capture');
  await worker(`/worker/turns/${second.turnId}/finish`, { workerId: 'w1', leaseToken: second.leaseToken, outcome: { state: 'failed', stopReason: 'capture', summary: 'No browser found to capture with' } });
  const after = await json('/api/projects/checkout-v2/product');
  assert.deepEqual([after.body.snapshots[0].state, after.body.snapshots[0].error, after.body.environments.find((item: any) => item.id === envId).last_status], ['failed', 'No browser found to capture with', 'failed']);
  assert.ok(await db.selectFrom('events').select('seq').where('type', '=', 'snapshot.failed').executeTakeFirst());
  } finally { await coordinator.close(); }
});
