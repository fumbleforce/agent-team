import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE_DIR } from './blueprint.mjs';
import { materialize, shippedTeams, subagentRoles, teamFromDirectory, validateTeam } from './teams.mjs';

const base = () => ({ id: 'ops', name: 'Ops', roster: { 'team-coordinator': { name: 'A', title: 'c', voice: 'v' }, 'team-pm': { name: 'B', title: 'p', voice: 'v' }, 'team-owner': { name: 'C', title: 'o', voice: 'v' }, 'team-analyst': { name: 'D', title: 'a', voice: 'v' } },
  agents: { 'team-coordinator': { mode: 'primary', prompt: 'coordinate' }, 'team-pm': { mode: 'subagent', prompt: 'plan' }, 'team-owner': { mode: 'primary', prompt: 'front desk' }, 'team-analyst': { mode: 'subagent', prompt: 'analyse', deny: ['edit'] } } });

test('a team document is validated for shape, required roles and defaults', () => {
  const team = validateTeam(base());
  assert.deepEqual(team.defaultRoles, ['team-analyst'], 'defaults are every subagent but the PM');
  assert.deepEqual(team.agents['team-analyst'].deny, ['edit']);
  assert.equal(team.description, '');
  assert.throws(() => validateTeam({ ...base(), id: 'Ops' }), /lowercase/);
  assert.throws(() => validateTeam({ ...base(), agents: { ...base().agents, 'team-pm': undefined } }), /must include team-pm/);
  assert.throws(() => validateTeam({ ...base(), agents: { ...base().agents, 'team-owner': { mode: 'subagent', prompt: 'x' } } }), /primary roles/);
  assert.throws(() => validateTeam({ ...base(), agents: { ...base().agents, 'analyst': { mode: 'subagent', prompt: 'x' } } }), /team-<word>/);
  assert.throws(() => validateTeam({ ...base(), roster: { ...base().roster, 'team-analyst': undefined } }), /roster must include team-analyst/);
  assert.throws(() => validateTeam({ ...base(), agents: { ...base().agents, 'team-analyst': { mode: 'subagent', prompt: 'x', deny: ['network'] } } }), /deny must list/);
  assert.throws(() => validateTeam({ ...base(), defaultRoles: ['team-coordinator'] }), /distinct subagent roles/);
  assert.throws(() => validateTeam({ ...base(), agents: { ...base().agents, 'team-analyst': { mode: 'subagent', prompt: 'x'.repeat(40_001) } } }), /prompt/);
});

test('directory blueprints become team documents and the toolkit ships two', () => {
  const teams = shippedTeams(PACKAGE_DIR, {});
  assert.deepEqual(teams.map(team => team.id), ['default', 'research-desk']);
  assert.deepEqual(teams[0].defaultRoles, ['team-dev', 'team-tester']);
  assert.equal(teams[0].roster['team-dev'].name, 'Gandalf');
  assert.match(teams[0].agents['team-dev'].prompt, /\w/);
  assert.deepEqual(subagentRoles(teams[1]), ['team-pm', 'team-researcher', 'team-writer', 'team-editor']);
  assert.equal(teamFromDirectory(`${PACKAGE_DIR}/teams/research-desk`).roster['team-researcher'].name, 'Ada');
});

test('materializing keeps the committed permissions as the ceiling and lets a team only tighten them', () => {
  const ceiling = { instructions: ['/shared/OWNER_PREFERENCES.md'], agent: {
    'team-coordinator': { mode: 'primary', prompt: 'old', permission: { bash: { '*': 'allow', '*git push*--force*': 'deny' } }, steps: 100 },
    'team-pm': { mode: 'subagent', prompt: 'old', permission: { edit: 'deny', bash: 'deny', task: 'deny', question: 'deny' } },
    'team-owner': { mode: 'primary', prompt: 'old', permission: { edit: 'deny' } },
  } };
  const team = validateTeam({ ...base(), agents: { ...base().agents, 'team-pm': { mode: 'subagent', prompt: 'new plan', deny: ['tracker'] } } });
  const shared = materialize(team, ceiling);
  assert.equal(shared.agent['team-coordinator'].prompt, 'coordinate', 'the stored prompt replaces the committed one');
  assert.deepEqual(shared.agent['team-coordinator'].permission, ceiling.agent['team-coordinator'].permission, 'permissions come from the ceiling');
  assert.equal(shared.agent['team-coordinator'].steps, 100);
  assert.deepEqual(shared.agent['team-pm'].permission, { edit: 'deny', bash: 'deny', task: 'deny', question: 'deny', 'tracker_*': 'deny' }, 'a deny tightens');
  assert.deepEqual(shared.agent['team-analyst'].permission, { task: 'deny', question: 'deny', 'tracker_*': 'deny', edit: 'deny' }, 'an unknown subagent gets the floor plus its own denials');
  assert.deepEqual(shared.instructions, ceiling.instructions);
  assert.deepEqual(shared.team, { id: 'ops', defaultRoles: ['team-analyst'] });
  assert.deepEqual(Object.keys(materialize(team, ceiling, { roles: ['team-analyst'] }).agent), ['team-coordinator', 'team-owner', 'team-analyst']);
  assert.throws(() => materialize(team, ceiling, { roles: ['team-dev'] }), /not a subagent of team ops/);
  const primary = validateTeam({ ...base(), roster: { ...base().roster, 'team-ideation': { name: 'E', title: 'i', voice: 'v' } }, agents: { ...base().agents, 'team-ideation': { mode: 'primary', prompt: 'ideas' } } });
  assert.throws(() => materialize(primary, ceiling), /primary role team-ideation is not in the committed roles file/);
  const flipped = validateTeam({ ...base(), agents: { ...base().agents, 'team-pm': { mode: 'primary', prompt: 'x' } } });
  assert.throws(() => materialize(flipped, ceiling), /team-pm is subagent in the committed roles file/);
});
