import { useEffect, useState } from 'react';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { ChoiceCard, More, MultiPicker, SecretField, StatusLine, type PickOption } from '../../patterns';
import { Button, Chip, CodeBlock, Dialog, Field, Input, SectionLabel, Text, type DotTone } from '../../ui';

export interface Readiness { state: 'ready' | 'waiting' | 'none'; message: string; workers: string[]; need?: 'worker' | 'tool' | 'key' | null }
export interface Provider { id: string; name: string; kind: string; engine: string; catalog: string | null; models: string[]; fallbacks?: { providerId: string; model: string | null }[]; status: string; agents: number; readiness: Readiness; efforts?: string[]; modelEfforts?: Record<string, string[]>; keyLabel?: string | null; keySaved?: boolean; limits: { concurrency: number | null; windowTokens: number | null; windowHours: number | null } }
interface CatalogEntry { kind: string; title: string; summary: string; billing: string; install: string; signIn?: string; named?: boolean; window: boolean; hasList: boolean; keySaved: boolean; providerId: string | null; readiness: Readiness;
  key?: { variable: string; label: string; getAt: string; placeholder?: string; optional?: boolean; help?: string }; aliases?: string[] }

export const BILLING: Record<string, string> = { subscription: 'Subscription', metered: 'Pay per use', local: 'Runs on your hardware' };
export const READY_TONE: Record<Readiness['state'], DotTone> = { ready: 'working', waiting: 'attention', none: 'off' };
const GROUPS = [['subscription', 'A plan you already pay for'], ['metered', 'Pay for what the team uses'], ['local', 'Your own hardware']] as const;

// Pick a provider, paste its key if it has one, tick the models. Everything else has a default and is folded away.
export function ProviderFlow({ open, kind, providers, onOpenChange, onDone }: { open: boolean; kind: string | null; providers: Provider[]; onOpenChange(open: boolean, kind?: string | null): void; onDone(): void }) {
  const catalog = useResource<{ entries: CatalogEntry[] }>('/api/providers/catalog');
  const [errors, setErrors] = useState<Record<string, string>>({}), [failure, setFailure] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const entry = catalog.data?.entries.find(item => item.kind === kind) ?? null;
  const existing = entry ? providers.find(provider => provider.catalog === entry.kind) ?? null : null;
  const list = useResource<{ models: PickOption[]; error: string | null }>(entry ? `/api/providers/catalog/${entry.kind}/models` : null);
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => { setModels(existing?.models ?? entry?.aliases ?? []); setTyped(null); }, [entry?.kind, existing?.id]);
  // A list that only opens with a key is asked for again with the key as typed, before anything is saved.
  const [typed, setTyped] = useState<PickOption[] | null>(null);
  const withKey = async (key: string) => { if (entry && key.trim().length >= 8) try { const found = await api<{ models: PickOption[] }>(`/api/providers/catalog/${entry.kind}/models`, { key: key.trim() }); if (found.models.length) setTyped(found.models); } catch { /* the saved list stays */ } };
  const pick = (next: string | null) => { setErrors({}); setFailure(null); onOpenChange(true, next); };

  async function save(form: HTMLFormElement) {
    if (!entry) return;
    const data = new FormData(form), text = (key: string) => String(data.get(key) ?? '');
    setBusy(true); setErrors({}); setFailure(null);
    try {
      await api('/api/providers/setup', { kind: entry.kind, ...(text('key') ? { key: text('key') } : {}), values: { name: text('name'), models: text('models'), concurrency: text('concurrency'), windowTokens: text('windowTokens'), windowHours: text('windowHours') } });
      catalog.reload(); onOpenChange(false); onDone();
    } catch (problem) {
      if (problem instanceof ApiError && Object.keys(problem.fields).length) setErrors(problem.fields);
      else setFailure(problem instanceof ApiError && problem.status === 403 ? 'Only an owner or admin can do this.' : problem instanceof ApiError ? problem.message : 'That did not work; try again.');
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={next => onOpenChange(next, null)} title={entry ? entry.title : 'Add a model provider'} {...(entry ? { description: entry.summary } : {})}
      footer={entry && (
        <div className="flex grow items-center gap-2">
          <Button variant="ghost" onClick={() => pick(null)}>← Back</Button>
          <span className="grow" />
          <Button type="submit" form="provider-flow" variant="primary" disabled={busy}>{existing ? 'Save' : 'Add'}</Button>
        </div>
      )}>
      {!entry ? (
        <div className="flex min-h-0 flex-col gap-4">
          {GROUPS.map(([billing, label]) => (
            <section key={billing} className="flex flex-col gap-1.5">
              <SectionLabel>{label}</SectionLabel>
              <div className="grid grid-cols-1 gap-2">
                {catalog.data?.entries.filter(item => item.billing === billing).map(item => <ChoiceCard key={item.kind} title={item.title} note={item.summary} onClick={() => pick(item.kind)} aside={item.providerId ? <Chip tone="working">Added</Chip> : item.readiness.state === 'ready' ? <Chip>Ready</Chip> : undefined} />)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <form id="provider-flow" key={entry.kind + (existing?.id ?? '')} className="flex min-h-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(event.currentTarget); }}>
          <div className="flex items-center gap-2"><span className="grow"><StatusLine tone={READY_TONE[entry.readiness.state]}>{entry.readiness.message}</StatusLine></span><Chip tone={entry.billing === 'metered' ? 'attention' : 'neutral'}>{BILLING[entry.billing]}</Chip></div>
          {entry.readiness.need === 'tool' && <CodeBlock text={entry.install} />}
          {entry.readiness.state !== 'ready' && entry.signIn && <section className="flex flex-col gap-1.5"><SectionLabel>Sign in once on the worker</SectionLabel><CodeBlock text={entry.signIn} /></section>}
          {entry.key && !entry.key.optional && <SecretField onLeave={value => { void withKey(value); }} name="key" label={entry.key.label} saved={entry.keySaved} getAt={entry.key.getAt} placeholder={entry.key.placeholder} error={errors.key} />}
          {entry.key?.optional && <More label={`${entry.key.label}${entry.keySaved ? ' (saved)' : ''}`}>{entry.key.help && <Text size="small" tone="muted">{entry.key.help}</Text>}<SecretField name="key" label={entry.key.label} saved={entry.keySaved} getAt={entry.key.getAt} placeholder={entry.key.placeholder} error={errors.key} /></More>}
          {entry.named && <Field label="Name" error={errors.name}><Input name="name" defaultValue={existing?.name ?? ''} placeholder="Company gateway" required /></Field>}
          <MultiPicker name="models" label="Models" options={typed ?? list.data?.models ?? []} value={models} onChange={setModels} loading={entry.hasList && !list.data} error={errors.models ?? list.data?.error ?? undefined} />
          <More label="Limits">
            <Field label="Turns at once" error={errors.concurrency}><Input name="concurrency" inputMode="numeric" placeholder="2" defaultValue={existing?.limits.concurrency ?? ''} /></Field>
            {entry.window && <div className="grid grid-cols-2 gap-3">
              <Field label="Token allowance" error={errors.windowTokens}><Input name="windowTokens" inputMode="numeric" placeholder="No limit" defaultValue={existing?.limits.windowTokens ?? ''} /></Field>
              <Field label="Per hours" error={errors.windowHours}><Input name="windowHours" inputMode="numeric" placeholder="5" defaultValue={existing?.limits.windowHours ?? ''} /></Field>
            </div>}
          </More>
          {failure && <StatusLine boxed tone="stop">{failure}</StatusLine>}
        </form>
      )}
    </Dialog>
  );
}
