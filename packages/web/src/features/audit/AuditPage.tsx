import { useEffect, useState } from 'react';
import { api, ApiError, type Me, type ProjectNode } from '../../data/client';
import { useResource } from '../../data/useResource';
import { DataTable, EmptyState, SettingsBody } from '../../patterns';
import { Button, Checkbox, Chip, Field, Input, Select, Text, type ChipTone } from '../../ui';
import { isOrgAdmin, OrgShell } from '../org/OrgShell';

interface Entry { seq: number; at: number; action: string; category: string; actor: { kind: string; id: string | null; name: string; email: string | null }; target: string | null; project: { id: string; name: string | null } | null; payload: Record<string, unknown> }
interface Filters { type: string; actor: string; project: string; from: string; to: string; all: boolean }
const EMPTY: Filters = { type: '', actor: '', project: '', from: '', to: '', all: false };
const AREAS = [['', 'Everything'], ['auth.', 'Sign-in and credentials'], ['member.', 'Members'], ['settings.', 'Settings and documents'], ['project.', 'Projects'], ['team.', 'Teams']] as const;
// What happened, as a sentence. An action without an entry here is shown with its dots and underscores turned into spaces.
const SAID: Record<string, string> = {
  'auth.signed_in': 'Signed in', 'auth.signed_out': 'Signed out', 'auth.login_failed': 'Failed to sign in', 'auth.locked': 'Locked after too many failed sign-ins', 'auth.owner_created': 'Created the owner account',
  'auth.machine_token_created': 'Created a worker token', 'auth.machine_token_revoked': 'Revoked a worker token', 'member.invited': 'Invited someone', 'member.invite_revoked': 'Took back an invitation', 'member.joined': 'Joined',
  'member.role_changed': 'Changed someone’s role', 'member.disabled': 'Disabled an account', 'member.enabled': 'Enabled an account', 'member.grant_changed': 'Changed someone’s access to a project', 'project.status_changed': 'Paused, resumed or archived a project',
  'connection.added': 'Connected an integration', 'connection.removed': 'Removed an integration', 'provider.added': 'Added a model provider', 'provider.updated': 'Changed a model provider', 'provider.removed': 'Removed a model provider',
  'agent.created': 'Added an agent', 'agent.updated': 'Changed an agent', 'agent.paused': 'Paused an agent', 'agent.retired': 'Retired an agent', 'team.pm_changed': 'Moved the PM seat', 'team.reordered': 'Reordered the team', 'team.created_from_template': 'Created a team from a template',
  'settings.changed': 'Changed settings', 'quarantine.released': 'Released work with an unknown outcome', 'delivery.reconciled': 'Settled a merge that was cut off',
};
const said = (action: string) => SAID[action] ?? (action[0]!.toUpperCase() + action.slice(1)).replaceAll(/[._]/g, ' ');
const LABELS: Record<string, string> = { method: 'with', kind: 'what', slug: 'name', version: 'version', name: 'name', email: 'email', role: 'role', resolution: 'decision', note: 'note', what: 'what', reason: 'reason' };
const tone = (action: string): ChipTone => (/failed|locked|disabled|revoked|removed/.test(action) ? 'stop' : action.startsWith('auth.') ? 'review' : action.startsWith('member.') ? 'attention' : 'neutral');
const detail = (payload: Record<string, unknown>) => Object.entries(payload).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([key, value]) => `${LABELS[key] ?? key.replaceAll('_', ' ')}: ${String(value).replaceAll('_', ' ')}`).join(' · ');

// The audit page is the event log, filtered: who did what to what, and when. Newest first, a page at a time.
export function AuditPage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const people = useResource<{ users: { id: string; name: string }[] }>(isOrgAdmin(me) ? '/api/users' : null);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = (after: number | null) => new URLSearchParams({ limit: '50', ...(after ? { after: String(after) } : {}), ...(filters.type ? { type: filters.type } : {}), ...(filters.actor ? { actor: filters.actor } : {}), ...(filters.project ? { project: filters.project } : {}), ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: `${filters.to}T23:59:59` } : {}), ...(filters.all ? { all: '1' } : {}) }).toString();
  const load = (after: number | null) => api<{ entries: Entry[]; next: number | null }>(`/api/audit?${query(after)}`).then(page => { setEntries(current => (after ? [...current, ...page.entries] : page.entries)); setNext(page.next); setError(null); }, failure => setError(failure instanceof ApiError ? failure.message : 'Could not load the log'));
  useEffect(() => { if (isOrgAdmin(me)) void load(null); }, [filters]);
  const set = (patch: Partial<Filters>) => setFilters(current => ({ ...current, ...patch }));

  return (
    <OrgShell me={me} projects={projects} title="Audit" active="/audit">
      <SettingsBody>
        {!isOrgAdmin(me) ? <EmptyState title="For administrators" note="The audit log is open to owners and administrators of the organization." /> : (
          <>
            <div className="flex flex-wrap items-end gap-2.5">
              <Field label="Area"><Select value={filters.type} onChange={event => set({ type: event.target.value })}>{AREAS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
              <Field label="Person"><Select value={filters.actor} onChange={event => set({ actor: event.target.value })}><option value="">Anyone</option>{people.data?.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</Select></Field>
              <Field label="Project"><Select value={filters.project} onChange={event => set({ project: event.target.value })}><option value="">Any</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</Select></Field>
              <Field label="From"><Input type="date" value={filters.from} onChange={event => set({ from: event.target.value })} /></Field>
              <Field label="To"><Input type="date" value={filters.to} onChange={event => set({ to: event.target.value })} /></Field>
              <Checkbox label="Everything people did" note="Not only access and settings" checked={filters.all} onChange={event => set({ all: event.target.checked })} />
              <Button variant="ghost" onClick={() => setFilters(EMPTY)}>Clear</Button>
            </div>
            {error && <Text tone="stop">{error}</Text>}
            <DataTable rows={entries} rowKey={entry => entry.seq} empty={<Text size="small" tone="muted">Nothing in the log matches.</Text>} columns={[
              { label: 'When', cell: entry => <Text size="caption" tone="muted" mono>{new Date(entry.at).toLocaleString()}</Text> },
              { label: 'Who', cell: entry => <span className="flex min-w-0 flex-col"><Text size="small" weight="medium" truncate>{entry.actor.name}</Text>{entry.actor.email && <Text size="caption" tone="muted" truncate>{entry.actor.email}</Text>}</span> },
              { label: 'Action', cell: entry => <Chip tone={tone(entry.action)}>{said(entry.action)}</Chip> },
              { label: 'Target', cell: entry => <Text size="small" truncate>{entry.target ?? '—'}</Text> },
              { label: 'Detail', width: 'grow', cell: entry => <Text size="caption" tone="muted" truncate>{[entry.project?.name, detail(entry.payload)].filter(Boolean).join(' · ')}</Text> },
            ]} />
            {next !== null && <div><Button onClick={() => { void load(next); }}>Load older entries</Button></div>}
          </>
        )}
      </SettingsBody>
    </OrgShell>
  );
}
