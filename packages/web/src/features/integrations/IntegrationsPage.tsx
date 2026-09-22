import { useState } from 'react';
import { api, type ApiError, type Me, type ProjectNode, type ProjectView, type TaskCardData } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, Attachment, PageHeader, Sidebar, SidePanel } from '../../patterns';
import { Button, Card, Chip, Field, SectionLabel, Select, StatusDot, Text, Textarea } from '../../ui';
import { CATEGORY, ConnectFlow } from './ConnectFlow';
import { DeciderSection } from './DeciderSection';
import { ProvidersSection } from './ProvidersSection';

interface Connection { projectScoped: boolean; id: string; kind: string; name: string; category: string; mode: string; status: string; statusDetail: string | null; credentialRef: string | null }
interface Handoff { id: string; source: string; title: string; summary: string; attachmentId: string | null; state: string; direction: string; target: { type: string; key: string | null; title: string | null } | null; result: string | null }
const TONE = { connected: 'working', warning: 'attention', off: 'off' } as const;

// Where a handoff stands, in words: what was done with one that came in, and whether one that went out has come back.
function standing(handoff: Handoff): string {
  if (handoff.direction === 'out') return handoff.state === 'returned' ? 'The result is in' : 'Waiting for a result';
  if (handoff.target?.type === 'task') return `Attached to ${[handoff.target.key, handoff.target.title].filter(Boolean).join(' · ') || 'a task'}`;
  return handoff.state === 'new' ? 'Not placed yet' : 'Handed to the team in the discussion';
}

// One handoff. New work from outside goes to the whole team or onto one task; work the team sent out waits here for its result.
function HandoffCard({ slug, handoff, tasks, onChanged }: { slug: string; handoff: Handoff; tasks: TaskCardData[]; onChanged(): void }) {
  const [mode, setMode] = useState<'attach' | 'result' | null>(null), [taskId, setTaskId] = useState(''), [result, setResult] = useState(''), [problem, setProblem] = useState<string | null>(null);
  const send = (path: string, body: unknown) => { void api(`/api/projects/${slug}/handoffs/${handoff.id}/${path}`, body).then(() => { setMode(null); setProblem(null); onChanged(); }, (error: ApiError) => setProblem(error.message)); };
  const incoming = handoff.direction !== 'out', waiting = !incoming && handoff.state === 'outbox';
  return (
    <Card tone={handoff.state === 'new' || waiting ? 'decision' : 'raised'} pad="sm" className="flex flex-col gap-2">
      <div className="flex items-center gap-2"><Chip>{incoming ? `From ${handoff.source}` : `To ${handoff.source}`}</Chip><Text size="small" weight="semibold" truncate>{handoff.title}</Text></div>
      {handoff.summary && <Text size="small" tone="soft">{handoff.summary}</Text>}
      {handoff.attachmentId && <Attachment id={handoff.attachmentId} />}
      {!incoming && handoff.target?.type === 'task' && <Text size="caption" tone="muted">For {[handoff.target.key, handoff.target.title].filter(Boolean).join(' · ')}</Text>}
      {handoff.result && <Text size="small" tone="soft">Result: {handoff.result}</Text>}
      {handoff.state === 'new' && incoming && mode === null && (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => send('hand', {})}>Hand to team</Button>
          <Button disabled={tasks.length === 0} onClick={() => setMode('attach')}>Attach to a task</Button>
        </div>
      )}
      {mode === 'attach' && (
        <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (taskId) send('attach', { taskId }); }}>
          <Field label="Which task is this for?">
            <Select value={taskId} onChange={event => setTaskId(event.target.value)} required><option value="">Choose a task</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.key} · {task.title}</option>)}</Select>
          </Field>
          <div className="flex gap-2"><Button type="submit" variant="primary" disabled={!taskId}>Attach</Button><Button onClick={() => setMode(null)}>Cancel</Button></div>
        </form>
      )}
      {waiting && mode === null && <div className="flex items-center gap-2"><Chip tone="attention">Waiting for a result</Chip><span className="ml-auto"><Button size="sm" onClick={() => setMode('result')}>Record the result</Button></span></div>}
      {mode === 'result' && (
        <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (result.trim()) send('result', { result: result.trim() }); }}>
          <Field label="What came back?"><Textarea rows={3} maxLength={4000} value={result} onChange={event => setResult(event.target.value)} required /></Field>
          <div className="flex gap-2"><Button type="submit" variant="primary" disabled={!result.trim()}>Save the result</Button><Button onClick={() => setMode(null)}>Cancel</Button></div>
        </form>
      )}
      {!(handoff.state === 'new' && incoming) && !waiting && <Text size="caption" tone="muted">{standing(handoff)}</Text>}
      {problem && <Text size="caption" tone="stop">{problem}</Text>}
    </Card>
  );
}

export function IntegrationsPage({ slug, me, projects }: { slug: string; me: Me; projects: ProjectNode[] }) {
  const view = useResource<{ connections: Connection[]; handoffs: Handoff[]; sync?: { resource: string; lastOkAt: number | null; error: string | null; failingSince: number | null }[] }>(`/api/projects/${slug}/integrations`);
  useStream(event => event.type.startsWith('handoff.') || event.type.startsWith('connection.'), view.reload);
  // The tasks a handoff can be attached to: everything on the project's board that is not finished.
  const board = useResource<ProjectView>(`/api/projects/${slug}`).data?.board;
  const tasks = board ? [...board.in_progress, ...board.review, ...board.backlog] : [];
  const incoming = view.data?.handoffs.filter(handoff => handoff.direction !== 'out') ?? [], outgoing = view.data?.handoffs.filter(handoff => handoff.direction === 'out') ?? [];
  const groups = Object.keys(CATEGORY).map(key => ({ key, items: view.data?.connections.filter(item => item.category === key) ?? [] })).filter(group => group.items.length);
  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={slug} roster={[]} links={[]} />}>
      <PageHeader title="Integrations" crumbs={[{ label: me.org?.name ?? 'Organization', href: '/org' }, { label: projects.flatMap(project => [project, ...project.subprojects]).find(project => project.slug === slug)?.name ?? slug, href: `/p/${slug}` }]}>
        <div className="flex items-center gap-3 pb-3"><span className="grow" /><ConnectFlow slug={slug} connectedKinds={view.data?.connections.map(item => item.kind) ?? []} onDone={view.reload} /></div>
      </PageHeader>
      <div className="flex min-h-0 grow">
        <div className="flex min-w-0 grow flex-col gap-3 overflow-y-auto px-5 py-3.5">
          <ProvidersSection />
          <DeciderSection slug={slug} />
          {groups.map(group => (
            <section key={group.key} className="flex flex-col gap-1.5">
              <SectionLabel>{CATEGORY[group.key]}</SectionLabel>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {group.items.map(item => (
                  <Card key={item.id} tone="raised" pad="sm" className="flex flex-col gap-1">
                    <div className="flex items-center gap-2"><StatusDot tone={TONE[item.status as keyof typeof TONE] ?? 'off'} /><Text weight="semibold">{item.name}</Text><Text size="caption" tone="muted" className="ml-auto whitespace-nowrap">{item.mode}</Text></div>
                    <div className="flex items-center gap-2"><Text size="caption" tone="muted" truncate className="grow">{item.statusDetail ?? ''}</Text>{item.projectScoped && <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Remove ${item.name}?`)) void api(`/api/projects/${slug}/integrations/${item.id}/remove`, {}).then(view.reload); }}>Remove</Button>}</div>
                  </Card>
                ))}
              </div>
            </section>
          ))}
          {view.data?.sync?.map(row => <Text key={row.resource} size="caption" tone="muted">{row.resource}: {row.failingSince ? `failing since ${new Date(row.failingSince).toLocaleString()} (${row.error ?? "unknown"})` : row.lastOkAt ? `last synced ${new Date(row.lastOkAt).toLocaleString()}` : "not synced yet"}</Text>)}
          {groups.length === 0 && <Text size="small" tone="muted">Nothing else is connected yet. Start with the code and the task board.</Text>}
        </div>
        <SidePanel label="Handoffs" side="right" wide>
          <div className="flex flex-col gap-2.5 px-1.5">
            <SectionLabel>Handoffs</SectionLabel>
            {incoming.map(handoff => <HandoffCard key={handoff.id} slug={slug} handoff={handoff} tasks={tasks} onChanged={view.reload} />)}
            {view.data && incoming.length === 0 && <Text size="small" tone="muted">Nothing handed over yet.</Text>}
            {outgoing.length > 0 && <SectionLabel>Sent out by the team</SectionLabel>}
            {outgoing.map(handoff => <HandoffCard key={handoff.id} slug={slug} handoff={handoff} tasks={tasks} onChanged={view.reload} />)}
          </div>
        </SidePanel>
      </div>
    </AppShell>
  );
}
