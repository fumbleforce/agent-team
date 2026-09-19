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
    <SettingsSection title="Milestones" note="Open milestones show in the project header with their progress. Tasks point at a milestone; deleting one leaves its tasks in place.">
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
    <SettingsSection title="Members" note="People with a grant on this project. Owners and administrators of the organization always have access and are not listed.">
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

const tabsText = (tabs: { label: string; url: string }[]) => tabs.map(tab => `${tab.label} | ${tab.url}`).join('\n');
const parseTabs = (text: string) => text.split('\n').map(line => line.split('|').map(part => part.trim())).filter(parts => parts[0]).map(parts => ({ label: parts[0] ?? '', url: parts.slice(1).join('|') }));

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
              <Text size="caption" tone="muted">A paused project keeps its board and threads and stops syncing with its tracker. An archived project leaves the sidebar and every list.</Text>
              <ActionError error={status.error} />
            </SettingsSection>

            <SettingsSection title="Settings" aside={<Text size="caption" tone="muted">{data.version ? `v${data.version} · saved by ${data.author}` : 'never saved'}</Text>}>
              <form key={data.version} className="flex flex-col gap-2.5" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void save.run(() => api(`/api/projects/${id}/settings`, { doc: { description: form.get('description'), customTabs: parseTabs(String(form.get('tabs'))) }, note: form.get('note') || undefined }, { 'if-match': String(data.version) })).then(ok => { if (ok) view.reload(); }); }}>
                <Field label="What this project is for" error={save.error?.fields.description}><Textarea name="description" rows={4} maxLength={2000} disabled={!data.can.configure} defaultValue={data.settings.description} /></Field>
                <Field label="Custom tabs, one per line: Label | https://address the team serves"><Textarea name="tabs" rows={3} disabled={!data.can.configure} defaultValue={tabsText(data.settings.customTabs)} /></Field>
                {data.can.configure && <div className="flex flex-wrap items-end gap-2.5"><Field label="Note for the history"><Input name="note" maxLength={200} /></Field><Button type="submit" variant="primary" disabled={save.busy}>Save settings</Button>{save.error?.status === 412 && <Button onClick={view.reload}>Reload</Button>}</div>}
                <ActionError error={save.error} />
              </form>
              {data.history.length > 0 && <div className="flex flex-col gap-1">{data.history.map(entry => <Text key={entry.version} size="caption" tone="muted">v{entry.version} · {entry.author} · {new Date(Number(entry.created_at)).toLocaleString()}{entry.note ? ` · ${entry.note}` : ''}</Text>)}</div>}
            </SettingsSection>

            <Milestones slug={data.project.slug} canEdit={data.can.configure} />
            {data.can.members && <ProjectMembers slug={data.project.slug} />}
          </>
        )}
      </SettingsBody>
    </OrgShell>
  );
}
