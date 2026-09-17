import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifest } from './manifest.mjs';
import { SETTINGS_FIELDS, overridesFromForm, renderSettingsForm, renderSettingsHistory } from './settings.mjs';

const repo = normalizeManifest({ version: 1, name: 'A', instructions: [], workspaceId: 'w', workspaceUrl: 'https://t/w', teamId: 't', projectId: 'p', projectUrl: 'https://t/p', readyLabel: 'r' });

// A submitted form carrying every field at its effective value, with the given changes applied.
const formFor = (manifest, changes = {}) => {
  const form = new URLSearchParams();
  for (const field of SETTINGS_FIELDS) {
    const name = `${field.section}.${field.key}`;
    const value = Object.hasOwn(changes, name) ? changes[name] : manifest[field.section]?.[field.key];
    if (field.type === 'multi') { if (value === null || value === undefined) form.set(`${name}.all`, 'on'); else for (const role of value) form.append(name, role); }
    else if (field.type === 'boolean') { if (value) form.set(name, 'on'); }
    else form.set(name, value === undefined || value === null ? '' : String(value));
  }
  return form;
};

test('an unchanged form yields no overrides and deviations are recorded per field', () => {
  assert.deepEqual(overridesFromForm(formFor(repo), repo), {});
  const overrides = overridesFromForm(formFor(repo, { 'pm.autonomy': 'act', 'pm.dailyCapUsd': '7.5', 'team.roles': ['team-dev'], 'ideation.enabled': true, 'tracker.projectId': 'p2' }), repo);
  assert.deepEqual(overrides, { pm: { autonomy: 'act', dailyCapUsd: 7.5 }, team: { roles: ['team-dev'] }, ideation: { enabled: true }, tracker: { projectId: 'p2' } });
  assert.doesNotThrow(() => normalizeManifest(repo, overrides));
  assert.throws(() => overridesFromForm(formFor(repo, { 'pm.dailyCapUsd': 'lots' }), repo), /must be a number/);
});

test('clearing a text field removes the repository value and null roles mean all shared roles', () => {
  const withInbox = normalizeManifest({ ...repo, tracker: { ...repo.tracker, ownerInboxIssue: 'T-1' }, team: { roles: ['team-dev'] } });
  const overrides = overridesFromForm(formFor(withInbox, { 'tracker.ownerInboxIssue': '', 'team.roles': null }), withInbox);
  assert.deepEqual(overrides, { tracker: { ownerInboxIssue: null }, team: { roles: null } });
  assert.equal(Object.hasOwn(normalizeManifest(withInbox, overrides).tracker, 'ownerInboxIssue'), false);
  assert.equal(normalizeManifest(withInbox, overrides).team.roles, null);
});

test('the form marks overrides, escapes values, lists tracker choices and shows repository-owned values read-only', () => {
  const settings = { overrides: { pm: { autonomy: 'act' } }, repoManifest: repo, manifest: normalizeManifest(repo, { pm: { autonomy: 'act' } }), error: null };
  const lookup = { workspace: { name: 'Acme' }, teamId: 't', teams: [{ id: 't', key: 'ACM', name: 'Acme <core>' }], projects: [{ id: 'p', name: 'Platform' }], labels: [{ id: 'l', name: 'agent:ready' }], states: [{ id: 's', name: 'Todo', type: 'unstarted' }] };
  const html = renderSettingsForm({ projectId: 'a', settings, lookup, lookupError: null });
  assert.match(html, /PM autonomy <span class="st act"/);
  assert.match(html, /<option selected>act<\/option>/);
  assert.match(html, /Acme &lt;core&gt; \(ACM\)/);
  assert.match(html, /<datalist id="ideation-proposedState-list">.*Todo/);
  assert.match(html, /Repository-owned/); assert.match(html, /Tracker kind<\/span><span class="what">linear/);
  assert.doesNotMatch(html, /name="scm\./);
  const broken = renderSettingsForm({ projectId: 'a', settings: { ...settings, error: 'pm.autonomy must be one of observe, suggest, act' }, lookup: null, lookupError: 'LINEAR_API_KEY is not available' });
  assert.match(broken, /do not validate against the repository manifest/); assert.match(broken, /Tracker choices unavailable/);
  assert.match(renderSettingsHistory([{ createdAt: 0, author: 'owner', note: 'x', overrides: { pm: { autonomy: 'act' } } }]), /owner<small>x<\/small>/);
  assert.match(renderSettingsHistory([]), /No changes yet/);
});
