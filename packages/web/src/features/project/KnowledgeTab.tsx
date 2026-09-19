import { useState } from 'react';
import { api } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { ListLink, NoteCard, Prose, SidePanel } from '../../patterns';
import { Button, Chip, SectionLabel, Text } from '../../ui';

interface PageRef { id: string; path: string; title: string }
interface Memory { id: string; title: string; body: string; type: string; status: string }
interface Tree { pages: PageRef[]; memories: Memory[] }
interface PageView { page: { id: string; path: string; title: string; rev: number; body: string; updatedAt: number; readByToday: number } }

export function KnowledgeTab({ slug, pageId }: { slug: string; pageId: string | null }) {
  const tree = useResource<Tree>(`/api/projects/${slug}/knowledge`);
  const selected = pageId ?? tree.data?.pages[0]?.id ?? null;
  const page = useResource<PageView>(selected ? `/api/projects/${slug}/knowledge/pages/${selected}` : null);
  const [busy, setBusy] = useState<string | null>(null);
  useStream(event => event.type === 'kb.page_revised' || event.type === 'memory.filed', () => { tree.reload(); page.reload(); });

  const act = async (memory: Memory, action: 'confirm' | 'retire' | 'promote') => {
    setBusy(memory.id);
    const path = `notes/${memory.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.md`;
    await api(`/api/projects/${slug}/memories/${memory.id}`, action === 'promote' ? { action, path } : { action }).finally(() => setBusy(null));
    tree.reload();
  };

  let folder = '';
  return (
    <div className="flex min-h-0 grow">
      <SidePanel label="Pages">
        {tree.data?.pages.map(item => {
          const parts = item.path.split('/'), dir = parts.slice(0, -1).join('/');
          const heading = dir !== folder ? (folder = dir) : null;
          return (
            <div key={item.id} className="flex flex-col gap-0.5">
              {heading && <div className="px-2 pt-2"><Text size="small" tone="soft" weight="medium">▸ {heading}</Text></div>}
              <ListLink href={`/p/${slug}/knowledge/${item.id}`} active={item.id === selected} indent={dir !== ''}>{parts.at(-1)}</ListLink>
            </div>
          );
        })}
        {tree.data?.pages.length === 0 && <div className="p-2"><Text size="small" tone="muted">No pages yet. Agents write them as they learn; you can promote a memory.</Text></div>}
      </SidePanel>

      <article className="flex min-w-0 grow flex-col gap-3.5 overflow-y-auto px-8 py-5">
        {page.data ? (
          <>
            <div className="flex items-center gap-2">
              <Text size="caption" tone="muted" mono>{page.data.page.path}</Text>
              <Text size="caption" tone="muted" mono className="ml-auto">v{page.data.page.rev} · read by {page.data.page.readByToday} agent{page.data.page.readByToday === 1 ? '' : 's'} today</Text>
            </div>
            <Text as="h1" size="display">{page.data.page.title}</Text>
            <Prose>{page.data.page.body}</Prose>
          </>
        ) : <Text tone="muted">Select a page.</Text>}
      </article>

      <SidePanel label="Memory" side="right" wide>
        <div className="flex flex-col gap-2 px-1.5">
          <SectionLabel>Memory</SectionLabel>
          <Text size="caption" tone="muted">Things the team learned, not yet pages.</Text>
          {tree.data?.memories.map(memory => (
            <div key={memory.id} className="flex flex-col gap-1.5">
              <NoteCard meta={<>{memory.title}</>} tag={memory.status}>{memory.body}</NoteCard>
              <div className="flex gap-1.5">
                {memory.status === 'filed' && <Button size="sm" disabled={busy === memory.id} onClick={() => act(memory, 'confirm')}>Confirm</Button>}
                <Button size="sm" disabled={busy === memory.id} onClick={() => act(memory, 'promote')}>Promote to page</Button>
                <Button size="sm" variant="ghost" disabled={busy === memory.id} onClick={() => act(memory, 'retire')}>Retire</Button>
              </div>
            </div>
          ))}
          {tree.data?.memories.length === 0 && <Chip>nothing filed</Chip>}
        </div>
      </SidePanel>
    </div>
  );
}
