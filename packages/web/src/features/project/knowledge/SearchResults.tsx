import { useEffect, useState } from 'react';
import { useResource } from '../../../data/useResource';
import { EmptyState } from '../../../patterns';
import { Card, ListRow, SectionLabel, Text } from '../../../ui';
import type { Hit } from './model';

const GROUPS: { type: string; label: string; note: string }[] = [
  { type: 'page', label: 'Pages', note: 'Opens the page' },
  { type: 'memory', label: 'Memories', note: 'Shows it in the list on the right' },
  { type: 'message', label: 'Said in discussions', note: 'Opens the conversation' },
  { type: 'issue', label: 'Issues', note: 'Opens the issue' },
];

// Waits for a pause in typing before asking, so a search is not sent for every letter.
export function useSettled(value: string, delay = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return settled;
}

// Results of one search over the project's pages, memories, discussions and issues, grouped by what they are.
export function SearchResults({ slug, query, onOpen }: { slug: string; query: string; onOpen(hit: Hit): void }) {
  const found = useResource<{ hits: Hit[] }>(`/api/projects/${slug}/search?limit=24&q=${encodeURIComponent(query)}`);
  if (found.error) return <Text tone="muted">{found.error.message}</Text>;
  if (!found.data) return <Text tone="muted">Searching…</Text>;
  const hits = found.data.hits;
  if (hits.length === 0) return <EmptyState title={`Nothing found for “${query}”`} note="Search looks for words that start with what you typed, and every word has to be there. Try fewer words, or just the start of one." />;
  return (
    <div className="flex max-w-180 flex-col gap-3.5">
      <Text size="small" tone="muted">{hits.length === 1 ? 'One result' : `${hits.length} results`} for “{query}”</Text>
      {GROUPS.map(group => {
        const items = hits.filter(hit => hit.type === group.type);
        return items.length === 0 ? null : (
          <Card key={group.type} pad="sm" className="flex flex-col gap-0.5">
            <SectionLabel aside={<Text size="caption" tone="faint">{group.note}</Text>}>{group.label}</SectionLabel>
            {items.map(hit => <ListRow key={`${hit.type}${hit.id}`} title={hit.title} note={hit.excerpt} onClick={() => onOpen(hit)} />)}
          </Card>
        );
      })}
    </div>
  );
}
