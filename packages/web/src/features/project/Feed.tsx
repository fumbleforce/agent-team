import { Link } from 'wouter';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { Avatar, Spinner, Text, type Tone } from '../../ui';

interface FeedItem { id: string; at: number; agent: { id: string; name: string; initials: string; tint: string }; task: { id: string; key: string; title: string } | null; kind: 'step' | 'started' | 'finished'; turnKind: string; stepKind: string | null; text: string; state: string }
const DOING: Record<string, string> = { work: 'working on', review: 'reviewing', deliver: 'merging', publish: 'publishing', triage: 'sorting out what was raised', reply: 'answering', feedback: 'giving feedback', revise: 'revising a proposal', conclude: 'deciding a proposal', retro: 'in the retro', ideate: 'looking for ideas', capture: 'taking a screenshot' };
const ENDED: Record<string, [string, Tone]> = { completed: ['finished', 'working'], deferred: ['put back in the queue', 'muted'], failed: ['stopped with an error', 'stop'], timed_out: ['ran out of time', 'stop'], interrupted: ['was interrupted', 'attention'], uncertain: ['lost contact', 'stop'] };
const STEP: Record<string, string> = { read: 'read', edit: 'edited', run: 'ran', think: '', message: 'said' };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// Everything the team does, as it happens, in one stream: every step of every running turn and how each turn ended.
// It answers "is anything useful going on" at a glance; the detail of one agent is on that agent's page.
export function Feed({ slug }: { slug: string }) {
  const feed = useResource<{ items: FeedItem[]; running: number }>(`/api/projects/${slug}/feed`);
  useStream(event => event.type.startsWith('turn.') || event.type.startsWith('task.'), feed.reload);
  const items = feed.data?.items ?? [];
  return (
    <div className="flex min-h-0 grow flex-col gap-2.5 overflow-y-auto px-4 py-3.5">
      {feed.data && <div className="flex items-center gap-2">{feed.data.running > 0 ? <Spinner /> : null}<Text size="small" tone={feed.data.running ? 'working' : 'muted'}>{feed.data.running === 0 ? 'Nobody is working right now' : `${feed.data.running} working right now`}</Text></div>}
      {items.map(item => {
        const [ended, tone] = ENDED[item.state] ?? [item.state, 'muted' as Tone], about = item.task ? <Link href={`/p/${slug}/tasks/${item.task.id}`} className="underline">{item.task.key}</Link> : null;
        return (
          <div key={item.id} className="flex items-start gap-2">
            <Link href={`/agents/${item.agent.id}`} aria-label={item.agent.name}><Avatar initials={item.agent.initials} tint={item.agent.tint} size="xs" /></Link>
            <div className="flex min-w-0 grow flex-col">
              {item.kind === 'step'
                ? <Text size="small" tone="soft"><Text as="span" size="small" tone="muted">{item.agent.name} {STEP[item.stepKind ?? ''] ?? ''} </Text>{item.text}</Text>
                : item.kind === 'started'
                  ? <Text size="small"><Text as="span" size="small" weight="medium">{item.agent.name}</Text> started {DOING[item.turnKind] ?? item.turnKind} {about}</Text>
                  : <Text size="small"><Text as="span" size="small" weight="medium">{item.agent.name}</Text> <Text as="span" size="small" tone={tone}>{ended}</Text> {DOING[item.turnKind] ?? item.turnKind} {about}{item.text ? <Text as="span" size="small" tone="muted">: {item.text}</Text> : null}</Text>}
            </div>
            <Text size="caption" tone="faint" mono className="shrink-0">{clock(item.at)}</Text>
          </div>
        );
      })}
      {feed.data && items.length === 0 && <Text size="small" tone="muted">Nothing has happened yet.</Text>}
    </div>
  );
}
