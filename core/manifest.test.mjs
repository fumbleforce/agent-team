import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifest, approvalRoles, flatTracker, ALL_ROLES, DEFAULT_ROLES } from './manifest.mjs';

const v1 = { version: 1, name: 'Legacy', instructions: ['AGENTS.md'], workspaceId: 'w', workspaceUrl: 'https://tracker.example/w', teamId: 't', projectId: 'p', projectUrl: 'https://tracker.example/w/p', readyLabel: 'agent:ready', delivery: { repository: 'owner/repo', autoMergeAuthorized: true } };

test('a version 1 manifest upgrades to version 2 with the first provider of each kind and the full pipeline', () => {
  const manifest = normalizeManifest(v1);
  assert.equal(manifest.version, 2);
  assert.deepEqual([manifest.scm.kind, manifest.tracker.kind, manifest.engine.default, manifest.worker.launcher], ['github', 'linear', 'opencode', 'local']);
  assert.equal(manifest.scm.repository, 'owner/repo'); assert.equal(manifest.scm.branchPrefix, 'agents/');
  assert.equal(manifest.tracker.readyLabel, 'agent:ready');
  assert.equal(manifest.team.roles, null, 'legacy manifests delegate to every shared subagent');
  assert.deepEqual(approvalRoles(manifest), ['tester', 'reviewer', 'pm']);
  assert.equal(manifest.delivery.baseBranch, undefined, 'a legacy delivery without baseBranch keeps building on HEAD');
  assert.equal(flatTracker(manifest).projectId, 'p'); assert.equal(flatTracker(manifest).name, 'Legacy');
});

test('a version 2 manifest fills defaults and validates each section', () => {
  const manifest = normalizeManifest({ version: 2, name: 'Modern', instructions: [], scm: { kind: 'gitlab', repository: 'group/sub/project', baseBranch: 'develop' },
    tracker: { kind: 'linear', workspaceId: 'w', workspaceUrl: 'https://tracker.example/w', teamId: 't', projectId: 'p', projectUrl: 'https://tracker.example/w/p', readyLabel: 'ready' },
    engine: { default: 'claude', billing: 'bedrock', model: 'sonnet' }, worker: { launcher: 'ec2', ami: 'ami-123' }, pm: { autonomy: 'act' }, delivery: { requiredChecks: ['humbugbot', 'test'] } });
  assert.deepEqual(manifest.team.roles, DEFAULT_ROLES);
  assert.deepEqual(approvalRoles(manifest), ['tester']);
  assert.equal(manifest.memory.injectCapTokens, 4000); assert.equal(manifest.pm.dailyCapUsd, 20);
  assert.deepEqual([manifest.delivery.repository, manifest.delivery.baseBranch], ['group/sub/project', 'develop']);
  for (const change of [{ scm: { kind: 'svn' } }, { scm: { kind: 'gitlab', branchPrefix: 'nope' } }, { engine: { default: 'claude', billing: 'free' } }, { worker: { launcher: 'balloon' } },
    { pm: { autonomy: 'yolo' } }, { team: { roles: ['team-dev', 'team-dev'] } }, { team: { roles: ['team-chef'] } }, { memory: { injectCapTokens: -1 } }, { delivery: { repository: 'other/repo' } }, { version: 3 }]) {
    assert.throws(() => normalizeManifest({ version: 2, name: 'Modern', instructions: [], tracker: { workspaceId: 'w', workspaceUrl: 'https://t.example/w', teamId: 't', projectId: 'p', projectUrl: 'https://t.example/p', readyLabel: 'r' }, scm: { repository: 'owner/repo' }, ...change }), `${JSON.stringify(change)} must be rejected`);
  }
  assert.ok(ALL_ROLES.includes('team-reviewer'));
});
