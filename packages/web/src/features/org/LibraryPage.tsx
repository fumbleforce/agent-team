import { useState } from 'react';
import { api, ApiError, type Me, type ProjectNode } from '../../data/client';
import { useResource } from '../../data/useResource';
import { StatusLine } from '../../patterns';
import { Button, Card, Checkbox, Chip, Dialog, Field, Input, SectionLabel, Text, Textarea } from '../../ui';
import { roleName } from '../project/AgentDialog';
import { isOrgAdmin, OrgShell } from './OrgShell';

interface LibraryDoc { name: string; title: string; persona: string; summary: string; roles: string[] }
interface Stored { slug: string; version: number; author: string; doc: LibraryDoc }
const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// Agents kept ready to be hired into any project's team: who they are and which roles they wear. Everyone reads; admins write.
export function LibraryPage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const library = useResource<{ items: Stored[] }>('/api/library/agents');
  const roles = useResource<{ roles: { slug: string; doc: { summary: string } }[] }>('/api/roles');
  const [editing, setEditing] = useState<{ open: boolean; item: Stored | null }>({ open: false, item: null });
  const [errors, setErrors] = useState<Record<string, string>>({}), [failure, setFailure] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const canEdit = isOrgAdmin(me), item = editing.item;

  async function save(form: HTMLFormElement) {
    const data = new FormData(form), name = String(data.get('name')).trim();
    const slug = item?.slug ?? slugOf(name);
    setErrors({}); setFailure(null);
    if (!slug) { setErrors({ name: 'Give the agent a name with at least one letter or digit' }); return; }
    if (!item && library.data?.items.some(other => other.slug === slug)) { setErrors({ name: 'The library already has an agent with this name' }); return; }
    setBusy(true);
    try {
      await api(`/api/library/agents/${slug}`, { doc: { name, title: String(data.get('title')), summary: String(data.get('summary')), persona: String(data.get('persona')), roles: data.getAll('roles').map(String) } }, item ? { 'if-match': String(item.version) } : {});
      setEditing({ open: false, item: null }); library.reload();
    } catch (problem) {
      if (problem instanceof ApiError && Object.keys(problem.fields).length) setErrors(Object.fromEntries(Object.entries(problem.fields).map(([key, value]) => [key.replace(/^doc\./, ''), value])));
      else setFailure(problem instanceof ApiError && problem.status === 412 ? 'Someone else changed this. Reload and try again.' : problem instanceof ApiError ? problem.message : 'That did not work; try again.');
    } finally { setBusy(false); }
  }

  return (
    <OrgShell me={me} projects={projects} title="Agent library" active="/library">
      <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-5 pt-4 pb-5">
        <div className="flex items-center gap-3"><span className="grow" />{canEdit && <Button variant="primary" onClick={() => setEditing({ open: true, item: null })}>+ Add an agent to the library</Button>}</div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {library.data?.items.map(entry => (
            <Card key={entry.slug} tone="raised" pad="sm" className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2"><Text weight="semibold">{entry.doc.name}</Text><Text size="caption" tone="muted" truncate>{entry.doc.title}</Text>{canEdit && <span className="ml-auto"><Button size="sm" variant="ghost" onClick={() => setEditing({ open: true, item: entry })}>Change</Button></span>}</div>
              {(entry.doc.summary || entry.doc.persona) && <Text size="small" tone="soft">{entry.doc.summary || entry.doc.persona}</Text>}
              <div className="flex flex-wrap gap-1">{entry.doc.roles.map(role => <Chip key={role}>{roleName(role)}</Chip>)}{entry.doc.roles.length === 0 && <Text size="caption" tone="muted">No roles yet</Text>}</div>
            </Card>
          ))}
        </div>
        {library.data?.items.length === 0 && <Text tone="muted">The library is empty. Add the agents you expect to hire more than once.</Text>}
      </div>
      <Dialog open={editing.open} onOpenChange={open => { setEditing(previous => ({ ...previous, open })); if (!open) { setErrors({}); setFailure(null); } }} title={item ? `Change ${item.doc.name}` : 'Add an agent to the library'} description="Who this agent is, wherever it is hired."
        footer={<><Button variant="ghost" onClick={() => setEditing(previous => ({ ...previous, open: false }))}>Cancel</Button><Button type="submit" form="library-agent" variant="primary" disabled={busy}>{item ? 'Save changes' : 'Add to the library'}</Button></>}>
        <form id="library-agent" key={item?.slug ?? 'new'} className="flex flex-col gap-3.5" onSubmit={event => { event.preventDefault(); void save(event.currentTarget); }}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" error={errors.name}><Input name="name" required maxLength={60} defaultValue={item?.doc.name} placeholder="Noor" autoFocus /></Field>
            <Field label="What they do (optional)" error={errors.title}><Input name="title" maxLength={80} defaultValue={item?.doc.title} placeholder="Security reviewer" /></Field>
          </div>
          <Field label="One line for whoever is hiring (optional)" error={errors.summary}><Input name="summary" maxLength={400} defaultValue={item?.doc.summary} placeholder="Reads every change for ways it could be misused" /></Field>
          <Field label="Personality and way of working (optional)" error={errors.persona}><Textarea name="persona" rows={4} maxLength={2000} defaultValue={item?.doc.persona} placeholder="Sceptical and thorough. Explains every finding." /></Field>
          <section className="flex flex-col gap-2">
            <SectionLabel>Roles</SectionLabel>
            {roles.data?.roles.map(role => <Checkbox key={role.slug} name="roles" value={role.slug} defaultChecked={item?.doc.roles.includes(role.slug) ?? false} label={roleName(role.slug)} note={role.doc.summary} />)}
            {errors.roles && <Text size="caption" tone="stop">{errors.roles}</Text>}
          </section>
          {failure && <StatusLine boxed tone="stop">{failure}</StatusLine>}
        </form>
      </Dialog>
    </OrgShell>
  );
}
