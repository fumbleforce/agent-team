import { useState } from 'react';
import type { Me, ProjectNode } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, Attachment, DiffView, Disclosure, OutputView, PageHeader, Sidebar, TraceRow } from '../../patterns';
import { Avatar, Card, Chip, SectionLabel, Text, type ChipTone } from '../../ui';

interface Turn { id: string; kind: string; state: string; summary: string | null; tokens_in: number; tokens_out: number; cost_minor: number; started_at: number }
type ArtifactKind = 'diff' | 'output' | 'think' | 'image';
interface Step { seq: number; at: number; kind: string; title: string; detail: string | null; artifact_kind?: ArtifactKind | null }
interface Trace { steps: Step[] }
interface Artifact { artifact: { kind: ArtifactKind; body: string; truncated: boolean } }
interface View { agent: { id: string; name: string; initials: string; tint: string; title: string; persona: string; status: string; model: string | null; doing: string | null }; turns: Turn[]; steps: Step[] }

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
  const data = view.data, latest = data?.turns[0]?.id ?? null;
  // The trace is read per turn, so each step says whether it carries a diff or output; the agent view's own steps cover the moment before it loads.
  const trace = useResource<Trace>(latest ? `/api/turns/${latest}/steps` : null);
  useStream(event => event.type.startsWith('turn.') && (event as { agentId?: string }).agentId === id, () => { view.reload(); trace.reload(); });
  const steps = trace.data?.steps ?? data?.steps ?? [];
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
            <SectionLabel>Recent turns</SectionLabel>
            {data.turns.map(turn => (
              <div key={turn.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5"><Chip tone={STATE[turn.state] ?? 'neutral'}>{turn.state}</Chip><Text size="small" weight="medium">{turn.kind}</Text><Text size="caption" tone="muted" mono className="ml-auto">{turn.tokens_in + turn.tokens_out} tok</Text></div>
                {turn.summary && <Text size="caption" tone="muted">{turn.summary}</Text>}
              </div>
            ))}
            {data.turns.length === 0 && <Text size="small" tone="muted">No turns yet.</Text>}
          </Card>
          <Card className="flex min-h-0 flex-col gap-1 xl:col-span-2">
            <SectionLabel aside={data.agent.doing ? <Text size="caption" tone="working">streaming</Text> : undefined}>Trace of the latest turn</SectionLabel>
            <div className="flex min-h-0 flex-col overflow-y-auto">{steps.map(step => <StepRow key={`${latest}:${step.seq}`} turnId={latest ?? ''} step={step} />)}</div>
            {steps.length === 0 && <Text size="small" tone="muted">Nothing traced yet.</Text>}
          </Card>
        </div>
      )}
    </AppShell>
  );
}
