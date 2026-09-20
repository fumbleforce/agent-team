import { Link } from 'wouter';
import { api, type Me, type ProjectNode } from '../../data/client';
import { useResource } from '../../data/useResource';
import { DataTable, SettingsBody, SettingsSection } from '../../patterns';
import { Button, Chip, Field, Input, Select, StatusDot, Text, Textarea } from '../../ui';
import { ActionError, OrgShell, useAction, useCreateKey } from '../org/OrgShell';

interface SettingsView { project: { id: string; slug: string; name: string; kind: string; status: string }; version: number; author: string | null; settings: { description: string; customTabs: { label: string; url: string }[] }; history: { version: number; author: string; note: string | null; created_at: number }[]; can: { configure: boolean; members: boolean; archive: boolean } }
export interface Milestone { id: string; projectId: string; label: string; dueAt: number | null; state: string; tasks: number; done: number }
interface Members { members: { id: string; name: string; email: string; orgRole: string; role: string }[]; candidates: { id: string; name: string; email: string }[] }

const dateInput = (at: number | null) => (at ? new Date(at).toISOString().slice(0, 10) : '');
const dueLabel = (at: number | null) => (at ? new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'no date');
const STATE_TONE = { open: 'working', done: 'neutral', dropped: 'stop' } as const;

// Shown in the project header: what the project is heading for, soonest first.
export function MilestoneStrip({ slug }: { slug: string }) {
  const milestones = useResource<{ milestones: Milestone[] }>(`/api/projects/${slug}/milestones`);
  const open = milestones.data?.milestones.filter(item => item.state === 'open') ?? [];
  if (open.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-1.5">{open.slice(0, 4).map(item => <Chip key={item.id} pill tone={item.dueAt !== null && item.dueAt < Date.now() ? 'attention' : 'neutral'}>{item.label} · {item.done}/{item.tasks} · {dueLabel(item.dueAt)}</Chip>)}{open.length > 4 && <Text size="caption" tone="muted">+{open.length - 4} more</Text>}</div>;
}

function Milestones({ slug, canEdit }: { slug: string; canEdit: boolean }) {
  const milestones = useResource<{ milestones: Milestone[] }>(`/api/projects/${slug}/milestones`);
  const action = useAction(), key = useCreateKey();
  const patch = (id: string, body: Record<string, unknown>) => { void action.run(() => api(`/api/milestones/${id}`, body)).then(milestones.reload); };
  return (
    <SettingsSection title="Milestones">
      <DataTable rows={milestones.data?.milestones ?? []} rowKey={item => item.id} empty={<Text size="small" tone="muted">No milestones yet.</Text>} columns={[
        { label: 'Milestone', width: 'grow', cell: item => <Text size="small" weight="medium" truncate>{item.label}</Text> },
        { label: 'Due', cell: item => (canEdit ? <Input type="date" aria-label={`Due date of ${item.label}`} defaultValue={dateInput(item.dueAt)} onChange={event => patch(item.id, { dueAt: event.target.value ? Date.parse(event.target.value) : null })} /> : <Text size="caption" tone="muted" mono>{dueLabel(item.dueAt)}</Text>) },
        { label: 'Tasks', width: 'sm', cell: item => <Text size="caption" tone="muted" mono>{item.done}/{item.tasks} done</Text> },
        { label: 'State', width: 'sm', cell: item => (canEdit ? <Select compact aria-label={`State of ${item.label}`} value={item.state} onChange={event => patch(item.id, { state: event.target.value })}><option value="open">open</option><option value="done">done</option><option value="dropped">dropped</option></Select> : <Chip tone={STATE_TONE[item.state as keyof typeof STATE_TONE] ?? 'neutral'}>{item.state}</Chip>) },
        { label: '', width: 'sm', cell: item => (canEdit ? <Button size="sm" variant="ghost" onClick={() => { void action.run(() => api(`/api/milestones/${item.id}/delete`, {})).then(milestones.reload); }}>Delete</Button> : null) },
      ]} />
      {canEdit && (
        <form className="flex flex-wrap items-end gap-2.5" onSubmit={action.submit(async form => { await api(`/api/projects/${slug}/milestones`, { label: form.get('label'), dueAt: form.get('due') ? Date.parse(String(form.get('due'))) : null }, key.headers()); key.renew(); milestones.reload(); })}>
          <Field label="Label" error={action.error?.fields.label}><Input name="label" required maxLength={80} placeholder="Public beta" /></Field>
          <Field label="Due"><Input name="due" type="date" /></Field>
          <Button type="submit" disabled={action.busy}>Add milestone</Button>
        </form>
      )}
      <ActionError error={action.error} />
    </SettingsSection>
  );
}

function ProjectMembers({ slug }: { slug: string }) {
  const members = useResource<Members>(`/api/projects/${slug}/members`);
  const action = useAction();
  const set = (userId: string, role: string | null) => { void action.run(() => api(`/api/projects/${slug}/members`, { userId, role })).then(members.reload); };
  return (
    <SettingsSection title="Members">
      <DataTable rows={members.data?.members ?? []} rowKey={member => member.id} empty={<Text size="small" tone="muted">Nobody has a grant on this project yet.</Text>} columns={[
        { label: 'Person', width: 'grow', cell: member => <span className="flex min-w-0 flex-col"><Text size="small" weight="medium" truncate>{member.name}</Text><Text size="caption" tone="muted" truncate>{member.email}</Text></span> },
        { label: 'Role here', width: 'sm', cell: member => <Select compact aria-label={`Project role of ${member.name}`} value={member.role} onChange={event => set(member.id, event.target.value)}><option value="viewer">viewer</option><option value="member">member</option><option value="admin">admin</option></Select> },
        { label: 'In the organization', width: 'sm', cell: member => <Chip>{member.orgRole}</Chip> },
        { label: '', width: 'sm', cell: member => <Button size="sm" variant="ghost" onClick={() => set(member.id, null)}>Remove</Button> },
      ]} />
      {(members.data?.candidates.length ?? 0) > 0 && (
        <form className="flex flex-wrap items-end gap-2.5" onSubmit={action.submit(async form => { await api(`/api/projects/${slug}/members`, { userId: form.get('user'), role: form.get('role') }); members.reload(); })}>
          <Field label="Person"><Select name="user">{members.data?.candidates.map(user => <option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}</Select></Field>
          <Field label="Role"><Select name="role" defaultValue="member"><option value="viewer">viewer</option><option value="member">member</option><option value="admin">admin</option></Select></Field>
          <Button type="submit" disabled={action.busy}>Add to project</Button>
        </form>
      )}
      <ActionError error={action.error} />
    </SettingsSection>
  );
}

interface ExtraTab { label: string; url: string }
const MAX_TABS = 8;

// Pages the team serves itself, shown as extra tabs of the project. Adding or removing one saves the settings straight away.
function ExtraTabs({ tabs, canEdit, onSave }: { tabs: ExtraTab[]; canEdit: boolean; onSave(tabs: ExtraTab[], note: string): Promise<void> }) {
  const action = useAction();
  const save = (next: ExtraTab[], note: string) => action.run(() => onSave(next, note));
  return (
    <SettingsSection title="Extra tabs" note="Pages your team runs elsewhere, opened from a tab beside Tasks.">
      <DataTable rows={tabs} rowKey={tab => `${tab.label} ${tab.url}`} empty={<Text size="small" tone="muted">No extra tabs yet.</Text>} columns={[
        { label: 'Name on the tab', cell: tab => <Text size="small" weight="medium" truncate>{tab.label}</Text> },
        { label: 'Opens', width: 'grow', cell: tab => <Text size="caption" tone="muted" truncate>{tab.url}</Text> },
        { label: '', width: 'sm', cell: tab => (canEdit ? <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => { void save(tabs.filter(other => other !== tab), `Removed the ${tab.label} tab`); }}>Remove</Button> : null) },
      ]} />
      {canEdit && tabs.length < MAX_TABS && (
        <form className="flex flex-wrap items-end gap-2.5" onSubmit={event => {
          event.preventDefault();
          const target = event.currentTarget, form = new FormData(target), label = String(form.get('label') ?? '').trim(), url = String(form.get('url') ?? '').trim();
          void save([...tabs, { label, url }], `Added the ${label} tab`).then(ok => { if (ok) target.reset(); });
        }}>
          <Field label="Name on the tab"><Input name="label" required maxLength={40} placeholder="Calendar" /></Field>
          <Field label="Web address of the page"><Input name="url" type="url" required maxLength={500} pattern="https?://.+" placeholder="https://calendar.example.com" /></Field>
          <Button type="submit" disabled={action.busy}>Add tab</Button>
        </form>
      )}
      {canEdit && tabs.length >= MAX_TABS && <Text size="caption" tone="muted">A project has room for {MAX_TABS} extra tabs. Remove one to add another.</Text>}
      <ActionError error={action.error} />
    </SettingsSection>
  );
}

export function ProjectSettingsPage({ id, me, projects }: { id: string; me: Me; projects: ProjectNode[] }) {
  const view = useResource<SettingsView>(`/api/projects/${id}/settings`);
  const save = useAction(), status = useAction();
  const data = view.data;
  const setStatus = (next: string) => { void status.run(() => api(`/api/projects/${id}/status`, { status: next })).then(() => window.location.reload()); };

  return (
    <OrgShell me={me} projects={projects} title={data ? `${data.project.name} settings` : 'Project settings'} active={null} crumbs={[{ label: me.org?.name ?? 'Organization', href: '/org' }, ...(data ? [{ label: data.project.name, href: `/p/${data.project.slug}` }] : [])]}>
      <SettingsBody>
        {view.error && <Text tone="stop">{view.error.message}</Text>}
        {data && (
          <>
            <SettingsSection title="Project" aside={<Link href={`/p/${data.project.slug}/tasks`}><Text size="caption" tone="accent">Open the board</Text></Link>}>
              <div className="flex flex-wrap items-center gap-2.5">
                <StatusDot tone={data.project.status === 'active' ? 'working' : data.project.status === 'paused' ? 'attention' : 'off'} /><Text weight="semibold">{data.project.status}</Text><Chip mono>{data.project.slug}</Chip><Chip>{data.project.kind}</Chip>
                <span className="ml-auto flex gap-2">
                  {data.can.configure && data.project.status === 'active' && <Button disabled={status.busy} onClick={() => setStatus('paused')}>Pause</Button>}
                  {data.can.configure && data.project.status === 'paused' && <Button variant="primary" disabled={status.busy} onClick={() => setStatus('active')}>Resume</Button>}
                  {data.can.archive && data.project.status !== 'archived' && <Button variant="danger" disabled={status.busy} onClick={() => setStatus('archived')}>Archive</Button>}
                  {data.can.archive && data.project.status === 'archived' && <Button disabled={status.busy} onClick={() => setStatus('active')}>Restore</Button>}
                </span>
              </div>
              <Text size="caption" tone="muted">Paused: kept, but no longer synced. Archived: gone from the sidebar.</Text>
              <ActionError error={status.error} />
            </SettingsSection>

            <SettingsSection title="Settings" aside={<Text size="caption" tone="muted">{data.version ? `v${data.version} · saved by ${data.author}` : 'never saved'}</Text>}>
              <form key={data.version} className="flex flex-col gap-2.5" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void save.run(() => api(`/api/projects/${id}/settings`, { doc: { description: form.get('description'), customTabs: data.settings.customTabs }, note: form.get('note') || undefined }, { 'if-match': String(data.version) })).then(ok => { if (ok) view.reload(); }); }}>
                <Field label="What this project is for" error={save.error?.fields.description}><Textarea name="description" rows={4} maxLength={2000} disabled={!data.can.configure} defaultValue={data.settings.description} /></Field>
                {data.can.configure && <div className="flex flex-wrap items-end gap-2.5"><Field label="Note for the history"><Input name="note" maxLength={200} /></Field><Button type="submit" variant="primary" disabled={save.busy}>Save settings</Button>{save.error?.status === 412 && <Button onClick={view.reload}>Reload</Button>}</div>}
                <ActionError error={save.error} />
              </form>
              {data.history.length > 0 && <div className="flex flex-col gap-1">{data.history.map(entry => <Text key={entry.version} size="caption" tone="muted">v{entry.version} · {entry.author} · {new Date(Number(entry.created_at)).toLocaleString()}{entry.note ? ` · ${entry.note}` : ''}</Text>)}</div>}
            </SettingsSection>

            <ExtraTabs tabs={data.settings.customTabs} canEdit={data.can.configure} onSave={async (customTabs, note) => { await api(`/api/projects/${id}/settings`, { doc: { description: data.settings.description, customTabs }, note }, { 'if-match': String(data.version) }); view.reload(); }} />
            <Milestones slug={data.project.slug} canEdit={data.can.configure} />
            {data.can.members && <ProjectMembers slug={data.project.slug} />}
          </>
        )}
      </SettingsBody>
    </OrgShell>
  );
}
