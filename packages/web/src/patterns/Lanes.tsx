import type { ReactNode } from 'react';
import { Link } from 'wouter';
import type { Agent } from '../data/client';
import { Avatar, Card, Chip, cx, Text } from '../ui';

export interface LaneItem { id: string; kind: string; key: string | null; title: string; deferReason: string | null }

export function LaneRow({ agent, load, children }: { agent: Agent; load: string; children: ReactNode }) {
  return (
    <Card pad="sm" className="flex items-start gap-3">
      <Link href={`/agents/${agent.id}`} className="flex w-42 shrink-0 items-center gap-2.5">
        <Avatar initials={agent.initials} tint={agent.tint} size="lg" status={agent.status === 'paused' ? 'attention' : agent.doing ? 'working' : 'idle'} />
        <span className="flex min-w-0 flex-col"><Text weight="semibold">{agent.name}</Text><Text size="caption" tone="muted">{agent.title}</Text><Text size="caption" tone="faint" mono>{load}</Text></span>
      </Link>
      {children}
    </Card>
  );
}

// What a turn is for and why work waits, in the words a person would use.
const KIND: Record<string, string> = { work: 'Working on a task', review: 'Reviewing', feedback: 'Giving feedback', revise: 'Revising a proposal', conclude: 'Deciding', triage: 'Sorting out what came in', reply: 'Replying', retro: 'Looking back on the week', ideate: 'Proposing new work', deliver: 'Merging', publish: 'Publishing a branch', capture: 'Capturing a page' };
const WAITS: Record<string, string> = { 'agent-paused': 'agent is paused', 'task-blocked': 'task is blocked', 'task-closed': 'task is closed', 'task-quarantined': 'needs a person first', 'lane-busy': 'after the current task', 'writer-busy': 'someone else is editing this', 'writers-busy': 'project is at its limit of editors', 'delivery-busy': 'a merge is under way',
  'provider-unavailable': 'provider is not available', 'provider-limited': 'provider hit its usage limit', 'provider-busy': 'provider is at its limit', 'provider-window': 'close to the usage allowance', 'over-cap': 'over today’s cap', 'over-budget': 'budget is used up', 'project-paused': 'project is paused', 'no-worktree-holder': 'its worker is away', 'checkout-quarantined': 'that worker’s copy needs a person' };

// Why something waits is shown on the item itself; idle is a signal, so it is said out loud.
export function LaneCell({ items, empty, emphasis }: { items: LaneItem[]; empty: string; emphasis?: boolean }) {
  return (
    <div className="flex min-w-0 grow basis-0 flex-col gap-1">
      {items.map(item => (
        <div key={item.id} className={cx('flex items-center gap-1.5 rounded-control border px-2 py-1', emphasis ? 'border-line-strong bg-raised' : 'border-line bg-raised')}>
          {item.key && <Text size="caption" tone="muted" mono className="whitespace-nowrap">{item.key}</Text>}
          <Text size="small" truncate>{item.key ? item.title : KIND[item.kind] ?? item.title}</Text>
          {item.deferReason && <span className="ml-auto"><Chip tone="attention">{WAITS[item.deferReason] ?? item.deferReason.replaceAll('-', ' ')}</Chip></span>}
        </div>
      ))}
      {items.length === 0 && <Text size="caption" tone="faint">{empty}</Text>}
    </div>
  );
}

export function SeatRow({ agent, children }: { agent: Agent; children?: ReactNode }) {
  return (
    <Card tone={agent.is_pm ? 'decision' : 'raised'} pad="sm" className="flex items-center gap-3">
      <Avatar initials={agent.initials} tint={agent.tint} size="lg" />
      <span className="flex w-38 shrink-0 flex-col">
        <span className="flex items-center gap-1.5"><Text weight="semibold">{agent.name}</Text>{agent.is_pm && <Chip tone="attention">PM</Chip>}</span>
        <Text size="caption" tone="muted">{agent.title}</Text>
      </span>
      <Text size="small" tone="soft" className="min-w-0 grow">{agent.persona}</Text>
      {children ?? <Chip mono>{agent.model ?? 'default model'}</Chip>}
    </Card>
  );
}

const STANCE_TONE = { for: 'working', against: 'stop', neutral: 'neutral' } as const;

export function VoteLine({ agent, stance, note }: { agent: Agent | undefined; stance: string; note: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Avatar initials={agent?.initials ?? '··'} tint={agent?.tint ?? '8'} size="sm" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-1.5"><Text size="small" weight="semibold">{agent?.name ?? 'Agent'}</Text><Chip tone={STANCE_TONE[stance as keyof typeof STANCE_TONE] ?? 'neutral'}>{stance}</Chip></div>
        <Text size="small" tone="soft">{note}</Text>
      </div>
    </div>
  );
}

export function SubHeader({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2.5 border-b border-line px-6 py-3">{children}</div>;
}

// An uploaded image, shown at a readable size; the full image opens in a new tab. `src` names an image kept somewhere other than the attachments.
export function Attachment({ id, src, alt = 'Attached screenshot', onRemove }: { id?: string; src?: string; alt?: string; onRemove?: () => void }) {
  const href = src ?? `/api/attachments/${id}`;
  return (
    <div className="flex items-start gap-2">
      <a href={href} target="_blank" rel="noreferrer"><img src={href} alt={alt} className="max-h-60 max-w-100 rounded-control border border-line-strong" /></a>
      {onRemove && <button type="button" aria-label="Remove attachment" onClick={onRemove} className="cursor-pointer rounded-control px-1.5 text-ink-muted hover:bg-active"><Text size="small" tone="inherit">×</Text></button>}
    </div>
  );
}

export function KeyValueList({ items }: { items: [string, string][] }) {
  return (
    <dl className="m-0 flex flex-col gap-1.5">
      {items.map(([key, value]) => <div key={key} className="flex items-baseline gap-2"><Text as="dt" size="small" tone="muted">{key}</Text><Text as="dd" size="small" mono className="m-0 ml-auto text-right">{value}</Text></div>)}
    </dl>
  );
}

// The product where it runs. A site may refuse to be framed; the address bar always offers it in a new tab.
export function PreviewFrame({ url }: { url: string }) {
  return (
    <div className="flex min-h-0 grow flex-col overflow-hidden rounded-card border border-line-strong bg-ground">
      <div className="flex items-center gap-2.5 border-b border-line bg-card px-3 py-2">
        <Text size="caption" tone="muted" mono truncate className="grow">{url}</Text>
        <a href={url} target="_blank" rel="noreferrer"><Text size="caption" tone="accent">Open in a new tab</Text></a>
      </div>
      <iframe title="Product preview" src={url} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" className="min-h-0 grow border-0 bg-ink" />
    </div>
  );
}
