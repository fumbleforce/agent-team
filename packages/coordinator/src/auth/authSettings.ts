import type { z } from 'zod';
import { OidcSettings, type AuthSettingsBody } from '@agent-team/protocol';
import type { Context } from '../context.ts';

// How people sign in, as the organization keeps it. Every way of changing it (the settings route, the guided setup)
// goes through `save`, so the audit trail and the clean-up of what was entered are the same.
export function createAuthSettings(context: Context) {
  const { storage, events } = context;
  return {
    async oidc(): Promise<OidcSettings | null> {
      const settings = JSON.parse((await storage.db.selectFrom('org').select('settings').executeTakeFirst())?.settings ?? '{}') as { oidc?: unknown };
      const parsed = OidcSettings.safeParse(settings.oidc);
      return parsed.success ? parsed.data : null;
    },

    async save(userId: string, input: z.infer<typeof AuthSettingsBody>): Promise<void> {
      const published = await storage.transaction(async tx => {
        const row = await tx.selectFrom('org').select(['id', 'settings']).executeTakeFirstOrThrow();
        const { oidc: _previous, ...rest } = JSON.parse(row.settings) as Record<string, unknown>;
        await tx.updateTable('org').set({ settings: JSON.stringify(input.oidc ? { ...rest, oidc: { ...input.oidc, allowedDomains: input.oidc.allowedDomains.map(domain => domain.trim().toLowerCase().replace(/^@/, '')) } } : rest) }).where('id', '=', row.id).execute();
        return events.append(tx, [{ type: 'settings.changed', category: 'audit', actorKind: 'user', userId, payload: { kind: 'auth', oidc: input.oidc ? { issuer: input.oidc.issuer, allowedDomains: input.oidc.allowedDomains } : null } }]);
      });
      events.published(published);
    },
  };
}
export type AuthSettings = ReturnType<typeof createAuthSettings>;
