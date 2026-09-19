import { api, type Agent } from '../../data/client';
import { useResource } from '../../data/useResource';
import { SeatRow } from '../../patterns';
import { Button, Card, Field, Input, SectionLabel, Select, StatusDot, Text } from '../../ui';

interface Provider { id: string; name: string; kind: string; engine: string; models: string[]; status: string; agents: number }

export function TeamTab({ roster, teamName, onChanged }: { roster: Agent[]; teamName: string | null; onChanged(): void }) {
  const providers = useResource<{ providers: Provider[] }>('/api/providers');
  const list = providers.data?.providers ?? [];
  const assign = (agent: Agent, value: string) => {
    const [providerId, model] = value ? value.split('\n') : [null, null];
    void api(`/api/agents/${agent.id}/provider`, { providerId: providerId ?? null, model: model ?? null }).then(onChanged);
  };
  const add = async (form: FormData) => {
    await api('/api/providers', { name: form.get('name'), kind: form.get('kind'), engine: form.get('engine'), models: String(form.get('models')).split(',').map(item => item.trim()).filter(Boolean) });
    providers.reload();
  };

  return (
    <div className="flex min-h-0 grow flex-col gap-5 overflow-y-auto p-5">
      <section className="flex flex-col gap-2">
        <SectionLabel aside={<Text size="caption" tone="muted">The PM decides ties</Text>}>{teamName ?? 'Team'} · {roster.length}</SectionLabel>
        {roster.map(agent => (
          <SeatRow key={agent.id} agent={agent}>
            <Select compact aria-label={`Provider and model for ${agent.name}`} value={agent.provider_id ? `${agent.provider_id}\n${agent.model ?? ''}` : ''} onChange={event => assign(agent, event.target.value)}>
              <option value="">Worker default</option>
              {list.flatMap(provider => provider.models.map(model => <option key={`${provider.id}${model}`} value={`${provider.id}\n${model}`}>{provider.name} · {model}</option>))}
            </Select>
          </SeatRow>
        ))}
        {roster.length === 0 && <Text tone="muted">This project has no team yet.</Text>}
      </section>

      <section className="flex flex-col gap-2">
        <SectionLabel>Providers</SectionLabel>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
          {list.map(provider => (
            <Card key={provider.id} tone="raised" pad="sm" className="flex flex-col gap-1">
              <div className="flex items-center gap-2"><StatusDot tone={provider.status === 'connected' ? 'working' : 'off'} /><Text weight="semibold">{provider.name}</Text><Text size="caption" tone="muted" className="ml-auto">{provider.kind}</Text></div>
              <Text size="caption" tone="muted" mono>{provider.engine} · {provider.agents} agent{provider.agents === 1 ? '' : 's'} · {provider.models.length} model{provider.models.length === 1 ? '' : 's'}</Text>
            </Card>
          ))}
        </div>
        <form className="flex flex-wrap items-end gap-2.5" onSubmit={event => { event.preventDefault(); void add(new FormData(event.currentTarget)); event.currentTarget.reset(); }}>
          <Field label="Name"><Input name="name" required placeholder="Metered gateway" /></Field>
          <Field label="Billing"><Select name="kind"><option value="metered">metered</option><option value="subscription">subscription</option><option value="local">local</option></Select></Field>
          <Field label="Engine adapter"><Input name="engine" required placeholder="as named on the workers" /></Field>
          <Field label="Models, comma-separated"><Input name="models" required placeholder="vendor/model-a, vendor/model-b" /></Field>
          <Button type="submit">Add provider</Button>
        </form>
        <Text size="caption" tone="muted">Any agent can run on any provider. Credentials stay on the workers; a provider here only names the engine and the models it offers.</Text>
      </section>
    </div>
  );
}
