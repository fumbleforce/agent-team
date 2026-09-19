import { HttpError, type Context } from '../context.ts';

// Failures inside one window before the subject is locked. An address is shared by many people, so it gets more room than an account.
export const LOGIN_LIMITS = { account: 8, ip: 40, windowMs: 15 * 60_000, lockMs: 15 * 60_000 } as const;
const limitOf = (subject: string): number => (subject.startsWith('ip:') ? LOGIN_LIMITS.ip : LOGIN_LIMITS.account);
export const loginSubjects = (ip: string, email: string): string[] => [`ip:${ip}`, `account:${email.toLowerCase()}`];

// Sign-in throttling that survives a restart and is shared by every coordinator process on the same database.
export function createLoginLimiter(context: Context) {
  const { storage, now } = context;
  return {
    // Refuses while any subject is locked; a locked subject stays locked even when the password would now be right.
    async check(subjects: string[]): Promise<void> {
      const rows = await storage.db.selectFrom('login_attempts').select(['subject', 'locked_until']).where('subject', 'in', subjects).execute();
      const until = Math.max(0, ...rows.map(row => Number(row.locked_until ?? 0)));
      if (until > now()) throw new HttpError(429, 'locked', `Too many attempts; try again in ${Math.ceil((until - now()) / 60_000)} minutes`);
    },

    // Counts one failure against every subject; returns the subjects this failure locked.
    async fail(subjects: string[]): Promise<string[]> {
      return storage.transaction(async tx => {
        const locked: string[] = [];
        for (const subject of subjects) {
          const row = await tx.selectFrom('login_attempts').selectAll().where('subject', '=', subject).executeTakeFirst();
          const fresh = !row || Number(row.window_start) + LOGIN_LIMITS.windowMs < now();
          const failures = fresh ? 1 : row.failures + 1;
          const lockedUntil = failures >= limitOf(subject) ? now() + LOGIN_LIMITS.lockMs : null;
          if (lockedUntil) locked.push(subject);
          if (row) await tx.updateTable('login_attempts').set({ failures, window_start: fresh ? now() : row.window_start, locked_until: lockedUntil }).where('subject', '=', subject).execute();
          else await tx.insertInto('login_attempts').values({ subject, failures, window_start: now(), locked_until: lockedUntil }).execute();
        }
        // Stale rows of subjects that never came back are dropped as a side effect, so the table stays small.
        await tx.deleteFrom('login_attempts').where('window_start', '<', now() - 4 * LOGIN_LIMITS.windowMs).execute();
        return locked;
      });
    },

    // A successful sign-in clears the account, never the address: one good login must not reset an attacker's address budget.
    async clear(subject: string): Promise<void> {
      await storage.db.deleteFrom('login_attempts').where('subject', '=', subject).execute();
    },
  };
}
