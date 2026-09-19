import { newId } from '@agent-team/protocol';
import type { z } from 'zod';
import type { MachineTokenBody } from '@agent-team/protocol';
import { notFound, type Context } from '../context.ts';
import type { Viewer } from './rbac.ts';
import { hashToken, newToken, sameSecret } from './secrets.ts';

const PREFIX = 'mt_';
const TOUCH_MS = 60_000;

// Named worker and CLI credentials next to the root machine token: shown once, stored hashed, revocable one by one.
export function createMachineTokens(context: Context) {
  const { storage, events, now } = context;
  return {
    async create(by: Viewer, input: z.infer<typeof MachineTokenBody>): Promise<{ id: string; token: string }> {
      const id = newId(now()), token = PREFIX + newToken();
      const published = await storage.transaction(async tx => {
        await tx.insertInto('machine_tokens').values({ id, name: input.name, token_hash: hashToken(token), kind: input.kind, created_by: by.userId, created_at: now(), revoked_at: null, last_used_at: null }).execute();
        return events.append(tx, [{ type: 'auth.machine_token_created', category: 'audit', actorKind: 'user', userId: by.userId, payload: { tokenId: id, name: input.name, kind: input.kind } }]);
      });
      events.published(published);
      return { id, token };
    },

    async list() {
      const rows = await storage.db.selectFrom('machine_tokens').leftJoin('users', 'users.id', 'machine_tokens.created_by')
        .select(['machine_tokens.id', 'machine_tokens.name', 'machine_tokens.kind', 'machine_tokens.created_at', 'machine_tokens.revoked_at', 'machine_tokens.last_used_at', 'users.name as created_by_name']).orderBy('machine_tokens.created_at', 'desc').execute();
      return rows.map(row => ({ id: row.id, name: row.name, kind: row.kind, createdBy: row.created_by_name, createdAt: Number(row.created_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at), lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at) }));
    },

    async revoke(by: Viewer, id: string): Promise<void> {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('machine_tokens').select(['name', 'revoked_at']).where('id', '=', id).executeTakeFirst();
        if (!row) throw notFound('Machine token');
        if (row.revoked_at !== null) return [];
        await tx.updateTable('machine_tokens').set({ revoked_at: now() }).where('id', '=', id).execute();
        return events.append(tx, [{ type: 'auth.machine_token_revoked', category: 'audit', actorKind: 'user', userId: by.userId, payload: { tokenId: id, name: row.name } }]);
      });
      events.published(published);
    },

    // True for the root token or a named token that is not revoked. The authorization header is "Bearer <token>".
    async accepts(authorization: string | undefined): Promise<boolean> {
      const header = authorization ?? '';
      if (sameSecret(header, `Bearer ${context.machineToken}`)) return true;
      if (!header.startsWith(`Bearer ${PREFIX}`)) return false;
      const row = await storage.db.selectFrom('machine_tokens').select(['id', 'revoked_at', 'last_used_at']).where('token_hash', '=', hashToken(header.slice('Bearer '.length))).executeTakeFirst();
      if (!row || row.revoked_at !== null) return false;
      // A worker polls every few seconds; once a minute is enough to show that a credential is alive.
      if (Number(row.last_used_at ?? 0) + TOUCH_MS < now()) await storage.db.updateTable('machine_tokens').set({ last_used_at: now() }).where('id', '=', row.id).execute();
      return true;
    },
  };
}
export type MachineTokens = ReturnType<typeof createMachineTokens>;
