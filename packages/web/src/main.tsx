import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Redirect, Route, Switch } from 'wouter';
import type { Agent, Me, ProjectNode } from './data/client';
import { AgentPage } from './features/agent/AgentPage';
import { CostsPage } from './features/costs/CostsPage';
import { IntegrationsPage } from './features/integrations/IntegrationsPage';
import { OrgPage, RolesPage } from './features/org/OrgPages';
import { ProposalsPage } from './features/proposals/ProposalsPage';
import { startStream } from './data/stream';
import { useResource } from './data/useResource';
import { Gallery } from './dev/Gallery';
import { ProjectPage } from './features/project/ProjectPage';
import { InvitePage, LoginPage, SetupPage } from './features/session/SessionPages';
import { CenteredPanel } from './patterns';
import './tokens.css';

function Signed() {
  const me = useResource<Me>('/api/me');
  const tree = useResource<{ projects: ProjectNode[] }>(me.data ? '/api/projects' : null);
  useEffect(() => { if (me.data) startStream(me.data.seq); }, [me.data]);
  const agents = useResource<{ agents: Agent[] }>(me.data ? '/api/agents' : null);
  if (me.error?.status === 401) return <Redirect to="/login" />;
  if (!me.data || !tree.data) return null;
  const first = tree.data.projects[0];
  const home = first ? `/p/${first.subprojects[0]?.slug ?? first.slug}/tasks` : null;
  return (
    <Switch>
      <Route path="/p/:slug/knowledge/:pageId">{params => <ProjectPage slug={params.slug} tab="knowledge" pageId={params.pageId} me={me.data!} projects={tree.data!.projects} />}</Route>
      <Route path="/p/:slug/issues/:number">{params => <ProjectPage slug={params.slug} tab="issues" pageId={params.number} me={me.data!} projects={tree.data!.projects} />}</Route>
      <Route path="/p/:slug/integrations">{params => <IntegrationsPage slug={params.slug} me={me.data!} projects={tree.data!.projects} />}</Route>
      <Route path="/org"><OrgPage me={me.data} projects={tree.data.projects} /></Route>
      <Route path="/roles/:slug">{params => <RolesPage slug={params.slug} me={me.data!} projects={tree.data!.projects} />}</Route>
      <Route path="/roles"><RolesPage slug={null} me={me.data} projects={tree.data.projects} /></Route>
      <Route path="/costs"><CostsPage me={me.data} projects={tree.data.projects} agents={agents.data?.agents ?? []} /></Route>
      <Route path="/proposals/:id">{params => <ProposalsPage id={params.id} me={me.data!} projects={tree.data!.projects} agents={agents.data?.agents ?? []} />}</Route>
      <Route path="/proposals"><ProposalsPage id={null} me={me.data} projects={tree.data.projects} agents={agents.data?.agents ?? []} /></Route>
      <Route path="/agents/:id">{params => <AgentPage id={params.id} me={me.data!} projects={tree.data!.projects} />}</Route>
      <Route path="/p/:slug/:tab">{params => <ProjectPage slug={params.slug} tab={params.tab} me={me.data!} projects={tree.data!.projects} />}</Route>
      <Route path="/p/:slug">{params => <Redirect to={`/p/${params.slug}/tasks`} />}</Route>
      <Route>{home ? <Redirect to={home} /> : <CenteredPanel title="No projects yet" note="Run agent-team up in a checkout to register the first project." >{null}</CenteredPanel>}</Route>
    </Switch>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/setup" component={SetupPage} />
      <Route path="/invite/:token">{params => <InvitePage token={params.token} />}</Route>
      <Route path="/dev/ui" component={Gallery} />
      <Route component={Signed} />
    </Switch>
  </StrictMode>,
);
