import { useEffect, useRef, useState } from 'react';
import { api, postToThread, uploadImage, type Me, type ProjectNode, type ProjectView, type ThreadMessagesView } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, BoardColumn, Composer, mentionOptions, Message, PageHeader, RailHeader, resolveAuthor, Sidebar } from '../../patterns';
import { Button, Dialog, Segmented, Tabs, Text } from '../../ui';
import { useLocation } from 'wouter';
import { ChecksTab } from './ChecksTab';
import { Feed } from './Feed';
import { IssueRedirect, RaiseIssue } from './IssuesTab';
import { ProductTab } from './ProductTab';
import { KnowledgeTab } from './KnowledgeTab';
import { FrontDesk } from '../desk/FrontDesk';
import { TaskPage } from './TaskPage';
import { TeamTab } from './TeamTab';
import { TeamExtras } from '../org/TeamExtras';
import { MilestoneStrip } from '../settings/ProjectSettingsPage';
import { WorkloadTab } from './WorkloadTab';

const COLUMNS = [
  { key: 'inbox', name: 'Inbox', tone: 'attention' },
  { key: 'backlog', name: 'Backlog', tone: 'off' },
  { key: 'in_progress', name: 'In progress', tone: 'working' },
  { key: 'review', name: 'Review', tone: 'review' },
  { key: 'done', name: 'Done', tone: 'idle' },
] as const;
// A project that is not code has checks rather than tests: the same page under the word its team uses.
const tabsFor = (kind: string) => ['Tasks', 'Product', kind === 'repo' ? 'Tests' : 'Checks', 'Workload', 'Knowledge', 'Team'];
const links = (slug: string) => [{ href: '/proposals', label: 'Team proposals' }, { href: '/costs', label: 'Costs' }, { href: `/p/${slug}/integrations`, label: 'Integrations' }, { href: '/roles', label: 'Roles' }, { href: `/settings/project/${slug}`, label: 'Project settings' }];

function Discussion({ threadId, view, me }: { threadId: string; view: ProjectView; me: Me }) {
  const thread = useResource<ThreadMessagesView>(`/api/threads/${threadId}/messages`);
  useStream(event => event.type === 'message.posted' && event.threadId === threadId, thread.reload);
  const end = useRef<HTMLDivElement>(null);
  // The rail shows what people and agents say, or what the agents are doing; the choice is remembered.
  const [showing, setShowing] = useState<'discussion' | 'feed'>(() => { try { return localStorage.getItem('rail') === 'feed' ? 'feed' : 'discussion'; } catch { return 'discussion'; } });
  const show = (next: 'discussion' | 'feed') => { setShowing(next); try { localStorage.setItem('rail', next); } catch { /* a convenience only */ } };
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [thread.data?.messages.length, showing]);
  const toggle = <Segmented options={[{ value: 'discussion', label: 'Discussion' }, { value: 'feed', label: 'Live feed' }]} value={showing} onChange={show} />;
  if (showing === 'feed') return <><RailHeader title="Team" aside={toggle} /><Feed slug={view.project.slug} /></>;
  return (
    <>
      <RailHeader title="Team" aside={toggle} />
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
  const [raising, setRaising] = useState(false);
  useStream(event => (event.type.startsWith('task.') || event.type.startsWith('issue.')) && event.projectId === view.data?.project.id, view.reload);
  const data = view.data;
  const root = projects.find(project => project.slug === slug || project.subprojects.some(sub => sub.slug === slug));

  const sidebar = <Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={slug} roster={data?.roster ?? []} teamName={root?.team?.name ?? null} links={links(slug)} />;
  if (!data) return <AppShell sidebar={sidebar}><div className="p-5"><Text tone="muted">{view.error ? view.error.message : 'Loading…'}</Text></div></AppShell>;

  // Either address of the checks page lights the tab this project shows.
  const shown = tab === 'tests' || tab === 'checks' ? (data.project.kind === 'repo' ? 'tests' : 'checks') : tab;

  return (
    <AppShell sidebar={sidebar} rail={tab === 'tasks' && !pageId && data.discussionThreadId ? <Discussion threadId={data.discussionThreadId} view={data} me={me} /> : undefined}>
      <PageHeader title={data.project.name} aside={<FrontDesk slug={slug} />} crumbs={[{ label: me.org?.name ?? 'Organization', href: '/org' }, ...(data.project.parent ? [{ label: data.project.parent.name, href: `/p/${data.project.parent.slug}` }] : [])]}>
        <MilestoneStrip slug={slug} />
        <Tabs items={[...tabsFor(data.project.kind).map(label => ({ label, href: `/p/${slug}/${label.toLowerCase()}`, active: label.toLowerCase() === shown })), ...(data.customTabs ?? []).map(item => ({ label: item.label, href: item.url, external: true }))]} />
      </PageHeader>
      {tab === 'tasks' && pageId
        ? <TaskPage key={pageId} slug={slug} taskId={pageId} roster={data.roster} board={COLUMNS.flatMap(column => data.board[column.key])} navigate={navigate} />
        : tab === 'tasks'
        ? <div className="grid min-h-0 grow grid-cols-1 gap-3 overflow-y-auto px-5 pt-4 pb-5 sm:grid-cols-2 xl:grid-cols-5">{COLUMNS.map(column => <BoardColumn key={column.key} name={column.name} tone={column.tone} tasks={data.board[column.key]} roster={data.roster} hrefOf={taskId => `/p/${slug}/tasks/${taskId}`} aside={column.key === 'inbox' ? <Button size="sm" variant="ghost" onClick={() => setRaising(true)}>+ Raise</Button> : undefined} onAssign={(taskId, agentId) => { void api(`/api/tasks/${taskId}/assign`, { agentId }).then(view.reload); }} />)}<Dialog open={raising} onOpenChange={setRaising} title="Raise something"><RaiseIssue slug={slug} onRaised={raised => { setRaising(false); view.reload(); navigate(`/p/${slug}/tasks/${raised}`); }} /></Dialog></div>
        : tab === 'knowledge' ? <KnowledgeTab slug={slug} pageId={pageId} />
        : tab === 'issues' ? <IssueRedirect slug={slug} number={pageId ? Number(pageId) : null} navigate={navigate} />
        : tab === 'product' ? <ProductTab slug={slug} navigate={navigate} />
        : tab === 'tests' || tab === 'checks' ? <ChecksTab slug={slug} code={data.project.kind === 'repo'} />
        : tab === 'workload' ? <WorkloadTab slug={slug} />
        : tab === 'team' ? <TeamTab roster={data.roster} onChanged={view.reload}><TeamExtras slug={slug} roster={data.roster} onChanged={view.reload} /></TeamTab>
        : <div className="p-5"><Text tone="muted">This view arrives in a later phase of docs/SPEC.md.</Text></div>}
    </AppShell>
  );
}
