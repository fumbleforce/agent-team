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
const tone = (action: string): ChipTone => (/failed|locked|disabled|revoked|removed/.test(action) ? 'stop' : action.startsWith('auth.') ? 'review' : action.startsWith('member.') ? 'attention' : 'neutral');
const detail = (payload: Record<string, unknown>) => Object.entries(payload).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([key, value]) => `${key}: ${String(value)}`).join(' · ');

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
              { label: 'Action', cell: entry => <Chip mono tone={tone(entry.action)}>{entry.action}</Chip> },
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
