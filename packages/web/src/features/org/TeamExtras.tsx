import { useState } from 'react';
import { api, type Agent } from '../../data/client';
import { useResource } from '../../data/useResource';
import { Avatar, Button, Card, Chip, Field, Input, ListRow, SectionLabel, Select, Text, Textarea } from '../../ui';
import { ActionError, useAction, useCreateKey } from './OrgShell';
import type { SeatLoan } from './Structure';

interface Seat { name: string; title: string; roles: string[]; isPm?: boolean }
interface Stored<T> { slug: string; version: number; author: string; doc: T }
type Template = Stored<{ name: string; summary: string; seats: Seat[] }>;
type LibraryAgent = Stored<Seat & { summary: string; persona: string }>;
interface Loans { borrowed: SeatLoan[]; lent: SeatLoan[]; targets: { id: string; name: string }[]; canEdit: boolean }

// The Team tab's organization side: seats on loan, hiring from the library, and team templates (save, create from, import, export).
export function TeamExtras({ slug, roster, onChanged }: { slug: string; roster: Agent[]; onChanged(): void }) {
  const loans = useResource<Loans>(`/api/projects/${slug}/loans`);
  const templates = useResource<{ items: Template[] }>('/api/templates');
  const library = useResource<{ items: LibraryAgent[] }>('/api/library/agents');
  const lend = useAction(), hire = useAction(), save = useAction(), stamp = useAction(), bring = useAction();
  const lendKey = useCreateKey(), hireKey = useCreateKey(), stampKey = useCreateKey();
  const [importing, setImporting] = useState(false);
  const canEdit = loans.data?.canEdit === true;
  const changed = () => { loans.reload(); onChanged(); };

  return (
    <>
      {(canEdit || (loans.data && loans.data.borrowed.length + loans.data.lent.length > 0)) && (
        <section className="flex flex-col gap-2">
          <SectionLabel>Seats on loan</SectionLabel>
          {[...(loans.data?.borrowed ?? []), ...(loans.data?.lent ?? [])].map(loan => (
            <Card key={loan.id} tone="raised" pad="sm" className="flex items-center gap-3">
              <Avatar initials={loan.agent.initials} tint={loan.agent.tint} />
              <span className="flex min-w-0 grow flex-col"><Text weight="semibold">{loan.agent.name}</Text><Text size="caption" tone="muted">{loan.agent.title}{loan.note ? ` · ${loan.note}` : ''}</Text></span>
              <Chip tone="review">{loans.data?.borrowed.includes(loan) ? `on loan from ${loan.from.name}` : `lent to ${loan.to.name}`}</Chip>
              {canEdit && <Button size="sm" onClick={() => { void lend.run(() => api(`/api/loans/${loan.id}/end`, {})).then(changed); }}>End loan</Button>}
            </Card>
          ))}
          {canEdit && roster.length > 0 && (loans.data?.targets.length ?? 0) > 0 && (
            <form className="flex flex-wrap items-end gap-2.5" onSubmit={lend.submit(async form => { await api(`/api/agents/${String(form.get('agent'))}/loans`, { toProjectId: form.get('to'), note: form.get('note') ?? '' }, lendKey.headers()); lendKey.renew(); changed(); })}>
              <Field label="Lend"><Select name="agent">{roster.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></Field>
              <Field label="To project" error={lend.error?.fields.toProjectId}><Select name="to">{loans.data?.targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</Select></Field>
              <Field label="Note"><Input name="note" maxLength={200} placeholder="until the release" /></Field>
              <Button type="submit" disabled={lend.busy}>Lend seat</Button>
            </form>
          )}
          <ActionError error={lend.error} />
        </section>
      )}

      {canEdit && (
        <section className="flex flex-col gap-2">
          <SectionLabel>Hire from the library</SectionLabel>
          {library.data?.items.length === 0 && <Text size="small" tone="muted">The library is empty. An organization admin adds agents to it under Organization → Agent library.</Text>}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {library.data?.items.map(item => (
              <Card key={item.slug} tone="raised" pad="sm" className="flex items-center gap-2.5">
                <span className="flex min-w-0 grow flex-col"><Text weight="semibold">{item.doc.name}</Text><Text size="caption" tone="muted" truncate>{item.doc.title || item.doc.summary}{item.doc.roles.some(role => role.toLowerCase() !== (item.doc.title ?? '').toLowerCase()) ? ` · also ${item.doc.roles.filter(role => role.toLowerCase() !== (item.doc.title ?? '').toLowerCase()).join(', ')}` : ''}</Text></span>
                <Button size="sm" disabled={hire.busy} onClick={() => { void hire.run(() => api(`/api/projects/${slug}/team/hire`, { library: item.slug }, hireKey.headers())).then(ok => { if (ok) { hireKey.renew(); onChanged(); } }); }}>Hire</Button>
              </Card>
            ))}
          </div>
          <ActionError error={hire.error} />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <SectionLabel aside={canEdit ? <Button size="sm" variant="ghost" onClick={() => setImporting(value => !value)}>{importing ? 'Close import' : 'Import JSON'}</Button> : undefined}>Team templates</SectionLabel>
        {templates.data?.items.map(template => (
          <ListRow key={template.slug} title={template.doc.name} note={`${template.slug} · v${template.version} · ${template.doc.seats.length} seat${template.doc.seats.length === 1 ? '' : 's'} · ${template.doc.seats.map(seat => seat.title || seat.name).join(', ')}`}
            aside={<span className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => window.location.assign(`/api/templates/${template.slug}/export`)}>Export</Button>
              {canEdit && <Button size="sm" disabled={stamp.busy} onClick={() => { void stamp.run(() => api(`/api/projects/${slug}/team/from-template`, { template: template.slug, mode: roster.length ? 'append' : 'create' }, stampKey.headers())).then(ok => { if (ok) { stampKey.renew(); onChanged(); } }); }}>{roster.length ? 'Add these seats' : 'Create team'}</Button>}
            </span>} />
        ))}
        {templates.data?.items.length === 0 && <Text size="small" tone="muted">No templates yet. Save this team as the first one.</Text>}
        <ActionError error={stamp.error} />
        {canEdit && roster.length > 0 && (
          <form className="flex flex-wrap items-end gap-2.5" onSubmit={save.submit(async form => { await api(`/api/projects/${slug}/team/save-template`, { slug: String(form.get('name') ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40), name: form.get('name') }); templates.reload(); })}>
            <Field label="Template name"><Input name="name" required maxLength={80} placeholder="Product team" /></Field>
            <Button type="submit" disabled={save.busy}>Save this team as a template</Button>
          </form>
        )}
        <ActionError error={save.error} />
        {canEdit && importing && (
          <form className="flex flex-col gap-2.5" onSubmit={bring.submit(async form => {
            const parsed = JSON.parse(String(form.get('json'))) as { slug?: string; doc?: unknown };
            await api(`/api/templates/${String(form.get('slug') || parsed.slug || '')}`, { doc: parsed.doc ?? parsed, note: 'Imported' });
            templates.reload(); setImporting(false);
          })}>
            <Field label="Exported template (JSON)"><Textarea name="json" required rows={6} /></Field>
            <div className="flex flex-wrap items-end gap-2.5"><Field label="Save it under another name (optional)" help="Leave empty to keep the name in the file."><Input name="slug" pattern="[a-z0-9][a-z0-9-]*" placeholder="product-team" /></Field><Button type="submit" disabled={bring.busy}>Import</Button></div>
            <ActionError error={bring.error} />
          </form>
        )}
      </section>
    </>
  );
}
