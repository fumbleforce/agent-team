import { useEffect, useRef, useState } from 'react';
import { api } from '../../../data/client';
import { NoteCard, Notice } from '../../../patterns';
import { Button, SectionLabel, Segmented, Text } from '../../../ui';
import { slugify, usage, type Memory, type PageRef } from './model';

const STATUS: Record<string, { label: string; tone: 'neutral' | 'working' | 'attention' }> = { filed: { label: 'New', tone: 'neutral' }, confirmed: { label: 'Confirmed', tone: 'working' }, stale: { label: 'Not used lately', tone: 'attention' } };

// What the team has learned and not yet written up. An agent notes a memory; a person confirms it, which lets agents start
// their work with it; one that proves lasting becomes a page; one nobody has used for two months comes up for review.
export function MemoryRail({ slug, memories, pages, canWrite, focus, onChanged, onPromoted }: { slug: string; memories: Memory[]; pages: PageRef[]; canWrite: boolean; focus: string | null; onChanged(): void; onPromoted(pageId: string): void }) {
  const [picked, setFilter] = useState<'all' | 'stale'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const focused = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) { setFilter('all'); focused.current?.scrollIntoView({ block: 'center' }); } }, [focus]);

  const stale = memories.filter(memory => memory.stale);
  // With nothing left to review the list goes back to everything.
  const filter = stale.length > 0 ? picked : 'all';
  const shown = filter === 'stale' ? stale : memories;
  const act = async (memory: Memory, action: 'confirm' | 'retire' | 'promote') => {
    setBusy(memory.id); setFailed(null);
    // The new page goes under Notes, named after the memory; a number is added when that name is taken.
    const taken = new Set(pages.map(page => page.path)), stem = `notes/${slugify(memory.title) || 'memory'}`;
    let path = `${stem}.md`;
    for (let copy = 2; taken.has(path); copy++) path = `${stem}-${copy}.md`;
    try {
      const result = await api<{ id?: string }>(`/api/projects/${slug}/memories/${memory.id}`, action === 'promote' ? { action, path } : { action });
      onChanged();
      if (action === 'promote' && result.id) onPromoted(result.id);
    } catch (error) { setFailed((error as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="flex flex-col gap-2 px-1.5">
      <SectionLabel>Memory</SectionLabel>
      {stale.length > 0 && <Segmented<'all' | 'stale'> options={[{ value: 'all', label: `All (${memories.length})` }, { value: 'stale', label: `Review stale (${stale.length})` }]} value={filter} onChange={setFilter} />}
      {filter === 'stale' && <Text size="caption" tone="muted">Nobody has used these for two months. Keep what is still true, make a page of what deserves one, and retire the rest.</Text>}
      {failed && <Notice tone="stop" title="That did not work">{failed}</Notice>}
      {shown.map(memory => {
        const status = memory.stale ? STATUS.stale! : STATUS[memory.status] ?? STATUS.filed!;
        return (
          <div key={memory.id} ref={memory.id === focus ? focused : undefined} className="flex flex-col gap-1.5">
            <NoteCard meta={<>{memory.title} · {usage(memory)}</>} tag={status.label} tagTone={status.tone} highlight={memory.id === focus}>{memory.body}</NoteCard>
            {canWrite && (
              <div className="flex flex-wrap gap-1.5">
                {memory.stale ? <Button size="sm" disabled={busy === memory.id} onClick={() => void act(memory, 'confirm')}>Still true</Button>
                  : memory.status === 'filed' && <Button size="sm" disabled={busy === memory.id} onClick={() => void act(memory, 'confirm')}>Confirm</Button>}
                <Button size="sm" disabled={busy === memory.id} onClick={() => void act(memory, 'promote')}>Make it a page</Button>
                <Button size="sm" variant="ghost" disabled={busy === memory.id} onClick={() => void act(memory, 'retire')}>Retire</Button>
              </div>
            )}
          </div>
        );
      })}
      {memories.length === 0 && <Text size="small" tone="muted">Nothing noted here yet. Agents add to this list as they work.</Text>}
    </div>
  );
}
