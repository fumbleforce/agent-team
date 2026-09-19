import { useState } from 'react';
import { useResource } from '../data/useResource';
import { api, ApiError, type ProjectNode } from '../data/client';
import { Button, Dialog, Field, Input, Select, Text } from '../ui';

// Creates a project from the sidebar. Where the code and the issues live can be left out; a checkout brought up with
// `agent-team up` registers under the same name and its committed manifest takes over.
export function NewProject({ projects, primary, to = 'integrations' }: { projects: ProjectNode[]; primary?: boolean; to?: 'integrations' | 'welcome' }) {
  const catalog = useResource<{ entries: { kind: string; title: string; target: string }[] }>('/api/integrations/catalog');
  const hosts = catalog.data?.entries.filter(entry => entry.target === 'scm') ?? [];
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);

  async function create(form: FormData) {
    const text = (name: string) => String(form.get(name) ?? '').trim();
    setBusy(true); setError(null);
    try {
      if (text('scm') && !text('repository')) { setError('Add the repository, or leave the code host for later.'); return; }
      const created = await api<{ slug: string }>('/api/projects', { name: text('name'), kind: text('kind') || 'repo', ...(text('parent') ? { parentSlug: text('parent') } : {}) });
      // The code host goes through the same guided setup the Integrations page uses, so both store the same thing.
      if (text('scm')) await api(`/api/projects/${created.slug}/integrations/setup`, { kind: text('scm'), values: { repository: text('repository') } }).catch(() => null);
      setOpen(false);
      // The tree is loaded once at the top of the app; a full navigation picks the new project up.
      window.location.assign(to === 'welcome' ? `/welcome?project=${created.slug}` : `/p/${created.slug}/integrations`);
    } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'The project could not be created'); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen} title="New project" description="It starts with the default team of four. Next you connect its code, task board and chat, step by step." trigger={primary ? <Button variant="primary">Create your first project</Button> : <Button variant="dashed" block>+ New project</Button>}>
      <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void create(new FormData(event.currentTarget)); }}>
        <Field label="Name"><Input name="name" required maxLength={80} autoFocus placeholder="Web shop" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="What kind of work"><Select name="kind"><option value="repo">Software</option><option value="documents">Documents and other work</option></Select></Field>
          <Field label="Part of"><Select name="parent"><option value="">Its own project</option>{projects.map(project => <option key={project.id} value={project.slug}>{project.name}</option>)}</Select></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Where the code lives"><Select name="scm"><option value="">Decide later</option>{hosts.map(host => <option key={host.kind} value={host.kind}>{host.title}</option>)}</Select></Field>
          <Field label="Repository" help="As in the address bar: owner/name"><Input name="repository" placeholder="owner/name" /></Field>
        </div>
        {error && <Text size="small" tone="stop">{error}</Text>}
        <div className="flex justify-end gap-2"><Button type="button" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={busy}>Create project</Button></div>
      </form>
    </Dialog>
  );
}
