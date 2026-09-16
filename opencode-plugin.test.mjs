import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from './opencode-plugin.mjs';

test('shared roles load preferences and prompts without project-specific configuration', async () => {
  const config = {};
  (await plugin()).config(config);
  assert.equal(Object.keys(config.agent).length, 8);
  assert.equal(config.command.team.agent, 'team-owner');
  assert.equal(config.agent['team-ideation'].mode, 'primary');
  assert.match(config.agent['team-ideation'].prompt, /read-only/);
  for (const agent of Object.values(config.agent)) {
    assert.match(agent.prompt, /Owner preferences/);
    assert.doesNotMatch(agent.prompt, /\{file:/);
    assert.doesNotMatch(agent.prompt, /Myntbase|stockapp/);
  }
});

test('plugin preserves user overrides, defaults, and MCP authorization configuration', async () => {
  const hook = await plugin();
  const config = { agent: { build: { mode: 'primary' }, 'team-dev': { disable: true } },
    command: { existing: { template: 'hello' } }, mcp: { linear: { enabled: true } }, default_agent: 'build' };
  hook.config(config);
  assert.deepEqual(config.agent['team-dev'], { disable: true });
  assert.equal(config.default_agent, 'build');
  assert.deepEqual(config.mcp, { linear: { enabled: true } });
  assert.equal(config.command.existing.template, 'hello');
  assert.equal(config.command.team.agent, 'team-owner');
  assert.equal(config.agent['team-owner'].mode, 'primary');
});
