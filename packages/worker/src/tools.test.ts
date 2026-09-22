import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTurns, startCoordinator } from '@agent-team/coordinator';
import { claude } from '../../../adapters/engine/claude.ts';
import type { EngineAdapter } from '../../../adapters/engine/contract.ts';
import { fake } from '../../../adapters/engine/fake.ts';
import { createWorker } from './worker.ts';

const TOKEN = 'machine-token-for-tests-0123456789', CRM_TOKEN = 'crm-secret-value-0123';

// A tool the owner connected (a CRM behind an MCP server) reaches the turns of the seats it is meant for: the worker gets the server with
// the token the platform keeps sealed, the engine's MCP config carries it, and the prompt says what the tool is for without the token.
test('a connected tool reaches a matching seat\'s turn with its sealed token, and no other seat\'s', async () => {
  const coordinator = await startCoordinator({ port: 0, storage: { kind: 'sqlite', path: ':memory:' }, machineToken: TOKEN, webRoot: null, trackers: null });
  try {
    const { context } = coordinator, db = context.storage.db;
    const response = await fetch(`${coordinator.url}/machine/projects`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'sales', name: 'Sales' }) });
    const projectId = ((await response.json()) as { id: string }).id;
    await context.secrets.set('CRM_MCP_TOKEN', CRM_TOKEN, null);
    await db.insertInto('connections').values({ id: 'conn-crm', project_id: projectId, kind: 'mcp', name: 'crm', category: 'business', mode: 'agent tool', config: JSON.stringify({ name: 'crm', url: 'http://127.0.0.1:9/mcp', purpose: 'the customer list', roles: 'sales', target: 'connection' }), status: 'connected', status_detail: null, credential_ref: 'CRM_MCP_TOKEN', last_sync_at: null, created_at: 1 }).execute();
    const [seller, other] = await db.selectFrom('agents').innerJoin('projects', 'projects.team_id', 'agents.team_id').select('agents.id').where('projects.id', '=', projectId).orderBy('agents.sort').limit(2).execute();
    await db.insertInto('agent_roles').values({ agent_id: seller!.id, role_slug: 'sales' }).execute();
    const thread = await db.selectFrom('threads').select('id').where('project_id', '=', projectId).where('kind', '=', 'discussion').executeTakeFirstOrThrow();

    // The engine that runs is the fake one; what the claude adapter would have written for the same turn is kept to look at.
    const seen: { mcp: Record<string, { url: string; headers?: Record<string, string> }>; args: string[]; system: string; prompt: string }[] = [];
    const engine: EngineAdapter = { ...fake, capabilities: { ...fake.capabilities, mcp: 'http' }, prepare(spec, turnDir, env) {
      const shown = claude.prepare(spec, turnDir, env);
      seen.push({ mcp: (JSON.parse(shown.files.find(file => file.path.endsWith('mcp.json'))!.content) as { mcpServers: never }).mcpServers, args: shown.args, system: spec.systemPrompt, prompt: spec.prompt });
      return fake.prepare(spec, turnDir, env);
    } };
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-team-tools-'));
    const worker = createWorker({ coordinatorUrl: coordinator.url, token: TOKEN, workerId: 'w1', stateDir, lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [projectId]: stateDir }, engine, timeoutMs: 5000 });
    const turns = createTurns(context);
    const reply = async (agentId: string) => { assert.ok(await turns.enqueue({ agentId, projectId, kind: 'reply', threadId: thread.id })); assert.equal(await worker.tick(), true); await worker.idle(); };

    await reply(seller!.id);
    assert.deepEqual(seen[0]!.mcp.crm, { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: `Bearer ${CRM_TOKEN}` } });
    assert.ok(seen[0]!.args.includes('mcp__crm'));
    assert.match(seen[0]!.system, /crm \(MCP tools crm_\*\): the customer list\./);
    assert.ok(![seen[0]!.system, seen[0]!.prompt].some(text => text.includes(CRM_TOKEN)), 'the token is never packet text');
    // Nothing the platform keeps about the turn holds the token, and the worker leaves no copy of it on the disk.
    const stored = JSON.stringify([await db.selectFrom('turns').selectAll().execute(), await db.selectFrom('events').select('payload').execute(), await db.selectFrom('trace_steps').selectAll().execute()]);
    assert.ok(!stored.includes(CRM_TOKEN));
    const turnDirs = readdirSync(path.join(stateDir, 'turns'));
    assert.ok(turnDirs.every(dir => !readdirSync(path.join(stateDir, 'turns', dir)).some(name => name.startsWith('tool-'))));

    await reply(other!.id);
    assert.equal(seen[1]!.mcp.crm, undefined, 'a seat without the role does not get the tool');
    assert.ok(!seen[1]!.args.includes('mcp__crm'));
    assert.ok(!seen[1]!.system.includes('crm'));

    // An engine that cannot reach remote MCP servers is not given the tool, and the trace says so.
    const plain = createWorker({ coordinatorUrl: coordinator.url, token: TOKEN, workerId: 'w2', stateDir, lanes: { work: 1, bounded: 1, deliver: 1 }, projects: { [projectId]: stateDir }, engine: fake, timeoutMs: 5000 });
    assert.ok(await turns.enqueue({ agentId: seller!.id, projectId, kind: 'reply', threadId: thread.id }));
    assert.equal(await plain.tick(), true);
    await plain.idle();
    const last = await db.selectFrom('turns').select('id').where('worker_id', '=', 'w2').executeTakeFirstOrThrow();
    const notes = await db.selectFrom('trace_steps').select('title').where('turn_id', '=', last.id).execute();
    assert.ok(notes.some(step => /Not offered to this turn: crm\. The fake engine cannot reach connected tools\./.test(step.title)), JSON.stringify(notes));
    assert.equal(existsSync(path.join(stateDir, 'turns', last.id, 'tool-crm-token')), false);
  } finally { await coordinator.close(); }
});
