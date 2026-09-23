import { useState } from 'react';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { MultiPicker, StatusLine, type PickOption } from '../../patterns';
import { Button, Card, Chip, IconButton, Input, Menu, SectionLabel, Select, StatusDot, Text } from '../../ui';
import { BILLING, ProviderFlow, READY_TONE, type Provider } from '../project/ProviderFlow';

// One provider, flat: what it is, whether it is ready, and its models, which are changed right here and saved as they change.
function ProviderRow({ provider, others, canEdit, onChanged }: { provider: Provider; others: Provider[]; canEdit: boolean; onChanged(): void }) {
  const list = useResource<{ models: PickOption[] }>(provider.catalog && canEdit ? `/api/providers/catalog/${provider.catalog}/models` : null);
  const [models, setModels] = useState(provider.models), [problem, setProblem] = useState<string | null>(null);
  const change = (body: Record<string, unknown>, undo?: () => void) => { setProblem(null); void api(`/api/providers/${provider.id}/change`, body).then(onChanged, failure => { undo?.(); setProblem(failure instanceof ApiError ? failure.message : 'That did not work; try again.'); }); };
  const pick = (next: string[]) => { const before = models; setModels(next); if (next.length) change({ models: next }, () => setModels(before)); else { setModels(before); setProblem('Keep at least one model'); } };
  const [keying, setKeying] = useState(false), off = provider.status === 'paused';
  return (
    <Card tone="raised" pad="sm" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <StatusDot tone={off ? 'off' : READY_TONE[provider.readiness.state]} /><Text weight="semibold" tone={off ? 'muted' : 'ink'}>{provider.name}</Text>{off && <Chip>Off</Chip>}
        <Text size="caption" tone="muted" truncate className="grow">{off ? 'Nothing starts on it' : provider.readiness.message}{provider.agents ? ` · ${provider.agents} agent${provider.agents === 1 ? '' : 's'}` : ''}</Text>
        {canEdit && <Select compact aria-label={`Turns at once on ${provider.name}`} value={String(provider.limits.concurrency ?? 2)} onChange={event => change({ concurrency: Number(event.target.value) })}>{[...new Set([1, 2, 3, 4, 6, 8, 12, 16, provider.limits.concurrency ?? 2])].sort((a, b) => a - b).map(count => <option key={count} value={count}>{count} at once</option>)}</Select>}
        <Chip tone={provider.kind === 'metered' ? 'attention' : 'neutral'}>{BILLING[provider.kind] ?? provider.kind}</Chip>
        {canEdit && <Menu align="end" label={provider.name} trigger={<IconButton icon="more" label={`More for ${provider.name}`} hint={false} />} items={[
          { label: off ? 'Turn on' : 'Turn off', onSelect: () => change({ on: off }) },
          ...(provider.keyLabel ? [{ label: provider.keySaved ? `Replace the ${provider.keyLabel}…` : `Add the ${provider.keyLabel}…`, onSelect: () => setKeying(true) }] : []),
          'separator' as const,
          { label: 'Remove…', tone: 'danger' as const, onSelect: () => { if (window.confirm(`Remove ${provider.name}?`)) { setProblem(null); void api(`/api/providers/${provider.id}/remove`, {}).then(onChanged, failure => setProblem(failure instanceof ApiError ? failure.message : 'That did not work; try again.')); } } },
        ]} />}
      </div>
      <MultiPicker inline name={`models-${provider.id}`} label={`models of ${provider.name}`} options={list.data?.models ?? []} value={models} onChange={pick} loading={Boolean(provider.catalog) && canEdit && !list.data} disabled={!canEdit} />
      {keying && <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); const typed = String(new FormData(event.currentTarget).get('key') ?? '').trim(); if (typed) change({ key: typed }); setKeying(false); }}><Input compact name="key" type="password" autoComplete="off" autoFocus aria-label={provider.keyLabel ?? 'Key'} placeholder={provider.keyLabel ?? ''} /><Button type="submit" size="sm" variant="primary">Save</Button><Button size="sm" variant="ghost" onClick={() => setKeying(false)}>Cancel</Button></form>}
      {others.length > 0 && (canEdit || (provider.fallbacks?.length ?? 0) > 0) && <MultiPicker inline listedOnly noun="provider" name={`fallbacks-${provider.id}`} label={`When ${provider.name} cannot take the work, send it to`} options={others.map(other => ({ id: other.id, name: other.name }))} value={(provider.fallbacks ?? []).map(fallback => fallback.providerId)} onChange={next => change({ fallbacks: next.map(providerId => ({ providerId, model: null })) })} disabled={!canEdit} />}
      {(provider.fallbacks?.length ?? 0) > 0 && <Text size="caption" tone="muted">When it is at its limit, off or signed out, its work goes to {(provider.fallbacks ?? []).map(fallback => others.find(other => other.id === fallback.providerId)?.name ?? 'a removed provider').join(', then ')}.</Text>}
      {problem && <StatusLine tone="stop">{problem}</StatusLine>}
    </Card>
  );
}

// What the team's models run on. Organization-wide, shown first among what a project is connected to.
export function ProvidersSection() {
  const providers = useResource<{ providers: Provider[]; canEdit: boolean }>('/api/providers');
  const [flow, setFlow] = useState<{ open: boolean; kind: string | null }>({ open: false, kind: null });
  const list = providers.data?.providers ?? [], canEdit = providers.data?.canEdit === true;
  return (
    <section aria-label="Model providers" className="flex flex-col gap-1.5">
      <SectionLabel aside={canEdit ? <Button size="sm" onClick={() => setFlow({ open: true, kind: null })}>+ Add</Button> : undefined}>Model providers</SectionLabel>
      {list.map(provider => <ProviderRow key={provider.id} provider={provider} others={list.filter(other => other.id !== provider.id)} canEdit={canEdit} onChanged={providers.reload} />)}
      {providers.data && list.length === 0 && <Text size="small" tone="muted">None yet. Agents use what their worker has.</Text>}
      <ProviderFlow open={flow.open} kind={flow.kind} providers={list} onOpenChange={(open, kind) => setFlow(previous => ({ open, kind: kind === undefined ? previous.kind : kind }))} onDone={providers.reload} />
    </section>
  );
}
