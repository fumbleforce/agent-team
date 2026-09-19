import { useState } from 'react';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { ChoiceCard, StatusLine, Steps } from '../../patterns';
import { Button, Chip, Dialog, Field, Input, SectionLabel, Text } from '../../ui';

interface SetupField { key: string; label: string; placeholder?: string; help?: string; required?: boolean }
export interface CatalogEntry { kind: string; title: string; category: string; summary: string; does: string[]; steps: string[]; fields: SetupField[]; mode: string; testable: boolean; credentialPresent: boolean | null; credentialSource: string | null; prefill: Record<string, string>;
  credential: { variable: string; label: string; runsOn: 'coordinator' | 'workers' } | null }
export const CATEGORY: Record<string, string> = { code: 'Code', 'issue-boards': 'Task boards', comms: 'Chat', storage: 'Documents', business: 'Business tools', 'ai-workspaces': 'AI workspaces', media: 'Media', other: 'Anything else' };

// Pick what to connect, follow its steps, check that it works, connect. Secrets are never typed here:
// each entry says which variable to set and on which machine, and the check tells whether it is there.
// `only` narrows the choice to some categories and `label` names the button, so a guide can ask for one thing at a time.
export function ConnectFlow({ slug, connectedKinds, onDone, only, label = '+ Connect something', quiet }: { slug: string; connectedKinds: string[]; onDone(): void; only?: string[]; label?: string; quiet?: boolean }) {
  // Asked per project, so what was already entered for the same product (a repository, say) is offered again instead of asked again.
  const catalog = useResource<{ entries: CatalogEntry[] }>(`/api/projects/${slug}/integrations/catalog`);
  const [manual, setManual] = useState(false);
  const [open, setOpen] = useState(false), [entry, setEntry] = useState<CatalogEntry | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({}), [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null), [busy, setBusy] = useState(false);
  const pick = (next: CatalogEntry | null) => { setEntry(next); setErrors({}); setCheck(null); setManual(false); };
  // Everything needed is already known: the fields from what was connected before, the credential from this machine.
  const ready = entry !== null && !manual && entry.credentialPresent === true && entry.fields.filter(field => field.required).every(field => entry.prefill[field.key]);

  async function send(action: 'test' | 'setup', form: HTMLFormElement) {
    if (!entry) return;
    const values = Object.fromEntries(entry.fields.map(field => [field.key, String(new FormData(form).get(field.key) ?? entry.prefill[field.key] ?? '')]));
    setBusy(true); setErrors({});
    try {
      const result = await api<{ ok: boolean; message?: string }>(`/api/projects/${slug}/integrations/${action}`, { kind: entry.kind, values });
      if (action === 'test') setCheck({ ok: result.ok, message: result.message ?? '' });
      else { setOpen(false); pick(null); onDone(); }
    } catch (failure) {
      if (failure instanceof ApiError && Object.keys(failure.fields).length) setErrors(failure.fields as Record<string, string>);
      else setCheck({ ok: false, message: failure instanceof ApiError ? failure.message : 'That did not work; try again.' });
    } finally { setBusy(false); }
  }

  const groups = Object.keys(CATEGORY).filter(key => !only || only.includes(key)).map(key => ({ key, items: catalog.data?.entries.filter(item => item.category === key) ?? [] })).filter(group => group.items.length);
  return (
    <Dialog open={open} onOpenChange={next => { setOpen(next); if (!next) pick(null); }} title={entry ? `Connect ${entry.title}` : 'Connect something'} description={entry ? entry.summary : 'Pick what this project should work with. Each one walks you through its setup.'} trigger={<Button variant={quiet ? 'secondary' : 'primary'}>{label}</Button>}
      footer={entry && (
        <div className="flex grow items-center gap-2">
          <Button variant="ghost" onClick={() => pick(null)}>← Back</Button>
          <span className="grow" />
          {entry.testable && <Button disabled={busy} onClick={() => { const form = document.getElementById('connect-flow') as HTMLFormElement | null; if (form?.reportValidity()) void send('test', form); }}>Test connection</Button>}
          <Button type="submit" form="connect-flow" variant="primary" disabled={busy}>Connect {entry.title}</Button>
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
          {ready && (
            <>
              <StatusLine boxed tone="working">{Object.values(entry.prefill).join(', ')} is already connected, and its sign-in was found ({entry.credentialSource}). Nothing else to set up.</StatusLine>
              {entry.fields.map(field => <input key={field.key} type="hidden" name={field.key} value={entry.prefill[field.key] ?? ''} />)}
              <div><Button variant="ghost" onClick={() => setManual(true)}>Use a different repository or token</Button></div>
            </>
          )}
          <section className="flex flex-col gap-1.5"><SectionLabel>What the team does with it</SectionLabel>{entry.does.map(line => <Text key={line} size="small" tone="soft">· {line}</Text>)}</section>
          {!ready && <section className="flex flex-col gap-2"><SectionLabel>Before you connect</SectionLabel><Steps items={entry.steps} /></section>}
          {!ready && entry.credential && (entry.credential.runsOn === 'coordinator'
            ? <StatusLine boxed tone={entry.credentialPresent ? 'working' : 'attention'}>{entry.credentialPresent ? `${entry.credential.label} found: ${entry.credentialSource}.` : `${entry.credential.variable} is not set on the coordinator yet. You can connect now; it starts working once the variable is set and the coordinator restarted.`}</StatusLine>
            : <StatusLine boxed tone="off">The {entry.credential.label.toLowerCase()} lives on the worker machines as {entry.credential.variable}; it is never entered here.</StatusLine>)}
          {!ready && <section className="flex flex-col gap-3">
            {entry.fields.map((field, index) => <Field key={field.key} label={field.required ? field.label : `${field.label} (optional)`} help={field.help} error={errors[field.key]}><Input name={field.key} placeholder={field.placeholder} required={field.required} autoFocus={index === 0} defaultValue={entry.prefill[field.key] ?? ''} /></Field>)}
          </section>}
          {check && <StatusLine boxed tone={check.ok ? 'working' : 'stop'}>{check.message}</StatusLine>}
        </form>
      )}
    </Dialog>
  );
}
