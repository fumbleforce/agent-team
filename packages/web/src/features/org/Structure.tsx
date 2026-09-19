import { api, type Me, type ProjectNode } from '../../data/client';
import { Avatar, Button, Card, Chip, Field, Input, Select, Text } from '../../ui';
import { ActionError, isOrgAdmin, useAction, useCreateKey } from './OrgShell';

export interface ProjectLink { id: string; fromProjectId: string; toProjectId: string; kind: string; note: string }
export interface SeatLoan { id: string; note: string; since: number; agent: { id: string; name: string; initials: string; tint: string; title: string }; from: { id: string; name: string }; to: { id: string; name: string; slug: string } }
export interface Structure { links: ProjectLink[]; loans: SeatLoan[] }

const OUT = { depends_on: 'depends on', blocks: 'blocks', relates_to: 'relates to' } as const;
const IN = { depends_on: 'needed by', blocks: 'blocked by', relates_to: 'relates to' } as const;
const phrase = (words: Record<string, string>, kind: string) => words[kind] ?? kind;

// What ties one project to the others: its cross-project links and the seats it lends or borrows.
export function ProjectStructure({ projectId, projects, structure, onChanged }: { projectId: string; projects: ProjectNode[]; structure: Structure | null; onChanged(): void }) {
  const name = (id: string) => projects.find(project => project.id === id)?.name ?? 'another project';
  const links = structure?.links.filter(link => link.fromProjectId === projectId || link.toProjectId === projectId) ?? [];
  const loans = structure?.loans.filter(loan => loan.from.id === projectId || loan.to.id === projectId) ?? [];
  if (links.length === 0 && loans.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {links.map(link => {
        const outgoing = link.fromProjectId === projectId;
        return (
          <div key={link.id} className="flex items-center gap-1.5">
            <Chip tone={link.kind === 'relates_to' ? 'neutral' : outgoing ? 'attention' : 'review'}>{phrase(outgoing ? OUT : IN, link.kind)}</Chip>
            <Text size="small" truncate>{name(outgoing ? link.toProjectId : link.fromProjectId)}</Text>
            {link.note && <Text size="caption" tone="muted" truncate>{link.note}</Text>}
            {outgoing && <span className="ml-auto"><Button size="sm" variant="ghost" aria-label={`Remove the link to ${name(link.toProjectId)}`} onClick={() => { void api(`/api/org/links/${link.id}/delete`, {}).then(onChanged, () => undefined); }}>Remove</Button></span>}
          </div>
        );
      })}
      {loans.map(loan => (
        <div key={loan.id} className="flex items-center gap-1.5">
          <Avatar initials={loan.agent.initials} tint={loan.agent.tint} size="xs" />
          <Text size="small" truncate>{loan.agent.name}</Text>
          <Text size="caption" tone="muted" truncate>{loan.from.id === projectId ? `lent to ${loan.to.name}` : `on loan from ${loan.from.name}`}</Text>
        </div>
      ))}
    </div>
  );
}

// Organization admins draw the dependencies between projects here; a project's own admins can do it from the API.
export function LinkForm({ me, projects, onChanged }: { me: Me; projects: ProjectNode[]; onChanged(): void }) {
  const action = useAction(), key = useCreateKey();
  if (!isOrgAdmin(me) || projects.length < 2) return null;
  const options = projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>);
  return (
    <Card tone="outline" pad="sm" className="mx-5 mt-4 flex flex-col gap-2">
      <form className="flex flex-wrap items-end gap-2.5" onSubmit={action.submit(async form => { await api('/api/org/links', { fromProjectId: form.get('from'), toProjectId: form.get('to'), kind: form.get('kind'), note: form.get('note') ?? '' }, key.headers()); key.renew(); onChanged(); })}>
        <Field label="Project"><Select name="from">{options}</Select></Field>
        <Field label="Link"><Select name="kind"><option value="depends_on">depends on</option><option value="blocks">blocks</option><option value="relates_to">relates to</option></Select></Field>
        <Field label="Other project" error={action.error?.fields.toProjectId}><Select name="to" defaultValue={projects[1]?.id}>{options}</Select></Field>
        <Field label="Why"><Input name="note" maxLength={200} placeholder="needs the new checkout API" /></Field>
        <Button type="submit" disabled={action.busy}>Link projects</Button>
      </form>
      <ActionError error={action.error} />
    </Card>
  );
}
