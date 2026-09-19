import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { EmptyState, ListLink, Notice, Prose, SidePanel, SubHeader } from '../../patterns';
import { Button, Input, Segmented, Text } from '../../ui';
import { DecisionCard } from './knowledge/DecisionCard';
import { MemoryRail } from './knowledge/MemoryRail';
import { ago, folderName, folderOf, type Hit, type PageView, type Revision, type ScopeKey, type Tree } from './knowledge/model';
import { PageEditor } from './knowledge/PageEditor';
import { PageHistory } from './knowledge/PageHistory';
import { SearchResults, useSettled } from './knowledge/SearchResults';

type Mode = 'read' | 'edit' | 'new' | 'history';

// What the team knows: pages in folders, the memory beside them, and one search over both and over what was said.
// Knowledge is kept at several levels (this part of the project, the project, the team, the organization); the switch at the top picks one.
export function KnowledgeTab({ slug, pageId }: { slug: string; pageId: string | null }) {
  const [, navigate] = useLocation();
  const [scope, setScope] = useState<ScopeKey | null>(null);
  const [mode, setMode] = useState<Mode>('read');
  const [query, setQuery] = useState('');
  const [focusMemory, setFocusMemory] = useState<string | null>(null);
  const asked = useSettled(query.trim());

  const tree = useResource<Tree>(`/api/projects/${slug}/knowledge${scope ? `?scope=${scope}` : ''}`);
  // An address that names a page wins; otherwise the first page of the level shown.
  const selected = pageId ?? tree.data?.pages[0]?.id ?? null;
  const page = useResource<PageView>(selected ? `/api/projects/${slug}/knowledge/pages/${selected}` : null);
  const history = useResource<{ revisions: Revision[] }>(selected && page.data ? `/api/projects/${slug}/knowledge/pages/${selected}/history?at=${page.data.page.rev}` : null);
  useStream(event => event.type === 'kb.page_revised' || event.type === 'kb.page_conflict' || event.type === 'memory.filed', () => { tree.reload(); if (mode !== 'edit') page.reload(); history.reload(); });
  // A page opened by its address may live at another level than the one shown: follow it, so the list on the left contains it.
  useEffect(() => { if (pageId && page.data && tree.data && page.data.scope !== tree.data.scope) setScope(page.data.scope); }, [pageId, page.data, tree.data]);

  // Picking another page in the list leaves whatever was open on the previous one.
  useEffect(() => { setMode('read'); }, [pageId]);

  const level = tree.data?.scopes.find(item => item.key === tree.data?.scope);
  const current = page.data?.page ?? null;
  const last = history.data?.revisions.find(item => item.current);
  const waiting = history.data?.revisions.some(item => item.waiting) ?? false;
  const open = (id: string) => { setMode('read'); setQuery(''); navigate(`/p/${slug}/knowledge/${id}`); };
  const openHit = (hit: Hit) => {
    if (hit.target.kind === 'page') open(hit.target.pageId);
    else if (hit.target.kind === 'issue') navigate(`/p/${hit.target.slug}/issues/${hit.target.number}`);
    else if (hit.target.kind === 'discussion') navigate(`/p/${hit.target.slug}/tasks`);
    else { if (hit.target.scope) setScope(hit.target.scope); setFocusMemory(hit.target.memoryId); setQuery(''); }
  };

  let folder = '';
  return (
    <div className="flex min-h-0 grow flex-col">
      <SubHeader>
        {tree.data && tree.data.scopes.length > 1 && <Segmented options={tree.data.scopes.map(item => ({ value: item.key, label: item.label }))} value={tree.data.scope} onChange={key => { setScope(key); setMode('read'); setFocusMemory(null); navigate(`/p/${slug}/knowledge`); }} />}
        {level && <Text size="caption" tone="muted">{level.note}</Text>}
        <div className="ml-auto flex w-full max-w-100 items-center gap-2">
          <Input type="search" aria-label="Search knowledge" placeholder="Search pages, memories, discussions and issues" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
      </SubHeader>

      <div className="flex min-h-0 grow">
        <SidePanel label="Pages">
          {tree.data?.canWrite && <div className="px-1 pb-2"><Button block onClick={() => { setQuery(''); setMode('new'); }}>New page</Button></div>}
          {tree.data?.pages.map(item => {
            const dir = folderOf(item.path), heading = dir !== folder ? (folder = dir) : null;
            return (
              <div key={item.id} className="flex flex-col gap-0.5">
                {heading && <div className="px-2 pt-2"><Text size="small" tone="soft" weight="medium">▸ {folderName(heading)}</Text></div>}
                <ListLink href={`/p/${slug}/knowledge/${item.id}`} active={item.id === selected && mode !== 'new'} indent={dir !== ''}>{item.title}</ListLink>
              </div>
            );
          })}
          {tree.data?.pages.length === 0 && <div className="p-2"><Text size="small" tone="muted">No pages here yet. Agents write them as they learn, and you can write one yourself or make one from a memory.</Text></div>}
        </SidePanel>

        <article className="flex min-w-0 grow flex-col gap-3.5 overflow-y-auto px-8 py-5">
          {asked.length > 1 && query.trim() ? <SearchResults slug={slug} query={asked} onOpen={openHit} />
            : mode === 'new' && level ? <PageEditor key="new" slug={slug} scope={level} pages={tree.data?.pages ?? []} editing={null} onSaved={id => { tree.reload(); open(id); }} onCancel={() => setMode('read')} />
            : !current ? (tree.data && !selected ? <EmptyState title="Nothing written here yet" note={`Pages kept with ${level?.label ?? 'this project'} will show up here. Agents write them as they learn; you can start one too.`}>{tree.data.canWrite && <Button variant="primary" onClick={() => setMode('new')}>Write the first page</Button>}</EmptyState> : <Text tone="muted">{page.error ? page.error.message : 'Loading…'}</Text>)
            : mode === 'edit' && level ? <PageEditor key={current.id} slug={slug} scope={level} pages={tree.data?.pages ?? []} editing={current} onSaved={() => { setMode('read'); tree.reload(); page.reload(); }} onCancel={() => setMode('read')} />
            : mode === 'history' ? <PageHistory slug={slug} page={current} canWrite={page.data?.canWrite ?? false} onChanged={() => { tree.reload(); page.reload(); }} onClose={() => setMode('read')} />
            : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Text size="caption" tone="muted">{folderOf(current.path) ? `${folderName(folderOf(current.path))} · ` : ''}Version {current.rev}{last ? `, saved ${ago(last.at)} by ${last.author}` : ''} · read by {current.readByToday} agent{current.readByToday === 1 ? '' : 's'} today</Text>
                  <span className="ml-auto flex gap-2">
                    {page.data?.canWrite && <Button onClick={() => setMode('edit')}>Edit</Button>}
                    <Button onClick={() => setMode('history')}>History</Button>
                  </span>
                </div>
                {waiting && <Notice title="A different version came in from the document folder" actions={<Button onClick={() => setMode('history')}>Compare and choose</Button>}>The page below is your version. The other one is waiting in the history until someone chooses between them.</Notice>}
                <Text as="h1" size="display">{current.title}</Text>
                <Prose decision={id => <DecisionCard slug={slug} id={id} />}>{current.body}</Prose>
              </>
            )}
        </article>

        <SidePanel label="Memory" side="right" wide>
          <MemoryRail slug={slug} memories={tree.data?.memories ?? []} pages={tree.data?.pages ?? []} canWrite={tree.data?.canWrite ?? false} focus={focusMemory} onChanged={tree.reload} onPromoted={id => { tree.reload(); open(id); }} />
        </SidePanel>
      </div>
    </div>
  );
}
