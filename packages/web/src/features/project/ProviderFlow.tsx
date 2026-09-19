import { useState } from 'react';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { ChoiceCard, StatusLine, Steps } from '../../patterns';
import { Button, Chip, Dialog, Field, Input, SectionLabel, Text, Textarea, type DotTone } from '../../ui';

export interface Readiness { state: 'ready' | 'waiting' | 'none'; message: string; workers: string[] }
export interface Provider { id: string; name: string; kind: string; engine: string; catalog: string | null; models: string[]; status: string; agents: number; readiness: Readiness; limits: { concurrency: number | null; windowTokens: number | null; windowHours: number | null } }
interface ProviderField { key: string; label: string; help?: string; placeholder?: string; input: 'text' | 'lines' | 'number'; suggested?: string; required?: boolean }
interface CatalogEntry { kind: string; title: string; summary: string; billing: string; does: string[]; steps: string[]; fields: ProviderField[]; providerId: string | null; readiness: Readiness;
  credential: { label: string; variable?: string; login?: string } | null }

export const BILLING: Record<string, string> = { subscription: 'Subscription', metered: 'Pay per use', local: 'Runs on your hardware' };
export const READY_TONE: Record<Readiness['state'], DotTone> = { ready: 'working', waiting: 'attention', none: 'off' };
const GROUPS = [['subscription', 'A plan you already pay for'], ['metered', 'Pay for what the team uses'], ['local', 'Your own hardware']] as const;

// Pick how the team's models are paid for, follow the steps on the worker, say which models the team may use, add it.
// Keys and sign-ins are never typed here: they live on the worker machines, which report what they found.
export function ProviderFlow({ open, kind, providers, onOpenChange, onDone }: { open: boolean; kind: string | null; providers: Provider[]; onOpenChange(open: boolean, kind?: string | null): void; onDone(): void }) {
  const catalog = useResource<{ entries: CatalogEntry[] }>('/api/providers/catalog');
  const [errors, setErrors] = useState<Record<string, string>>({}), [failure, setFailure] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const entry = catalog.data?.entries.find(item => item.kind === kind) ?? null;
  const [details, setDetails] = useState(false);
  // Ready on a worker, nothing required left empty, and not an edit of something already added: one confirmation is enough.
  const settled = entry !== null && !details && entry.readiness.state === 'ready' && entry.providerId === null && entry.fields.every(field => !field.required || Boolean(field.suggested));
  const existing = entry ? providers.find(provider => provider.catalog === entry.kind) ?? null : null;
  const pick = (next: string | null) => { setErrors({}); setFailure(null); setDetails(false); onOpenChange(true, next); };
  const current = (field: ProviderField): string => {
    if (!existing) return field.suggested ?? '';
    const values: Record<string, string> = { name: existing.name, models: existing.models.join('\n'), concurrency: String(existing.limits.concurrency ?? ''), windowTokens: String(existing.limits.windowTokens ?? ''), windowHours: String(existing.limits.windowHours ?? '') };
    return values[field.key] ?? '';
  };

  async function save(form: HTMLFormElement) {
    if (!entry) return;
    const values = Object.fromEntries(entry.fields.map(field => [field.key, String(new FormData(form).get(field.key) ?? '')]));
    setBusy(true); setErrors({}); setFailure(null);
    try { await api('/api/providers/setup', { kind: entry.kind, values }); catalog.reload(); onOpenChange(false); onDone(); }
    catch (problem) {
      if (problem instanceof ApiError && Object.keys(problem.fields).length) setErrors(problem.fields);
      else setFailure(problem instanceof ApiError && problem.status === 403 ? 'Only the organization\'s owner or an admin can set up providers.' : problem instanceof ApiError ? problem.message : 'That did not work; try again.');
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={next => onOpenChange(next, null)} title={entry ? (existing ? `Change ${entry.title}` : `Add ${entry.title}`) : 'Add a model provider'} description={entry ? entry.summary : 'Choose how the team\'s models are paid for. Each one walks you through its setup; any agent can then be given any of its models.'}
      footer={entry && (
        <div className="flex grow items-center gap-2">
          <Button variant="ghost" onClick={() => pick(null)}>← Back</Button>
          <span className="grow" />
          <Button type="submit" form="provider-flow" variant="primary" disabled={busy}>{existing ? 'Save changes' : 'Add this provider'}</Button>
        </div>
      )}>
      {!entry ? (
        <div className="flex min-h-0 flex-col gap-4">
          {GROUPS.map(([billing, label]) => (
            <section key={billing} className="flex flex-col gap-1.5">
              <SectionLabel>{label}</SectionLabel>
              <div className="grid grid-cols-1 gap-2">
                {catalog.data?.entries.filter(item => item.billing === billing).map(item => <ChoiceCard key={item.kind} title={item.title} note={item.summary} onClick={() => pick(item.kind)} aside={item.providerId ? <Chip tone="working">Added</Chip> : item.readiness.state === 'ready' ? <Chip>Worker ready</Chip> : undefined} />)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <form id="provider-flow" key={entry.kind + (existing?.id ?? '')} className="flex min-h-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(event.currentTarget); }}>
          <section className="flex flex-col gap-1.5">
            <SectionLabel aside={<Chip tone={entry.billing === 'metered' ? 'attention' : 'neutral'}>{BILLING[entry.billing]}</Chip>}>What choosing it means</SectionLabel>
            {entry.does.map(line => <Text key={line} size="small" tone="soft">· {line}</Text>)}
          </section>
          {/* A worker that already has the tool and its sign-in needs none of the instructions, and every field has a working default. */}
          <StatusLine boxed tone={READY_TONE[entry.readiness.state]}>{entry.readiness.message}{settled ? ' Nothing else to set up.' : ''}</StatusLine>
          {settled && <div><Button variant="ghost" onClick={() => setDetails(true)}>Choose the models and limits myself</Button></div>}
          {!settled && <section className="flex flex-col gap-2"><SectionLabel>On each worker machine</SectionLabel><Steps items={entry.steps} /></section>}
          {!settled && entry.credential && <StatusLine boxed tone="off">{entry.credential.variable ? `The ${entry.credential.label} lives on the worker machines as ${entry.credential.variable}; it is never entered here.` : `The ${entry.credential.label} stays on the worker machines; it is never entered here.`}</StatusLine>}
          <section className={settled ? 'hidden' : 'flex flex-col gap-3'}>
            {entry.fields.map(field => (
              <Field key={field.key} label={field.required ? field.label : `${field.label} (optional)`} help={field.help} error={errors[field.key]}>
                {field.input === 'lines' ? <Textarea name={field.key} rows={4} defaultValue={current(field)} placeholder={field.placeholder} spellCheck={false} /> : <Input name={field.key} defaultValue={current(field)} placeholder={field.placeholder} inputMode={field.input === 'number' ? 'numeric' : undefined} />}
              </Field>
            ))}
          </section>
          {failure && <StatusLine boxed tone="stop">{failure}</StatusLine>}
        </form>
      )}
    </Dialog>
  );
}
