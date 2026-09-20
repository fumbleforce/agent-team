import { useState } from 'react';
import { api, ApiError, type Agent } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { Markdown, StatusLine } from '../../patterns';
import { Button, Chip, Dialog, LinkButton, SectionLabel, Text, Textarea } from '../../ui';

interface TaskView {
  task: { id: string; key: string; title: string; brief: string; state: string; tag: string | null; assignee_agent_id: string | null; branch: string | null; pr_url: string | null; blocked_reason: string | null; slug: string };
  issue: { number: number; title: string } | null; trackerUrl: string | null; canWrite: boolean;
  turns: { id: string; kind: string; state: string; summary: string | null; started_at: number; agent: string }[];
  queued: { kind: string; state: string; defer_reason: string | null; agent: string }[];
  messages: { id: string; author_kind: string; author_id: string | null; body: string; created_at: number }[];
}
const STATE: Record<string, string> = { backlog: 'Waiting', assigned: 'Assigned', in_progress: 'In progress', awaiting_decision: 'Waiting for a decision', in_review: 'In review', approved: 'Approved', merging: 'Merging', done: 'Done', blocked: 'Blocked', stopped: 'Stopped', canceled: 'Canceled', quarantined: 'Needs you' };
const KIND: Record<string, string> = { work: 'Worked on it', review: 'Reviewed it', publish: 'Published the change', deliver: 'Merged it' };
const when = (at: number) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// A card, opened: what the task asks for, who has it and what they are doing, what happened so far, and a place to give direction.
export function TaskDialog({ taskId, roster, onClose }: { taskId: string | null; roster: Agent[]; onClose(): void }) {
  const view = useResource<TaskView>(taskId ? `/api/tasks/${taskId}` : null);
  const [text, setText] = useState(''), [error, setError] = useState<string | null>(null);
  useStream(event => (event as { taskId?: string }).taskId === taskId, view.reload);
  const data = view.data, owner = roster.find(agent => agent.id === data?.task.assignee_agent_id);
  const send = async () => { if (!taskId || !text.trim()) return; try { await api(`/api/tasks/${taskId}/say`, { body: text }); setText(''); setError(null); view.reload(); } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'That could not be sent'); } };
  return (
    <Dialog open={taskId !== null} onOpenChange={open => { if (!open) onClose(); }} title={data ? `${data.task.key} · ${data.task.title}` : 'Task'}>
      {data && (
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={data.task.state === 'blocked' || data.task.state === 'quarantined' ? 'stop' : data.task.state === 'done' ? 'working' : 'neutral'}>{STATE[data.task.state] ?? data.task.state}</Chip>
            {owner ? <LinkButton size="sm" href={`/agents/${owner.id}`}>{owner.name}</LinkButton> : <Chip>Nobody has it</Chip>}
            {data.task.pr_url && <LinkButton size="sm" href={data.task.pr_url} target="_blank" rel="noreferrer noopener">The change ↗</LinkButton>}
            {data.trackerUrl && <LinkButton size="sm" href={data.trackerUrl} target="_blank" rel="noreferrer noopener">In the tracker ↗</LinkButton>}
            {data.issue && <LinkButton size="sm" href={`/p/${data.task.slug}/issues/${data.issue.number}`}>Issue #{data.issue.number}</LinkButton>}
          </div>
          {data.task.blocked_reason && <StatusLine tone="attention">{data.task.blocked_reason}</StatusLine>}
          {data.queued.map(item => <StatusLine key={item.kind + item.agent} tone="working" busy={item.state === 'leased'}>{item.agent} {item.state === 'leased' ? 'is on it now' : 'is up next on this'}</StatusLine>)}
          {data.task.brief && <Markdown size="small">{data.task.brief}</Markdown>}
          {data.turns.length > 0 && <section className="flex flex-col gap-1.5">
            <SectionLabel>So far</SectionLabel>
            {data.turns.map(turn => <div key={turn.id} className="flex flex-col gap-0.5"><Text size="caption" tone="muted">{turn.agent} · {KIND[turn.kind] ?? turn.kind}{turn.state === 'running' ? ' · now' : turn.state === 'completed' ? '' : ` · ${turn.state}`} · {when(turn.started_at)}</Text>{turn.summary && <Text size="small" tone="soft">{turn.summary}</Text>}</div>)}
          </section>}
          {data.messages.length > 0 && <section className="flex flex-col gap-1.5">
            <SectionLabel>Written on it</SectionLabel>
            {data.messages.map(message => <div key={message.id} className="flex flex-col gap-0.5"><Text size="caption" tone="muted">{message.author_kind === 'user' ? 'You' : roster.find(agent => agent.id === message.author_id)?.name ?? 'The tracker'} · {when(message.created_at)}</Text><Text size="small" tone="soft">{message.body}</Text></div>)}
          </section>}
          {data.canWrite && <div className="flex flex-col gap-2">
            <Textarea rows={2} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void send(); }} placeholder={owner ? `Give ${owner.name} direction on this` : 'Write on this task'} />
            {error && <Text size="small" tone="stop">{error}</Text>}
            <div><Button variant="primary" disabled={!text.trim()} onClick={() => { void send(); }}>Send</Button></div>
          </div>}
        </div>
      )}
    </Dialog>
  );
}
