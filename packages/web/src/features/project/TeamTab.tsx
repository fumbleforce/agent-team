import { useState, type ReactNode } from 'react';
import { useParams } from 'wouter';
import { api, ApiError, type Agent } from '../../data/client';
import { useResource } from '../../data/useResource';
import { SeatRow, StatusLine } from '../../patterns';
import { Button, Card, Chip, IconButton, Menu, SectionLabel, Select, StatusDot, Text } from '../../ui';
import { AgentDialog, type RoleChoice, type Seat } from './AgentDialog';
import { BILLING, ProviderFlow, READY_TONE, type Provider } from './ProviderFlow';

export function TeamTab({ roster, teamName, onChanged, children }: { roster: Agent[]; teamName: string | null; onChanged(): void; children?: ReactNode }) {
  const { slug = '' } = useParams<{ slug: string }>();
  const providers = useResource<{ providers: Provider[]; canEdit: boolean }>('/api/providers');
  const team = useResource<{ seats: Seat[]; roles: RoleChoice[]; canEdit: boolean }>(`/api/projects/${slug}/team`);
  const [flow, setFlow] = useState<{ open: boolean; kind: string | null }>({ open: false, kind: null });
  const [editor, setEditor] = useState<{ open: boolean; seat: Seat | null }>({ open: false, seat: null });
  const [problem, setProblem] = useState<{ about: 'team' | 'providers'; text: string } | null>(null);
  const list = providers.data?.providers ?? [], canEdit = team.data?.canEdit === true;
  const changed = () => { team.reload(); providers.reload(); onChanged(); };
  // Every change says what went wrong in the server's own words, and the page shows what is true afterwards either way.
  const act = (path: string, body: unknown, about: 'team' | 'providers' = 'team') => { setProblem(null); void api(path, body).catch(failure => setProblem({ about, text: failure instanceof ApiError ? failure.message : 'That did not work; try again.' })).then(changed); };
  const move = (index: number, by: number) => { const ids = roster.map(agent => agent.id), [id] = ids.splice(index, 1); ids.splice(index + by, 0, id!); act(`/api/projects/${slug}/team/order`, { agentIds: ids }); };
  const assign = (agent: Agent, value: string) => { const [providerId, model] = value ? value.split('\n') : [null, null]; act(`/api/agents/${agent.id}/provider`, { providerId: providerId ?? null, model: model ?? null }); };
  const pm = roster.find(agent => agent.is_pm);

  return (
    <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto p-5">
      <section className="flex flex-col gap-2">
        <SectionLabel aside={<span className="flex items-center gap-3"><Text size="caption" tone="muted">The PM decides ties</Text>{canEdit && <Button size="sm" variant="primary" onClick={() => setEditor({ open: true, seat: null })}>+ Add an agent</Button>}</span>}>{teamName ?? 'Team'} · {roster.length}</SectionLabel>
        {roster.map((agent, index) => {
          const seat = team.data?.seats.find(item => item.id === agent.id) ?? null, paused = agent.status === 'paused';
          return (
            <SeatRow key={agent.id} agent={agent}>
              {paused && <Chip tone="attention">Paused</Chip>}
              <Select compact aria-label={`Provider and model for ${agent.name}`} value={agent.provider_id ? `${agent.provider_id}\n${agent.model ?? ''}` : ''} onChange={event => assign(agent, event.target.value)}>
                <option value="">The worker's default</option>
                {list.flatMap(provider => provider.models.map(model => <option key={`${provider.id}${model}`} value={`${provider.id}\n${model}`}>{provider.name} · {model}</option>))}
              </Select>
              {canEdit && (
                <span className="flex shrink-0 items-center">
                  <IconButton icon="up" label={`Move ${agent.name} up`} disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconButton icon="down" label={`Move ${agent.name} down`} disabled={index === roster.length - 1} onClick={() => move(index, 1)} />
                  <Menu align="end" label={agent.name} trigger={<IconButton icon="more" label={`More for ${agent.name}`} hint={false} />} items={[
                    { label: 'Change name, roles and model…', disabled: !seat, onSelect: () => setEditor({ open: true, seat }) },
                    { label: agent.is_pm ? 'Is the PM' : 'Make the PM…', disabled: agent.is_pm || paused, onSelect: () => { if (window.confirm(`Make ${agent.name} the PM? ${pm ? `${pm.name} stops being the PM: ` : ''}a team has exactly one, and the PM decides ties and hands out work.`)) act(`/api/agents/${agent.id}/pm`, {}); } },
                    { label: paused ? 'Resume' : 'Pause', onSelect: () => act(`/api/agents/${agent.id}`, { status: paused ? 'active' : 'paused' }) },
                    'separator',
                    { label: 'Retire…', tone: 'danger', onSelect: () => { if (window.confirm(`Retire ${agent.name}? The seat leaves the team for good; its past work stays in the record.`)) act(`/api/agents/${agent.id}`, { status: 'retired' }); } },
                  ]} />
                </span>
              )}
            </SeatRow>
          );
        })}
        {roster.length === 0 && <Text tone="muted">This project has no team yet. Add the first agent, or create the team from a template below.</Text>}
        {problem?.about === 'team' && <StatusLine boxed tone="stop">{problem.text}</StatusLine>}
      </section>

      <section className="flex flex-col gap-2">
        <SectionLabel aside={providers.data?.canEdit ? <Button size="sm" variant="primary" onClick={() => setFlow({ open: true, kind: null })}>+ Add a model provider</Button> : undefined}>Model providers</SectionLabel>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {list.map(provider => (
            <Card key={provider.id} tone="raised" pad="sm" className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2"><StatusDot tone={READY_TONE[provider.readiness.state]} /><Text weight="semibold" truncate>{provider.name}</Text><span className="ml-auto"><Chip tone={provider.kind === 'metered' ? 'attention' : 'neutral'}>{BILLING[provider.kind] ?? provider.kind}</Chip></span></div>
              <Text size="caption" tone="soft">{provider.readiness.message}</Text>
              <Text size="caption" tone="muted" mono>{provider.models.join(' · ')}</Text>
              <div className="flex items-center gap-1.5">
                <Text size="caption" tone="muted" className="grow">{provider.agents === 0 ? 'No agent uses it yet' : `${provider.agents} agent${provider.agents === 1 ? '' : 's'}`}{provider.limits.concurrency ? ` · ${provider.limits.concurrency} at a time` : ''}</Text>
                {providers.data?.canEdit && provider.catalog && <Button size="sm" variant="ghost" onClick={() => setFlow({ open: true, kind: provider.catalog })}>Change</Button>}
                {providers.data?.canEdit && <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Remove ${provider.name}? Agents keep working only if they run on something else.`)) act(`/api/providers/${provider.id}/remove`, {}, 'providers'); }}>Remove</Button>}
              </div>
            </Card>
          ))}
        </div>
        {problem?.about === 'providers' && <StatusLine boxed tone="stop">{problem.text}</StatusLine>}
        {list.length === 0 && <Text size="small" tone="muted">No provider yet. Until one is added, every agent runs on whatever its worker machine was set up with.</Text>}
        <Text size="caption" tone="muted">Any agent can run on any provider. Keys and sign-ins stay on the worker machines; here you only say which models the team may use.</Text>
      </section>
      {children}
      <ProviderFlow open={flow.open} kind={flow.kind} providers={list} onOpenChange={(open, kind) => setFlow(previous => ({ open, kind: kind === undefined ? previous.kind : kind }))} onDone={changed} />
      <AgentDialog slug={slug} seat={editor.seat} open={editor.open} roles={team.data?.roles ?? []} providers={list} onOpenChange={open => setEditor(previous => ({ ...previous, open }))} onSaved={changed} />
    </div>
  );
}
