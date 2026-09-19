import { STEP_ARTIFACT_INLINE_BYTES, STEP_ARTIFACT_LIMITS, type StepArtifactKind } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';

const DAY_MS = 24 * 3600 * 1000;
// A task in one of these states is over; its trace is kept for the retention period from its last change and then removed.
const TERMINAL_TASK = ['done', 'stopped', 'canceled'] as const;
const IMAGE = /^image\/(png|jpeg|webp)$/;
const SWEEP_BATCH = 200;

interface TurnRef { id: string; project_id: string; agent_id: string }
export interface StepArtifactInput { seq: number; kind: StepArtifactKind; bytes: Uint8Array; mime: string; truncated: boolean }

// What trace steps carry beside their title. Small text stays in its row; large text, screenshots and the raw engine stream go to the
// artifact store and the row keeps the key and the size. Retention removes steps, rows and stored bodies together.
export function createTraceStore(context: Pick<Context, 'storage' | 'events' | 'now' | 'artifacts' | 'traceRetentionDays'>) {
  const { storage, events, now, artifacts } = context;
  const keyOf = (turnId: string, seq: number, kind: string) => `steps/${turnId}/${seq < 0 ? 'turn' : seq}-${kind}`;

  return {
    // Clipped again here whatever the worker sent. The body is written before the row, so a row never names a body that is missing;
    // `leased` is the caller's lease check and runs inside the same transaction as the insert.
    async put(leased: (tx: Tx) => Promise<TurnRef>, turnId: string, input: StepArtifactInput) {
      const text = input.kind !== 'image';
      if (!text && !IMAGE.test(input.mime)) return null;
      const limit = STEP_ARTIFACT_LIMITS[input.kind], clipped = input.bytes.length > limit;
      // An image cut short is no image: one over the limit is refused, text is cut.
      if (clipped && !text) return null;
      const bytes = clipped ? input.bytes.subarray(0, limit) : input.bytes;
      const stored = !text || bytes.length > STEP_ARTIFACT_INLINE_BYTES;
      const key = stored ? keyOf(turnId, input.seq, input.kind) : null;
      if (key) {
        // Only a live lease may write to the store; the check is repeated with the insert.
        await storage.transaction(leased);
        await artifacts.put(key, bytes);
      }
      const published = await storage.transaction(async tx => {
        const turn = await leased(tx);
        await tx.insertInto('step_artifacts').values({ turn_id: turn.id, seq: input.seq, kind: input.kind, body: key ? '' : new TextDecoder().decode(bytes), bytes: bytes.length, truncated: input.truncated || clipped ? 1 : 0, created_at: now(), storage_key: key, mime: text ? null : input.mime })
          .onConflict(oc => oc.columns(['turn_id', 'seq']).doNothing()).execute();
        return events.append(tx, [{ type: 'turn.steps', category: 'trace', actorKind: 'worker', projectId: turn.project_id, agentId: turn.agent_id, turnId: turn.id, payload: { from: input.seq, to: input.seq, artifact: input.kind } }]);
      });
      events.published(published);
      return { stored };
    },

    // One artifact with its body, wherever that lives. A body the store no longer has reads as absent.
    async read(turnId: string, seq: number) {
      const row = await storage.db.selectFrom('step_artifacts').select(['seq', 'kind', 'body', 'bytes', 'truncated', 'storage_key', 'mime']).where('turn_id', '=', turnId).where('seq', '=', seq).executeTakeFirst();
      if (!row) return null;
      const data = row.storage_key ? await artifacts.get(row.storage_key) : new TextEncoder().encode(row.body);
      return data ? { seq: row.seq, kind: row.kind, bytes: Number(row.bytes), truncated: Number(row.truncated) === 1, mime: row.mime, stored: row.storage_key !== null, data } : null;
    },

    // Retention: trace steps, their artifacts and the stored bodies go once the task has been terminal for the retention period
    // (a turn without a task: once it has been finished that long). Audit and domain events, turns and costs are never touched.
    async sweep(): Promise<{ turns: number; steps: number; artifacts: number }> {
      const cutoff = now() - context.traceRetentionDays * DAY_MS, db = storage.db;
      const due = await db.selectFrom('turns').leftJoin('tasks', 'tasks.id', 'turns.task_id').select('turns.id')
        .where('turns.state', '!=', 'running')
        .where(eb => eb.or([
          eb.and([eb('turns.task_id', 'is not', null), eb('tasks.state', 'in', [...TERMINAL_TASK]), eb('tasks.updated_at', '<', cutoff)]),
          eb.and([eb('turns.task_id', 'is', null), eb('turns.finished_at', 'is not', null), eb('turns.finished_at', '<', cutoff)]),
        ]))
        .where(eb => eb.or([
          eb.exists(eb.selectFrom('trace_steps').select('trace_steps.seq').whereRef('trace_steps.turn_id', '=', 'turns.id')),
          eb.exists(eb.selectFrom('step_artifacts').select('step_artifacts.seq').whereRef('step_artifacts.turn_id', '=', 'turns.id')),
        ]))
        .limit(SWEEP_BATCH).execute();
      const removed = { turns: 0, steps: 0, artifacts: 0 };
      for (const turn of due) {
        // Bodies first: a row that survives a failed removal is found again by the next sweep, a body without a row never would be.
        const keys = await db.selectFrom('step_artifacts').select('storage_key').where('turn_id', '=', turn.id).where('storage_key', 'is not', null).execute();
        for (const row of keys) await artifacts.remove(row.storage_key!);
        await storage.transaction(async tx => {
          removed.artifacts += Number((await tx.deleteFrom('step_artifacts').where('turn_id', '=', turn.id).executeTakeFirst()).numDeletedRows);
          removed.steps += Number((await tx.deleteFrom('trace_steps').where('turn_id', '=', turn.id).executeTakeFirst()).numDeletedRows);
        });
        removed.turns++;
      }
      return removed;
    },
  };
}
export type TraceStore = ReturnType<typeof createTraceStore>;
