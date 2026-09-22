import { useState } from 'react';
import { Link } from 'wouter';
import { api, ApiError } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { Markdown } from '../../patterns';
import { Button, Card, Chip, Meter, SectionLabel, Text, type ChipTone } from '../../ui';

type Kind = 'change' | 'card' | 'document' | 'asset' | 'record' | 'message' | 'campaign';
interface Round { dutyId: string; title: string; owner: string; kind: Kind; target: number; approved: number; everyHours: number; task: { id: string; key: string; state: string } | null }
interface Item { id: string; kind: Kind; title: string; body: string; link: string | null; fields: Record<string, string>; state: 'submitted' | 'approved' | 'rejected'; note: string | null; outcome: string | null; createdAt: number; author: string | null; reviewer: string | null; taskKey: string | null }

const WORDS: Record<Kind, [string, string]> = { change: ['change merged', 'changes merged'], card: ['card', 'cards'], document: ['document', 'documents'], asset: ['piece of material', 'pieces of material'], record: ['record', 'records'], message: ['message to send', 'messages to send'], campaign: ['campaign', 'campaigns'] };
const STATE: Record<Item['state'], { label: string; tone: ChipTone }> = { submitted: { label: 'Waiting to be judged', tone: 'attention' }, approved: { label: 'Approved', tone: 'working' }, rejected: { label: 'Sent back', tone: 'neutral' } };
const FIELD: Record<string, string> = { to: 'To', subject: 'Subject', name: 'Name', format: 'Format', channel: 'Channel' };
const every = (hours: number) => (hours === 24 ? 'every day' : hours === 168 ? 'every week' : hours % 24 === 0 ? `every ${hours / 24} days` : `every ${hours} hours`);
const day = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });

// What the team delivers: how far each round of a counted duty is, and every deliverable handed in lately with what became of it.
export function DeliverablesTab({ slug }: { slug: string }) {
  const view = useResource<{ rounds: Round[]; items: Item[] }>(`/api/projects/${slug}/deliverables`);
  useStream(event => event.type.startsWith('task.') || event.type === 'review.recorded' || event.type === 'duty.came_round', view.reload);
  if (!view.data) return <div className="p-5"><Text tone="muted">Loading…</Text></div>;
  const { rounds, items } = view.data;
  const days = [...new Set(items.map(item => day(item.createdAt)))];
  return (
    <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto px-5 pt-3.5 pb-4.5">
      {rounds.length === 0 && items.length === 0 && <Text size="small" tone="muted">Nothing is counted yet. Ask the chief of staff for a daily target, like ten leads a day, and it shows up here.</Text>}
      {rounds.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rounds.map(round => (
            <Card key={round.dutyId} pad="sm" className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <Text size="small" weight="semibold" className="grow">{round.title}</Text>
                <Text size="caption" tone="muted">{round.owner}, {every(round.everyHours)}</Text>
              </div>
              <div className="flex items-center gap-2">
                <Text size="heading" mono>{round.approved}</Text>
                <Text size="small" tone="muted">of {round.target} {WORDS[round.kind]?.[round.target === 1 ? 0 : 1] ?? round.kind}</Text>
              </div>
              <Meter thin tone={round.approved >= round.target ? 'working' : 'review'} value={Math.min(1, round.approved / round.target)} />
              {round.task && <Link href={`/p/${slug}/tasks/${round.task.id}`}><Text size="caption" tone="accent">{round.task.key}</Text></Link>}
            </Card>
          ))}
        </div>
      )}
      {days.map(label => (
        <div key={label} className="flex flex-col gap-2">
          <SectionLabel>{label}</SectionLabel>
          {items.filter(item => day(item.createdAt) === label).map(item => <Deliverable key={item.id} slug={slug} item={item} onChanged={view.reload} />)}
        </div>
      ))}
    </div>
  );
}

function Deliverable({ slug, item, onChanged }: { slug: string; item: Item; onChanged(): void }) {
  const [open, setOpen] = useState(false), [error, setError] = useState<string | null>(null);
  const decide = async (verdict: 'pass' | 'changes') => {
    setError(null);
    try { await api(`/api/projects/${slug}/deliverables/${item.id}/decide`, { verdict }); onChanged(); } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'That did not work'); }
  };
  const fields = Object.entries(item.fields).filter(([, value]) => value);
  return (
    <Card tone="raised" pad="sm" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <Text size="small" weight="medium" className="min-w-0 grow">{item.title}</Text>
        <Text size="caption" tone="muted">{WORDS[item.kind]?.[0] ?? item.kind}{item.author ? `, by ${item.author}` : ''}</Text>
        <Chip tone={STATE[item.state].tone}>{STATE[item.state].label}</Chip>
      </div>
      {fields.length > 0 && <Text size="caption" tone="soft">{fields.map(([key, value]) => `${FIELD[key] ?? key}: ${value}`).join(' · ')}</Text>}
      {item.note && item.state !== 'submitted' && <Text size="caption" tone="muted">{item.reviewer ?? 'You'}: {item.note}</Text>}
      {open && <Markdown size="small">{item.body}</Markdown>}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide' : 'Read it'}</Button>
        {item.link && <a href={item.link} target="_blank" rel="noreferrer"><Text size="caption" tone="accent">Open where it lives</Text></a>}
        {item.state === 'approved' && item.kind === 'message' && <Link href={`/p/${slug}/integrations`}><Text size="caption" tone="accent">Waiting for you to send</Text></Link>}
        {item.state === 'approved' && item.kind === 'card' && item.outcome && <Text size="caption" tone="muted">On the board as {item.outcome}</Text>}
        {item.state === 'submitted' && <span className="ml-auto flex gap-2"><Button size="sm" onClick={() => void decide('pass')}>Approve</Button><Button size="sm" variant="ghost" onClick={() => void decide('changes')}>Send back</Button></span>}
      </div>
      {error && <Text size="small" tone="stop">{error}</Text>}
    </Card>
  );
}
