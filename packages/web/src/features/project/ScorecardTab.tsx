import { useState } from 'react';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { Card, Chip, SectionLabel, Segmented, Text } from '../../ui';

// The figures of docs/ROADMAP.md for this project, added up by the coordinator from what it records.
type Unit = 'share' | 'count' | 'ms' | 'usd' | 'per100' | 'ratio';
interface Figure { id: string; group: string; measure: string; value: number | null; unit: Unit; sample: number; target: string; met: boolean | null; note?: string }
interface Scorecard { from: number; to: number; computedAt: number; figures: Figure[] }

const GROUPS: Record<string, string> = {
  'team-vs-one': 'The team against one model',
  'self-improving': 'A team that improves itself',
  memory: 'Memory',
  autonomy: 'Autonomy',
  performance: 'Performance',
  delivery: 'Delivery',
  observability: 'Observability',
  safety: 'Safety',
  decisions: 'The decision model',
};

const MINUTE = 60_000;
const FORMAT: Record<Unit, (value: number) => string> = {
  share: value => `${Math.round(value * 100)} %`,
  count: value => (Number.isInteger(value) ? String(value) : value.toFixed(2)),
  ratio: value => value.toFixed(2),
  per100: value => value.toFixed(1),
  usd: value => `$${value.toFixed(2)}`,
  ms: value => (value >= 60 * MINUTE ? `${(value / (60 * MINUTE)).toFixed(1)} h` : value >= MINUTE ? `${(value / MINUTE).toFixed(1)} min` : `${Math.round(value / 1000)} s`),
};

function Row({ item }: { item: Figure }) {
  const measured = item.value !== null;
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <Text size="caption" tone="muted" mono className="w-8 shrink-0">{item.id}</Text>
      <div className="flex min-w-0 grow flex-col">
        <Text size="small">{item.measure}</Text>
        {item.note && <Text size="caption" tone="muted">{item.note}</Text>}
      </div>
      <Text size="caption" tone="muted" className="hidden shrink-0 sm:block">target {item.target}</Text>
      <div className="flex w-28 shrink-0 items-baseline justify-end gap-2">
        {measured ? <Text size="small" weight="semibold" mono>{FORMAT[item.unit](item.value!)}</Text> : <Text size="caption" tone="faint">not measured</Text>}
        {item.met !== null && <Chip tone={item.met ? 'working' : 'attention'}>{item.met ? 'met' : 'not met'}</Chip>}
      </div>
    </div>
  );
}

export function ScorecardTab({ slug }: { slug: string }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const card = useResource<Scorecard>(`/api/projects/${slug}/scorecard?days=${days}`);
  useStream(event => event.type.startsWith('turn.') || event.type.startsWith('task.'), card.reload);
  const data = card.data;
  if (!data) return <div className="p-5"><Text tone="muted">Loading…</Text></div>;

  const groups = Object.keys(GROUPS).map(key => ({ key, items: data.figures.filter(item => item.group === key) })).filter(group => group.items.length > 0);
  const judged = data.figures.filter(item => item.met !== null);
  return (
    <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-5 pt-3.5 pb-4.5">
      <div className="flex flex-wrap items-center gap-3">
        <Text size="small" tone="muted" className="grow">{judged.filter(item => item.met).length} of {judged.length} measured targets met. A figure with nothing to count says so, and is never shown as zero.</Text>
        <Segmented<'7' | '30' | '90'> value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      </div>
      {groups.map(group => (
        <Card key={group.key} pad="sm" className="flex flex-col">
          <SectionLabel>{GROUPS[group.key]}</SectionLabel>
          {group.items.map(item => <Row key={item.id} item={item} />)}
        </Card>
      ))}
    </div>
  );
}
