import { useState, type ReactNode } from 'react';
import { useParams } from 'wouter';
import { api, ApiError, type Agent, type TeamView } from '../../data/client';
import { useResource } from '../../data/useResource';
import { SeatRow, StatusLine } from '../../patterns';
import { Button, Checkbox, Chip, IconButton, LinkButton, Menu, SectionLabel, Select, Text } from '../../ui';
import { AgentDialog, type Seat } from './AgentDialog';
import type { Provider } from './ProviderFlow';

export function TeamTab({ roster, onChanged, children }: { roster: Agent[]; onChanged(): void; children?: ReactNode }) {
  const { slug = '' } = useParams<{ slug: string }>();
  const providers = useResource<{ providers: Provider[] }>('/api/providers');
  const team = useResource<TeamView>(`/api/projects/${slug}/team`);
  const [editor, setEditor] = useState<{ open: boolean; seat: Seat | null }>({ open: false, seat: null });
  const [problem, setProblem] = useState<string | null>(null);
  const list = providers.data?.providers ?? [], canEdit = team.data?.canEdit === true;
  const changed = () => { team.reload(); providers.reload(); onChanged(); };
  // Every change says what went wrong in the server's own words, and the page shows what is true afterwards either way.
  const act = (path: string, body: unknown) => { setProblem(null); void api(path, body).catch(failure => setProblem(failure instanceof ApiError ? failure.message : 'That did not work; try again.')).then(changed); };
  const move = (index: number, by: number) => { const ids = roster.map(agent => agent.id), [id] = ids.splice(index, 1); ids.splice(index + by, 0, id!); act(`/api/projects/${slug}/team/order`, { agentIds: ids }); };
  const assign = (agent: Agent, value: string) => { const [providerId, model] = value ? value.split('\n') : [null, null]; act(`/api/agents/${agent.id}/provider`, { providerId: providerId ?? null, model: model ?? null }); };
  // The effort levels on offer are the ones the tool behind the choice says it takes: per model where it says so, else for the tool as a whole.
  const effortsFor = (providerId: string | null | undefined, model: string | null | undefined): string[] => { const provider = list.find(item => item.id === providerId); return provider ? provider.modelEfforts?.[model ?? ''] ?? provider.efforts ?? [] : [...new Set((team.data?.workerRuns ?? []).flatMap(item => item.efforts))]; };
  const pm = roster.find(agent => agent.is_pm);
  // What an agent without a choice of its own runs on, in words: the team's default when there is one, else what the worker itself runs.
  const fallback = team.data?.fallback, fallbackProvider = list.find(provider => provider.id === fallback?.providerId);
  const runs = team.data?.workerRuns ?? [], workerWords = runs.length ? [...new Set(runs.map(item => `${item.engine}${item.model ? ` · ${item.model}` : ', its own default model'}`))].join(' / ') : 'no worker is running to say';
  const defaultWords = fallbackProvider ? `${fallbackProvider.name} · ${fallback?.model}` : `the worker's: ${workerWords}`;
  const setDefault = (value: string) => { const [providerId, model] = value ? value.split('\n') : [null, null]; act(`/api/projects/${slug}/team/default`, { providerId: providerId ?? null, model: model ?? null }); };
  const defaultEfforts = effortsFor(fallback?.providerId, fallback?.model);
  // What the seat that staffs the team may do without asking, when the team has such a seat.
  const staffing = team.data?.staffing, hr = staffing?.seat;
  const setStaffing = (decides: boolean, maxSeats: number) => act(`/api/projects/${slug}/team/staffing`, { decides, maxSeats });

  return (
    <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto p-5">
      <section className="flex flex-col gap-2">
        <SectionLabel aside={<span className="flex items-center gap-3">{canEdit && <Button size="sm" variant="primary" onClick={() => setEditor({ open: true, seat: null })}>+ Add an agent</Button>}</span>}>Team · {roster.length}</SectionLabel>
        {roster.length > 0 && <div className="flex flex-wrap items-center gap-2">
          <Text size="small" tone="muted">Agents without a model of their own run on</Text>
          {canEdit ? <Select compact aria-label="The team's default provider and model" value={fallbackProvider ? `${fallback?.providerId}\n${fallback?.model ?? ''}` : ''} onChange={event => setDefault(event.target.value)}>
            <option value="">The worker's own: {workerWords}</option>
            {list.flatMap(provider => provider.models.map(model => <option key={`${provider.id}${model}`} value={`${provider.id}\n${model}`}>{provider.name} · {model}</option>))}
          </Select> : <Text size="small">{defaultWords}</Text>}
          {canEdit && defaultEfforts.length > 0 && <Select compact aria-label="The team's default effort" value={fallback?.effort ?? ''} onChange={event => act(`/api/projects/${slug}/team/default`, { providerId: fallback?.providerId ?? null, model: fallback?.model ?? null, effort: event.target.value || null })}><option value="">Effort: the tool's own</option>{defaultEfforts.map(level => <option key={level} value={level}>Effort: {level}</option>)}</Select>}
        </div>}
        {staffing && hr && <div className="flex flex-wrap items-center gap-2">
          {canEdit ? <Checkbox checked={staffing.decides} onChange={event => setStaffing(event.target.checked, staffing.maxSeats)} label={`${hr.name} hires and retires without asking`} /> : <Text size="small" tone="muted">{staffing.decides ? `${hr.name} hires and retires without asking, up to ${staffing.maxSeats} seats` : `${hr.name} asks before every hire and retirement`}</Text>}
          {canEdit && staffing.decides && <Select compact aria-label="How large the team may grow" value={staffing.maxSeats} onChange={event => setStaffing(true, Number(event.target.value))}>{[...new Set([4, 5, 6, 8, 10, 12, 16, 20, 30, 40, staffing.maxSeats])].sort((a, b) => a - b).map(size => <option key={size} value={size}>up to {size} seats</option>)}</Select>}
        </div>}
        {roster.map((agent, index) => {
          const seat = team.data?.seats.find(item => item.id === agent.id) ?? null, paused = agent.status === 'paused';
          return (
            <SeatRow key={agent.id} agent={agent}>
              {paused && <Chip tone="attention">Paused</Chip>}
              <Select compact aria-label={`Provider and model for ${agent.name}`} value={agent.provider_id ? `${agent.provider_id}\n${agent.model ?? ''}` : ''} onChange={event => assign(agent, event.target.value)}>
                <option value="">Team default ({defaultWords})</option>
                {list.flatMap(provider => provider.models.map(model => <option key={`${provider.id}${model}`} value={`${provider.id}\n${model}`}>{provider.name} · {model}</option>))}
              </Select>
              {(() => { const levels = effortsFor(agent.provider_id ?? fallback?.providerId, agent.provider_id ? agent.model : fallback?.model); return levels.length > 0 && <Select compact aria-label={`Effort for ${agent.name}`} value={agent.effort ?? ''} onChange={event => act(`/api/agents/${agent.id}/provider`, { providerId: agent.provider_id, model: agent.model, effort: event.target.value || null })}><option value="">Effort: {fallback?.effort ?? 'default'}</option>{levels.map(level => <option key={level} value={level}>Effort: {level}</option>)}</Select>; })()}
              {canEdit && (
                <span className="flex shrink-0 items-center">
                  <IconButton icon="up" label={`Move ${agent.name} up`} disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconButton icon="down" label={`Move ${agent.name} down`} disabled={index === roster.length - 1} onClick={() => move(index, 1)} />
                  <Menu align="end" label={agent.name} trigger={<IconButton icon="more" label={`More for ${agent.name}`} hint={false} />} items={[
                    { label: 'Change name, roles and model…', disabled: !seat, onSelect: () => setEditor({ open: true, seat }) },
                    { label: agent.is_pm ? 'Is the PM' : 'Make the PM…', disabled: agent.is_pm || paused, onSelect: () => { if (window.confirm(`Make ${agent.name} the PM? ${pm ? `${pm.name} stops being the PM: ` : ''}A team has exactly one PM.`)) act(`/api/agents/${agent.id}/pm`, {}); } },
                    { label: paused ? 'Resume' : 'Pause', onSelect: () => act(`/api/agents/${agent.id}`, { status: paused ? 'active' : 'paused' }) },
                    'separator',
                    { label: 'Retire…', tone: 'danger', onSelect: () => { if (window.confirm(`Retire ${agent.name}? The seat leaves the team for good; its past work stays in the record.`)) act(`/api/agents/${agent.id}`, { status: 'retired' }); } },
                  ]} />
                </span>
              )}
            </SeatRow>
          );
        })}
        {roster.length === 0 && <Text tone="muted">No team yet. Add an agent, or start from a template below.</Text>}
        {problem && <StatusLine boxed tone="stop">{problem}</StatusLine>}
        {providers.data && list.length === 0 && <div><LinkButton href={`/p/${slug}/integrations`} size="sm">Add a model provider</LinkButton></div>}
      </section>

      {children}
      <AgentDialog slug={slug} defaultWords={defaultWords} seat={editor.seat} open={editor.open} roles={team.data?.roles ?? []} providers={list} onOpenChange={open => setEditor(previous => ({ ...previous, open }))} onSaved={changed} />
    </div>
  );
}
