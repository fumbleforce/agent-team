import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LibraryAgent, packageRoot, Role, TeamTemplate } from '@agent-team/protocol';
import { boot } from '../http/testing.ts';

const read = (name: string) => JSON.parse(readFileSync(path.join(packageRoot(), 'blueprints', name), 'utf8')) as Record<string, { roles?: string[] }>;

test('every shipped role and library agent is valid, and every agent wears roles that exist', () => {
  const roles = read('roles.json'), agents = read('library-agents.json');
  for (const role of Object.values(roles)) Role.parse(role);
  for (const [slug, agent] of Object.entries(agents)) { LibraryAgent.parse(agent); for (const role of agent.roles ?? []) assert.ok(roles[role], `${slug} wears the unknown role ${role}`); }
  for (const template of Object.values(read('team-templates.json'))) { const parsed = TeamTemplate.parse(template); assert.equal(parsed.seats.filter(seat => seat.isPm).length, 1, `${parsed.name} has exactly one PM`); for (const seat of parsed.seats) for (const role of seat.roles) assert.ok(roles[role], `${parsed.name}: unknown role ${role}`); }
  for (const name of ['jeff', 'gandalf', 'joker', 'onion', 'rams', 'steve', 'overmind', 'jarvis']) assert.ok(agents[name], `the original persona ${name} is hireable`);
});

test('the personas are in the library of a new organization and can be hired into a team with their character intact', async () => {
  const { coordinator, db, call, owner, project } = await boot();
  try {
    const cookie = await owner();
    await project('app');
    const library = (await call('/api/library/agents', { cookie })).json.items as { slug: string; doc: { name: string } }[];
    assert.ok(library.some(item => item.slug === 'gandalf' && item.doc.name === 'Gandalf'));
    assert.equal((await call('/api/projects/app/team/hire', { cookie, body: { library: 'joker' } })).status, 200);
    const joker = await db.selectFrom('agents').select(['name', 'title', 'persona']).where('name', '=', 'Joker').executeTakeFirstOrThrow();
    assert.deepEqual([joker.title, /Delights in breaking things/.test(joker.persona)], ['Tester', true]);
    assert.deepEqual((await db.selectFrom('agent_roles').innerJoin('agents', 'agents.id', 'agent_roles.agent_id').select('role_slug').where('agents.name', '=', 'Joker').execute()).map(row => row.role_slug), ['tester']);
  } finally { await coordinator.close(); }
});
