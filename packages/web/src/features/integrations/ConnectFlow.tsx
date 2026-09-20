import { useEffect, useState } from 'react';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { ChoiceCard, More, SecretField, StatusLine, Steps } from '../../patterns';
import { Button, Chip, Dialog, Field, Input, SectionLabel, Select } from '../../ui';

interface SetupField { key: string; label: string; placeholder?: string; help?: string; required?: boolean; pickable?: boolean; filledBy?: string }
interface Choice { value: string; label: string; also?: Record<string, string> }
export interface CatalogEntry { kind: string; title: string; category: string; summary: string; steps: string[]; fields: SetupField[]; mode: string; testable: boolean; credentialPresent: boolean | null; credentialSource: string | null; prefill: Record<string, string>;
  credential: { variable: string; label: string; runsOn: 'coordinator' | 'workers'; getAt?: string; placeholder?: string } | null }
export const CATEGORY: Record<string, string> = { code: 'Code', 'issue-boards': 'Task boards', comms: 'Chat', storage: 'Documents', business: 'Business tools', 'ai-workspaces': 'AI workspaces', media: 'Media', other: 'Anything else' };

// A field that is picked from the product's own list once its token is known. Until then, and if the list cannot be had, it is typed.
function PickField({ slug, kind, field, error, ready, autoFocus }: { slug: string; kind: string; field: SetupField; error: string | undefined; ready: boolean; autoFocus: boolean }) {
  const [choices, setChoices] = useState<Choice[] | null>(null), [message, setMessage] = useState<string | null>(null), [busy, setBusy] = useState(false), [value, setValue] = useState('');
  const load = async (form: HTMLFormElement | null) => {
    const token = String(form ? new FormData(form).get('token') ?? '' : '');
    setBusy(true);
    try { const result = await api<{ choices: Choice[]; message: string | null }>(`/api/projects/${slug}/integrations/choices`, { kind, field: field.key, ...(token ? { token } : {}) }); setChoices(result.choices.length ? result.choices : null); setMessage(result.message ?? (result.choices.length ? null : 'Nothing was found.')); }
    catch { setMessage('The list could not be loaded.'); } finally { setBusy(false); }
  };
  useEffect(() => { if (ready) void load(null); }, [ready]);
  const also = choices?.find(choice => choice.value === value)?.also ?? {};
  return (
    <Field label={field.label} error={error ?? message ?? undefined}>
      {choices
        ? <Select name={field.key} required={field.required} value={value} onChange={event => setValue(event.target.value)}><option value="">Choose…</option>{choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</Select>
        : <div className="flex gap-2"><Input name={field.key} placeholder={field.placeholder} required={field.required} autoFocus={autoFocus} /><Button disabled={busy} onClick={event => { void load(event.currentTarget.closest('form')); }}>{busy ? 'Loading…' : 'Pick'}</Button></div>}
      {Object.entries(also).map(([key, extra]) => <input key={key} type="hidden" name={key} value={extra} />)}
    </Field>
  );
}

// Pick what to connect, paste its token if it has one, fill in what is not known yet, connect.
// `only` narrows the choice to some categories and `label` names the button, so a guide can ask for one thing at a time.
export function ConnectFlow({ slug, connectedKinds, onDone, only, label = '+ Connect something', quiet }: { slug: string; connectedKinds: string[]; onDone(): void; only?: string[]; label?: string; quiet?: boolean }) {
  // Asked per project, so what was already entered for the same product (a repository, say) is offered again instead of asked again.
  const catalog = useResource<{ entries: CatalogEntry[] }>(`/api/projects/${slug}/integrations/catalog`);
  const [manual, setManual] = useState(false);
  const [open, setOpen] = useState(false), [entry, setEntry] = useState<CatalogEntry | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({}), [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null), [busy, setBusy] = useState(false);
  const pick = (next: CatalogEntry | null) => { setEntry(next); setErrors({}); setCheck(null); setManual(false); };
  // A field whose value is already known is never asked for again, whatever else may still be missing.
  const known = entry && !manual ? entry.fields.filter(field => entry.prefill[field.key]) : [];
  const asked = entry ? entry.fields.filter(field => !known.includes(field) && (known.length === 0 || field.required)) : [];
  const here = entry?.credential?.runsOn === 'coordinator';

  async function send(action: 'test' | 'setup', form: HTMLFormElement) {
    if (!entry) return;
    const data = new FormData(form), token = String(data.get('token') ?? '');
    const values = Object.fromEntries(entry.fields.map(field => [field.key, String(data.get(field.key) ?? entry.prefill[field.key] ?? '')]));
    setBusy(true); setErrors({});
    try {
      const result = await api<{ ok: boolean; message?: string }>(`/api/projects/${slug}/integrations/${action}`, { kind: entry.kind, values, ...(token ? { token } : {}) });
      if (action === 'test') setCheck({ ok: result.ok, message: result.message ?? '' });
      else { setOpen(false); pick(null); catalog.reload(); onDone(); }
    } catch (failure) {
      if (failure instanceof ApiError && Object.keys(failure.fields).length) setErrors(failure.fields as Record<string, string>);
      else setCheck({ ok: false, message: failure instanceof ApiError ? failure.message : 'That did not work; try again.' });
    } finally { setBusy(false); }
  }

  const groups = Object.keys(CATEGORY).filter(key => !only || only.includes(key)).map(key => ({ key, items: catalog.data?.entries.filter(item => item.category === key) ?? [] })).filter(group => group.items.length);
  return (
    <Dialog open={open} onOpenChange={next => { setOpen(next); if (!next) pick(null); }} title={entry ? `Connect ${entry.title}` : 'Connect something'} {...(entry ? { description: entry.summary } : {})} trigger={<Button variant={quiet ? 'secondary' : 'primary'}>{label}</Button>}
      footer={entry && (
        <div className="flex grow items-center gap-2">
          <Button variant="ghost" onClick={() => pick(null)}>← Back</Button>
          <span className="grow" />
          {entry.testable && <Button disabled={busy} onClick={() => { const form = document.getElementById('connect-flow') as HTMLFormElement | null; if (form?.reportValidity()) void send('test', form); }}>Test</Button>}
          <Button type="submit" form="connect-flow" variant="primary" disabled={busy}>Connect</Button>
        </div>
      )}>
      {!entry ? (
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {groups.map(group => (
            <section key={group.key} className="flex flex-col gap-1.5">
              <SectionLabel>{CATEGORY[group.key]}</SectionLabel>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.items.map(item => <ChoiceCard key={item.kind} title={item.title} note={item.summary} onClick={() => pick(item)} aside={connectedKinds.includes(item.kind) ? <Chip tone="working">Connected</Chip> : undefined} />)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <form id="connect-flow" className="flex min-h-0 flex-col gap-4 overflow-y-auto" onSubmit={event => { event.preventDefault(); void send('setup', event.currentTarget); }}>
          {known.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="grow"><StatusLine tone="working">{known.map(field => entry.prefill[field.key]).join(', ')}</StatusLine></span>
              {known.map(field => <input key={field.key} type="hidden" name={field.key} value={entry.prefill[field.key]} />)}
              <Button size="sm" variant="ghost" onClick={() => setManual(true)}>Change</Button>
            </div>
          )}
          {/* A sign-in found on this machine needs nothing typed; otherwise the token goes here. */}
          {here && (entry.credentialPresent && entry.credentialSource !== 'saved here'
            ? <StatusLine tone="working">Signed in through {entry.credentialSource}</StatusLine>
            : <SecretField name="token" label={entry.credential!.label} saved={entry.credentialPresent === true} getAt={entry.credential!.getAt} placeholder={entry.credential!.placeholder} error={errors.token} />)}
          {asked.filter(field => field.pickable).map(field => <PickField key={field.key} slug={slug} kind={entry.kind} field={field} error={errors[field.key]} ready={entry.credentialPresent === true} autoFocus={false} />)}
          {asked.filter(field => !field.pickable && !(field.filledBy && asked.some(other => other.pickable && other.key === field.filledBy))).map((field, index) => <Field key={field.key} label={field.required ? field.label : `${field.label} (optional)`} help={field.help} error={errors[field.key]}><Input name={field.key} placeholder={field.placeholder} required={field.required} autoFocus={index === 0 && !here} defaultValue={manual ? entry.prefill[field.key] ?? '' : ''} /></Field>)}
          {entry.steps.length > 0 && (here ? !entry.credentialPresent : true) && <More label={here ? 'Where do I get this?' : 'How it signs in'}><Steps items={entry.steps} /></More>}
          {check && <StatusLine boxed tone={check.ok ? 'working' : 'stop'}>{check.message}</StatusLine>}
        </form>
      )}
    </Dialog>
  );
}
