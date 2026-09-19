import type { Me, ProjectNode } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, PageHeader, Sidebar, TraceRow } from '../../patterns';
import { Avatar, Card, Chip, SectionLabel, Text, type ChipTone } from '../../ui';

interface Turn { id: string; kind: string; state: string; summary: string | null; tokens_in: number; tokens_out: number; cost_minor: number; started_at: number }
interface Step { seq: number; at: number; kind: string; title: string; detail: string | null }
interface View { agent: { id: string; name: string; initials: string; tint: string; title: string; persona: string; status: string; model: string | null; doing: string | null }; turns: Turn[]; steps: Step[] }

const STATE: Record<string, ChipTone> = { running: 'working', completed: 'neutral', deferred: 'attention', failed: 'stop', timed_out: 'stop', uncertain: 'stop', interrupted: 'attention' };

export function AgentPage({ id, me, projects }: { id: string; me: Me; projects: ProjectNode[] }) {
  const view = useResource<View>(`/api/agents/${id}`);
  useStream(event => event.type.startsWith('turn.') && (event as { agentId?: string }).agentId === id, view.reload);
  const data = view.data;
  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={null} roster={[]} teamName={null} links={[]} />}>
      <PageHeader title={data?.agent.name ?? 'Agent'} crumbs={['Agents']} />
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
            <div className="flex min-h-0 flex-col overflow-y-auto">{data.steps.map(step => <TraceRow key={step.seq} at={step.at} kind={step.kind} title={step.title} detail={step.detail} />)}</div>
            {data.steps.length === 0 && <Text size="small" tone="muted">Nothing traced yet.</Text>}
          </Card>
        </div>
      )}
    </AppShell>
  );
}
