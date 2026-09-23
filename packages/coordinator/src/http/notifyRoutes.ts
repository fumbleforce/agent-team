import type { Context as Hc, Hono } from 'hono';
import { z } from 'zod';
import { NOTIFIERS, notifierEntry } from '../../../../adapters/notifier/index.ts';
import { can, type Viewer } from '../auth/rbac.ts';
import { forbidden, HttpError, type Context } from '../context.ts';
import { notifySettingsOf, type createNotifications } from '../runtime/notifications.ts';
import { createCursors } from '../sync/cursors.ts';
import { parseBody, publicOrigin } from './conventions.ts';

type Env = { Variables: { viewer: Viewer } };
const NotifyBody = z.object({ kind: z.string().max(40), values: z.record(z.string().max(40), z.string().trim().max(400)).default({}), token: z.string().trim().max(400).optional(), summaryHour: z.number().int().min(0).max(23).default(8) });

// Where the owner hears from the team: set up in the app from the notifiers the adapters offer, with a test that sends a message.
export function registerNotifyRoutes(app: Hono<Env>, context: Context, notifications: ReturnType<typeof createNotifications>) {
  const db = context.storage.db;
  const admin = (c: Hc<Env>) => { if (!can(c.get('viewer'), 'org.settings')) throw forbidden(); return c.get('viewer').userId; };
  const org = async () => db.selectFrom('org').select(['id', 'settings']).executeTakeFirstOrThrow();

  app.get('/api/settings/notify', async c => {
    const current = notifySettingsOf((await org()).settings), entry = current ? notifierEntry(current.kind) : null;
    const failing = (await createCursors(context).status('org')).find(row => row.resource === 'notify');
    return c.json({
      canEdit: can(c.get('viewer'), 'org.settings'),
      entries: NOTIFIERS.map(({ create: _create, fields, ...rest }) => ({ ...rest, fields: fields.map(({ suggest, ...field }) => ({ ...field, ...(suggest ? { suggestion: suggest() } : {}) })) })),
      current: current ? { kind: current.kind, values: current.values, summaryHour: current.summaryHour } : null,
      tokenSaved: Boolean(entry?.credential && context.secrets.has(entry.credential.variable)),
      error: failing?.error ?? null,
    });
  });

  app.post('/api/settings/notify', async c => {
    const userId = admin(c), input = await parseBody(c, NotifyBody), entry = notifierEntry(input.kind);
    if (!entry) throw new HttpError(404, 'not_found', 'That is not a way to reach you that is supported');
    const values: Record<string, string> = {}, fields: Record<string, string> = {};
    for (const field of entry.fields) {
      const value = input.values[field.key] ?? '';
      if (!value) { if (field.required) fields[field.key] = `${field.label} is needed`; continue; }
      if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(value)) { fields[field.key] = `${field.label} does not look right`; continue; }
      values[field.key] = value;
    }
    if (Object.keys(fields).length) throw new HttpError(400, 'invalid', 'Some fields need another look', fields);
    if (input.token && entry.credential) await context.secrets.set(entry.credential.variable, input.token, userId);
    // Links in a message lead back to the app at the address it was set up from.
    const appUrl = publicOrigin(c);
    const row = await org();
    const published = await context.storage.transaction(async tx => {
      await tx.updateTable('org').set({ settings: JSON.stringify({ ...(JSON.parse(row.settings) as Record<string, unknown>), notify: { kind: entry.kind, values, appUrl, summaryHour: input.summaryHour } }) }).where('id', '=', row.id).execute();
      return context.events.append(tx, [{ type: 'settings.changed', category: 'audit', actorKind: 'user', userId, payload: { what: 'notify', kind: entry.kind } }]);
    });
    context.events.published(published);
    return c.json({ ok: true });
  });

  app.post('/api/settings/notify/test', async c => {
    admin(c);
    try { await notifications.test(); return c.json({ ok: true, message: 'Sent. It should be on your phone or desktop now.' }); }
    catch (error) { return c.json({ ok: false, message: (error as Error).message.slice(0, 300) }); }
  });

  app.post('/api/settings/notify/off', async c => {
    const userId = admin(c), row = await org();
    const { notify: _notify, ...rest } = JSON.parse(row.settings) as Record<string, unknown>;
    const published = await context.storage.transaction(async tx => {
      await tx.updateTable('org').set({ settings: JSON.stringify(rest) }).where('id', '=', row.id).execute();
      return context.events.append(tx, [{ type: 'settings.changed', category: 'audit', actorKind: 'user', userId, payload: { what: 'notify', kind: null } }]);
    });
    context.events.published(published);
    return c.json({ ok: true });
  });
}
