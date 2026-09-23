import { useState } from 'react';
import { api, ApiError } from '../../data/client';
import { useResource } from '../../data/useResource';
import { More, SecretField, StatusLine, Steps } from '../../patterns';
import { Button, Card, Field, Input, Select, Text } from '../../ui';

interface SetupField { key: string; label: string; placeholder?: string; help?: string; required?: boolean; suggestion?: string }
interface Entry { kind: string; title: string; summary: string; steps: string[]; fields: SetupField[]; credential: { variable: string; label: string; optional: boolean; placeholder?: string } | null }
interface View { canEdit: boolean; entries: Entry[]; current: { kind: string; values: Record<string, string>; summaryHour: number } | null; tokenSaved: boolean; error: string | null }

// How the owner hears of what lands here when they are not looking: set up once, tested with one message, changed or turned off here.
export function ReachMe() {
  const view = useResource<View>('/api/settings/notify');
  const [editing, setEditing] = useState(false), [errors, setErrors] = useState<Record<string, string>>({}), [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null), [busy, setBusy] = useState(false);
  const data = view.data;
  if (!data) return null;
  const entry = data.entries.find(item => item.kind === (data.current?.kind ?? data.entries[0]?.kind)) ?? null;
  const test = async () => { setBusy(true); try { setCheck(await api<{ ok: boolean; message: string }>('/api/settings/notify/test', {})); } finally { setBusy(false); } };
  const save = async (form: FormData) => {
    if (!entry) return;
    setBusy(true); setErrors({}); setCheck(null);
    try {
      await api('/api/settings/notify', { kind: entry.kind, values: Object.fromEntries(entry.fields.map(field => [field.key, String(form.get(field.key) ?? '')])), ...(form.get('token') ? { token: String(form.get('token')) } : {}), summaryHour: Number(form.get('summaryHour') ?? 8) });
      setEditing(false); view.reload(); await test();
    } catch (problem) { if (problem instanceof ApiError && Object.keys(problem.fields).length) setErrors(problem.fields as Record<string, string>); else setCheck({ ok: false, message: problem instanceof ApiError ? problem.message : 'That did not work; try again.' }); }
    finally { setBusy(false); }
  };

  if (data.current && !editing) return (
    <Card tone="raised" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2"><span className="grow"><StatusLine tone={data.error ? 'stop' : 'working'}>{data.error ? `Messages are not getting through: ${data.error}` : `You are told through ${entry?.title ?? data.current.kind} when something lands here, with a summary of the day at ${data.current.summaryHour}:00.`}</StatusLine></span>
        {data.canEdit && <><Button size="sm" disabled={busy} onClick={() => { void test(); }}>Send a test</Button><Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Change</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { void api('/api/settings/notify/off', {}).then(view.reload); }}>Turn off</Button></>}</div>
      {check && <Text size="small" tone={check.ok ? 'muted' : 'stop'}>{check.message}</Text>}
    </Card>
  );
  if (!data.canEdit || !entry) return null;
  if (!editing) return (
    <Card tone="raised" className="flex flex-wrap items-center gap-2">
      <Text size="small" tone="muted" className="grow">Nothing tells you when something lands here while you are away.</Text>
      <Button size="sm" variant="primary" onClick={() => setEditing(true)}>Get told on your phone</Button>
    </Card>
  );
  return (
    <Card tone="raised">
      <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void save(new FormData(event.currentTarget)); }}>
        <Text weight="semibold">{entry.title}</Text>
        <Text size="small" tone="muted">{entry.summary}</Text>
        {entry.fields.map(field => <Field key={field.key} label={field.label} help={field.help} error={errors[field.key]}><Input name={field.key} required={field.required} placeholder={field.placeholder} defaultValue={data.current?.values[field.key] ?? field.suggestion ?? (field.key === 'server' ? field.placeholder : '')} /></Field>)}
        {entry.credential && <SecretField name="token" label={`${entry.credential.label}${entry.credential.optional ? ' (only for a server of your own)' : ''}`} saved={data.tokenSaved} placeholder={entry.credential.placeholder} error={errors.token} />}
        <Field label="A summary of the day at"><Select name="summaryHour" defaultValue={String(data.current?.summaryHour ?? 8)}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{`${hour}:00`}</option>)}</Select></Field>
        <More label="How to set it up"><Steps items={entry.steps} /></More>
        <div className="flex flex-wrap items-center gap-2"><Button type="submit" variant="primary" disabled={busy}>Save and send a test</Button><Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
        {check && <Text size="small" tone={check.ok ? 'muted' : 'stop'}>{check.message}</Text>}
      </form>
    </Card>
  );
}
