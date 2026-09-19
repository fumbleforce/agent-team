import { useState } from 'react';
import { Link } from 'wouter';
import type { Agent, Me, ProjectNode } from '../../data/client';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { KeyValueList, ListLink, SidePanel } from '../../patterns';
import { ActionError, isOrgAdmin, OrgShell, useAction } from './OrgShell';
import { LinkForm, ProjectStructure, type Structure } from './Structure';
import { RoleEditor, type EditableRole } from './RoleEditor';
import { Avatar, Button, Card, Chip, Dialog, Field, Input, Meter, SectionLabel, StatusDot, Text } from '../../ui';

interface OrgProject extends ProjectNode { roster: Agent[]; openTasks: number; spendMinor: number }
interface Grant { repoRead: unknown; codeWrite: unknown; shell: string; browser: string; issues: string; comms: string; deploy: string; secrets: string[]; spendDailyCapMinor: number }
interface RoleDoc { slug: string; version: number; author: string; doc: { summary: string; perspective: string; skills: string[]; permissions: Grant; knowledgeFirst: string[]; approvalKinds: string[] }; wornBy: { id: string; name: string; initials: string; tint: string }[] }

interface ArchivedProject { id: string; slug: string; name: string; kind: string; parentName: string | null }

// Projects taken off every board. Restoring one brings it back as it was: its board, threads and team are kept while it is archived.
function ArchivedProjects() {
  const archived = useResource<{ projects: ArchivedProject[] }>('/api/org/archived');
  const action = useAction();
  if (!archived.data?.projects.length) return null;
  return (
    <section aria-label="Archived projects" className="flex flex-col gap-2 px-5 pb-5">
      <SectionLabel>Archived projects</SectionLabel>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
        {archived.data.projects.map(project => (
          <Card key={project.id} tone="raised" pad="sm" className="flex items-center gap-2">
            <StatusDot tone="off" />
            <span className="flex min-w-0 grow flex-col"><Text size="small" weight="medium" truncate>{project.name}</Text>{project.parentName && <Text size="caption" tone="muted" truncate>Part of {project.parentName}</Text>}</span>
            {/* The sidebar and every list read the project tree once, so the page is loaded again with the project in it. */}
            <Button size="sm" disabled={action.busy} onClick={() => { void action.run(() => api(`/api/projects/${project.slug}/status`, { status: 'active' })).then(ok => { if (ok) window.location.reload(); }); }}>Restore</Button>
          </Card>
        ))}
      </div>
      <ActionError error={action.error} />
    </section>
  );
}

const scope = (value: unknown) => (typeof value === 'string' ? value : (value as { paths: string[] }).paths.join(', '));

export function OrgPage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const org = useResource<{ projects: OrgProject[] }>('/api/org');
  const structure = useResource<Structure>('/api/org/structure');
  const money = (minor: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: me.org?.currency ?? 'EUR', maximumFractionDigits: 0 }).format(minor / 100);
  return (
    <OrgShell me={me} projects={projects} title="Organization" active="/org">
      <LinkForm me={me} projects={projects} onChanged={structure.reload} />
      <div className="flex min-h-0 grow flex-col overflow-y-auto">
        <div className="grid auto-rows-min grid-cols-1 gap-3 px-5 pt-4 pb-5 md:grid-cols-2 xl:grid-cols-4">
          {org.data?.projects.map(project => (
            <Card key={project.id} as="article" className="flex flex-col gap-2.5">
              <div className="flex items-center gap-1.5"><StatusDot tone={project.status === 'paused' ? 'idle' : 'working'} /><Text weight="semibold">{project.name}</Text><span className="ml-auto"><Chip>{project.kind}</Chip></span></div>
              <Text size="caption" tone="muted">{project.subprojects.length ? `Sub-projects: ${project.subprojects.map(sub => sub.name).join(' · ')}` : 'No sub-projects'}</Text>
              <Meter thin value={project.progress} />
              <Card tone="raised" pad="sm" className="flex flex-col gap-1.5">
                <Text size="small" weight="medium">{project.team?.name ?? 'No team'}</Text>
                <div className="flex flex-wrap gap-1">{project.roster.map(agent => <Avatar key={agent.id} initials={agent.initials} tint={agent.tint} size="sm" />)}</div>
              </Card>
              <ProjectStructure projectId={project.id} projects={projects} structure={structure.data} onChanged={structure.reload} />
              <KeyValueList items={[['Open tasks', String(project.openTasks)], ['Spend this month', money(project.spendMinor)]]} />
              <Link href={`/p/${project.subprojects[0]?.slug ?? project.slug}/tasks`}><Button block>Open</Button></Link>
            </Card>
          ))}
        </div>
        {isOrgAdmin(me) && <ArchivedProjects />}
      </div>
    </OrgShell>
  );
}

// A role's name as a person reads it: "pm" is PM, "release-manager" is Release manager.
const roleName = (slug: string) => (slug.length <= 3 ? slug.toUpperCase() : (slug[0]!.toUpperCase() + slug.slice(1)).replaceAll('-', ' '));

// A new role starts from the safest grant (read only); what it may do is then set in the editor.
function NewRole({ onCreated }: { onCreated(slug: string): void }) {
  const [open, setOpen] = useState(false), [error, setError] = useState<string | null>(null);
  const create = async (form: FormData) => {
    const name = String(form.get('name') ?? '').trim(), slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!slug) { setError('Give the role a name'); return; }
    try { await api(`/api/roles/${slug}`, { doc: { summary: String(form.get('summary') ?? '').trim(), perspective: '', permissions: { repoRead: 'all' }, decides: [], approvalKinds: [] }, note: 'Created', expectedVersion: 0 }); setOpen(false); setError(null); onCreated(slug); }
    catch (failure) { setError(failure instanceof ApiError ? failure.message : 'The role could not be created'); }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen} title="New role" description="A role is a perspective plus what its wearer may do. It starts read-only; open it afterwards to grant more." trigger={<Button block variant="dashed">+ New role</Button>}>
      <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void create(new FormData(event.currentTarget)); }}>
        <Field label="Name"><Input name="name" required maxLength={40} autoFocus placeholder="Release manager" /></Field>
        <Field label="What it is for, in one line"><Input name="summary" required maxLength={160} placeholder="Owns the release checklist and the go / no-go call" /></Field>
        {error && <Text size="small" tone="stop">{error}</Text>}
        <div className="flex justify-end gap-2"><Button onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary">Create role</Button></div>
      </form>
    </Dialog>
  );
}

export function RolesPage({ slug, me, projects }: { slug: string | null; me: Me; projects: ProjectNode[] }) {
  const roles = useResource<{ roles: RoleDoc[] }>('/api/roles');
  const role = roles.data?.roles.find(item => item.slug === slug) ?? roles.data?.roles[0];
  const [editing, setEditing] = useState<string | null>(null);
  const canEdit = me.user.orgRole === 'owner' || me.user.orgRole === 'admin';
  return (
    <OrgShell me={me} projects={projects} title="Roles" active="/roles">
      <div className="flex min-h-0 grow">
        <SidePanel label="Roles" wide>
          {canEdit && <div className="px-1.5 pb-2"><NewRole onCreated={created => { roles.reload(); window.history.pushState(null, '', `/roles/${created}`); window.dispatchEvent(new PopStateEvent('popstate')); }} /></div>}
          {roles.data?.roles.map(item => <ListLink key={item.slug} href={`/roles/${item.slug}`} active={item.slug === role?.slug} aside={<span className="flex gap-0.5">{item.wornBy.map(agent => <Avatar key={agent.id} initials={agent.initials} tint={agent.tint} size="xs" />)}</span>}>{roleName(item.slug)}</ListLink>)}
        </SidePanel>
        {role && (
          <div className="flex min-w-0 grow flex-col gap-4 overflow-y-auto px-6 py-5">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2.5"><Text as="h2" size="heading">{roleName(role.slug)}</Text><Text size="caption" tone="muted">v{role.version} · edited by {role.author}</Text>{canEdit && editing !== role.slug && <span className="ml-auto"><Button onClick={() => setEditing(role.slug)}>Edit</Button></span>}</div>
              <Text tone="soft">{role.doc.summary}. {role.doc.perspective}</Text>
            </div>
            {editing === role.slug && <RoleEditor role={role as unknown as EditableRole} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); roles.reload(); }} />}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <Card className="flex flex-col gap-2.5">
                <SectionLabel>Permissions</SectionLabel>
                <KeyValueList items={[['Read repository', scope(role.doc.permissions.repoRead)], ['Write code', scope(role.doc.permissions.codeWrite)], ['Run shell', role.doc.permissions.shell], ['Run browser', role.doc.permissions.browser], ['Issues', role.doc.permissions.issues], ['Comms', role.doc.permissions.comms], ['Deploy', role.doc.permissions.deploy], ['Secrets', role.doc.permissions.secrets.join(', ') || 'none'], ['Spend per day', String(role.doc.permissions.spendDailyCapMinor / 100)]]} />
              </Card>
              <Card className="flex flex-col gap-2.5"><SectionLabel>Reads first</SectionLabel>{role.doc.knowledgeFirst.map(page => <Text key={page} size="small" mono tone="soft">{page}</Text>)}{role.doc.knowledgeFirst.length === 0 && <Text size="small" tone="muted">Nothing pinned.</Text>}<SectionLabel>Approves as</SectionLabel><div className="flex gap-1">{role.doc.approvalKinds.map(kind => <Chip key={kind} tone="review">{kind}</Chip>)}{role.doc.approvalKinds.length === 0 && <Text size="small" tone="muted">Nothing.</Text>}</div></Card>
              <Card className="flex flex-col gap-2.5"><SectionLabel>Worn by</SectionLabel>{role.wornBy.map(agent => <div key={agent.id} className="flex items-center gap-2"><Avatar initials={agent.initials} tint={agent.tint} size="sm" /><Text>{agent.name}</Text></div>)}{role.wornBy.length === 0 && <Text size="small" tone="muted">Nobody yet.</Text>}</Card>
            </div>
          </div>
        )}
      </div>
    </OrgShell>
  );
}
