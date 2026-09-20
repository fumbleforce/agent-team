import { useState } from 'react';
import { api, ApiError, type RoleChoiceView, type SeatView } from '../../data/client';
import { StatusLine } from '../../patterns';
import { Button, Checkbox, Dialog, Field, Input, SectionLabel, Select, Text, Textarea } from '../../ui';
import type { Provider } from './ProviderFlow';

export type Seat = SeatView;
export type RoleChoice = RoleChoiceView;
export const roleName = (slug: string) => slug.length <= 2 ? slug.toUpperCase() : slug.charAt(0).toUpperCase() + slug.slice(1).replaceAll('-', ' ');

// One seat on the team, made or changed by hand: who the agent is, what it may do (its roles), and what it runs on.
export function AgentDialog({ slug, seat, open, roles, providers, defaultWords, onOpenChange, onSaved }: { slug: string; seat: Seat | null; open: boolean; roles: RoleChoice[]; providers: Provider[]; /* What the team default is right now, in words. */ defaultWords: string; onOpenChange(open: boolean): void; onSaved(): void }) {
  const [errors, setErrors] = useState<Record<string, string>>({}), [failure, setFailure] = useState<string | null>(null), [busy, setBusy] = useState(false);

  async function save(form: HTMLFormElement) {
    const data = new FormData(form), [providerId, model] = String(data.get('route') ?? '').split('\n');
    const body = { name: String(data.get('name')), title: String(data.get('title')), persona: String(data.get('persona')), roles: data.getAll('roles').map(String), providerId: providerId || null, model: providerId ? model || null : null };
    setBusy(true); setErrors({}); setFailure(null);
    try { await api(seat ? `/api/agents/${seat.id}` : `/api/projects/${slug}/team/agents`, body); onOpenChange(false); onSaved(); }
    catch (problem) {
      if (problem instanceof ApiError && Object.keys(problem.fields).length) setErrors(problem.fields);
      else setFailure(problem instanceof ApiError ? problem.message : 'That did not work; try again.');
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) { setErrors({}); setFailure(null); } }} title={seat ? `Change ${seat.name}` : 'Add an agent to the team'} description={seat ? 'A turn that is already running keeps what it started with; changes apply from the next one.' : 'Describe who joins the team. You can change all of this later.'}
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" form="agent-dialog" variant="primary" disabled={busy}>{seat ? 'Save changes' : 'Add to the team'}</Button></>}>
      <form id="agent-dialog" key={seat?.id ?? 'new'} className="flex flex-col gap-3.5" onSubmit={event => { event.preventDefault(); void save(event.currentTarget); }}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" error={errors.name}><Input name="name" required maxLength={60} defaultValue={seat?.name} placeholder="Noor" autoFocus /></Field>
          <Field label="What they do on the team (optional)" error={errors.title}><Input name="title" maxLength={80} defaultValue={seat?.title} placeholder="Backend developer" /></Field>
        </div>
        <Field label="Personality and way of working (optional)" error={errors.persona}>
          <Textarea name="persona" rows={4} maxLength={2000} defaultValue={seat?.persona} placeholder="Careful and direct. Keeps changes small." />
        </Field>
        <section className="flex flex-col gap-2">
          <SectionLabel>Roles</SectionLabel>
          <Text size="caption" tone="muted">Roles decide what the agent may touch. They add up.</Text>
          {roles.map(role => <Checkbox key={role.slug} name="roles" value={role.slug} defaultChecked={seat?.roles.includes(role.slug) ?? false} label={roleName(role.slug)} note={role.summary} />)}
          {roles.length === 0 && <Text size="small" tone="muted">The role library is empty.</Text>}
          {errors.roles && <Text size="caption" tone="stop">{errors.roles}</Text>}
        </section>
        <Field label="Runs on" error={errors.provider}>
          <Select name="route" defaultValue={seat?.providerId ? `${seat.providerId}\n${seat.model ?? ''}` : ''}>
            <option value="">Team default ({defaultWords})</option>
            {providers.flatMap(provider => provider.models.map(model => <option key={`${provider.id}${model}`} value={`${provider.id}\n${model}`}>{provider.name} · {model}</option>))}
          </Select>
        </Field>
        {failure && <StatusLine boxed tone="stop">{failure}</StatusLine>}
      </form>
    </Dialog>
  );
}
