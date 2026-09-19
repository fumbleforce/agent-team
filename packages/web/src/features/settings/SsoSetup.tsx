import { useState } from 'react';
import { api, ApiError } from '../../data/client';
import { ChoiceCard, StatusLine, Steps } from '../../patterns';
import { Button, Card, CodeBlock, Dialog, Field, Input, SectionLabel, Select, Text } from '../../ui';

interface SetupField { key: string; label: string; placeholder?: string; help?: string; required?: boolean }
interface Secret { variable: string; present: boolean }
interface Check { ok: boolean; message: string }
export interface SsoEntry { kind: string; title: string; summary: string; steps: string[]; fields: SetupField[] }
export interface SsoCurrent { kind: string; title: string; allowedDomains: string[]; defaultRole: 'viewer' | 'member'; secret: Secret }
export interface SsoCatalog { entries: SsoEntry[]; redirectUri: string; secret: Secret; canEdit: boolean; current: SsoCurrent | null }

const ROLE = { viewer: 'a viewer, who can read everything they are given but change nothing', member: 'a member, who can work in the projects they are given' } as const;
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);
const Checks = ({ checks }: { checks: Check[] }) => <>{checks.map(check => <StatusLine key={check.message} boxed tone={check.ok ? 'working' : 'stop'}>{check.message}</StatusLine>)}</>;

// Pick the product people sign in with, follow its own console's steps, check that the sign-in service answers, turn it on.
// The client secret is never typed here: the steps say which variable to set on the coordinator, and the check says whether it is there.
export function SsoSetupFlow({ catalog, onDone }: { catalog: SsoCatalog; onDone(): void }) {
  const [open, setOpen] = useState(false), [entry, setEntry] = useState<SsoEntry | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({}), [checks, setChecks] = useState<Check[]>([]), [busy, setBusy] = useState(false);
  const pick = (next: SsoEntry | null) => { setEntry(next); setErrors({}); setChecks([]); };

  async function send(action: 'test' | 'setup', form: HTMLFormElement) {
    if (!entry) return;
    const data = new FormData(form), values = Object.fromEntries(entry.fields.map(field => [field.key, String(data.get(field.key) ?? '')]));
    setBusy(true); setErrors({}); setChecks([]);
    try {
      const result = await api<{ ok: boolean; checks?: Check[] }>(`/api/settings/sso/${action}`, { kind: entry.kind, values, allowedDomains: String(data.get('allowedDomains') ?? ''), defaultRole: data.get('defaultRole') });
      if (action === 'test') setChecks(result.checks ?? []);
      else { setOpen(false); pick(null); onDone(); }
    } catch (failure) {
      if (failure instanceof ApiError && Object.keys(failure.fields).length) setErrors(failure.fields);
      else setChecks([{ ok: false, message: failure instanceof ApiError ? failure.message : 'That did not work; try again.' }]);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={next => { setOpen(next); if (!next) pick(null); }} title={entry ? entry.title : 'Set up single sign-on'} description={entry ? entry.summary : 'Pick what your people already sign in with. Each one walks you through its setup.'} trigger={<Button variant="primary">Set up single sign-on</Button>}
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
          <section className="flex flex-col gap-1.5">
            <SectionLabel>The redirect address</SectionLabel>
            <Text size="small" tone="muted">Where people are sent back to after signing in. You paste it in one of the steps below.</Text>
            <CodeBlock text={catalog.redirectUri} />
          </section>
          <section className="flex flex-col gap-2"><SectionLabel>Register this app</SectionLabel><Steps items={entry.steps} /></section>
          <StatusLine boxed tone={catalog.secret.present ? 'working' : 'attention'}>{catalog.secret.present ? `${catalog.secret.variable} is set on the coordinator.` : `${catalog.secret.variable} is not set on the coordinator yet. You can turn this on now; signing in starts working once the variable is set and the coordinator restarted.`}</StatusLine>
          <section className="flex flex-col gap-3">
            <SectionLabel>What you copied</SectionLabel>
            {entry.fields.map(field => <Field key={field.key} label={field.label} help={field.help} error={errors[field.key]}><Input name={field.key} placeholder={field.placeholder} required={field.required} autoComplete="off" /></Field>)}
          </section>
          <section className="flex flex-col gap-3">
            <SectionLabel>Who may sign in</SectionLabel>
            <Field label="Email domains (optional)" help="Only people with an address at these domains get in. Separate several with commas. Leave empty for anyone the product signs in." error={errors.allowedDomains}><Input name="allowedDomains" placeholder="example.com, example.org" autoComplete="off" /></Field>
            <Field label="A person who signs in for the first time joins as" help="People you invited keep the role you gave them."><Select name="defaultRole" defaultValue="viewer"><option value="viewer">Viewer: reads, changes nothing</option><option value="member">Member: works in the projects they are given</option></Select></Field>
          </section>
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
          <Dialog open={confirm} onOpenChange={setConfirm} title="Turn off single sign-on?" description={`Nobody can sign in with ${current.title} until it is set up again. Passwords and invitations keep working.`} trigger={<Button variant="danger" disabled={busy}>Turn off</Button>}
            footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Keep it on</Button><Button variant="danger" disabled={busy} onClick={() => { void act(async () => { await api('/api/settings/sso/off', {}); setConfirm(false); onChange(); }); }}>Turn off</Button></>}>
            <Text size="small" tone="soft">The accounts of people who signed in this way stay as they are, and they get in again once it is set up again.</Text>
          </Dialog>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <Text size="small" tone="soft">{current.allowedDomains.length ? `Anyone with a verified email address at ${list(current.allowedDomains)} may sign in.` : 'Anyone it signs in with a verified email address may sign in.'}</Text>
        <Text size="small" tone="soft">A person who signs in for the first time joins as {ROLE[current.defaultRole]}. People you invited keep the role you gave them.</Text>
      </div>
      {!current.secret.present && checks.length === 0 && <StatusLine boxed tone="attention">{current.secret.variable} is not set on the coordinator yet. Set it to the client secret and restart the coordinator; until then signing in this way fails.</StatusLine>}
      <Checks checks={checks} />
    </Card>
  );
}
