import { useState } from 'react';
import { api, ApiError } from '../../data/client';
import { ChoiceCard, More, SecretField, StatusLine, Steps } from '../../patterns';
import { Button, Card, CodeBlock, Dialog, Field, Input, SectionLabel, Select, Text } from '../../ui';

interface SetupField { key: string; label: string; placeholder?: string; help?: string; required?: boolean }
interface Secret { variable: string; present: boolean }
interface Check { ok: boolean; message: string }
export interface SsoEntry { kind: string; title: string; summary: string; steps: string[]; fields: SetupField[] }
export interface SsoCurrent { kind: string; title: string; allowedDomains: string[]; defaultRole: 'viewer' | 'member'; secret: Secret }
export interface SsoCatalog { entries: SsoEntry[]; redirectUri: string; secret: Secret; canEdit: boolean; current: SsoCurrent | null }

const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);
const Checks = ({ checks }: { checks: Check[] }) => <>{checks.map(check => <StatusLine key={check.message} boxed tone={check.ok ? 'working' : 'stop'}>{check.message}</StatusLine>)}</>;

// Pick the product people sign in with, register this app there, paste back what it gave you, turn it on.
export function SsoSetupFlow({ catalog, onDone }: { catalog: SsoCatalog; onDone(): void }) {
  const [open, setOpen] = useState(false), [entry, setEntry] = useState<SsoEntry | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({}), [checks, setChecks] = useState<Check[]>([]), [busy, setBusy] = useState(false);
  const pick = (next: SsoEntry | null) => { setEntry(next); setErrors({}); setChecks([]); };

  async function send(action: 'test' | 'setup', form: HTMLFormElement) {
    if (!entry) return;
    const data = new FormData(form), clientSecret = String(data.get('clientSecret') ?? ''), values = Object.fromEntries(entry.fields.map(field => [field.key, String(data.get(field.key) ?? '')]));
    setBusy(true); setErrors({}); setChecks([]);
    try {
      const result = await api<{ ok: boolean; checks?: Check[] }>(`/api/settings/sso/${action}`, { kind: entry.kind, values, ...(clientSecret ? { clientSecret } : {}), allowedDomains: String(data.get('allowedDomains') ?? ''), defaultRole: data.get('defaultRole') });
      if (action === 'test') setChecks(result.checks ?? []);
      else { setOpen(false); pick(null); onDone(); }
    } catch (failure) {
      if (failure instanceof ApiError && Object.keys(failure.fields).length) setErrors(failure.fields);
      else setChecks([{ ok: false, message: failure instanceof ApiError ? failure.message : 'That did not work; try again.' }]);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={next => { setOpen(next); if (!next) pick(null); }} title={entry ? entry.title : 'Set up single sign-on'} {...(entry ? { description: entry.summary } : {})} trigger={<Button variant="primary">Set up single sign-on</Button>}
      footer={entry && (
        <div className="flex grow items-center gap-2">
          <Button variant="ghost" onClick={() => pick(null)}>← Back</Button>
          <span className="grow" />
          <Button disabled={busy} onClick={() => { const form = document.getElementById('sso-flow') as HTMLFormElement | null; if (form?.reportValidity()) void send('test', form); }}>Test</Button>
          <Button type="submit" form="sso-flow" variant="primary" disabled={busy}>Turn on</Button>
        </div>
      )}>
      {!entry ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {catalog.entries.map(item => <ChoiceCard key={item.kind} title={item.title} note={item.summary} onClick={() => pick(item)} />)}
        </div>
      ) : (
        <form id="sso-flow" className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void send('setup', event.currentTarget); }}>
          <section className="flex flex-col gap-1.5"><SectionLabel>Redirect address</SectionLabel><CodeBlock text={catalog.redirectUri} /></section>
          <More label="How to register this app"><Steps items={entry.steps} /></More>
          {entry.fields.map(field => <Field key={field.key} label={field.label} error={errors[field.key]}><Input name={field.key} placeholder={field.placeholder} required={field.required} autoComplete="off" /></Field>)}
          <SecretField name="clientSecret" label="Client secret" saved={catalog.secret.present} error={errors.clientSecret} required />
          <More label="Who may sign in">
            <Field label="Email domains" error={errors.allowedDomains}><Input name="allowedDomains" placeholder="Anyone the product signs in" autoComplete="off" /></Field>
            <Field label="New people join as"><Select name="defaultRole" defaultValue="viewer"><option value="viewer">Viewer</option><option value="member">Member</option></Select></Field>
          </More>
          <Checks checks={checks} />
        </form>
      )}
    </Dialog>
  );
}

// What is set up, in sentences: the product, who gets in, what they become, and whether the secret is where it must be.
export function SsoCard({ current, canEdit, onChange }: { current: SsoCurrent; canEdit: boolean; onChange(): void }) {
  const [checks, setChecks] = useState<Check[]>([]), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const act = async (action: () => Promise<void>) => { setBusy(true); setChecks([]); try { await action(); } catch (failure) { setChecks([{ ok: false, message: failure instanceof ApiError ? failure.message : 'That did not work; try again.' }]); } finally { setBusy(false); } };
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Text weight="semibold">{current.title}</Text>
        <span className="grow" />
        {canEdit && <Button disabled={busy} onClick={() => { void act(async () => setChecks((await api<{ checks: Check[] }>('/api/settings/sso/test', {})).checks)); }}>Test</Button>}
        {canEdit && (
          <Dialog open={confirm} onOpenChange={setConfirm} title="Turn off single sign-on?" description="Passwords and invitations keep working." trigger={<Button variant="danger" disabled={busy}>Turn off</Button>}
            footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Keep it on</Button><Button variant="danger" disabled={busy} onClick={() => { void act(async () => { await api('/api/settings/sso/off', {}); setConfirm(false); onChange(); }); }}>Turn off</Button></>}>
            <Text size="small" tone="soft">Accounts stay as they are.</Text>
          </Dialog>
        )}
      </div>
      <Text size="small" tone="soft">{current.allowedDomains.length ? `Open to ${list(current.allowedDomains)}` : 'Open to anyone it signs in'} · new people join as {current.defaultRole}</Text>
      {!current.secret.present && checks.length === 0 && <StatusLine boxed tone="attention">The client secret is missing. Set it up again to paste it.</StatusLine>}
      <Checks checks={checks} />
    </Card>
  );
}
