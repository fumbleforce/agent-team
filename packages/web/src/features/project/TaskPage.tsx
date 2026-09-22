import { useState, type ReactNode } from 'react';
import { api, ApiError, type Agent, type TaskCardData } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { DetailHeader, DetailRail, LogCard, Markdown, mentionOptions, Pipeline, RailFacts, RailSection, StatusLine, type PipelineStep } from '../../patterns';
import { Avatar, Button, Card, Chip, LinkButton, MarkerCanvas, SectionLabel, Select, Text, Textarea, type ChipTone, type Marker } from '../../ui';

interface TaskView {
  task: { id: string; key: string; title: string; brief: string; state: string; tag: string | null; assignee_agent_id: string | null; branch: string | null; pr_url: string | null; blocked_reason: string | null; slug: string; project: string };
  steps: PipelineStep[]; reviewer: string | null; pm: string | null; canWrite: boolean;
  issue: { number: number; source: string; priority: string; raisedBy: string | null; attachmentId: string | null; markers: Marker[]; environment: string | null } | null;
  tracker: { url: string | null; system: string; id: string } | null;
  log: { id: string; agentId: string; kind: string; state: string; summary: string | null; stopReason: string | null; at: number }[];
  approvals: { kind: string; agentId: string; verdict: string; summary: string; stale: boolean; at: number }[];
  messages: { id: string; authorKind: string; authorId: string | null; kind: string; body: string; at: number }[];
}
const STATE: Record<string, [string, ChipTone]> = { inbox: ['Inbox · triage', 'attention'], backlog: ['Backlog', 'neutral'], assigned: ['Assigned', 'neutral'], in_progress: ['In progress', 'working'], awaiting_decision: ['Waiting for a decision', 'attention'], in_review: ['In review', 'review'], approved: ['Approved', 'review'], merging: ['Merging', 'review'], done: ['Done', 'working'], blocked: ['Blocked', 'stop'], stopped: ['Stopped', 'stop'], canceled: ['Declined', 'neutral'], quarantined: ['Needs you', 'stop'] };
// Every entry says what happened and how it ended, in words; a turn that stopped carries why.
const LINE: Record<string, Record<string, string>> = {
  work: { running: 'working now', completed: 'worked on it', failed: 'stopped with an error', deferred: 'was set aside to wait', interrupted: 'was interrupted', timed_out: 'ran out of time', uncertain: 'ended in doubt' },
  review: { running: 'reviewing now', completed: 'reviewed it', failed: 'the review stopped with an error', deferred: 'was set aside to wait', interrupted: 'was interrupted', timed_out: 'ran out of time', uncertain: 'ended in doubt' },
  publish: { running: 'publishing now', completed: 'published the change', failed: 'could not publish it' },
  deliver: { running: 'merging now', completed: 'merged it', failed: 'could not merge it', deferred: 'was set aside to wait', interrupted: 'was interrupted', uncertain: 'ended in doubt' },
  reply: { running: 'writing the reply now', completed: 'answered in the thread' },
  triage: { running: 'sorting it out now', completed: 'sorted it out' },
  capture: { running: 'capturing now', completed: 'captured the screenshot', failed: 'the capture failed' },
};
const REASON: Record<string, string> = {
  'rate-limited': 'the usage limit was reached; it resumes on its own',
  'lease-expired': 'the worker stopped answering',
  'worker-restarted': 'the worker restarted',
  'no-report': 'the turn ended without a report',
  'auth': 'the engine could not sign in',
  'context-overflow': 'the context filled up',
  'resume-missing': 'the earlier session could not be resumed',
  'crashed': 'the engine stopped unexpectedly',
  'timeout': 'it ran out of time',
  'aborted': 'it was stopped',
};
const VERDICT: Record<string, string> = { pass: 'passed', changes: 'asked for changes', fail: 'failed' };
// The line of a log entry: what this kind of turn did, how it ended, and why it stopped.
const logLine = (turn: { kind: string; state: string; stopReason: string | null; summary: string | null }) => {
  const line = LINE[turn.kind]?.[turn.state] ?? `${turn.kind} · ${turn.state}`;
  if (turn.state === 'running') return line;
  // A work turn that ended with no report at all is marked as such rather than left to look like work went unrecorded.
  const unreported = turn.kind === 'work' && turn.state === 'completed' && !turn.summary?.trim() ? ' · ended without a report' : '';
  return `${line}${unreported}${turn.stopReason ? ` · ${REASON[turn.stopReason] ?? turn.stopReason}` : ''}`;
};
// Reasons an earlier version stored as a code, in words.
const WHY: Record<string, string> = { 'needs-attention': 'A turn on this task stopped with an error or ran out of time, and the task was set aside for it. Carry on puts it back where it was.', 'no-report': 'The work ended twice without a report. Carry on starts it again.' };
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// One task as a page. In the inbox: the report, its triage thread, and Accept / Merge into / Decline. Once accepted: the brief,
// the work log and the task's thread. The same layout either way, because it is the same object.
export function TaskPage({ slug, taskId, roster, board, navigate }: { slug: string; taskId: string; roster: Agent[]; board: TaskCardData[]; navigate(to: string): void }) {
  const view = useResource<TaskView>(`/api/tasks/${taskId}`);
  const [text, setText] = useState(''), [problem, setProblem] = useState<string | null>(null), [merging, setMerging] = useState(false);
  useStream(event => (event as { taskId?: string }).taskId === taskId || event.type.startsWith('turn.') || event.type === 'message.posted', view.reload);
  const data = view.data;
  if (!data) return <div className="p-5"><Text tone="muted">{view.error?.message ?? 'Loading…'}</Text></div>;
  const { task } = data, inbox = task.state === 'inbox', agent = (id: string | null) => roster.find(item => item.id === id);
  const owner = agent(task.assignee_agent_id), [stateWords, stateTone] = STATE[task.state] ?? [task.state, 'neutral' as ChipTone];
  const act = (path: string, body: unknown, then?: () => void) => { setProblem(null); void api(path, body).then(() => { view.reload(); then?.(); }, failure => setProblem(failure instanceof ApiError ? failure.message : 'That did not work; try again.')); };
  const send = () => { if (text.trim()) act(`/api/tasks/${task.id}/say`, { body: text }, () => setText('')); };
  const others = board.filter(card => card.id !== task.id && card.state !== 'inbox');

  return (
    <div className="flex min-h-0 grow flex-col">
      <DetailHeader>
        <div className="flex items-center gap-2"><LinkButton size="sm" href={`/p/${slug}/tasks`} aria-label="Back to the board">←</LinkButton><Text size="small" tone="muted">Tasks /</Text><Text size="small" mono>{task.key}</Text></div>
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 grow basis-96 flex-col gap-2">
            <Text as="h2" size="heading">{task.title}</Text>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={stateTone}>{stateWords}</Chip>
              {task.branch && <Text size="small" tone="muted" mono>{task.branch}</Text>}
              {data.issue && <Text size="small" tone="muted">{data.issue.source}{data.issue.raisedBy ? ` · raised by ${data.issue.raisedBy}` : ''}</Text>}
            </div>
          </div>
          {data.canWrite && <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {inbox && <span className="w-36"><Select aria-label="Accept and give it to" value="" onChange={event => { if (event.target.value) act(`/api/tasks/${task.id}/accept`, { agentId: event.target.value === 'backlog' ? null : event.target.value }); }}><option value="">Accept →</option><option value="backlog">The backlog, no owner yet</option>{roster.filter(item => item.status !== 'paused').map(item => <option key={item.id} value={item.id}>{item.name} · {item.title}</option>)}</Select></span>}
            {inbox && <Button onClick={() => setMerging(value => !value)}>Merge into…</Button>}
            {inbox && <Button onClick={() => { const reason = window.prompt('Why is this declined? (optional)'); if (reason !== null) act(`/api/tasks/${task.id}/decline`, { reason }, () => navigate(`/p/${slug}/tasks`)); }}>Decline</Button>}
            {!inbox && !['done', 'canceled'].includes(task.state) && <span className="w-36"><Select aria-label="Reassign" value="" onChange={event => { if (event.target.value) act(`/api/tasks/${task.id}/assign`, { agentId: event.target.value }); }}><option value="">{owner ? 'Reassign…' : 'Assign…'}</option>{roster.filter(item => item.id !== task.assignee_agent_id).map(item => <option key={item.id} value={item.id}>{item.name} · {item.title}</option>)}</Select></span>}
            {task.state === 'blocked' && <Button variant="primary" onClick={() => act(`/api/tasks/${task.id}/carry-on`, {})}>Carry on</Button>}
            {task.state === 'blocked' && task.pr_url && <Button onClick={() => act(`/api/tasks/${task.id}/merge-again`, {})}>Merge again</Button>}
            {!inbox && ['assigned', 'in_progress', 'blocked'].includes(task.state) && <Button variant="danger" onClick={() => { if (window.confirm(`Stop ${task.key}? The branch and any draft change are kept.`)) act(`/api/tasks/${task.id}/stop`, {}); }}>Stop</Button>}
          </div>}
        </div>
        {merging && <Select aria-label="Merge into" value="" onChange={event => { if (event.target.value) act(`/api/tasks/${task.id}/decline`, { intoTaskId: event.target.value }, () => navigate(`/p/${slug}/tasks/${event.target.value}`)); }}><option value="">Which task is this the same as?</option>{others.map(card => <option key={card.id} value={card.id}>{card.key} · {card.title}</option>)}</Select>}
        {problem && <StatusLine tone="stop">{problem}</StatusLine>}
      </DetailHeader>

      <div className="flex min-h-0 grow flex-col lg:flex-row">
        <main className="flex min-w-0 grow flex-col gap-4 overflow-y-auto px-6 py-4.5">
          <Pipeline steps={data.steps} roster={roster} />
          {task.blocked_reason && <StatusLine boxed tone="attention">{WHY[task.blocked_reason] ?? task.blocked_reason}</StatusLine>}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <section className="flex min-w-0 flex-col gap-2.5">
              <SectionLabel>{inbox ? 'Report' : 'Brief'}</SectionLabel>
              {task.brief ? <Markdown size="small">{task.brief}</Markdown> : <Text size="small" tone="muted">Nothing written yet.</Text>}
              {data.issue?.attachmentId && <MarkerCanvas src={`/api/attachments/${data.issue.attachmentId}`} markers={data.issue.markers} />}
              {data.issue?.environment && <Text size="caption" tone="muted" mono>{data.issue.environment}</Text>}
            </section>
            <section className="flex min-w-0 flex-col gap-2.5">
              <SectionLabel aside={owner ? <LinkButton size="sm" variant="ghost" href={`/agents/${owner.id}`}>Full trace</LinkButton> : undefined}>{inbox ? 'Triage' : 'Work log'}</SectionLabel>
              {data.log.map(turn => <LogCard key={turn.id} agent={agent(turn.agentId)} line={logLine(turn)} at={turn.at} live={turn.state === 'running'}>{turn.summary && <Markdown size="small">{turn.summary}</Markdown>}</LogCard>)}
              {data.approvals.map(row => <LogCard key={row.kind + row.at} agent={agent(row.agentId)} line={`${row.kind} review · ${VERDICT[row.verdict] ?? row.verdict}${row.stale ? ' · out of date' : ''}`} at={row.at}>{row.summary && <Text size="small" tone="soft">{row.summary}</Text>}</LogCard>)}
              {inbox && data.messages.map(message => message.kind === 'decision'
                ? <Card key={message.id} tone="decision" pad="sm" className="flex flex-col gap-1"><Text size="label" tone="accent">Decision · {message.authorKind === 'user' ? 'You' : agent(message.authorId)?.name ?? ''}</Text><Text size="small">{message.body}</Text></Card>
                : <LogCard key={message.id} agent={message.authorKind === 'user' ? undefined : agent(message.authorId)} line={message.authorKind === 'user' ? 'you' : ''} at={message.at}><Text size="small" tone="soft">{message.body}</Text></LogCard>)}
              {data.log.length === 0 && data.approvals.length === 0 && (!inbox || data.messages.length === 0) && <Text size="small" tone="muted">{inbox ? 'Nobody has looked at it yet.' : 'No work yet.'}</Text>}
            </section>
          </div>
        </main>

        <DetailRail label="Task details">
          <div className="px-4 py-4">
            <RailFacts rows={[
              [inbox ? 'Triage' : 'Owner', (() => { const who = inbox ? agent(data.pm) : owner; return who ? <><Avatar initials={who.initials} tint={who.tint} size="xs" /><Text size="small">{who.name}</Text><Text size="small" tone="muted">· {who.title}</Text></> : <Text size="small" tone="muted">Nobody yet</Text>; })()],
              ...(data.reviewer ? [['Reviewer', <><Avatar key="a" initials={agent(data.reviewer)?.initials ?? '·'} tint={agent(data.reviewer)?.tint ?? 8} size="xs" /><Text key="n" size="small">{agent(data.reviewer)?.name}</Text></>] as [string, ReactNode]] : []),
              ...(data.issue ? [['Priority', <Text key="p" size="small">{data.issue.priority}</Text>] as [string, ReactNode]] : []),
              ...(task.tag ? [['Labels', <Chip key="t">{task.tag}</Chip>] as [string, ReactNode]] : []),
            ]} />
          </div>
          {(task.pr_url || data.tracker?.url) && <RailSection label="Linked">
            {data.tracker?.url && <LinkButton size="sm" href={data.tracker.url} target="_blank" rel="noreferrer noopener">In the tracker · {data.tracker.id} ↗</LinkButton>}
            {task.pr_url && <LinkButton size="sm" href={task.pr_url} target="_blank" rel="noreferrer noopener">The change ↗</LinkButton>}
            {task.branch && <LinkButton size="sm" href={`/p/${slug}/tests`}>Tests on {task.branch}</LinkButton>}
          </RailSection>}
          <RailSection label={inbox ? 'Reply' : 'Thread on this task'}>
            {!inbox && data.messages.map(message => <div key={message.id} className="flex flex-col gap-0.5"><Text size="caption" tone="muted">{message.authorKind === 'user' ? 'You' : agent(message.authorId)?.name ?? 'The tracker'} · {time(message.at)}</Text><Text size="small" tone="soft">{message.body}</Text></div>)}
            {data.canWrite && <>
              <Textarea rows={3} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send(); }} placeholder={inbox ? 'Reply to the triage' : owner ? `Direction for ${owner.name}, or @${mentionOptions(roster)[0]?.label ?? 'someone'}` : 'Write on this task'} aria-label="Write on this task" />
              <div className="flex items-center gap-2"><Text size="caption" tone="faint" className="grow">Stays with the task</Text><Button variant="primary" size="sm" disabled={!text.trim()} onClick={send}>Send</Button></div>
            </>}
          </RailSection>
        </DetailRail>
      </div>
    </div>
  );
}
