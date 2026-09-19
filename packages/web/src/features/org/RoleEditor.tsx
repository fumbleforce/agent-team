import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../data/client';
import { Button, Field, Input, Select, Text, Textarea } from '../../ui';

export interface EditableRole { slug: string; version: number; doc: { summary: string; perspective: string; permissions: Record<string, unknown>; [key: string]: unknown } }

const LEVELS = { shell: ['none', 'restricted', 'full'], browser: ['none', 'allowed'], issues: ['none', 'comment', 'edit'], comms: ['none', 'mirror', 'post'], deploy: ['none', 'allowed'] } as const;
const scopeText = (value: unknown) => (typeof value === 'string' ? value : ((value as { paths?: string[] } | undefined)?.paths ?? []).join(', '));
// "all", "none", or a comma-separated list of paths.
const scopeValue = (text: string) => { const clean = text.trim(); return clean === 'all' || clean === 'none' || clean === '' ? (clean || 'none') : { paths: clean.split(',').map(item => item.trim()).filter(Boolean) }; };

export function RoleEditor({ role, onSaved, onCancel }: { role: EditableRole; onSaved(): void; onCancel(): void }) {
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const permissions = { ...role.doc.permissions, repoRead: scopeValue(String(form.get('repoRead'))), codeWrite: scopeValue(String(form.get('codeWrite'))), spendDailyCapMinor: Math.round(Number(form.get('spend')) * 100), ...Object.fromEntries(Object.keys(LEVELS).map(key => [key, form.get(key)])) };
    try {
      // The version guards against overwriting someone else's edit.
      await api(`/api/roles/${role.slug}`, { doc: { ...role.doc, summary: form.get('summary'), perspective: form.get('perspective'), permissions }, note: form.get('note') || undefined, expectedVersion: role.version });
      onSaved();
    } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'Saving failed'); }
  };
  return (
    <form onSubmit={submit} className="flex max-w-180 flex-col gap-3.5">
      <Field label="Summary"><Input name="summary" defaultValue={role.doc.summary} required maxLength={200} /></Field>
      <Field label="Perspective: what this role looks for"><Textarea name="perspective" rows={3} defaultValue={role.doc.perspective} maxLength={800} /></Field>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Read repository: all, none, or paths"><Input name="repoRead" defaultValue={scopeText(role.doc.permissions.repoRead)} /></Field>
        <Field label="Write code: all, none, or paths"><Input name="codeWrite" defaultValue={scopeText(role.doc.permissions.codeWrite)} /></Field>
        {Object.entries(LEVELS).map(([key, levels]) => <Field key={key} label={key}><Select name={key} defaultValue={String(role.doc.permissions[key] ?? 'none')}>{levels.map(level => <option key={level}>{level}</option>)}</Select></Field>)}
        <Field label="Spend per day"><Input name="spend" type="number" min={0} step="0.5" defaultValue={Number(role.doc.permissions.spendDailyCapMinor ?? 0) / 100} /></Field>
      </div>
      <Field label="Note for the history"><Input name="note" maxLength={200} /></Field>
      {error && <Text size="small" tone="stop">{error}</Text>}
      <div className="flex gap-1.5"><Button variant="primary" type="submit">Save as version {role.version + 1}</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
