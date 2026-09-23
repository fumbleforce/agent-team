import { notifierEntry, type Notice, type Notifier } from '../../../../adapters/notifier/index.ts';
import type { Context } from '../context.ts';
import { createCursors } from '../sync/cursors.ts';
import type { NeedsYouItem } from './needsYou.ts';

const DAY = 24 * 3600_000;
// More new things than this at once arrive as one message listing them, not a message each.
const ONE_BY_ONE = 3;
export interface NotifySettings { kind: string; values: Record<string, string>; appUrl: string | null; summaryHour: number }
export const notifySettingsOf = (settings: string | undefined): NotifySettings | null => ((settings ? JSON.parse(settings) : {}) as { notify?: NotifySettings }).notify ?? null;

// The owner hears of what needs them where they are: each new thing on Needs you (in one message when several come at once), a reminder
// of what is still waiting a day later, and a summary of the day at the hour they chose, built from what is stored, with no model.
export function createNotifications(context: Context, needsYou: { list(): Promise<NeedsYouItem[]> }) {
  const { storage, events, now } = context, db = storage.db, cursors = createCursors(context);

  async function channel(): Promise<{ notifier: Notifier; settings: NotifySettings } | null> {
    const settings = notifySettingsOf((await db.selectFrom('org').select('settings').executeTakeFirst())?.settings);
    const entry = settings ? notifierEntry(settings.kind) : null;
    if (!settings || !entry) return null;
    const token = entry.credential ? context.secrets.get(entry.credential.variable) ?? context.env[entry.credential.variable] ?? null : null;
    return { notifier: entry.create(settings.values, token, context.fetch), settings };
  }
  const link = (settings: NotifySettings, href: string | null) => (settings.appUrl ? `${settings.appUrl}${href ?? '/needs-you'}` : null);
  const told = async (keys: string[], column: 'notified_at' | 'reminded_at') => {
    if (keys.length === 0) return;
    events.published(await storage.transaction(async tx => {
      await tx.updateTable('notifications').set({ [column]: now() }).where('key', 'in', keys).execute();
      return events.append(tx, [{ type: column === 'notified_at' ? 'owner.notified' : 'owner.reminded', actorKind: 'system', payload: { keys } }]);
    }));
  };

  async function summary(settings: NotifySettings): Promise<Notice> {
    const since = now() - DAY;
    const done = await db.selectFrom('events').innerJoin('tasks', 'tasks.id', 'events.task_id').select(['tasks.key', 'tasks.title', 'events.payload']).where('events.type', '=', 'task.state_changed').where('events.at', '>', since).execute();
    const finished = done.filter(row => (JSON.parse(row.payload) as { to?: string }).to === 'done');
    const blocked = await db.selectFrom('tasks').select(eb => eb.fn.countAll<number>().as('n')).where('state', '=', 'blocked').executeTakeFirstOrThrow();
    const spent = await db.selectFrom('turns').select(eb => eb.fn.coalesce(eb.fn.sum<number>('cost_minor'), eb.lit(0)).as('minor')).where('started_at', '>', since).executeTakeFirstOrThrow();
    const waiting = (await needsYou.list()).length;
    const lines = [
      finished.length ? `Finished: ${finished.length} (${finished.slice(0, 5).map(row => `${row.key} ${row.title}`).join('; ')}${finished.length > 5 ? '; …' : ''})` : 'Nothing finished.',
      `Blocked: ${Number(blocked.n)}. Waiting for you: ${waiting}.`,
      `Spent on metered models: $${(Number(spent.minor) / 100).toFixed(2)}.`,
    ];
    return { title: 'The team today', body: lines.join('\n'), url: link(settings, waiting ? '/needs-you' : '/') };
  }

  return {
    async sweep(): Promise<{ sent: number }> {
      const at = now(), items = await needsYou.list(), current = new Map(items.map(item => [`${item.kind}:${item.id}`, item]));
      const open = await db.selectFrom('notifications').selectAll().where('resolved_at', 'is', null).where('key', 'not like', 'summary:%').execute();
      const known = new Set(open.map(row => row.key));
      const fresh = [...current].filter(([key]) => !known.has(key));
      const gone = open.filter(row => !current.has(row.key)).map(row => row.key);
      if (fresh.length || gone.length) {
        await storage.transaction(async tx => {
          for (const [key, item] of fresh) await tx.insertInto('notifications').values({ key, project_id: item.projectId, title: item.title.slice(0, 200), first_seen_at: at, notified_at: null, reminded_at: null, resolved_at: null }).execute();
          if (gone.length) await tx.updateTable('notifications').set({ resolved_at: at }).where('key', 'in', gone).execute();
        });
      }
      const found = await channel();
      if (!found) return { sent: 0 };
      const { notifier, settings } = found;
      let sent = 0;
      try {
        const untold = (await db.selectFrom('notifications').select(['key', 'title']).where('resolved_at', 'is', null).where('notified_at', 'is', null).where('key', 'not like', 'summary:%').orderBy('first_seen_at').execute()).filter(row => current.has(row.key));
        if (untold.length > ONE_BY_ONE) {
          await notifier.send({ title: `${untold.length} things need you`, body: untold.slice(0, 8).map(row => `- ${row.title}`).join('\n'), url: link(settings, '/needs-you'), urgent: true });
          sent++;
        } else for (const row of untold) {
          const item = current.get(row.key)!;
          await notifier.send({ title: item.title, body: item.detail.slice(0, 600), url: link(settings, item.href ?? item.about?.taskHref ?? '/needs-you'), urgent: item.kind === 'decision' || item.kind === 'system' });
          sent++;
        }
        await told(untold.map(row => row.key), 'notified_at');
        // A day on, what is still waiting is said once more, together.
        const stale = await db.selectFrom('notifications').select(['key', 'title']).where('resolved_at', 'is', null).where('reminded_at', 'is', null).where('notified_at', '<', at - DAY).where('key', 'not like', 'summary:%').execute();
        if (stale.length) {
          await notifier.send({ title: `Still waiting for you: ${stale.length}`, body: stale.slice(0, 8).map(row => `- ${row.title}`).join('\n'), url: link(settings, '/needs-you') });
          await told(stale.map(row => row.key), 'reminded_at');
          sent++;
        }
        // The day's summary, once a day at the chosen hour of this machine's clock.
        const today = new Date(at), key = `summary:${today.toISOString().slice(0, 10)}`;
        if (today.getHours() >= settings.summaryHour && !await db.selectFrom('notifications').select('key').where('key', '=', key).executeTakeFirst()) {
          await notifier.send(await summary(settings));
          await storage.transaction(tx => tx.insertInto('notifications').values({ key, project_id: null, title: 'The team today', first_seen_at: at, notified_at: at, reminded_at: null, resolved_at: at }).execute());
          sent++;
        }
        await cursors.ok('org', 'notify');
      } catch (error) { await cursors.fail('org', 'notify', error); }
      return { sent };
    },

    async test(): Promise<void> {
      const found = await channel();
      if (!found) throw new Error('Nothing is set up to send to');
      await found.notifier.send({ title: 'The team can reach you', body: 'This is how you will hear when something needs you.', url: link(found.settings, '/needs-you') });
    },
  };
}
