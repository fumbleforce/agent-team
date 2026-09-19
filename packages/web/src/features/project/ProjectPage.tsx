import { useEffect, useRef } from 'react';
import { api, postToThread, uploadImage, type Me, type Message as MessageData, type ProjectNode, type ProjectView } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, BoardColumn, Composer, mentionOptions, Message, PageHeader, RailHeader, resolveAuthor, Sidebar } from '../../patterns';
import { Tabs, Text } from '../../ui';
import { useLocation } from 'wouter';
import { ChecksTab } from './ChecksTab';
import { IssuesTab } from './IssuesTab';
import { ProductTab } from './ProductTab';
import { KnowledgeTab } from './KnowledgeTab';
import { TeamTab } from './TeamTab';
import { TeamExtras } from '../org/TeamExtras';
import { MilestoneStrip } from '../settings/ProjectSettingsPage';
import { WorkloadTab } from './WorkloadTab';

const COLUMNS = [
  { key: 'backlog', name: 'Backlog', tone: 'off' },
  { key: 'in_progress', name: 'In progress', tone: 'working' },
  { key: 'review', name: 'Review', tone: 'review' },
  { key: 'done', name: 'Done', tone: 'idle' },
] as const;
const TABS = ['Tasks', 'Issues', 'Product', 'Tests', 'Workload', 'Knowledge', 'Team'];
const links = (slug: string) => [{ href: '/proposals', label: 'Team proposals' }, { href: '/costs', label: 'Costs' }, { href: `/p/${slug}/integrations`, label: 'Integrations' }, { href: '/roles', label: 'Roles' }, { href: `/settings/project/${slug}`, label: 'Project settings' }];

function Discussion({ threadId, view, me }: { threadId: string; view: ProjectView; me: Me }) {
  const thread = useResource<{ messages: MessageData[] }>(`/api/threads/${threadId}/messages`);
  useStream(event => event.type === 'message.posted' && event.threadId === threadId, thread.reload);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [thread.data?.messages.length]);
  return (
    <>
      <RailHeader title="Discussion" note={`#${view.project.slug}`} live />
      <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-4 py-3.5">
        {thread.data?.messages.map(message => <Message key={message.id} message={message} author={resolveAuthor(message, view.roster, me.user)} />)}
        <div ref={end} />
      </div>
      <Composer placeholder="Raise an issue or suggestion — the team will pick it up and discuss…" action="Send to team" mentions={mentionOptions(view.roster)} onAttach={uploadImage} onSend={(body, images) => postToThread(threadId, body, images)} />
    </>
  );
}

export function ProjectPage({ slug, tab, pageId = null, me, projects }: { slug: string; tab: string; pageId?: string | null; me: Me; projects: ProjectNode[] }) {
  const [, navigate] = useLocation();
  const view = useResource<ProjectView>(`/api/projects/${slug}`);
  useStream(event => event.type.startsWith('task.') && event.projectId === view.data?.project.id, view.reload);
  const data = view.data;
  const root = projects.find(project => project.slug === slug || project.subprojects.some(sub => sub.slug === slug));

  const sidebar = <Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={slug} roster={data?.roster ?? []} teamName={root?.team?.name ?? null} links={links(slug)} />;
  if (!data) return <AppShell sidebar={sidebar}><div className="p-5"><Text tone="muted">{view.error ? view.error.message : 'Loading…'}</Text></div></AppShell>;

  return (
    <AppShell sidebar={sidebar} rail={tab === 'tasks' && data.discussionThreadId ? <Discussion threadId={data.discussionThreadId} view={data} me={me} /> : undefined}>
      <PageHeader title={data.project.name} crumbs={[{ label: me.org?.name ?? 'Organization', href: '/org' }, ...(data.project.parent ? [{ label: data.project.parent.name, href: `/p/${data.project.parent.slug}` }] : [])]}>
        <MilestoneStrip slug={slug} />
        <Tabs items={TABS.map(label => ({ label, href: `/p/${slug}/${label.toLowerCase()}`, active: label.toLowerCase() === tab }))} />
      </PageHeader>
      {tab === 'tasks'
        ? <div className="grid min-h-0 grow grid-cols-1 gap-3 overflow-y-auto px-5 pt-4 pb-5 sm:grid-cols-2 xl:grid-cols-4">{COLUMNS.map(column => <BoardColumn key={column.key} name={column.name} tone={column.tone} tasks={data.board[column.key]} roster={data.roster} onAssign={(taskId, agentId) => { void api(`/api/tasks/${taskId}/assign`, { agentId }).then(view.reload); }} />)}</div>
        : tab === 'knowledge' ? <KnowledgeTab slug={slug} pageId={pageId} />
        : tab === 'issues' ? <IssuesTab slug={slug} number={pageId ? Number(pageId) : null} roster={data.roster} me={me} navigate={navigate} />
        : tab === 'product' ? <ProductTab slug={slug} navigate={navigate} />
        : tab === 'tests' ? <ChecksTab slug={slug} />
        : tab === 'workload' ? <WorkloadTab slug={slug} />
        : tab === 'team' ? <TeamTab roster={data.roster} teamName={root?.team?.name ?? null} onChanged={view.reload}><TeamExtras slug={slug} roster={data.roster} onChanged={view.reload} /></TeamTab>
        : <div className="p-5"><Text tone="muted">This view arrives in a later phase of docs/SPEC.md.</Text></div>}
    </AppShell>
  );
}
