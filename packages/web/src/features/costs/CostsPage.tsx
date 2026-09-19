import { useState } from 'react';
import { api, type Agent, type ApiError, type Me, type ProjectNode } from '../../data/client';
import { useResource } from '../../data/useResource';
import { AppShell, BarRow, PageHeader, Sidebar } from '../../patterns';
import { Button, Card, Checkbox, ColumnChart, Field, Input, LinkButton, Meter, SectionLabel, Select, StatTile, Text } from '../../ui';

interface Total { id: string; amountMinor: number; tokens: number }
interface Summary { totalMinor: number; budgetMinor: number | null; daily: Total[]; byAgent: Total[]; byProject: Total[] }
interface CostRules { dailyCap: { enabled: boolean; fallbackProvider: string | null }; budgetWarn: { enabled: boolean; percent: number }; windowPause: { enabled: boolean; percent: number } }
interface RoutingRules { routes: { id: string; enabled: boolean; kinds: string[]; tags: string[]; provider: string; model: string | null }[] }
interface RulesDoc<T> { version: number; doc: T }
interface ProviderRow { id: string; name: string }

const compact = (tokens: number) => (tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1e3 ? `${Math.round(tokens / 1e3)}k` : String(tokens));

export function CostsPage({ me, projects, agents }: { me: Me; projects: ProjectNode[]; agents: Agent[] }) {
  const summary = useResource<Summary>('/api/costs');
  const costRules = useResource<RulesDoc<CostRules>>('/api/rules/cost_rules'), routing = useResource<RulesDoc<RoutingRules>>('/api/rules/routing_rules');
  const providers = useResource<{ providers: ProviderRow[] }>('/api/providers');
  const [budget, setBudget] = useState<string | null>(null), [problem, setProblem] = useState<string | null>(null);
  const money = (minor: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: me.org?.currency ?? 'EUR', maximumFractionDigits: minor >= 10000 ? 0 : 2 }).format(minor / 100);
  const names = new Map<string, string>(projects.flatMap(project => [[project.id, project.name] as const, ...project.subprojects.map(sub => [sub.id, sub.name] as const)]));
  const data = summary.data, rules = costRules.data;
  const top = (rows: Total[]) => Math.max(1, ...rows.map(row => row.amountMinor));
  const admin = me.user.orgRole === 'owner' || me.user.orgRole === 'admin';
  const providerName = (ref: string) => providers.data?.providers.find(provider => provider.id === ref || provider.name === ref)?.name ?? ref;

  // Every change is one save against the version last read; a lost race reloads and says so.
  const save = <T,>(kind: string, current: RulesDoc<T>, doc: T, reload: () => void) => api(`/api/rules/${kind}`, doc, { 'if-match': String(current.version) })
    .then(() => setProblem(null), (error: ApiError) => setProblem(error.status === 412 ? 'Someone else changed the rules; they were reloaded.' : error.message)).then(reload);
  const saveCost = (change: Partial<CostRules>) => { if (rules) void save('cost_rules', rules, { ...rules.doc, ...change }, costRules.reload); };
  const saveBudget = () => api('/api/budgets', { scope: 'org', amountMinor: budget === null || budget.trim() === '' ? null : Math.round(Number(budget) * 100) })
    .then(() => { setBudget(null); setProblem(null); summary.reload(); }, (error: ApiError) => setProblem(error.message));

  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={null} roster={[]} teamName={null} links={[]} />}>
      <PageHeader title="Costs" crumbs={[{ label: me.org?.name ?? 'Organization', href: '/org' }]} />
      {!data ? <div className="p-5"><Text tone="muted">Loading…</Text></div> : (
        <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto px-5 pt-4 pb-5">
          <div className="flex items-center justify-end gap-2">
            <Text size="caption" tone="muted">Every cost entry of this month</Text>
            <LinkButton href="/api/costs/export.csv" download size="sm">Export CSV</LinkButton>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="flex flex-col gap-1.5">
              <Text size="caption" tone="muted">Spend this month</Text>
              <Text size="metric">{money(data.totalMinor)}</Text>
              {data.budgetMinor !== null && <><Text size="caption" tone="muted">of {money(data.budgetMinor)} budget</Text><Meter thin tone="review" value={data.budgetMinor > 0 ? data.totalMinor / data.budgetMinor : 1} /></>}
              {admin && (budget === null
                ? <div><Button size="sm" variant="ghost" onClick={() => setBudget(data.budgetMinor === null ? '' : String(data.budgetMinor / 100))}>{data.budgetMinor === null ? 'Set a monthly budget' : 'Edit budget'}</Button></div>
                : (
                  <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); void saveBudget(); }}>
                    <Field label={`Monthly budget in ${me.org?.currency ?? 'EUR'}; empty for none`}><Input type="number" min={0} step="0.01" value={budget} onChange={event => setBudget(event.target.value)} autoFocus /></Field>
                    <Button type="submit" variant="primary">Save</Button>
                    <Button onClick={() => setBudget(null)}>Cancel</Button>
                  </form>
                ))}
            </Card>
            <StatTile label="Tokens this month" value={compact(data.daily.reduce((sum, day) => sum + day.tokens, 0))} />
            <StatTile label="Agents with spend" value={data.byAgent.filter(row => row.amountMinor > 0).length} />
          </div>
          {rules && (
            <Card className="flex flex-col gap-3">
              <div className="flex items-center gap-3"><SectionLabel>Rules</SectionLabel>{problem && <Text size="caption" tone="stop">{problem}</Text>}</div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="flex flex-col gap-2">
                  <Checkbox label="Daily cap per agent" note="Over its cap an agent waits for tomorrow, or moves to the fallback provider." disabled={!admin} checked={rules.doc.dailyCap.enabled} onChange={event => saveCost({ dailyCap: { ...rules.doc.dailyCap, enabled: event.target.checked } })} />
                  <Field label="Fallback provider">
                    <Select disabled={!admin || !rules.doc.dailyCap.enabled} value={rules.doc.dailyCap.fallbackProvider ?? ''} onChange={event => saveCost({ dailyCap: { ...rules.doc.dailyCap, fallbackProvider: event.target.value || null } })}>
                      <option value="">None: wait for tomorrow</option>
                      {providers.data?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="flex flex-col gap-2">
                  <Checkbox label="Warn in the discussion" note="One message when spend crosses this share of a budget. At 100 % only replies to people and unblocking work run." disabled={!admin} checked={rules.doc.budgetWarn.enabled} onChange={event => saveCost({ budgetWarn: { ...rules.doc.budgetWarn, enabled: event.target.checked } })} />
                  <Field label="Warn at, % of budget"><Input key={rules.version} type="number" min={1} max={100} disabled={!admin || !rules.doc.budgetWarn.enabled} defaultValue={rules.doc.budgetWarn.percent} onBlur={event => { const percent = Number(event.target.value); if (percent !== rules.doc.budgetWarn.percent) saveCost({ budgetWarn: { ...rules.doc.budgetWarn, percent } }); }} /></Field>
                </div>
                <div className="flex flex-col gap-2">
                  <Checkbox label="Pause agents of paused projects" note="A paused project keeps its agents until the usage window of their provider is this full." disabled={!admin} checked={rules.doc.windowPause.enabled} onChange={event => saveCost({ windowPause: { ...rules.doc.windowPause, enabled: event.target.checked } })} />
                  <Field label="Pause at, % of window"><Input key={rules.version} type="number" min={1} max={100} disabled={!admin || !rules.doc.windowPause.enabled} defaultValue={rules.doc.windowPause.percent} onBlur={event => { const percent = Number(event.target.value); if (percent !== rules.doc.windowPause.percent) saveCost({ windowPause: { ...rules.doc.windowPause, percent } }); }} /></Field>
                </div>
              </div>
              {routing.data && routing.data.doc.routes.length > 0 && (
                <div className="flex flex-col gap-2">
                  <Text size="caption" tone="muted">Routing, first match wins</Text>
                  {routing.data.doc.routes.map(route => (
                    <Checkbox key={route.id} disabled={!admin} checked={route.enabled}
                      label={`${route.kinds.length ? route.kinds.join(', ') : 'Every turn'}${route.tags.length ? ` tagged ${route.tags.join(', ')}` : ''}`}
                      note={`runs on ${providerName(route.provider)}${route.model ? ` · ${route.model}` : ''}`}
                      onChange={event => { const current = routing.data; if (current) void save('routing_rules', current, { routes: current.doc.routes.map(other => (other.id === route.id ? { ...other, enabled: event.target.checked } : other)) }, routing.reload); }} />
                  ))}
                </div>
              )}
            </Card>
          )}
          <div className="grid min-h-0 grow grid-cols-1 gap-3 xl:grid-cols-3">
            <Card className="flex flex-col gap-2.5">
              <SectionLabel>Spend per day</SectionLabel>
              <ColumnChart points={data.daily.map(day => ({ label: String(Number(day.id.slice(8))), value: day.amountMinor, caption: money(day.amountMinor) }))} />
            </Card>
            <Card className="flex flex-col gap-2.5">
              <SectionLabel>By agent</SectionLabel>
              {data.byAgent.map(row => <BarRow key={row.id} label={agents.find(agent => agent.id === row.id)?.name ?? 'Unassigned'} value={money(row.amountMinor)} note={compact(row.tokens)} share={row.amountMinor / top(data.byAgent)} />)}
            </Card>
            <Card className="flex flex-col gap-2.5">
              <SectionLabel>By project</SectionLabel>
              {data.byProject.map(row => <BarRow key={row.id} label={names.get(row.id) ?? row.id} value={money(row.amountMinor)} share={row.amountMinor / top(data.byProject)} />)}
            </Card>
          </div>
        </div>
      )}
    </AppShell>
  );
}
