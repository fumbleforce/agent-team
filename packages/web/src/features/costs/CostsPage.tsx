import { useState } from 'react';
import { api, type Agent, type ApiError, type CostCurrency, type CostsSummaryView, type CostTotal, type Me, type ProjectNode } from '../../data/client';
import { useResource } from '../../data/useResource';
import { AppShell, BarRow, PageHeader, Sidebar } from '../../patterns';
import { Button, Card, Checkbox, ColumnChart, Field, Input, LinkButton, Meter, SectionLabel, Select, StatTile, Text } from '../../ui';

interface CostRules { dailyCap: { enabled: boolean; fallbackProvider: string | null }; budgetWarn: { enabled: boolean; percent: number }; windowPause: { enabled: boolean; percent: number } }
interface Route { id: string; enabled: boolean; kinds: string[]; tags: string[]; provider: string; model: string | null }
interface RoutingRules { routes: Route[] }
interface Budget { scope: string; scopeId: string; amountMinor: number }
interface RulesDoc<T> { version: number; doc: T }
interface ProviderRow { id: string; name: string; models: string[] }

// The kinds of turn an agent takes, in the words a person would use for them.
const KIND_WORDS: Record<string, string> = { work: 'work on a task', review: 'a review', feedback: 'feedback on a proposal', revise: 'revising a proposal', conclude: 'deciding a proposal', triage: 'sorting what was raised', reply: 'a reply to a message', retro: 'the weekly retro', ideate: 'ideas for what to do next', publish: 'publishing a change', deliver: 'delivering a change', capture: 'a capture of the product' };
const list = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`);
// A rule read aloud: when it applies, then where the turn runs.
const ruleWords = (route: Route) => `When a turn is ${route.kinds.length ? list(route.kinds.map(kind => KIND_WORDS[kind] ?? kind)) : 'of any kind'}${route.tags.length ? ` and the task is tagged ${list(route.tags)}` : ''}`;

// Routing rules in plain words: list, switch on and off, remove, and add one from four choices.
function RoutingEditor({ routes, providers, canEdit, onSave }: { routes: Route[]; providers: ProviderRow[]; canEdit: boolean; onSave(routes: Route[]): void }) {
  const [kind, setKind] = useState(''), [tag, setTag] = useState(''), [providerId, setProviderId] = useState(''), [model, setModel] = useState('');
  const provider = providers.find(item => item.id === providerId);
  const named = (ref: string) => providers.find(item => item.id === ref || item.name === ref)?.name ?? 'a provider that is no longer set up';
  const add = () => {
    if (!provider) return;
    onSave([...routes, { id: crypto.randomUUID().slice(0, 8), enabled: true, kinds: kind ? [kind] : [], tags: tag.trim() ? [tag.trim().toLowerCase()] : [], provider: provider.id, model: model || null }]);
    setKind(''); setTag(''); setProviderId(''); setModel('');
  };
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5"><Text size="small" weight="semibold">Which provider runs what</Text></div>
      {routes.map(route => (
        <div key={route.id} className="flex items-start gap-2">
          <div className="min-w-0 grow"><Checkbox disabled={!canEdit} checked={route.enabled} label={ruleWords(route)} note={`use ${named(route.provider)}${route.model ? ` with the model ${route.model}` : ''}${route.enabled ? '' : ' · switched off'}`} onChange={event => onSave(routes.map(other => (other.id === route.id ? { ...other, enabled: event.target.checked } : other)))} /></div>
          {canEdit && <Button size="sm" variant="ghost" onClick={() => onSave(routes.filter(other => other.id !== route.id))}>Remove</Button>}
        </div>
      ))}
      {routes.length === 0 && <Text size="small" tone="muted">No rules yet.</Text>}
      {canEdit && providers.length > 0 && (
        <form className="grid grid-cols-1 items-start gap-2.5 md:grid-cols-2 xl:grid-cols-5" onSubmit={event => { event.preventDefault(); add(); }}>
          <Field label="When a turn is" help="Leave on any kind to match every turn.">
            <Select value={kind} onChange={event => setKind(event.target.value)}><option value="">any kind of turn</option>{Object.entries(KIND_WORDS).map(([value, words]) => <option key={value} value={value}>{words}</option>)}</Select>
          </Field>
          <Field label="And the task is tagged"><Input value={tag} maxLength={40} placeholder="any tag" onChange={event => setTag(event.target.value)} /></Field>
          <Field label="Use this provider">
            <Select value={providerId} required onChange={event => { setProviderId(event.target.value); setModel(''); }}><option value="">Choose a provider</option>{providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
          </Field>
          <Field label="With this model">
            <Select value={model} disabled={!provider} onChange={event => setModel(event.target.value)}><option value="">the provider’s usual model</option>{provider?.models.map(item => <option key={item} value={item}>{item}</option>)}</Select>
          </Field>
          <div className="pt-6"><Button type="submit" disabled={!provider}>Add rule</Button></div>
        </form>
      )}
      {canEdit && providers.length === 0 && <Text size="caption" tone="muted">Set up a provider first; a rule needs somewhere to send turns.</Text>}
    </div>
  );
}

// A monthly budget per project, next to what the project and its sub-projects have spent this month.
function ProjectBudgets({ projects, budgets, spent, money, currency, canEdit, onSave }: { projects: ProjectNode[]; budgets: Budget[]; spent(project: ProjectNode): number; money(minor: number): string; currency: string; canEdit: boolean; onSave(projectId: string, amountMinor: number | null): void }) {
  const [editing, setEditing] = useState<string | null>(null), [amount, setAmount] = useState('');
  return (
    <Card className="flex flex-col gap-2.5">
      <SectionLabel>Project budgets</SectionLabel>
      {projects.map(project => {
        const budget = budgets.find(item => item.scope === 'project' && item.scopeId === project.id) ?? null, total = spent(project);
        return (
          <div key={project.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Text size="small" weight="medium" truncate className="w-44 shrink-0">{project.name}</Text>
            {editing === project.id ? (
              <form className="flex grow flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); onSave(project.id, amount.trim() === '' ? null : Math.round(Number(amount) * 100)); setEditing(null); }}>
                <Field label={`Budget per month in ${currency}`}><Input type="number" min={0} step="0.01" value={amount} autoFocus onChange={event => setAmount(event.target.value)} /></Field>
                <Button type="submit" variant="primary">Save</Button>
                <Button onClick={() => setEditing(null)}>Cancel</Button>
              </form>
            ) : (
              <>
                <div className="flex min-w-40 grow basis-0 items-center gap-2">{budget ? <Meter thin tone="review" value={budget.amountMinor > 0 ? total / budget.amountMinor : 1} /> : null}</div>
                <Text size="caption" tone="muted" className="whitespace-nowrap">{budget ? `${money(total)} of ${money(budget.amountMinor)} this month` : `${money(total)} this month · no budget`}</Text>
                {canEdit && <Button size="sm" variant="ghost" onClick={() => { setEditing(project.id); setAmount(budget ? String(budget.amountMinor / 100) : ''); }}>{budget ? 'Change' : 'Set a budget'}</Button>}
              </>
            )}
          </div>
        );
      })}
      {projects.length === 0 && <Text size="small" tone="muted">No projects yet.</Text>}
    </Card>
  );
}

// The currency costs are shown in. Engines report US dollars, so the organization says what one dollar is worth in its own money.
function CurrencyCard({ shown, canEdit, onSave }: { shown: CostCurrency; canEdit: boolean; onSave(input: CostCurrency): Promise<unknown> }) {
  const [editing, setEditing] = useState(false), [currency, setCurrency] = useState(shown.currency), [rate, setRate] = useState(String(shown.rate)), [problem, setProblem] = useState<string | null>(null);
  const code = currency.trim().toUpperCase(), worth = Number(rate);
  const save = () => onSave({ currency: code, rate: worth }).then(() => { setEditing(false); setProblem(null); }, (error: ApiError) => setProblem(error.message));
  return (
    <Card className="flex flex-col gap-2.5">
      <SectionLabel>Currency</SectionLabel>
      {editing ? (
        <form className="flex flex-wrap items-start gap-2.5" onSubmit={event => { event.preventDefault(); void save(); }}>
          <Field label="Show costs in"><Input value={currency} maxLength={3} required autoFocus onChange={event => setCurrency(event.target.value)} /></Field>
          <Field label={`One US dollar is worth this many ${code || 'of it'}`} help="0.92 for euros, say."><Input type="number" min={0} step="any" required value={rate} onChange={event => setRate(event.target.value)} /></Field>
          <div className="flex gap-2 pt-6"><Button type="submit" variant="primary" disabled={code.length !== 3 || !(worth > 0)}>Save</Button><Button onClick={() => { setEditing(false); setProblem(null); }}>Cancel</Button></div>
          {code !== shown.currency && code.length === 3 && <Text size="caption" tone="muted" className="basis-full">Earlier days are restated at this rate. Budgets keep their numbers.</Text>}
          {problem && <Text size="caption" tone="stop" className="basis-full">{problem}</Text>}
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Text size="small">{shown.currency === 'USD' && shown.rate === 1 ? 'Costs are shown in US dollars, as reported.' : `Costs are shown in ${shown.currency}. One US dollar counts as ${shown.rate} ${shown.currency}.`}</Text>
          {canEdit && <Button size="sm" variant="ghost" onClick={() => { setCurrency(shown.currency); setRate(String(shown.rate)); setEditing(true); }}>Change the currency</Button>}
        </div>
      )}
    </Card>
  );
}

const compact = (tokens: number) => (tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1e3 ? `${Math.round(tokens / 1e3)}k` : String(tokens));

export function CostsPage({ me, projects, agents }: { me: Me; projects: ProjectNode[]; agents: Agent[] }) {
  const summary = useResource<CostsSummaryView>('/api/costs');
  const costRules = useResource<RulesDoc<CostRules>>('/api/rules/cost_rules'), routing = useResource<RulesDoc<RoutingRules>>('/api/rules/routing_rules');
  const providers = useResource<{ providers: ProviderRow[] }>('/api/providers'), budgets = useResource<{ budgets: Budget[] }>('/api/budgets');
  const [budget, setBudget] = useState<string | null>(null), [problem, setProblem] = useState<string | null>(null);
  const money = (minor: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: summary.data?.currency ?? me.org?.currency ?? 'EUR', maximumFractionDigits: minor >= 10000 ? 0 : 2 }).format(minor / 100);
  const names = new Map<string, string>(projects.flatMap(project => [[project.id, project.name] as const, ...project.subprojects.map(sub => [sub.id, sub.name] as const)]));
  const data = summary.data, rules = costRules.data;
  const top = (rows: CostTotal[]) => Math.max(1, ...rows.map(row => row.amountMinor));
  const admin = me.user.orgRole === 'owner' || me.user.orgRole === 'admin';

  // Every change is one save against the version last read; a lost race reloads and says so.
  const save = <T,>(kind: string, current: RulesDoc<T>, doc: T, reload: () => void) => api(`/api/rules/${kind}`, doc, { 'if-match': String(current.version) })
    .then(() => setProblem(null), (error: ApiError) => setProblem(error.status === 412 ? 'Someone else changed the rules; they were reloaded.' : error.message)).then(reload);
  const saveCost = (change: Partial<CostRules>) => { if (rules) void save('cost_rules', rules, { ...rules.doc, ...change }, costRules.reload); };
  const saveBudget = () => api('/api/budgets', { scope: 'org', amountMinor: budget === null || budget.trim() === '' ? null : Math.round(Number(budget) * 100) })
    .then(() => { setBudget(null); setProblem(null); summary.reload(); }, (error: ApiError) => setProblem(error.message));
  const saveCurrency = (input: CostCurrency) => api('/api/costs/currency', input).then(() => summary.reload());
  const saveProjectBudget = (scopeId: string, amountMinor: number | null) => { void api('/api/budgets', { scope: 'project', scopeId, amountMinor }).then(() => { setProblem(null); budgets.reload(); }, (error: ApiError) => setProblem(error.message)); };
  const spentBy = (project: ProjectNode) => { const ids = [project.id, ...project.subprojects.map(sub => sub.id)]; return data?.byProject.filter(row => ids.includes(row.id)).reduce((sum, row) => sum + row.amountMinor, 0) ?? 0; };

  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={null} roster={[]} teamName={null} links={[]} />}>
      <PageHeader title="Costs" crumbs={[{ label: me.org?.name ?? 'Organization', href: '/org' }]} />
      {!data ? <div className="p-5"><Text tone="muted">Loading…</Text></div> : (
        <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto px-5 pt-4 pb-5">
          <div className="flex items-center justify-end gap-2">
            
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
                    <Field label={`Monthly budget in ${data.currency}; empty for none`}><Input type="number" min={0} step="0.01" value={budget} onChange={event => setBudget(event.target.value)} autoFocus /></Field>
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
                  <Checkbox label="Daily cap per agent" disabled={!admin} checked={rules.doc.dailyCap.enabled} onChange={event => saveCost({ dailyCap: { ...rules.doc.dailyCap, enabled: event.target.checked } })} />
                  <Field label="Fallback provider">
                    <Select disabled={!admin || !rules.doc.dailyCap.enabled} value={rules.doc.dailyCap.fallbackProvider ?? ''} onChange={event => saveCost({ dailyCap: { ...rules.doc.dailyCap, fallbackProvider: event.target.value || null } })}>
                      <option value="">None: wait for tomorrow</option>
                      {providers.data?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="flex flex-col gap-2">
                  <Checkbox label="Warn in the discussion" disabled={!admin} checked={rules.doc.budgetWarn.enabled} onChange={event => saveCost({ budgetWarn: { ...rules.doc.budgetWarn, enabled: event.target.checked } })} />
                  <Field label="Warn at, % of budget"><Input key={rules.version} type="number" min={1} max={100} disabled={!admin || !rules.doc.budgetWarn.enabled} defaultValue={rules.doc.budgetWarn.percent} onBlur={event => { const percent = Number(event.target.value); if (percent !== rules.doc.budgetWarn.percent) saveCost({ budgetWarn: { ...rules.doc.budgetWarn, percent } }); }} /></Field>
                </div>
                <div className="flex flex-col gap-2">
                  <Checkbox label="Pause agents of paused projects" disabled={!admin} checked={rules.doc.windowPause.enabled} onChange={event => saveCost({ windowPause: { ...rules.doc.windowPause, enabled: event.target.checked } })} />
                  <Field label="Pause at, % of window"><Input key={rules.version} type="number" min={1} max={100} disabled={!admin || !rules.doc.windowPause.enabled} defaultValue={rules.doc.windowPause.percent} onBlur={event => { const percent = Number(event.target.value); if (percent !== rules.doc.windowPause.percent) saveCost({ windowPause: { ...rules.doc.windowPause, percent } }); }} /></Field>
                </div>
              </div>
              {routing.data && <RoutingEditor routes={routing.data.doc.routes} providers={providers.data?.providers ?? []} canEdit={admin} onSave={routes => { const current = routing.data; if (current) void save('routing_rules', current, { routes }, routing.reload); }} />}
            </Card>
          )}
          <CurrencyCard shown={data} canEdit={admin} onSave={saveCurrency} />
          <ProjectBudgets projects={projects} budgets={budgets.data?.budgets ?? []} spent={spentBy} money={money} currency={data?.currency ?? 'EUR'} canEdit={admin} onSave={saveProjectBudget} />
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
