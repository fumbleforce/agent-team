import { useState } from 'react';
import { Link } from 'wouter';
import type { Me, ProjectNode } from '../../data/client';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { ListLink, Markdown, SidePanel } from '../../patterns';
import { Button, Card, Checkbox, Chip, CodeBlock, Dialog, Field, Input, SectionLabel, Text, Textarea } from '../../ui';
import { OrgShell } from './OrgShell';

interface Source { repository: string; path: string; commit: string | null; license: string; author: string | null }
interface SkillRow { slug: string; version: number; author: string; description: string; always: boolean; source: Source | null; files: number; usedBy: string[] }
interface SkillDoc { slug: string; description: string; body: string; files: { path: string; content: string }[]; always: boolean; source: Source | null }
interface SkillView { slug: string; version: number; author: string; doc: SkillDoc; usedBy: string[]; history: { version: number; author: string; note: string | null }[] }
interface ImportSource { title: string; example: string }
interface Preview { source: Source; skipped: string[]; skills: { slug: string; description: string; files: string[]; state: 'new' | 'changed' | 'same' }[] }

const go = (href: string) => { window.history.pushState(null, '', href); window.dispatchEvent(new PopStateEvent('popstate')); };
const failed = (failure: unknown, fallback: string) => (failure instanceof ApiError ? failure.message : fallback);
const origin = (source: Source) => [`${source.repository}${source.path ? `/${source.path}` : ''}${source.commit ? ` at ${source.commit.slice(0, 7)}` : ''}`, source.license === 'none' ? 'no license found' : `${source.license} license`, source.author].filter(Boolean).join(' · ');
const STATE = { new: 'New here', changed: 'Differs from ours', same: 'Same as ours' } as const;
const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

// Import is two steps: what is at the address and how it compares with what is here, then the ones ticked. New and changed ones
// start ticked; importing a skill again replaces its text, and the text it had stays in its history.
function ImportSkills({ sources, onDone }: { sources: ImportSource[]; onDone(slugs: string[]): void }) {
  const [open, setOpen] = useState(false), [url, setUrl] = useState(''), [preview, setPreview] = useState<Preview | null>(null);
  const [chosen, setChosen] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const reset = (next: boolean) => { setOpen(next); if (!next) { setPreview(null); setChosen([]); setError(null); } };
  const look = async () => {
    setBusy(true); setError(null);
    try { const found = await api<Preview>('/api/skills/import/preview', { url }); setPreview(found); setChosen(found.skills.filter(skill => skill.state !== 'same').map(skill => skill.slug)); }
    catch (failure) { setError(failed(failure, 'That address could not be read')); } finally { setBusy(false); }
  };
  const bring = async () => {
    setBusy(true); setError(null);
    try { const done = await api<{ imported: string[] }>('/api/skills/import', { url, slugs: chosen }); reset(false); onDone(done.imported); }
    catch (failure) { setError(failed(failure, 'The import failed')); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={reset} title="Import skills" description={`From a folder of skills on ${sources.map(source => source.title).join(' or ')}: one SKILL.md per folder, as the common skill collections are written.`} trigger={<Button block>Import from {sources.map(source => source.title).join(' or ')}</Button>}>
      <div className="flex flex-col gap-3">
        <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); void look(); }}>
          <span className="grow"><Field label="Address of the folder"><Input value={url} onChange={event => { setUrl(event.target.value); setPreview(null); }} required autoFocus placeholder={sources[0]?.example ?? ''} /></Field></span>
          <Button type="submit" disabled={busy || !url.trim()}>Look</Button>
        </form>
        {preview && (
          <div className="flex flex-col gap-2">
            <Text size="small" tone="muted">{origin(preview.source)}</Text>
            <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
              {preview.skills.map(skill => <Checkbox key={skill.slug} label={<span className="flex items-center gap-2">{skill.slug}<Chip tone={skill.state === 'same' ? 'neutral' : 'working'}>{STATE[skill.state]}</Chip></span>} note={skill.description} checked={chosen.includes(skill.slug)} onChange={() => setChosen(chosen.includes(skill.slug) ? chosen.filter(slug => slug !== skill.slug) : [...chosen, skill.slug])} />)}
            </div>
            {preview.skipped.length > 0 && <Text size="caption" tone="muted">Left out: {preview.skipped.join('; ')}</Text>}
            <Text size="caption" tone="muted">Scripts in a skill are kept as text and never run. Only roles you give a skill to will read it.</Text>
          </div>
        )}
        {error && <Text size="small" tone="stop">{error}</Text>}
        <div className="flex justify-end gap-2"><Button onClick={() => reset(false)}>Cancel</Button><Button variant="primary" disabled={busy || !preview || chosen.length === 0} onClick={() => void bring()}>Import {chosen.length || ''}</Button></div>
      </div>
    </Dialog>
  );
}

function NewSkill({ onCreated }: { onCreated(slug: string): void }) {
  const [open, setOpen] = useState(false), [error, setError] = useState<string | null>(null);
  const create = async (form: FormData) => {
    const slug = slugOf(String(form.get('name') ?? ''));
    if (!slug) { setError('Give the skill a name'); return; }
    try { await api(`/api/skills/${slug}`, { doc: { description: String(form.get('description') ?? '').trim(), body: String(form.get('body') ?? '').trim() }, note: 'Created', expectedVersion: 0 }); setOpen(false); setError(null); onCreated(slug); }
    catch (failure) { setError(failed(failure, 'The skill could not be created')); }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen} title="New skill" description="A written method for one kind of work. Give it to a role to have its seats use it." trigger={<Button block variant="dashed">+ New skill</Button>}>
      <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void create(new FormData(event.currentTarget)); }}>
        <Field label="Name"><Input name="name" required maxLength={63} autoFocus placeholder="release-notes" /></Field>
        <Field label="When to use it" help="What a seat reads before deciding to open the rest."><Textarea name="description" required rows={2} maxLength={600} placeholder="Use when writing the notes for a release." /></Field>
        <Field label="The method"><Textarea name="body" required rows={10} placeholder="# Release notes" /></Field>
        {error && <Text size="small" tone="stop">{error}</Text>}
        <div className="flex justify-end gap-2"><Button onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary">Create skill</Button></div>
      </form>
    </Dialog>
  );
}

function SkillEditor({ skill, onSaved, onCancel }: { skill: SkillView; onSaved(): void; onCancel(): void }) {
  const [error, setError] = useState<string | null>(null);
  const submit = async (form: FormData) => {
    // The version guards against overwriting someone else's edit.
    try { await api(`/api/skills/${skill.slug}`, { doc: { ...skill.doc, description: form.get('description'), body: form.get('body'), always: form.get('always') === 'on' }, note: form.get('note') || undefined, expectedVersion: skill.version }); onSaved(); }
    catch (failure) { setError(failed(failure, 'Saving failed')); }
  };
  return (
    <form className="flex flex-col gap-3.5" onSubmit={event => { event.preventDefault(); void submit(new FormData(event.currentTarget)); }}>
      <Field label="When to use it"><Textarea name="description" rows={2} required maxLength={600} defaultValue={skill.doc.description} /></Field>
      <Checkbox name="always" label="Always apply" note="Its whole text goes with every turn of the seats that have it, instead of being read when needed. Keep this for short skills about everything they write." defaultChecked={skill.doc.always} />
      <Field label="The method (Markdown)"><Textarea name="body" rows={22} required defaultValue={skill.doc.body} /></Field>
      <Field label="Note for the history"><Input name="note" maxLength={200} /></Field>
      {error && <Text size="small" tone="stop">{error}</Text>}
      <div className="flex gap-1.5"><Button variant="primary" type="submit">Save as version {skill.version + 1}</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function SkillDetail({ slug, canEdit, onChanged }: { slug: string; canEdit: boolean; onChanged(): void }) {
  const view = useResource<SkillView>(`/api/skills/${slug}`);
  const [editing, setEditing] = useState(false), [shown, setShown] = useState<string[]>([]), [error, setError] = useState<string | null>(null);
  const skill = view.data;
  if (!skill) return null;
  const changed = () => { view.reload(); onChanged(); };
  const revert = (version: number) => { setError(null); void api(`/api/skills/${slug}/revert`, { version }).then(changed, failure => setError(failed(failure, 'That version could not be put back'))); };
  return (
    <div className="flex min-w-0 grow flex-col gap-4 overflow-y-auto px-6 py-5">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5"><Text as="h2" size="heading">{skill.slug}</Text>{skill.doc.always && <Chip tone="working">Always applied</Chip>}<Text size="caption" tone="muted">v{skill.version} · edited by {skill.author}</Text>{canEdit && !editing && <span className="ml-auto"><Button onClick={() => setEditing(true)}>Edit</Button></span>}</div>
        <Text tone="soft">{skill.doc.description}</Text>
        {skill.doc.source && <Text size="caption" tone="muted">From {origin(skill.doc.source)}</Text>}
        <div className="flex flex-wrap items-center gap-1.5"><Text size="small" tone="muted">Used by</Text>{skill.usedBy.map(role => <Link key={role} href={`/roles/${role}`}><Chip>{role}</Chip></Link>)}{skill.usedBy.length === 0 && <Text size="small" tone="muted">no role yet: give it to one on the Roles page</Text>}</div>
      </div>
      {editing ? <SkillEditor skill={skill} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); changed(); }} /> : <Card><Markdown>{skill.doc.body}</Markdown></Card>}
      {skill.doc.files.length > 0 && (
        <section aria-label="Files" className="flex flex-col gap-2">
          <SectionLabel>Files it refers to</SectionLabel>
          {skill.doc.files.map(file => (
            <div key={file.path} className="flex flex-col gap-1.5">
              <div><Button size="sm" variant="ghost" onClick={() => setShown(shown.includes(file.path) ? shown.filter(path => path !== file.path) : [...shown, file.path])}>{shown.includes(file.path) ? 'Hide' : 'Show'} {file.path}</Button></div>
              {shown.includes(file.path) && (file.path.endsWith('.md') ? <Card pad="sm"><Markdown size="small">{file.content}</Markdown></Card> : <CodeBlock text={file.content} />)}
            </div>
          ))}
        </section>
      )}
      <section aria-label="History" className="flex flex-col gap-1.5">
        <SectionLabel>History</SectionLabel>
        {skill.history.map(row => <div key={row.version} className="flex items-center gap-2"><Text size="small">v{row.version}</Text><Text size="small" tone="muted" truncate>{row.author}{row.note ? ` · ${row.note}` : ''}</Text>{canEdit && row.version !== skill.version && <span className="ml-auto"><Button size="sm" variant="ghost" onClick={() => revert(row.version)}>Put back</Button></span>}</div>)}
        {error && <Text size="small" tone="stop">{error}</Text>}
      </section>
    </div>
  );
}

export function SkillsPage({ slug, me, projects }: { slug: string | null; me: Me; projects: ProjectNode[] }) {
  const list = useResource<{ skills: SkillRow[]; canEdit: boolean; sources: ImportSource[] }>('/api/skills');
  const skills = list.data?.skills ?? [], canEdit = list.data?.canEdit === true;
  const current = skills.find(skill => skill.slug === slug)?.slug ?? skills[0]?.slug ?? null;
  return (
    <OrgShell me={me} projects={projects} title="Skills" active="/skills">
      <div className="flex min-h-0 grow">
        <SidePanel label="Skills" wide>
          {canEdit && <div className="flex flex-col gap-1.5 px-1.5 pb-2">{list.data!.sources.length > 0 && <ImportSkills sources={list.data!.sources} onDone={slugs => { list.reload(); if (slugs[0]) go(`/skills/${slugs[0]}`); }} />}<NewSkill onCreated={created => { list.reload(); go(`/skills/${created}`); }} /></div>}
          {skills.map(skill => <ListLink key={skill.slug} href={`/skills/${skill.slug}`} active={skill.slug === current} aside={skill.always ? <Chip>always</Chip> : skill.usedBy.length ? <Text size="caption" tone="muted">{skill.usedBy.length}</Text> : undefined}>{skill.slug}</ListLink>)}
          {list.data && skills.length === 0 && <Text size="small" tone="muted">No skills yet.</Text>}
        </SidePanel>
        {current && <SkillDetail key={current} slug={current} canEdit={canEdit} onChanged={list.reload} />}
      </div>
    </OrgShell>
  );
}
