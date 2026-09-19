import { useState } from 'react';
import { api, type Agent, type ApiError } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { LaneCell, LaneRow } from '../../patterns';
import { Button, Card, SectionLabel, Text } from '../../ui';

interface Item { id: string; kind: string; key: string | null; title: string; deferReason: string | null }
interface Workload { lanes: { agent: Agent & { limitedUntil: number | null }; now: Item[]; queued: Item[]; owed: Item[] }[]; busy: number }
interface Move { workItemId: string; fromAgentId: string; toAgentId: string; fromName: string; toName: string; key: string | null; title: string }

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function WorkloadTab({ slug }: { slug: string }) {
  const workload = useResource<Workload>(`/api/projects/${slug}/workload`);
  // Rebalancing is two steps: see the suggested moves, then apply exactly those.
  const [moves, setMoves] = useState<Move[] | null>(null), [note, setNote] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useStream(event => event.type.startsWith('turn.') || event.type.startsWith('work_item.') || event.type === 'provider.limited', workload.reload);
  const data = workload.data;
  if (!data) return <div className="p-5"><Text tone="muted">Loading…</Text></div>;

  const failed = (error: ApiError) => setNote(error.message);
  const suggest = () => { setBusy(true); api<{ moves: Move[] }>(`/api/projects/${slug}/workload/rebalance`).then(result => { setMoves(result.moves.length ? result.moves : null); setNote(result.moves.length ? null : 'The queues are already level: nothing to move.'); }, failed).finally(() => setBusy(false)); };
  const apply = () => {
    if (!moves) return;
    setBusy(true);
    api<{ applied: number; skipped: string[] }>(`/api/projects/${slug}/workload/rebalance`, { moves: moves.map(move => ({ workItemId: move.workItemId, fromAgentId: move.fromAgentId, toAgentId: move.toAgentId })) })
      .then(result => { setMoves(null); setNote(`${result.applied} moved${result.skipped.length ? `, ${result.skipped.length} skipped because they had already started or moved` : ''}.`); workload.reload(); }, failed).finally(() => setBusy(false));
  };

  return (
    <div className="flex min-h-0 grow flex-col gap-2 overflow-y-auto px-5 pt-3.5 pb-4.5">
      <div className="flex items-center gap-3 px-3">
        <div className="w-42 shrink-0"><SectionLabel>Agent</SectionLabel></div>
        <div className="grow basis-0"><SectionLabel>Now</SectionLabel></div>
        <div className="grow basis-0"><SectionLabel>Queued</SectionLabel></div>
        <div className="grow basis-0"><SectionLabel>Feedback owed</SectionLabel></div>
        <Text size="caption" tone={data.busy === data.lanes.length ? 'working' : 'muted'}>{data.busy} of {data.lanes.length} busy</Text>
        <Button size="sm" disabled={busy || moves !== null} onClick={suggest}>Rebalance</Button>
      </div>
      {(moves || note) && (
        <Card tone="decision" pad="sm" className="flex flex-col gap-2">
          {note && <Text size="small" tone="muted">{note}</Text>}
          {moves && moves.length > 0 && (
            <>
              <Text size="small" weight="semibold">Suggested moves, queued work only</Text>
              {moves.map(move => (
                <div key={move.workItemId} className="flex items-center gap-2">
                  <Text size="caption" tone="muted" mono>{move.key ?? 'work'}</Text>
                  <Text size="small" truncate className="min-w-0 grow">{move.title}</Text>
                  <Text size="small" tone="soft">{move.fromName} → {move.toName}</Text>
                </div>
              ))}
              <div className="flex gap-2">
                <Button size="sm" variant="primary" disabled={busy} onClick={apply}>Apply {moves.length} {moves.length === 1 ? 'move' : 'moves'}</Button>
                <Button size="sm" disabled={busy} onClick={() => { setMoves(null); setNote(null); }}>Dismiss</Button>
              </div>
            </>
          )}
        </Card>
      )}
      {data.lanes.map(lane => (
        <LaneRow key={lane.agent.id} agent={lane.agent} load={lane.agent.limitedUntil ? `provider-limited until ${clock(lane.agent.limitedUntil)}` : `${lane.queued.length} queued · ${lane.owed.length} owed`}>
          <LaneCell items={lane.now} empty="idle" emphasis />
          <LaneCell items={lane.queued} empty="nothing queued" />
          <LaneCell items={lane.owed} empty="nothing owed" />
        </LaneRow>
      ))}
    </div>
  );
}
