import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_DIR, blueprintDir, blueprintFile, loadRoster, loadRolesFile, subagentRoles } from './blueprint.mjs';
import { DEFAULT_ROSTER } from './roster.mjs';
import { loadSharedConfig } from './runner.mjs';

test('without a selection the toolkit itself is the blueprint', () => {
  assert.equal(blueprintDir(PACKAGE_DIR, {}), PACKAGE_DIR);
  assert.deepEqual(subagentRoles(PACKAGE_DIR, {}), ['team-pm', 'team-ux', 'team-dev', 'team-tester', 'team-reviewer']);
  assert.equal(loadRoster(DEFAULT_ROSTER, PACKAGE_DIR, {}), DEFAULT_ROSTER);
  assert.equal(blueprintFile('portraits/team-dev.webp', { env: {} }), path.join(PACKAGE_DIR, 'portraits', 'team-dev.webp'));
});

test('a named blueprint under teams/ supplies roles, prompts and roster, falling back to shared files', () => {
  const env = { AGENT_TEAM_BLUEPRINT: 'research-desk' };
  assert.equal(blueprintDir(PACKAGE_DIR, env), path.join(PACKAGE_DIR, 'teams', 'research-desk'));
  assert.deepEqual(subagentRoles(PACKAGE_DIR, env), ['team-pm', 'team-researcher', 'team-writer', 'team-editor']);
  assert.deepEqual(loadRolesFile(PACKAGE_DIR, env).team.defaultRoles, ['team-researcher', 'team-writer', 'team-editor']);
  const roster = loadRoster(DEFAULT_ROSTER, PACKAGE_DIR, env);
  assert.equal(roster['team-researcher'].name, 'Ada'); assert.equal(roster['team-dev'], undefined);
  const shared = loadSharedConfig(PACKAGE_DIR, ['team-researcher', 'team-editor'], env);
  assert.deepEqual(Object.keys(shared.agent).sort(), ['team-coordinator', 'team-editor', 'team-ideation', 'team-owner', 'team-researcher']);
  assert.match(shared.agent['team-researcher'].prompt, /Distrusts summaries|primary source/);
  assert.deepEqual(shared.instructions, [path.join(PACKAGE_DIR, 'OWNER_PREFERENCES.md')], 'shared instructions fall back to the toolkit copy');
  assert.equal(shared.blueprint, path.join(PACKAGE_DIR, 'teams', 'research-desk'));
  assert.throws(() => loadSharedConfig(PACKAGE_DIR, ['team-dev'], env), /not a shared subagent/);
  assert.equal(blueprintFile('portraits/team-researcher.webp', { env }), null, 'no portrait, no fallback to another face');
  for (const bad of ['missing', '../etc', 'Research']) assert.throws(() => blueprintDir(PACKAGE_DIR, { AGENT_TEAM_BLUEPRINT: bad }), /no roles.json/);
});

test('a blueprint directory is validated for the roles the platform addresses by name', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-blueprint-'));
  try {
    mkdirSync(path.join(dir, 'agents'));
    writeFileSync(path.join(dir, 'roles.json'), JSON.stringify({ agent: { 'team-pm': { mode: 'subagent', prompt: 'x' } } }));
    assert.throws(() => loadRolesFile(PACKAGE_DIR, { AGENT_TEAM_BLUEPRINT: dir }), /requires agent.team-coordinator/);
    writeFileSync(path.join(dir, 'roles.json'), JSON.stringify({ agent: { 'team-coordinator': { mode: 'primary', prompt: '{file:./agents/team-coordinator.md}' }, 'team-pm': { mode: 'subagent', prompt: 'x' } } }));
    writeFileSync(path.join(dir, 'agents', 'team-coordinator.md'), 'Coordinate');
    writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({ 'team-coordinator': { name: 'A', title: 'c', voice: 'v' } }));
    assert.throws(() => loadRoster(DEFAULT_ROSTER, PACKAGE_DIR, { AGENT_TEAM_BLUEPRINT: dir }), /requires team-pm/);
    writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({ 'team-coordinator': { name: 'A', title: 'c', voice: 'v' }, 'team-pm': { name: 'B', title: 'p', voice: 'v' }, 'team-owner': { name: 'C', title: 'o', voice: 'v' }, 'bad role': { name: 'x', title: 'y', voice: 'z' } }));
    assert.throws(() => loadRoster(DEFAULT_ROSTER, PACKAGE_DIR, { AGENT_TEAM_BLUEPRINT: dir }), /must look like team-/);
    writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({ 'team-coordinator': { name: 'A', title: 'c', voice: 'v' }, 'team-pm': { name: 'B', title: 'p', voice: 'v' }, 'team-owner': { name: 'C', title: 'o', voice: 'v' } }));
    assert.equal(loadRoster(DEFAULT_ROSTER, PACKAGE_DIR, { AGENT_TEAM_BLUEPRINT: dir })['team-pm'].name, 'B');
    assert.equal(loadSharedConfig(PACKAGE_DIR, null, { AGENT_TEAM_BLUEPRINT: dir }).agent['team-coordinator'].prompt, 'Coordinate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
