import type { z } from 'zod';
import { CostCurrency, newId, type BudgetBody, type CostsSummaryView } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export interface Spend { turnId: string | null; agentId: string | null; projectId: string; providerId: string | null; billingKind: 'metered' | 'subscription' | 'local'; tokensIn: number; tokensOut: number; amountMinor: number }

export function createCosts(context: Context) {
  const { storage, now } = context;
  const db = storage.db;

  // The currency costs are shown in, and how many of it one US dollar buys. Kept with the organization's settings.
  const display = async (executor: Tx | typeof db = db): Promise<CostCurrency> => {
    const org = await executor.selectFrom('org').select(['currency', 'settings']).executeTakeFirst();
    const stored = CostCurrency.shape.rate.safeParse((JSON.parse(org?.settings ?? '{}') as { costs?: { usdRate?: unknown } }).costs?.usdRate);
    return { currency: org?.currency ?? 'EUR', rate: stored.success ? stored.data : 1 };
  };

  return {
    display,

    // A new rate applies to turns from now on: entries keep the rate they were recorded at. A new currency also restates
    // the daily rollups from the entries' dollar amounts at the new rate, so one page never adds two currencies together.
    async setDisplay(userId: string, input: CostCurrency) {
      const published = await storage.transaction(async tx => {
        const org = await tx.selectFrom('org').select(['id', 'currency', 'settings']).executeTakeFirstOrThrow();
        const settings = JSON.parse(org.settings) as Record<string, unknown>;
        await tx.updateTable('org').set({ currency: input.currency, settings: JSON.stringify({ ...settings, costs: { usdRate: input.rate } }) }).where('id', '=', org.id).execute();
        if (org.currency !== input.currency) {
          const totals = new Map<string, { day: string; project_id: string; agent_id: string; amount_minor: number }>();
          for (const entry of await tx.selectFrom('cost_entries').select(['project_id', 'agent_id', 'usd_minor', 'at']).execute()) {
            const row = { day: day(Number(entry.at)), project_id: entry.project_id, agent_id: entry.agent_id ?? '' }, key = [row.day, row.project_id, row.agent_id].join(' ');
            const total = totals.get(key) ?? { ...row, amount_minor: 0 };
            total.amount_minor += Math.round(entry.usd_minor * input.rate);
            totals.set(key, total);
          }
          for (const total of totals.values()) await tx.updateTable('cost_daily').set({ amount_minor: total.amount_minor }).where('day', '=', total.day).where('project_id', '=', total.project_id).where('agent_id', '=', total.agent_id).execute();
        }
        return context.events.append(tx, [{ type: 'settings.changed', category: 'audit', actorKind: 'user', userId, payload: { kind: 'cost-currency', currency: input.currency, rate: input.rate } }]);
      });
      context.events.published(published);
    },

    // Called inside the transaction that finishes the turn, so entries and rollups never disagree.
    async record(tx: Tx, spend: Spend) {
      const tokens = spend.tokensIn + spend.tokensOut;
      if (tokens === 0 && spend.amountMinor === 0) return;
      // Engines report US dollars. A subscription or a local model costs nothing more per turn, so only metered turns
      // carry an amount; every turn keeps its tokens, which is what a provider's window limit counts.
      const usdMinor = spend.billingKind === 'metered' ? spend.amountMinor : 0;
      const { currency, rate } = await display(tx);
      const amountMinor = Math.round(usdMinor * rate);
      await tx.insertInto('cost_entries').values({ id: newId(now()), turn_id: spend.turnId, agent_id: spend.agentId, project_id: spend.projectId, provider_id: spend.providerId, billing_kind: spend.billingKind, tokens_in: spend.tokensIn, tokens_out: spend.tokensOut, amount_minor: amountMinor, currency, rate, usd_minor: usdMinor, at: now() }).execute();
      await tx.insertInto('cost_daily').values({ day: day(now()), project_id: spend.projectId, agent_id: spend.agentId ?? '', amount_minor: amountMinor, tokens })
        .onConflict(oc => oc.columns(['day', 'project_id', 'agent_id']).doUpdateSet(eb => ({ amount_minor: eb('cost_daily.amount_minor', '+', amountMinor), tokens: eb('cost_daily.tokens', '+', tokens) }))).execute();
    },

    // Everything the cost center shows for a set of projects over a period.
    // Amounts are in the organization's currency, which the answer names.
    async summary(projectIds: string[], fromDay: string, toDay: string): Promise<CostsSummaryView> {
      const shown = await display();
      if (projectIds.length === 0) return { ...shown, totalMinor: 0, budgetMinor: null, daily: [], byAgent: [], byProject: [] };
      const rows = await db.selectFrom('cost_daily').selectAll().where('project_id', 'in', projectIds).where('day', '>=', fromDay).where('day', '<=', toDay).execute();
      const sum = <K extends string>(key: (row: (typeof rows)[number]) => K) => {
        const totals = new Map<K, { amountMinor: number; tokens: number }>();
        for (const row of rows) { const entry = totals.get(key(row)) ?? { amountMinor: 0, tokens: 0 }; entry.amountMinor += row.amount_minor; entry.tokens += row.tokens; totals.set(key(row), entry); }
        return [...totals].map(([id, total]) => ({ id, ...total }));
      };
      const budget = await db.selectFrom('budgets').select('amount_minor').where('scope', '=', 'org').where('period', '=', 'month').executeTakeFirst();
      return {
        ...shown,
        totalMinor: rows.reduce((total, row) => total + row.amount_minor, 0),
        budgetMinor: budget?.amount_minor ?? null,
        daily: sum(row => row.day).sort((a, b) => a.id.localeCompare(b.id)),
        byAgent: sum(row => row.agent_id).sort((a, b) => b.amountMinor - a.amountMinor),
        byProject: sum(row => row.project_id).sort((a, b) => b.amountMinor - a.amountMinor),
      };
    },

    // Every entry of a period as CSV, oldest first. Names are resolved here so the file reads without the database.
    async exportCsv(projectIds: string[], from: number, to: number): Promise<string> {
      const rows = projectIds.length ? await db.selectFrom('cost_entries').innerJoin('projects', 'projects.id', 'cost_entries.project_id').leftJoin('agents', 'agents.id', 'cost_entries.agent_id').leftJoin('providers', 'providers.id', 'cost_entries.provider_id')
        .select(['cost_entries.id', 'cost_entries.at', 'projects.slug', 'agents.name as agent', 'providers.name as provider', 'cost_entries.billing_kind', 'cost_entries.tokens_in', 'cost_entries.tokens_out', 'cost_entries.amount_minor', 'cost_entries.currency', 'cost_entries.usd_minor', 'cost_entries.rate', 'cost_entries.turn_id'])
        .where('cost_entries.project_id', 'in', projectIds).where('cost_entries.at', '>=', from).where('cost_entries.at', '<', to).orderBy('cost_entries.at').orderBy('cost_entries.id').execute() : [];
      // Quoted when needed; a leading formula character is defused so a spreadsheet never runs a name.
      const cell = (value: string | number | null) => {
        const text = typeof value === 'string' && /^[=+@-]/.test(value) ? `'${value}` : String(value ?? '');
        return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      };
      const lines = rows.map(row => [new Date(Number(row.at)).toISOString(), row.slug, row.agent, row.provider, row.billing_kind, row.tokens_in, row.tokens_out, row.amount_minor, row.currency, row.usd_minor, row.rate, row.turn_id].map(cell).join(','));
      return `${['at,project,agent,provider,billing_kind,tokens_in,tokens_out,amount_minor,currency,usd_minor,rate,turn_id', ...lines].join('\r\n')}\r\n`;
    },

    async budgets(projectIds: string[]) {
      const rows = await db.selectFrom('budgets').select(['scope', 'scope_id', 'period', 'amount_minor']).orderBy('scope').orderBy('scope_id').execute();
      return rows.filter(row => row.scope === 'org' || projectIds.includes(row.scope_id)).map(row => ({ scope: row.scope, scopeId: row.scope_id, period: row.period, amountMinor: row.amount_minor }));
    },

    // Changing the amount re-arms the warning: the new budget has not warned yet.
    async setBudget(input: z.infer<typeof BudgetBody> & { amountMinor: number }) {
      const published = await storage.transaction(async tx => {
        await tx.insertInto('budgets').values({ scope: input.scope, scope_id: input.scopeId, period: input.period, amount_minor: input.amountMinor, warned_period: null }).onConflict(oc => oc.columns(['scope', 'scope_id', 'period']).doUpdateSet({ amount_minor: input.amountMinor, warned_period: null })).execute();
        return context.events.append(tx, [{ type: 'settings.changed', category: 'audit', actorKind: 'user', projectId: input.scope === 'project' ? input.scopeId : null, payload: { kind: 'budget', scope: input.scope, scopeId: input.scopeId, amountMinor: input.amountMinor } }]);
      });
      context.events.published(published);
    },

    async deleteBudget(scope: string, scopeId: string, period = 'month') {
      const published = await storage.transaction(async tx => {
        const gone = await tx.deleteFrom('budgets').where('scope', '=', scope).where('scope_id', '=', scopeId).where('period', '=', period).executeTakeFirst();
        return Number(gone.numDeletedRows) ? context.events.append(tx, [{ type: 'settings.changed', category: 'audit', actorKind: 'user', projectId: scope === 'project' ? scopeId : null, payload: { kind: 'budget', scope, scopeId, amountMinor: null } }]) : [];
      });
      context.events.published(published);
    },

    // Inside a transaction pass it as the executor: a second connection would wait on the first forever.
    async spentToday(agentId: string, executor: Tx | typeof db = db): Promise<number> {
      const row = await executor.selectFrom('cost_daily').select(eb => eb.fn.sum<number>('amount_minor').as('total')).where('agent_id', '=', agentId).where('day', '=', day(now())).executeTakeFirst();
      return Number(row?.total ?? 0);
    },
  };
}
export type Costs = ReturnType<typeof createCosts>;
