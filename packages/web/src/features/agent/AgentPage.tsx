import { useState } from 'react';
import type { Me, ProjectNode } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, Attachment, DiffView, Disclosure, OutputView, PageHeader, Sidebar, TraceRow } from '../../patterns';
import { AgentControls, DirectMessages } from './AgentControls';
import { Avatar, Card, Chip, ListRow, SectionLabel, Text, type ChipTone } from '../../ui';

interface Turn { id: string; kind: string; state: string; summary: string | null; tokens_in: number; tokens_out: number; cost_minor: number; started_at: number }
type ArtifactKind = 'diff' | 'output' | 'think' | 'image';
interface Step { seq: number; at: number; kind: string; title: string; detail: string | null; artifact_kind?: ArtifactKind | null }
interface Trace { steps: Step[] }
interface Artifact { artifact: { kind: ArtifactKind; body: string; truncated: boolean } }
interface View { agent: { id: string; name: string; initials: string; tint: string; title: string; persona: string; status: string; model: string | null; doing: string | null }; turns: Turn[]; steps: Step[] }

const KIND: Record<string, string> = { work: 'Work on a task', review: 'A review', reply: 'A reply to a message', triage: 'Sorting out what was raised', feedback: 'Feedback on a proposal', revise: 'Revising a proposal', conclude: 'Deciding a proposal', retro: 'The retro', ideate: 'New ideas', publish: 'Publishing a change', deliver: 'Merging a change', capture: 'A screenshot' };
const STATE: Record<string, ChipTone> = { running: 'working', completed: 'neutral', deferred: 'attention', failed: 'stop', timed_out: 'stop', uncertain: 'stop', interrupted: 'attention' };

// A step that produced something opens onto it: an edit onto its diff as git saw it, a run onto its output or the files its shell changed,
// a screenshot onto the image the browser tool left behind.
function StepRow({ turnId, step }: { turnId: string; step: Step }) {
  const [open, setOpen] = useState(false);
  const image = step.artifact_kind === 'image';
  const loaded = useResource<Artifact>(open && !image ? `/api/turns/${turnId}/steps?seq=${step.seq}` : null);
  const row = <TraceRow at={step.at} kind={step.kind} title={step.title} detail={step.detail} />;
  if (!step.artifact_kind) return row;
  const artifact = loaded.data?.artifact;
  return (
    <Disclosure open={open} onToggle={() => setOpen(value => !value)} label={`${open ? 'Hide' : 'Show'} the ${image ? 'image' : step.artifact_kind === 'diff' ? 'diff' : 'output'} of: ${step.title}`} row={row}>
      {image ? <Attachment src={`/api/turns/${turnId}/steps?seq=${step.seq}&raw=1`} alt={step.title} /> : !artifact ? <Text size="caption" tone="muted">{loaded.error?.message ?? 'Loading…'}</Text> : artifact.kind === 'diff' ? <DiffView text={artifact.body} truncated={artifact.truncated} /> : <OutputView text={artifact.body} truncated={artifact.truncated} />}
    </Disclosure>
  );
}

export function AgentPage({ id, me, projects }: { id: string; me: Me; projects: ProjectNode[] }) {
  const view = useResource<View>(`/api/agents/${id}`);
  // Which turn's trace is shown: the one picked, else the work in hand. A short reply to a message never takes the place of the work being looked at.
  const [picked, setPicked] = useState<string | null>(null);
  const data = view.data, shown = data?.turns.find(turn => turn.id === picked) ?? data?.turns.find(turn => turn.state === 'running' && turn.kind === 'work') ?? data?.turns.find(turn => turn.kind === 'work') ?? data?.turns[0] ?? null, latest = shown?.id ?? null;
  // The trace is read per turn, so each step says whether it carries a diff or output; the agent view's own steps cover the moment before it loads.
  const trace = useResource<Trace>(latest ? `/api/turns/${latest}/steps` : null);
  useStream(event => event.type.startsWith('turn.') && (event as { agentId?: string }).agentId === id, () => { view.reload(); trace.reload(); });
  const steps = trace.data?.steps ?? (latest === data?.turns[0]?.id ? data?.steps : undefined) ?? [];
  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={null} roster={[]} teamName={null} links={[]} />}>
      <PageHeader title={data?.agent.name ?? 'Agent'} crumbs={[{ label: 'Teams', href: '/org' }]} />
      {!data ? <div className="p-5"><Text tone="muted">{view.error?.message ?? 'Loading…'}</Text></div> : (
        <div className="grid min-h-0 grow grid-cols-1 gap-3 overflow-y-auto px-5 pt-4 pb-5 xl:grid-cols-3">
          <Card className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Avatar initials={data.agent.initials} tint={data.agent.tint} size="lg" status={data.agent.doing ? 'working' : 'idle'} />
              <div className="flex flex-col"><Text size="title">{data.agent.name}</Text><Text size="small" tone="muted">{data.agent.title}</Text></div>
              {data.agent.model && <span className="ml-auto"><Chip mono>{data.agent.model}</Chip></span>}
            </div>
            <Text size="small" tone="soft">{data.agent.persona}</Text>
            <AgentControls id={id} name={data.agent.name} status={data.agent.status} running={data.turns.some(turn => turn.state === 'running')} onChanged={view.reload} />
            <DirectMessages id={id} name={data.agent.name} />
            <SectionLabel>Recent turns</SectionLabel>
            {data.turns.map(turn => (
              <ListRow key={turn.id} active={turn.id === latest} onClick={() => setPicked(turn.id)} title={KIND[turn.kind] ?? turn.kind} note={turn.summary ?? ''} aside={<Chip tone={STATE[turn.state] ?? 'neutral'}>{turn.state}</Chip>} />
            ))}
            {data.turns.length === 0 && <Text size="small" tone="muted">No turns yet.</Text>}
          </Card>
          <Card className="flex min-h-0 flex-col gap-1 xl:col-span-2">
            <SectionLabel aside={shown?.state === 'running' ? <Text size="caption" tone="working">streaming</Text> : undefined}>{shown ? `${KIND[shown.kind] ?? shown.kind} · ${new Date(shown.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'Trace'}</SectionLabel>
            <div className="flex min-h-0 flex-col overflow-y-auto">{steps.map(step => <StepRow key={`${latest}:${step.seq}`} turnId={latest ?? ''} step={step} />)}</div>
            {steps.length === 0 && <Text size="small" tone="muted">Nothing traced yet.</Text>}
          </Card>
        </div>
      )}
    </AppShell>
  );
}
