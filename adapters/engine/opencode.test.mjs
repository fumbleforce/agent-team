import test from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './opencode.mjs';

test('integration servers reach the roles configuration with headers and per-role denials', () => {
  const roles = { agent: { 'team-coordinator': { mode: 'primary', permission: { bash: { '*': 'allow' } } }, 'team-dev': { mode: 'subagent' }, 'team-tester': { mode: 'subagent', permission: { edit: 'deny' } } } };
  const env = environment({ PATH: '/bin' }, { roles, denied: ['gh pr merge'], mcp: { tracker: { type: 'http', url: 'https://t.example/' }, slack: { type: 'http', url: 'https://s.example/', headers: { Authorization: 'Bearer x' } } }, access: { slack: ['team-dev'], tracker: null } });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.mcp.slack, { type: 'remote', url: 'https://s.example/', enabled: true, headers: { Authorization: 'Bearer x' } });
  assert.deepEqual(config.mcp.tracker, { type: 'remote', url: 'https://t.example/', enabled: true });
  assert.equal(config.agent['team-dev'].permission?.['slack_*'], undefined);
  assert.equal(config.agent['team-tester'].permission['slack_*'], 'deny');
  assert.equal(config.agent['team-coordinator'].permission['slack_*'], 'deny');
  assert.equal(config.agent['team-coordinator'].permission.bash['*gh pr merge*'], 'deny');
  assert.throws(() => environment({ OPENCODE_CONFIG_CONTENT: '{}' }, { roles }), /Preexisting/);
});
