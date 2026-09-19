import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../../data/client';
import { useResource } from '../../../data/useResource';
import { decisionToken, hasDecisionToken, Notice, Prose } from '../../../patterns';
import { Button, Field, Input, Segmented, Select, Text, Textarea } from '../../../ui';
import { DecisionCard } from './DecisionCard';
import { folderName, folderOf, foldersOf, pathFor, slugify, type Decision, type PageRef, type PageView, type ScopeChoice } from './model';

const NEW_FOLDER = '+new';
const NEWLINE = String.fromCharCode(10);

// Writing a new page or editing one. A person never types a file path: the place is picked from the folders that exist
// (or a new one is named) and the address is made from the title. Saving an edit names the version it started from,
// so an edit made on top of someone else's newer text is refused instead of silently replacing it.
export function PageEditor({ slug, scope, pages, editing, onSaved, onCancel }: { slug: string; scope: ScopeChoice; pages: PageRef[]; editing: PageView['page'] | null; onSaved(pageId: string): void; onCancel(): void }) {
  const [title, setTitle] = useState(editing?.title ?? '');
  const [folder, setFolder] = useState(editing ? folderOf(editing.path) : '');
  const [newFolder, setNewFolder] = useState('');
  const [body, setBody] = useState(editing?.body ?? '');
  const [note, setNote] = useState('');
  const [baseRev, setBaseRev] = useState(editing?.rev ?? 0);
  const [view, setView] = useState<'write' | 'preview'>('write');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ kind: 'stale' | 'exists' | 'other'; message: string } | null>(null);
  const decisions = useResource<{ decisions: Decision[] }>(`/api/projects/${slug}/decisions`);

  // A refused save is answered right above the buttons; bring that into view, since the form is taller than most windows.
  const answer = useRef<HTMLDivElement>(null);
  useEffect(() => { if (problem) answer.current?.scrollIntoView({ block: 'center' }); }, [problem]);

  const place = folder === NEW_FOLDER ? slugify(newFolder) : folder;
  const path = editing ? editing.path : pathFor(place, title);
  const ready = title.trim() !== '' && body.trim() !== '' && (folder !== NEW_FOLDER || place !== '');

  const save = async (expectedRev: number) => {
    setBusy(true); setProblem(null);
    try {
      const saved = await api<{ id: string }>(`/api/projects/${slug}/knowledge?scope=${scope.key}`, { path, title: title.trim(), body, expectedRev, ...(note.trim() ? { note: note.trim() } : {}) });
      onSaved(saved.id);
    } catch (error) {
      const stale = error instanceof ApiError && error.code === 'stale';
      setProblem(stale ? { kind: editing ? 'stale' : 'exists', message: '' } : { kind: 'other', message: (error as Error).message });
    } finally { setBusy(false); }
  };
  // Someone saved first: take their text and start again from it, or knowingly put ours on top (theirs stays in the history).
  const loadLatest = async () => {
    if (!editing) return;
    const latest = await api<PageView>(`/api/projects/${slug}/knowledge/pages/${editing.id}`);
    setTitle(latest.page.title); setBody(latest.page.body); setBaseRev(latest.page.rev); setProblem(null);
  };
  const saveOverTheirs = async () => {
    if (!editing) return;
    const latest = await api<PageView>(`/api/projects/${slug}/knowledge/pages/${editing.id}`);
    setBaseRev(latest.page.rev);
    await save(latest.page.rev);
  };

  return (
    <form className="flex max-w-180 flex-col gap-4" onSubmit={event => { event.preventDefault(); if (ready && !busy) void save(baseRev); }}>
      <div className="flex flex-col gap-1">
        <Text as="h1" size="heading">{editing ? 'Edit this page' : 'Write a new page'}</Text>
        <Text size="small" tone="muted">{editing ? 'Saving keeps the earlier version in the history, so nothing is lost.' : `The page is kept with ${scope.label} and the agents working there can read it.`}</Text>
      </div>

      <Field label="Title" help="What the page is about, the way you would say it to a colleague.">
        <Input value={title} onChange={event => setTitle(event.target.value)} placeholder="How refunds work" maxLength={160} required />
      </Field>

      {!editing && (
        <Field label="Where it goes" help="Folders keep related pages together in the list on the left.">
          <Select value={folder} onChange={event => setFolder(event.target.value)}>
            <option value="">At the top, in no folder</option>
            {foldersOf(pages).map(dir => <option key={dir} value={dir}>In “{folderName(dir)}”</option>)}
            <option value={NEW_FOLDER}>In a new folder…</option>
          </Select>
        </Field>
      )}
      {!editing && folder === NEW_FOLDER && (
        <Field label="Name of the new folder" help="A word or two, for example “Payments” or “How we work”.">
          <Input value={newFolder} onChange={event => setNewFolder(event.target.value)} placeholder="Payments" maxLength={60} />
        </Field>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-end gap-2">
          <Text size="small" tone="muted">What the page says</Text>
          <span className="ml-auto"><Segmented<'write' | 'preview'> options={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]} value={view} onChange={setView} /></span>
        </div>
        {view === 'write'
          ? <Textarea aria-label="What the page says" rows={16} value={body} onChange={event => setBody(event.target.value)} placeholder={'Write in plain text. A line starting with # becomes a heading, a line starting with - becomes a list item, and **two stars** make text bold.'} />
          : body.trim() ? <Prose decision={id => <DecisionCard slug={slug} id={id} />}>{body}</Prose> : <Text size="small" tone="muted">Nothing to preview yet.</Text>}
        {view === 'write' && hasDecisionToken(body) && <Text size="caption" tone="muted">A line that starts with [[decision: is where a decision is shown; Preview shows which one. Move the whole line to move it, or delete the line to take it out.</Text>}
        <Text size="caption" tone="faint">Formatting is Markdown: # heading, - list item, **bold**, [link text](address). Preview shows how it will look.</Text>
      </div>

      {(decisions.data?.decisions.length ?? 0) > 0 && (
        <Field label="Point at a decision (optional)" help="The page will show the decision as it stands when someone reads it, instead of a copy that goes out of date.">
          <Select value="" onChange={event => { if (event.target.value) setBody(current => `${current.replace(/\s+$/, '')}${current.trim() ? NEWLINE + NEWLINE : ''}${decisionToken(event.target.value)}${NEWLINE}`); }}>
            <option value="">Choose a decision to add at the end of the page…</option>
            {decisions.data?.decisions.map(item => <option key={item.id} value={item.id}>{item.summary.length > 90 ? `${item.summary.slice(0, 90)}…` : item.summary}</option>)}
          </Select>
        </Field>
      )}

      {editing && (
        <Field label="What changed (optional)" help="One line for the history, so others can tell this version from the one before.">
          <Input value={note} onChange={event => setNote(event.target.value)} placeholder="Added the refund limits" maxLength={200} />
        </Field>
      )}

      <div ref={answer} className="flex flex-col gap-2">
      {problem?.kind === 'stale' && (
        <Notice title="Someone else changed this page while you were writing" actions={<><Button onClick={() => void loadLatest()}>Load their version (replaces what you typed)</Button><Button onClick={() => void saveOverTheirs()}>Save mine on top</Button></>}>
          Your text has not been saved yet and is still here. If you save yours on top, their version stays in the history and can be restored.
        </Notice>
      )}
      {problem?.kind === 'exists' && <Notice title="There is already a page with this title in that place">Choose a different title or folder, or open the existing page and edit it.</Notice>}
      {problem?.kind === 'other' && <Notice tone="stop" title="The page could not be saved">{problem.message}</Notice>}
      </div>

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!ready || busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save page'}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
