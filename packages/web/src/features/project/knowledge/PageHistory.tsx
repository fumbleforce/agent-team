import { useState } from 'react';
import { api } from '../../../data/client';
import { useResource } from '../../../data/useResource';
import { DiffView, maskDecisionTokens, Notice, Prose } from '../../../patterns';
import { Button, Card, Chip, ListRow, SectionLabel, Segmented, Text } from '../../../ui';
import { DecisionCard } from './DecisionCard';
import { ago, type PageView, type Revision, type RevisionView } from './model';

// The versions of a page, newest first: who wrote each, when, and their note. Any of them can be read as it was, compared with
// the page as it is now, and brought back. Bringing one back writes a new version on top; nothing is ever removed.
// A version that arrived from the document folder while the page had also changed here waits at the top until someone chooses.
export function PageHistory({ slug, page, canWrite, onChanged, onClose }: { slug: string; page: PageView['page']; canWrite: boolean; onChanged(): void; onClose(): void }) {
  const base = `/api/projects/${slug}/knowledge/pages/${page.id}`;
  const history = useResource<{ revisions: Revision[] }>(`${base}/history?at=${page.rev}`);
  const [chosen, setChosen] = useState<number | null>(null);
  const [show, setShow] = useState<'changes' | 'text'>('changes');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const opened = useResource<RevisionView>(chosen === null ? null : `${base}/revisions/${chosen}?at=${page.rev}`);

  const revisions = history.data?.revisions ?? [];
  const waiting = revisions.filter(item => item.waiting);
  const selected = revisions.find(item => item.rev === chosen) ?? null;
  const act = async (path: string, body: unknown) => {
    setBusy(true); setFailed(null);
    try { await api(`${base}/${path}`, body); setChosen(null); onChanged(); history.reload(); }
    catch (error) { setFailed((error as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex max-w-180 flex-col gap-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 grow flex-col gap-1">
          <Text as="h1" size="heading">History of “{page.title}”</Text>
        </div>
        <Button onClick={onClose}>Back to the page</Button>
      </div>

      {waiting.map(item => (
        <Notice key={item.rev} title="A different version came in from the document folder"
          actions={canWrite ? <><Button disabled={busy} onClick={() => void act('conflict', { rev: item.rev, choice: 'mine' })}>Keep mine</Button><Button disabled={busy} onClick={() => void act('conflict', { rev: item.rev, choice: 'theirs' })}>Use theirs</Button><Button variant="ghost" onClick={() => { setChosen(item.rev); setShow('changes'); }}>See what differs</Button></> : undefined}>
          Someone edited the copy in the document folder {ago(item.at)}, after this page had also changed here. The page still shows your version. “Keep mine” sets theirs aside; “Use theirs” makes it the page. Either way both stay in the history.
        </Notice>
      ))}
      {failed && <Notice tone="stop" title="That did not work">{failed}</Notice>}

      <Card pad="sm" className="flex flex-col gap-0.5">
        <SectionLabel>Versions</SectionLabel>
        {revisions.map(item => (
          <ListRow key={item.rev} active={item.rev === chosen} onClick={() => { setChosen(item.rev); setShow(item.current ? 'text' : 'changes'); }}
            title={`Version ${item.rev} · ${item.author} · ${ago(item.at)}`}
            note={item.note ?? (item.rev === 1 ? 'First version' : 'No note')}
            aside={item.current ? <Chip tone="working">Shown now</Chip> : item.waiting ? <Chip tone="attention">Waiting for a choice</Chip> : undefined} />
        ))}
        {!history.data && <Text size="small" tone="muted">Loading…</Text>}
      </Card>

      {selected && (
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Text size="title">Version {selected.rev}</Text>
            <Text size="small" tone="muted">{selected.author}, {new Date(selected.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</Text>
            {!selected.current && <span className="ml-auto"><Segmented<'changes' | 'text'> options={[{ value: 'changes', label: selected.waiting ? 'What differs' : 'What changed since' }, { value: 'text', label: selected.waiting ? 'Their version' : 'The page as it was' }]} value={show} onChange={setShow} /></span>}
          </div>
          {!opened.data ? <Text size="small" tone="muted">Loading…</Text> : selected.current || show === 'text' ? <Prose decision={id => <DecisionCard slug={slug} id={id} />}>{opened.data.revision.body}</Prose> : (
            <>
              <Text size="small" tone="muted">{selected.waiting ? 'Red lines are only in their version. Green lines are only in yours.' : `From version ${selected.rev} to the page as it is now: green lines were added, red lines were taken out.`}</Text>
              {opened.data.diff.text ? <DiffView plain text={maskDecisionTokens(opened.data.diff.text)} /> : <Text size="small" tone="muted">The text is the same as the page shows now.</Text>}
            </>
          )}
          {canWrite && !selected.current && !selected.waiting && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void act('restore', { rev: selected.rev })}>Restore this version</Button>
              <Text size="caption" tone="muted">Brings this text back as a new version on top. Nothing in the history is removed.</Text>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
