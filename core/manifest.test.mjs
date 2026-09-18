import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifest, approvalRoles, flatTracker, ALL_ROLES, DEFAULT_ROLES, validateOverrides, applyOverrides, OVERRIDABLE_SECTIONS } from './manifest.mjs';

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
  assert.equal(manifest.tracker.stallAlertAfter, 1, 'the owner stall alert is on as soon as quarantine holds a project');
  assert.equal(normalizeManifest(v1, { tracker: { stallAlertAfter: 0 } }).tracker.stallAlertAfter, 0);
  for (const value of ['1', 1.5, -1, 51]) assert.throws(() => normalizeManifest(v1, { tracker: { stallAlertAfter: value } }), /stallAlertAfter/);
  assert.equal(normalizeManifest(v1, { tracker: { stallAlertAfter: null } }).tracker.stallAlertAfter, 1, 'clearing the override restores the default');
  assert.deepEqual([manifest.delivery.repository, manifest.delivery.baseBranch], ['group/sub/project', 'develop']);
  for (const change of [{ scm: { kind: 'svn' } }, { scm: { kind: 'gitlab', branchPrefix: 'nope' } }, { engine: { default: 'claude', billing: 'free' } }, { worker: { launcher: 'balloon' } },
    { pm: { autonomy: 'yolo' } }, { team: { roles: ['team-dev', 'team-dev'] } }, { team: { roles: ['team-chef'] } }, { memory: { injectCapTokens: -1 } }, { delivery: { repository: 'other/repo' } }, { version: 3 }]) {
    assert.throws(() => normalizeManifest({ version: 2, name: 'Modern', instructions: [], tracker: { workspaceId: 'w', workspaceUrl: 'https://t.example/w', teamId: 't', projectId: 'p', projectUrl: 'https://t.example/p', readyLabel: 'r' }, scm: { repository: 'owner/repo' }, ...change }), `${JSON.stringify(change)} must be rejected`);
  }
  assert.ok(ALL_ROLES.includes('team-reviewer'));
});

test('dashboard overrides merge into allowlisted sections and are validated', () => {
  const merged = normalizeManifest(v1, { tracker: { projectId: 'p2', ownerInboxIssue: null }, pm: { autonomy: 'act', dailyCapUsd: 5 }, team: { roles: ['team-dev'] }, engine: { default: 'claude' } });
  assert.equal(merged.tracker.projectId, 'p2'); assert.equal(merged.tracker.kind, 'linear');
  assert.equal(merged.pm.autonomy, 'act'); assert.equal(merged.pm.dailyCapUsd, 5);
  assert.deepEqual(merged.team.roles, ['team-dev']); assert.equal(merged.engine.default, 'claude');
  assert.deepEqual(approvalRoles(merged), []);
  assert.deepEqual(normalizeManifest(v1, {}), normalizeManifest(v1));
  assert.deepEqual(validateOverrides({ pm: {} }), {});
  assert.throws(() => validateOverrides({ scm: { kind: 'gitlab' } }), /cannot be overridden/);
  assert.throws(() => validateOverrides({ delivery: { autoMergeAuthorized: true } }), /cannot be overridden/);
  assert.throws(() => validateOverrides({ tracker: { kind: 'jira' } }), /tracker\.kind cannot/);
  assert.throws(() => validateOverrides({ pm: { autonomy: { nested: true } } }), /Invalid override value/);
  assert.throws(() => validateOverrides({ pm: { 'bad key': 1 } }), /Invalid override key/);
  assert.throws(() => normalizeManifest(v1, { pm: { autonomy: 'yolo' } }), /pm\.autonomy/);
  assert.throws(() => normalizeManifest(v1, { worker: { launcher: 'balloon' } }), /worker\.launcher/);
  const cleared = applyOverrides({ ...v1, version: 2, tracker: { kind: 'linear', workspaceId: 'w', workspaceUrl: 'https://t/w', teamId: 't', projectId: 'p', projectUrl: 'https://t/p', readyLabel: 'r', ownerInboxIssue: 'T-1' } }, { tracker: { ownerInboxIssue: null } });
  assert.equal(Object.hasOwn(cleared.tracker, 'ownerInboxIssue'), false);
  assert.ok(OVERRIDABLE_SECTIONS.includes('pm') && !OVERRIDABLE_SECTIONS.includes('scm'));
});
