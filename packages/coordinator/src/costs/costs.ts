import { newId } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export interface Spend { turnId: string | null; agentId: string | null; projectId: string; providerId: string | null; billingKind: 'metered' | 'subscription' | 'local'; tokensIn: number; tokensOut: number; amountMinor: number }

export function createCosts(context: Context) {
  const { storage, now } = context;
  const db = storage.db;

  return {
    // Called inside the transaction that finishes the turn, so entries and rollups never disagree.
    async record(tx: Tx, spend: Spend) {
      const tokens = spend.tokensIn + spend.tokensOut;
      if (tokens === 0 && spend.amountMinor === 0) return;
      const org = await tx.selectFrom('org').select('currency').executeTakeFirst();
      await tx.insertInto('cost_entries').values({ id: newId(now()), turn_id: spend.turnId, agent_id: spend.agentId, project_id: spend.projectId, provider_id: spend.providerId, billing_kind: spend.billingKind, tokens_in: spend.tokensIn, tokens_out: spend.tokensOut, amount_minor: spend.amountMinor, currency: org?.currency ?? 'EUR', at: now() }).execute();
      await tx.insertInto('cost_daily').values({ day: day(now()), project_id: spend.projectId, agent_id: spend.agentId ?? '', amount_minor: spend.amountMinor, tokens })
        .onConflict(oc => oc.columns(['day', 'project_id', 'agent_id']).doUpdateSet(eb => ({ amount_minor: eb('cost_daily.amount_minor', '+', spend.amountMinor), tokens: eb('cost_daily.tokens', '+', tokens) }))).execute();
    },

    // Everything the cost center shows for a set of projects over a period.
    async summary(projectIds: string[], fromDay: string, toDay: string) {
      if (projectIds.length === 0) return { totalMinor: 0, budgetMinor: null, daily: [], byAgent: [], byProject: [] };
      const rows = await db.selectFrom('cost_daily').selectAll().where('project_id', 'in', projectIds).where('day', '>=', fromDay).where('day', '<=', toDay).execute();
      const sum = <K extends string>(key: (row: (typeof rows)[number]) => K) => {
        const totals = new Map<K, { amountMinor: number; tokens: number }>();
        for (const row of rows) { const entry = totals.get(key(row)) ?? { amountMinor: 0, tokens: 0 }; entry.amountMinor += row.amount_minor; entry.tokens += row.tokens; totals.set(key(row), entry); }
        return [...totals].map(([id, total]) => ({ id, ...total }));
      };
      const budget = await db.selectFrom('budgets').select('amount_minor').where('scope', '=', 'org').where('period', '=', 'month').executeTakeFirst();
      return {
        totalMinor: rows.reduce((total, row) => total + row.amount_minor, 0),
        budgetMinor: budget?.amount_minor ?? null,
        daily: sum(row => row.day).sort((a, b) => a.id.localeCompare(b.id)),
        byAgent: sum(row => row.agent_id).sort((a, b) => b.amountMinor - a.amountMinor),
        byProject: sum(row => row.project_id).sort((a, b) => b.amountMinor - a.amountMinor),
      };
    },

    // Inside a transaction pass it as the executor: a second connection would wait on the first forever.
    async spentToday(agentId: string, executor: Tx | typeof db = db): Promise<number> {
      const row = await executor.selectFrom('cost_daily').select(eb => eb.fn.sum<number>('amount_minor').as('total')).where('agent_id', '=', agentId).where('day', '=', day(now())).executeTakeFirst();
      return Number(row?.total ?? 0);
    },
  };
}
export type Costs = ReturnType<typeof createCosts>;
