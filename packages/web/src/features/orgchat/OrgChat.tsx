import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, ApiError, type Message as MessageData } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { Composer, Message, RailHeader, StatusLine } from '../../patterns';
import { Button, Card, Chip, Icon, Text } from '../../ui';

interface Seat { id: string; name: string; title: string; initials: string; tint: string }
interface Chat { seat: Seat; threadId: string; messages: MessageData[] }
interface Plan { id: string; title: string; why: string; steps: string[]; state: 'waiting' | 'applied' | 'dismissed' | 'replaced'; outcome: string[] | null; setUp: { team: string; name: string; tool: string }[] }

const ENDED: Record<Exclude<Plan['state'], 'waiting'>, string> = { applied: 'Applied', dismissed: 'Dismissed', replaced: 'Replaced by a newer plan' };

// The organisation's own conversation: the owner says what they want of the teams, the chief of staff answers with a plan, and
// nothing changes until the owner applies it.
export function OrgChat() {
  const chat = useResource<Chat>('/api/org/chat');
  const [waiting, setWaiting] = useState(false), [error, setError] = useState<string | null>(null);
  const threadId = chat.data?.threadId;
  useStream(event => event.type === 'message.posted' && (event as { threadId?: string }).threadId === threadId, chat.reload);
  const messages = chat.data?.messages ?? [], last = messages.at(-1), end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); if (last && last.authorKind === 'agent') setWaiting(false); }, [last?.id]);

  if (!chat.data) return <div className="flex flex-col"><RailHeader title="Chief of staff" />{chat.error && <div className="p-4"><Text size="small" tone="stop">{chat.error.message}</Text></div>}</div>;
  const { seat } = chat.data;
  const author = (message: MessageData) => (message.authorKind === 'agent' ? { name: seat.name, initials: seat.initials, tint: seat.tint, role: seat.title } : { name: 'You', initials: 'Yo', tint: 'accent' as const, role: '' });
  const send = async (body: string) => {
    setError(null);
    try { await api('/api/org/chat', { body }); setWaiting(true); chat.reload(); } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'That could not be sent'); }
  };

  return (
    <div className="flex min-h-0 grow flex-col">
      <RailHeader title={seat.name} note={seat.title} />
      <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto px-4 py-3">
        {messages.length === 0 && <Text size="small" tone="muted">Say what you want of the teams: a new team, more people on one, something delivered every day.</Text>}
        {messages.map(message => {
          const plan = typeof message.payload.orgPlan === 'string' ? message.payload.orgPlan : null;
          // What became of a plan is shown on the plan itself.
          if (message.authorKind === 'system') return null;
          if (plan && message.kind === 'proposal') return <PlanCard key={message.id} id={plan} threadId={chat.data!.threadId} />;
          return <Message key={message.id} message={message} author={author(message)} />;
        })}
        {waiting && <StatusLine tone="working" busy>{seat.name} is answering</StatusLine>}
        {error && <Text size="small" tone="stop">{error}</Text>}
        <div ref={end} />
      </div>
      <Composer placeholder={`Ask ${seat.name}`} action="Send" onSend={send} />
    </div>
  );
}

export function PlanCard({ id, threadId }: { id: string; threadId: string }) {
  const plan = useResource<Plan>(`/api/org/plans/${id}`);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useStream(event => event.type === 'message.posted' && (event as { threadId?: string }).threadId === threadId, plan.reload);
  const act = async (what: 'apply' | 'dismiss') => {
    setBusy(true); setError(null);
    try { await api(`/api/org/plans/${id}/${what}`, {}); plan.reload(); } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'That did not work'); } finally { setBusy(false); }
  };
  if (!plan.data) return null;
  const { title, why, steps, state, setUp } = plan.data;
  return (
    <Card tone={state === 'waiting' ? 'decision' : 'raised'} pad="sm" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <Text size="small" weight="semibold" className="grow">{title}</Text>
        {state !== 'waiting' && <Chip tone={state === 'applied' ? 'working' : 'neutral'}>{ENDED[state]}</Chip>}
      </div>
      <Text size="caption" tone="muted">{why}</Text>
      <ol className="flex flex-col gap-1.5">
        {steps.map((step, index) => (
          <li key={step} className="flex items-start gap-2">
            {state === 'applied' ? <Text size="caption" tone="working"><Icon name="check" size={12} /></Text> : <Text size="caption" tone="faint" mono>{index + 1}</Text>}
            <Text size="small" tone={state === 'dismissed' || state === 'replaced' ? 'muted' : 'ink'}>{step}</Text>
          </li>
        ))}
      </ol>
      {state === 'waiting' && (
        <div className="flex items-center gap-2 pt-1">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void act('apply')}>Apply</Button>
          <Button size="sm" disabled={busy} onClick={() => void act('dismiss')}>Dismiss</Button>
        </div>
      )}
      {state === 'applied' && setUp.map(item => (
        <Link key={`${item.team}:${item.tool}`} href={`/p/${item.team}/integrations`}><Text size="small" tone="accent">Paste the {item.tool} token for {item.name}</Text></Link>
      ))}
      {error && <Text size="small" tone="stop">{error}</Text>}
    </Card>
  );
}
