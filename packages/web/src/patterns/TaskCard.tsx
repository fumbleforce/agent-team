import type { Agent, TaskCardData } from '../data/client';
import { Avatar, Card, Chip, Select, StatusDot, Text, type DotTone } from '../ui';

// Why a card is held, in the words of the person looking at the board.
const HELD: [RegExp, string][] = [[/approval required/i, 'Waiting for your approval'], [/being marked ready/i, 'Approved: getting ready'], [/on hold/i, 'On hold'], [/is blocked/i, 'Blocked by another issue']];
const heldWords = (reason: string) => HELD.find(([pattern]) => pattern.test(reason))?.[1] ?? reason;

export function TaskCard({ task, owner, roster = [], onAssign, onOpen }: { task: TaskCardData; owner: Agent | undefined; roster?: Agent[]; onAssign?: ((taskId: string, agentId: string) => void) | undefined; onOpen?: ((taskId: string) => void) | undefined }) {
  const held = task.state === 'backlog' && Boolean(task.blocked_reason);
  return (
    <Card as="article" tone="raised" pad="sm" className="flex flex-col gap-2">
      {onOpen ? <button type="button" onClick={() => onOpen(task.id)} className="cursor-pointer text-left hover:underline focus-visible:outline-2 focus-visible:outline-accent"><Text size="small" weight="medium">{task.title}</Text></button> : <Text size="small" weight="medium">{task.title}</Text>}
      <div className="flex items-center gap-1.5">
        <Text size="caption" tone="muted" mono>{task.key}</Text>
        {task.tag && <Chip>{task.tag}</Chip>}
        {(task.state === 'blocked' || task.state === 'quarantined') && <Chip tone="stop">{task.state}</Chip>}
        {task.state === 'awaiting_decision' && <Chip tone="attention">awaiting decision</Chip>}
        {held && <Chip tone="attention">{heldWords(task.blocked_reason!)}</Chip>}
        <span className="ml-auto flex items-center gap-1.5">
          {onAssign && !owner && !held && <Select compact aria-label={`Assign ${task.key}`} value="" onChange={event => { if (event.target.value) onAssign(task.id, event.target.value); }}><option value="">Assign…</option>{roster.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select>}
          {owner && <Avatar initials={owner.initials} tint={owner.tint} size="xs" />}
        </span>
      </div>
    </Card>
  );
}

export function BoardColumn({ name, tone, tasks, roster, onAssign, onOpen }: { name: string; tone: DotTone; tasks: TaskCardData[]; roster: Agent[]; onAssign?: (taskId: string, agentId: string) => void; onOpen?: (taskId: string) => void }) {
  return (
    <section className="flex min-h-0 flex-col gap-2">
      <div className="flex h-5.5 items-center gap-2 px-0.5"><StatusDot tone={tone} /><Text size="small" weight="semibold">{name}</Text><Text size="caption" tone="muted" mono>{tasks.length}</Text></div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        {tasks.map(task => <TaskCard key={task.id} task={task} owner={roster.find(agent => agent.id === task.assignee_agent_id)} roster={roster} onAssign={onAssign} onOpen={onOpen} />)}
      </div>
    </section>
  );
}
