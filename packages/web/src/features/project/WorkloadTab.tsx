import type { Agent } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { LaneCell, LaneRow } from '../../patterns';
import { SectionLabel, Text } from '../../ui';

interface Item { id: string; kind: string; key: string | null; title: string; deferReason: string | null }
interface Workload { lanes: { agent: Agent; now: Item[]; queued: Item[]; owed: Item[] }[]; busy: number }

export function WorkloadTab({ slug }: { slug: string }) {
  const workload = useResource<Workload>(`/api/projects/${slug}/workload`);
  useStream(event => event.type.startsWith('turn.') || event.type.startsWith('work_item.'), workload.reload);
  const data = workload.data;
  if (!data) return <div className="p-5"><Text tone="muted">Loading…</Text></div>;
  return (
    <div className="flex min-h-0 grow flex-col gap-2 overflow-y-auto px-5 pt-3.5 pb-4.5">
      <div className="flex items-center gap-3 px-3">
        <div className="w-42 shrink-0"><SectionLabel>Agent</SectionLabel></div>
        <div className="grow basis-0"><SectionLabel>Now</SectionLabel></div>
        <div className="grow basis-0"><SectionLabel>Queued</SectionLabel></div>
        <div className="grow basis-0"><SectionLabel>Feedback owed</SectionLabel></div>
        <Text size="caption" tone={data.busy === data.lanes.length ? 'working' : 'muted'}>{data.busy} of {data.lanes.length} busy</Text>
      </div>
      {data.lanes.map(lane => (
        <LaneRow key={lane.agent.id} agent={lane.agent} load={`${lane.queued.length} queued · ${lane.owed.length} owed`}>
          <LaneCell items={lane.now} empty="idle" emphasis />
          <LaneCell items={lane.queued} empty="nothing queued" />
          <LaneCell items={lane.owed} empty="nothing owed" />
        </LaneRow>
      ))}
    </div>
  );
}
