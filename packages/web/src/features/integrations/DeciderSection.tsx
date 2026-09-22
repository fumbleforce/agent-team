import { useState } from 'react';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { StatusLine } from '../../patterns';
import { Button, Card, Chip, IconButton, Input, Menu, SectionLabel, StatusDot, Text } from '../../ui';

interface Key { label: string; own: boolean; saved: boolean; inEnvironment: boolean; active: boolean }
interface DeciderView { canEdit: boolean; name: string; on: boolean; source: string | null; keys: Key[]; reads: { count: number; usdMicro: number; lastAt: number | null; model: string | null } }

const money = (usdMicro: number) => (usdMicro < 10_000 ? `$${(usdMicro / 1_000_000).toFixed(4)}` : `$${(usdMicro / 1_000_000).toFixed(2)}`);
const where = (key: Key) => (key.saved ? 'entered in the app' : key.inEnvironment ? 'from the environment' : null);

// The decision model: the team's typed reads (what kind of report, how urgent, how hard a task looks). It runs no turn, so it
// is not a model provider; it is on as soon as a key is, and this says which one and what it has read for this project.
export function DeciderSection({ slug }: { slug: string }) {
  const view = useResource<DeciderView>(`/api/decider?project=${encodeURIComponent(slug)}`);
  const [keying, setKeying] = useState(false), [problem, setProblem] = useState<string | null>(null);
  const send = (path: string, body: unknown) => { setProblem(null); void api(path, body).then(view.reload, failure => setProblem(failure instanceof ApiError ? failure.message : 'That did not work; try again.')); };
  const data = view.data;
  if (!data) return null;
  const reads = data.reads, own = data.keys.find(key => key.own), shared = data.keys.filter(key => !key.own), active = data.keys.find(key => key.active);
  const source = active ? `On, with the ${active.label} ${where(active) ?? ''}`.trim() : `Off: add the ${own?.label ?? 'key'} here${shared.length ? `, or the ${shared.map(key => key.label).join(' or ')} under Model providers` : ''}`;
  const said = reads.count === 0 ? 'Nothing read yet for this project' : `${reads.count} read${reads.count === 1 ? '' : 's'} for this project, ${money(reads.usdMicro)} in all${reads.lastAt ? `, last ${new Date(reads.lastAt).toLocaleString()}` : ''}${reads.model ? ` · ${reads.model}` : ''}`;
  return (
    <section aria-label="Decision model" className="flex flex-col gap-1.5">
      <SectionLabel>Decision model</SectionLabel>
      <Card tone="raised" pad="sm" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <StatusDot tone={data.on ? 'working' : 'off'} /><Text weight="semibold">{data.name}</Text>
          <Text size="caption" tone="muted" truncate className="grow">{source}</Text>
          <Chip tone={data.on ? 'attention' : 'neutral'}>Pay per read</Chip>
          {data.canEdit && own && <Menu align="end" label="Decision model" trigger={<IconButton icon="more" label="More for the decision model" hint={false} />} items={[
            { label: own.saved ? `Replace the ${own.label}…` : `Add the ${own.label}…`, onSelect: () => setKeying(true) },
            ...(own.saved ? ['separator' as const, { label: `Forget the ${own.label}…`, tone: 'danger' as const, onSelect: () => { if (window.confirm(`Forget the ${own.label}?`)) send('/api/decider/key/remove', {}); } }] : []),
          ]} />}
        </div>
        <Text size="small" tone="soft">Reads every report before the PM triages it (what kind, how bad, how urgent, who fits it, whether it is already on the board) and sizes every task before its first turn. It answers typed questions only, never a turn, and decides nothing on its own.</Text>
        <Text size="caption" tone="muted">{said}</Text>
        {keying && <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); const typed = String(new FormData(event.currentTarget).get('key') ?? '').trim(); if (typed) send('/api/decider/key', { key: typed }); setKeying(false); }}><Input compact name="key" type="password" autoComplete="off" autoFocus aria-label={own?.label ?? 'Key'} placeholder={own?.label ?? ''} /><Button type="submit" size="sm" variant="primary">Save</Button><Button size="sm" variant="ghost" onClick={() => setKeying(false)}>Cancel</Button></form>}
        {problem && <StatusLine tone="stop">{problem}</StatusLine>}
      </Card>
    </section>
  );
}
