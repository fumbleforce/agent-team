import { EventDraft, newId, type StoredEvent } from '@agent-team/protocol';
import type { StorageAdapter, Tx } from '@agent-team/storage';

type Row = { seq: number; id: string; at: number; type: string; category: string; project_id: string | null; subproject_id: string | null; agent_id: string | null; user_id: string | null; task_id: string | null; thread_id: string | null; turn_id: string | null; actor_kind: string; payload: string };

const toEvent = (row: Row): StoredEvent => ({
  seq: Number(row.seq), id: row.id, at: Number(row.at), type: row.type, category: row.category as StoredEvent['category'],
  projectId: row.project_id, subprojectId: row.subproject_id, agentId: row.agent_id, userId: row.user_id, taskId: row.task_id,
  threadId: row.thread_id, turnId: row.turn_id, actorKind: row.actor_kind as StoredEvent['actorKind'], payload: JSON.parse(row.payload),
});

export interface EventLog {
  // The one write path: call inside the transaction that also updates the read models.
  append(tx: Tx, drafts: EventDraft[]): Promise<StoredEvent[]>;
  // Call after the transaction commits.
  published(events: StoredEvent[]): void;
  read(options: { after: number; limit?: number }): Promise<StoredEvent[]>;
  head(): Promise<number>;
}

export function createEventLog(storage: StorageAdapter, now: () => number = Date.now): EventLog {
  return {
    async append(tx, drafts) {
      await storage.appendLock(tx);
      const stored: StoredEvent[] = [];
      for (const draft of drafts) {
        const event = EventDraft.parse(draft);
        if (event.idempotencyKey) {
          const prior = await tx.selectFrom('events').selectAll().where('idempotency_key', '=', event.idempotencyKey).executeTakeFirst();
          if (prior) { stored.push(toEvent(prior as Row)); continue; }
        }
        const row = await tx.insertInto('events').values({
          id: newId(now()), at: now(), type: event.type, category: event.category, project_id: event.projectId ?? null, subproject_id: event.subprojectId ?? null,
          agent_id: event.agentId ?? null, user_id: event.userId ?? null, task_id: event.taskId ?? null, thread_id: event.threadId ?? null, turn_id: event.turnId ?? null,
          actor_kind: event.actorKind, payload: JSON.stringify(event.payload), idempotency_key: event.idempotencyKey ?? null,
        }).returningAll().executeTakeFirstOrThrow();
        stored.push(toEvent(row as Row));
      }
      return stored;
    },
    published(events) { const last = events.at(-1); if (last) storage.bus.notify(last.seq); },
    async read({ after, limit = 500 }) {
      const rows = await storage.db.selectFrom('events').selectAll().where('seq', '>', after).orderBy('seq').limit(limit).execute();
      return rows.map(row => toEvent(row as Row));
    },
    async head() {
      const row = await storage.db.selectFrom('events').select(eb => eb.fn.max('seq').as('seq')).executeTakeFirst();
      return Number(row?.seq ?? 0);
    },
  };
}
