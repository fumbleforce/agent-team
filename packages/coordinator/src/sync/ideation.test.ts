import test from 'node:test';
import assert from 'node:assert/strict';
import { turnToken } from '../auth/secrets.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createTurns } from '../runtime/turns.ts';
import { boot, TOKEN } from '../http/testing.ts';
import type { TrackerClient, TrackerIssue } from './tracker.ts';

const IDEATION = { enabled: true, backlogCap: 5, batchSize: 1, minimumIntervalHours: 24, ideaLabel: 'idea', proposedState: 'Proposed', approvedState: 'Todo', rejectedState: 'Canceled' };
const IDEA = { title: 'Saved carts', problem: 'Carts are lost', benefit: 'More orders', scope: 'Persist the cart', successCriteria: ['Cart survives a reload'], effort: 'S', evidence: ['Three support tickets'], whyNow: 'Peak season' };

test('an ideation turn: the poll asks the PM, its ideas.propose call is bounded by the manifest, and the next poll files the issue', async () => {
  const created: { title: string; state: string }[] = [];
  const issues: TrackerIssue[] = [];
  const client: TrackerClient = { snapshot: async () => ({ allIssues: issues }), createIssue: async (_manifest, input) => { created.push({ title: input.title, state: input.state }); return { identifier: 'GH-1', url: null }; } };
  const harness = await boot({ trackers: async () => client });
  try {
    const { context } = harness.coordinator, db = harness.db;
    const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: { tracker: { kind: 'fake' }, ideation: IDEATION } });
    await harness.coordinator.poll();
    const claimed = (await createTurns(context).claim({ workerId: 'w1', free: { bounded: 1 }, projects: [projectId] }))!;
    assert.equal(claimed.kind, 'ideate');
    assert.match(claimed.packet.prompt, /ideas\.propose/);

    let id = 0;
    const rpc = async (method: string, params?: unknown) => (await (await fetch(`${harness.coordinator.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${turnToken(TOKEN, claimed.turnId, claimed.leaseToken)}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json() as any).result;
    assert.ok((await rpc('tools/list')).tools.some((tool: { name: string }) => tool.name === 'ideas.propose'));
    const tooMany = await rpc('tools/call', { name: 'ideas.propose', arguments: { proposals: [IDEA, { ...IDEA, title: 'Wishlist' }] } });
    assert.match(tooMany.content[0].text, /At most 1 ideas per turn/);
    assert.equal(created.length, 0);
    // A refused call counts against the tool's limit, which therefore leaves room for one correction.
    const accepted = await rpc('tools/call', { name: 'ideas.propose', arguments: { proposals: [IDEA] } });
    assert.equal(accepted.isError, undefined, accepted.content[0].text);
    assert.equal((await db.selectFrom('events').select('seq').where('type', '=', 'ideation.proposed').execute()).length, 1);

    await harness.coordinator.poll();
    assert.deepEqual(created, [{ title: 'Saved carts', state: 'Proposed' }]);
  } finally { await harness.coordinator.close(); }
});
