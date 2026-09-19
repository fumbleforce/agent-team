import { newId, type Viewport } from '@agent-team/protocol';
import { HttpError, notFound, type Context } from '../context.ts';
import type { createIssues } from '../repos/issues.ts';
import type { Turns } from './turns.ts';

// A snapshot is a page capture made on a worker: requested here, served by a model-free `capture` turn, and filled
// when that turn uploads its image under its lease.
export function createCaptures(context: Context, turns: Turns, issues: ReturnType<typeof createIssues>) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    // Turns belong to a seat; like delivery, a capture rides on the project's PM, or any active agent without one.
    async request(userId: string, project: { id: string; team_id: string | null }, agentId: string | null, envId: string, viewport: Viewport) {
      const env = await db.selectFrom('product_envs').select(['id', 'url']).where('id', '=', envId).where('project_id', '=', project.id).executeTakeFirst();
      if (!env) throw notFound('Environment');
      if (!/^https?:$/.test(new URL(env.url).protocol)) throw new HttpError(400, 'invalid', 'An environment is an http or https address');
      let anyone = db.selectFrom('agents').select('id').where('status', '=', 'active');
      if (project.team_id) anyone = anyone.where('team_id', '=', project.team_id);
      const seat = agentId ?? (await anyone.orderBy('sort').executeTakeFirst())?.id;
      if (!seat) throw new HttpError(409, 'capture', 'No active agent seat can carry the capture');
      const snapshotId = newId(now());
      const queued = await turns.enqueue({
        agentId: seat, projectId: project.id, kind: 'capture', dedupeKey: `capture:${env.id}:${viewport}`,
        prepare: async (tx, workItemId) => {
          await tx.insertInto('snapshots').values({ id: snapshotId, project_id: project.id, env_id: env.id, url: env.url, viewport, state: 'requested', error: null, attachment_id: null, markers: '[]', description: null, issue_id: null, work_item_id: workItemId, requested_by: userId, created_at: now(), captured_at: null }).execute();
        },
      });
      if (queued) return { id: snapshotId, state: 'requested' };
      // The same capture is already waiting: answer with it instead of queueing a second one.
      const waiting = await db.selectFrom('snapshots').select('id').where('env_id', '=', env.id).where('viewport', '=', viewport).where('state', '=', 'requested').orderBy('created_at', 'desc').executeTakeFirst();
      return { id: waiting?.id ?? snapshotId, state: 'requested' };
    },

    async list(projectId: string) {
      return db.selectFrom('snapshots').select(['id', 'env_id', 'viewport', 'state', 'error', 'attachment_id', 'issue_id', 'created_at', 'captured_at']).where('project_id', '=', projectId).orderBy('created_at', 'desc').limit(60).execute();
    },

    // The worker's upload: lease first, then file, row and event in one transaction.
    async artifact(turnId: string, workerId: string, leaseToken: string, input: { mime: string; bytes: Uint8Array; latencyMs: number | null }) {
      const result = await storage.transaction(async tx => {
        const turn = await turns.leased(tx, turnId, workerId, leaseToken);
        if (turn.kind !== 'capture') throw new HttpError(409, 'capture', 'Not a capture turn');
        const snapshot = await tx.selectFrom('snapshots').select(['id', 'env_id', 'viewport']).where('work_item_id', '=', turn.work_item_id).where('state', '=', 'requested').executeTakeFirst();
        if (!snapshot) throw new HttpError(409, 'capture', 'This turn has no open capture request');
        const attachmentId = await issues.attach(null, { name: `capture-${snapshot.viewport}.png`, mime: input.mime, bytes: input.bytes }, tx);
        await tx.updateTable('snapshots').set({ state: 'captured', attachment_id: attachmentId, captured_at: now() }).where('id', '=', snapshot.id).execute();
        await tx.updateTable('product_envs').set({ last_status: 'ok', last_latency_ms: input.latencyMs }).where('id', '=', snapshot.env_id).execute();
        const published = await events.append(tx, [{ type: 'snapshot.captured', actorKind: 'worker', projectId: turn.project_id, turnId, payload: { snapshotId: snapshot.id, envId: snapshot.env_id, viewport: snapshot.viewport, attachmentId } }]);
        return { published, snapshotId: snapshot.id, attachmentId };
      });
      events.published(result.published);
      return { snapshotId: result.snapshotId, attachmentId: result.attachmentId };
    },
  };
}
