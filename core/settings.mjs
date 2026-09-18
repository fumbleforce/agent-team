import { ENGINES } from '../adapters/engine/index.mjs';
import { LAUNCHER_KINDS } from '../adapters/launcher/index.mjs';
import { DEFAULT_SCM } from '../adapters/scm/index.mjs';
import { DEFAULT_TRACKER } from '../adapters/tracker/index.mjs';
import { ALL_ROLES, AUTONOMY_LEVELS, OVERRIDABLE_SECTIONS } from './manifest.mjs';

// The dashboard settings form: one field per operational decision the owner may take without a
// commit. Anything absent here (scm, delivery gates, charter, instructions) stays repository-owned.
// `lookup` names the tracker lookup list that supplies choices when the coordinator can reach it.
export const SETTINGS_FIELDS = [
  { section: 'tracker', key: 'teamId', label: 'Tracker team', type: 'text', lookup: 'teams', hint: 'Team whose ready issues the intake claims.' },
  { section: 'tracker', key: 'projectId', label: 'Tracker project', type: 'text', lookup: 'projects', hint: 'Project the intake and ideation are scoped to.' },
  { section: 'tracker', key: 'readyLabel', label: 'Ready label', type: 'text', lookup: 'labels', hint: 'Issues carrying this label are picked up.' },
  { section: 'tracker', key: 'ownerInboxIssue', label: 'Owner inbox issue', type: 'text', hint: 'Issue where the PM posts questions for you. Empty disables the inbox.' },
  { section: 'tracker', key: 'stallAlertAfter', label: 'Stall alert after N held jobs', type: 'number', min: 0, max: 50, hint: 'The coordinator comments on the owner inbox issue once when this many jobs sit blocked or failed, and once more when work resumes. 0 turns the alert off.' },
  { section: 'engine', key: 'default', label: 'Default engine', type: 'select', options: ENGINES },
  { section: 'engine', key: 'billing', label: 'Billing mode', type: 'text', hint: 'Adapter-specific; leave empty for the engine default.' },
  { section: 'engine', key: 'model', label: 'Model', type: 'text', hint: 'Adapter-specific model alias. Empty uses the engine default.' },
  { section: 'worker', key: 'launcher', label: 'Worker launcher', type: 'select', options: LAUNCHER_KINDS },
  { section: 'worker', key: 'environment', label: 'Worker environment', type: 'select', optionsFrom: 'environments', options: ['standard'], hint: 'What the worker machine offers a run: browser, containers, display. Edit the catalog under Environments.' },
  { section: 'worker', key: 'instanceType', label: 'Instance type', type: 'text', hint: 'Cloud launchers only.' },
  { section: 'memory', key: 'injectCapTokens', label: 'Memory injected per run (tokens)', type: 'number', min: 0, max: 60000 },
  { section: 'pm', key: 'autonomy', label: 'PM autonomy', type: 'select', options: AUTONOMY_LEVELS, hint: 'observe: reads only. suggest: asks before acting. act: enqueues and curates memory on its own.' },
  { section: 'pm', key: 'dailyCapUsd', label: 'PM daily spend cap (USD)', type: 'number', min: 0, max: 10000, step: 0.5 },
  { section: 'team', key: 'blueprint', label: 'Team', type: 'select', optionsFrom: 'blueprints', options: ['default'], hint: 'Which stored team runs this project. Edit teams under Teams.' },
  { section: 'team', key: 'roles', label: 'Team roles', type: 'multi', optionsFrom: 'roles', options: ALL_ROLES, hint: 'Subagents the coordinator delegates to. Auto-merge needs team-tester.' },
  { section: 'ideation', key: 'enabled', label: 'Ideation enabled', type: 'boolean' },
  { section: 'ideation', key: 'batchSize', label: 'Ideas per cycle', type: 'number', min: 1, max: 10 },
  { section: 'ideation', key: 'backlogCap', label: 'Idea backlog cap', type: 'number', min: 1, max: 100 },
  { section: 'ideation', key: 'minimumIntervalHours', label: 'Hours between ideation cycles', type: 'number', min: 1, max: 720 },
  { section: 'ideation', key: 'ideaLabel', label: 'Idea label', type: 'text', lookup: 'labels' },
  { section: 'ideation', key: 'proposedState', label: 'Proposed state', type: 'text', lookup: 'states' },
  { section: 'ideation', key: 'approvedState', label: 'Approved state', type: 'text', lookup: 'states' },
  { section: 'ideation', key: 'rejectedState', label: 'Rejected state', type: 'text', lookup: 'states' }
];

// Converts a submitted dashboard form into an override document. Every field is present in the
// form; a value equal to the repository's own value is dropped so the stored overrides only hold
// genuine deviations, and an empty text field removes an existing override.
export function overridesFromForm(form, repoManifest) {
  const overrides = {};
  const repoValue = field => repoManifest?.[field.section]?.[field.key];
  const set = (field, value) => { if (value !== undefined) (overrides[field.section] ??= {})[field.key] = value; };
  for (const field of SETTINGS_FIELDS) {
    const name = `${field.section}.${field.key}`;
    let value;
    if (field.type === 'multi') {
      const chosen = form.getAll(name).filter(role => /^team-[a-z]+$/.test(role));
      if (form.get(`${name}.all`) === 'on') value = null;
      else value = chosen;
    } else if (field.type === 'boolean') {
      value = form.get(name) === 'on';
      if (value === Boolean(repoValue(field))) continue;
    } else {
      const raw = (form.get(name) ?? '').trim();
      // A select always submits a value; an absent one means the form predates the field.
      if (!raw) { if (field.type !== 'select' && repoValue(field) !== undefined && repoValue(field) !== null) set(field, null); continue; }
      if (field.type === 'number') { value = Number(raw); if (!Number.isFinite(value)) throw new Error(`${field.label} must be a number`); }
      else value = raw;
    }
    const same = JSON.stringify(value) === JSON.stringify(repoValue(field));
    if (!same) set(field, value);
  }
  for (const section of OVERRIDABLE_SECTIONS) if (overrides[section] && !Object.keys(overrides[section]).length) delete overrides[section];
  return overrides;
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Renders one field with its effective value, marking it when a dashboard override is in force and
// attaching a datalist of live tracker choices when a lookup supplied them.
function renderField(field, { effective, repoManifest, overrides, lookup }) {
  const name = `${field.section}.${field.key}`;
  const id = name.replace('.', '-');
  const value = effective?.[field.section]?.[field.key];
  const overridden = overrides?.[field.section] && Object.hasOwn(overrides[field.section], field.key);
  const repo = repoManifest?.[field.section]?.[field.key];
  const badge = overridden ? `<span class="st act" title="Repository value: ${escape(repo === undefined ? 'not set' : JSON.stringify(repo))}">override</span>` : '';
  const hint = field.hint ? `<small id="${id}-hint">${escape(field.hint)}</small>` : '';
  const describe = field.hint ? ` aria-describedby="${id}-hint"` : '';
  let control;
  // Options may come from the coordinator's stores (teams, environments, the team's roles).
  const options = field.optionsFrom && lookup?.[field.optionsFrom]?.length ? lookup[field.optionsFrom] : field.options;
  if (field.type === 'select') control = `<select id="${id}" name="${name}"${describe}>${[...new Set([...options, ...(value ? [value] : [])])].map(option => `<option${option === value ? ' selected' : ''}>${escape(option)}</option>`).join('')}</select>`;
  else if (field.type === 'boolean') control = `<input type="checkbox" id="${id}" name="${name}"${value ? ' checked' : ''}${describe}>`;
  else if (field.type === 'multi') {
    const all = value === null || value === undefined;
    control = `<fieldset class="roles"><legend class="sr">${escape(field.label)}</legend><label><input type="checkbox" name="${name}.all"${all ? ' checked' : ''}> all shared roles</label>${options.map(option => `<label><input type="checkbox" name="${name}" value="${escape(option)}"${!all && value.includes(option) ? ' checked' : ''}> ${escape(option)}</label>`).join('')}</fieldset>`;
  } else {
    const choices = field.lookup && lookup?.[field.lookup]?.length ? lookup[field.lookup] : null;
    const list = choices ? `<datalist id="${id}-list">${choices.map(choice => `<option value="${escape(field.lookup === 'teams' || field.lookup === 'projects' ? choice.id : choice.name)}">${escape(choice.name)}${choice.key ? ` (${escape(choice.key)})` : ''}</option>`).join('')}</datalist>` : '';
    const attributes = field.type === 'number' ? ` type="number"${field.min !== undefined ? ` min="${field.min}"` : ''}${field.max !== undefined ? ` max="${field.max}"` : ''} step="${field.step ?? 1}"` : ' type="text" maxlength="2000"';
    control = `<input id="${id}" name="${name}"${attributes} value="${escape(value ?? '')}"${list ? ` list="${id}-list"` : ''}${describe}>${list}`;
  }
  return `<div class="field"><label for="${id}">${escape(field.label)} ${badge}</label>${control}${hint}</div>`;
}

// The settings form grouped by section, followed by read-only repository-owned values.
export function renderSettingsForm({ projectId, settings, lookup, lookupError }) {
  const { manifest: effective, repoManifest, overrides } = settings;
  const sections = OVERRIDABLE_SECTIONS.map(section => {
    const fields = SETTINGS_FIELDS.filter(field => field.section === section);
    if (!fields.length) return '';
    return `<fieldset><legend>${escape(section)}${section === 'tracker' ? ` <small>${escape(effective?.tracker?.kind ?? repoManifest?.tracker?.kind ?? '')}</small>` : ''}</legend>${fields.map(field => renderField(field, { effective, repoManifest, overrides, lookup })).join('')}</fieldset>`;
  }).join('');
  const readOnly = repoManifest ? `<h2>Repository-owned <small>change these in .agent-team.json</small></h2><div class="list">${[
    ['Source control', `${repoManifest.scm?.kind ?? DEFAULT_SCM} · ${repoManifest.scm?.repository ?? repoManifest.delivery?.repository ?? ''} · base ${repoManifest.scm?.baseBranch ?? repoManifest.delivery?.baseBranch ?? 'main'}`],
    ['Tracker kind', repoManifest.tracker?.kind ?? DEFAULT_TRACKER],
    ['Workspace', repoManifest.tracker?.workspaceId ?? repoManifest.workspaceId ?? ''],
    ['Required checks', (repoManifest.delivery?.requiredChecks ?? []).join(', ') || 'none'],
    ['Auto-merge authorized', String(repoManifest.delivery?.autoMergeAuthorized ?? false)],
    ['Charter', repoManifest.charter ?? 'default'],
    ['Instructions', (repoManifest.instructions ?? []).join(', ') || 'none']
  ].map(([label, value]) => `<div class="row"><span class="who">${escape(label)}</span><span class="what">${escape(value)}</span></div>`).join('')}</div>` : '<p class="empty">No repository manifest registered yet; a worker registers it on its first poll. Settings saved now apply once it does.</p>';
  const lookupNote = lookupError ? `<p class="n">Tracker choices unavailable: ${escape(lookupError)}. Enter identifiers by hand.</p>` : lookup ? `<p class="n">Choices loaded from ${escape(lookup.workspace?.name ?? 'the tracker')}${lookup.teamId ? `; states and labels are for team ${escape(lookup.teams?.find(team => team.id === lookup.teamId)?.name ?? lookup.teamId)}` : ''}.</p>` : '';
  return `${settings.error ? `<div class="flash err">Current overrides do not validate against the repository manifest: ${escape(settings.error)}. The repository values are in force until this is fixed.</div>` : ''}
${lookupNote}
<form method="post" action="/projects/${escape(projectId)}/settings" class="settings">${sections}
<div class="field"><label for="settings-note">Change note</label><input id="settings-note" name="note" type="text" maxlength="400" placeholder="Why this changes (kept in history)"></div>
<div class="actions"><button type="submit">Save settings</button> <button type="submit" name="reset" value="1" class="secondary" formnovalidate>Clear all overrides</button></div></form>
${readOnly}`;
}

// History rows: newest first, each showing the override document that was in force from then on.
export function renderSettingsHistory(history) {
  if (!history.length) return '<p class="empty">No changes yet.</p>';
  return `<div class="list">${history.map(entry => `<div class="row"><span class="at">${escape(new Date(entry.createdAt).toISOString().slice(0, 16).replace('T', ' '))}</span><span class="who">${escape(entry.author)}${entry.note ? `<small>${escape(entry.note)}</small>` : ''}</span><span class="what"><code>${escape(JSON.stringify(entry.overrides))}</code></span></div>`).join('')}</div>`;
}
