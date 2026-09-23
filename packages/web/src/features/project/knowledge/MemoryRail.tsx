import { useEffect, useRef, useState } from 'react';
import { api } from '../../../data/client';
import { NoteCard, Notice } from '../../../patterns';
import { Button, SectionLabel, Segmented, Text } from '../../../ui';
import { slugify, usage, type Memory, type PageRef } from './model';

const STATUS: Record<string, { label: string; tone: 'neutral' | 'working' | 'attention' }> = { filed: { label: 'In use', tone: 'neutral' }, confirmed: { label: 'Confirmed', tone: 'working' }, stale: { label: 'Out of use', tone: 'attention' }, superseded: { label: 'Replaced', tone: 'neutral' } };

// What the team has learned and not yet written up. The team keeps memories from its own work and turns are given the ones that bear
// on them at once; a person confirming one ranks it higher. One that proves lasting becomes a page; one nobody used for two months, or
// whose work kept being sent back, is taken out of use until a person looks. A replacement the team made is listed for a month and can be undone.
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
  const act = async (memory: Memory, action: 'confirm' | 'retire' | 'promote' | 'restore') => {
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
      {filter === 'stale' && <Text size="caption" tone="muted">Unused for two months. Keep, make a page, or retire.</Text>}
      {failed && <Notice tone="stop" title="That did not work">{failed}</Notice>}
      {shown.map(memory => {
        const status = memory.stale ? STATUS.stale! : STATUS[memory.status] ?? STATUS.filed!;
        return (
          <div key={memory.id} ref={memory.id === focus ? focused : undefined} className="flex flex-col gap-1.5">
            <NoteCard meta={<>{memory.title} · {memory.source === 'owner' ? 'from you · ' : ''}{memory.roleSlug ? `for ${memory.roleSlug} · ` : ''}{usage(memory)}</>} tag={status.label} tagTone={status.tone} highlight={memory.id === focus}>{memory.body}</NoteCard>
            {memory.status === 'superseded' && <Text size="caption" tone="muted">Replaced{memory.supersedeReason ? `: ${memory.supersedeReason}` : ''}</Text>}
            {canWrite && memory.status === 'superseded' && <div className="flex flex-wrap gap-1.5"><Button size="sm" disabled={busy === memory.id} onClick={() => void act(memory, 'restore')}>Undo the replacement</Button></div>}
            {canWrite && memory.status !== 'superseded' && (
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
