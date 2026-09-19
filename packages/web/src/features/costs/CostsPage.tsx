import type { Agent, Me, ProjectNode } from '../../data/client';
import { useResource } from '../../data/useResource';
import { AppShell, BarRow, PageHeader, Sidebar } from '../../patterns';
import { Card, ColumnChart, Meter, SectionLabel, StatTile, Text } from '../../ui';

interface Total { id: string; amountMinor: number; tokens: number }
interface Summary { totalMinor: number; budgetMinor: number | null; daily: Total[]; byAgent: Total[]; byProject: Total[] }

const compact = (tokens: number) => (tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : tokens >= 1e3 ? `${Math.round(tokens / 1e3)}k` : String(tokens));

export function CostsPage({ me, projects, agents }: { me: Me; projects: ProjectNode[]; agents: Agent[] }) {
  const summary = useResource<Summary>('/api/costs');
  const money = (minor: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: me.org?.currency ?? 'EUR', maximumFractionDigits: minor >= 10000 ? 0 : 2 }).format(minor / 100);
  const names = new Map<string, string>(projects.flatMap(project => [[project.id, project.name] as const, ...project.subprojects.map(sub => [sub.id, sub.name] as const)]));
  const data = summary.data;
  const top = (rows: Total[]) => Math.max(1, ...rows.map(row => row.amountMinor));

  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={null} roster={[]} teamName={null} links={[]} />}>
      <PageHeader title="Costs" crumbs={[me.org?.name ?? 'Organization']} />
      {!data ? <div className="p-5"><Text tone="muted">Loading…</Text></div> : (
        <div className="flex min-h-0 grow flex-col gap-3.5 overflow-y-auto px-5 pt-4 pb-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="flex flex-col gap-1.5">
              <Text size="caption" tone="muted">Spend this month</Text>
              <Text size="metric">{money(data.totalMinor)}</Text>
              {data.budgetMinor !== null && <><Text size="caption" tone="muted">of {money(data.budgetMinor)} budget</Text><Meter thin tone="review" value={data.totalMinor / data.budgetMinor} /></>}
            </Card>
            <StatTile label="Tokens this month" value={compact(data.daily.reduce((sum, day) => sum + day.tokens, 0))} />
            <StatTile label="Agents with spend" value={data.byAgent.filter(row => row.amountMinor > 0).length} />
          </div>
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
