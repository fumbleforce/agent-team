import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { api, ApiError, type Me, type ProjectNode } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, NewProject, PageHeader, SettingsBody, Sidebar, StatusLine, StepCard } from '../../patterns';
import { Button, CodeBlock, Field, Input, Segmented, Text } from '../../ui';
import { ConnectFlow } from '../integrations/ConnectFlow';
import { ProviderFlow, type Provider } from '../project/ProviderFlow';

type Key = 'project' | 'code' | 'board' | 'provider' | 'worker' | 'task' | 'people';
interface Guide { project: { slug: string; name: string } | null; steps: { key: Key; done: boolean; optional: boolean; detail: string | null }[]; done: number; total: number; complete: boolean; dismissed: boolean; canAdmin: boolean; url: string }

// The way from an empty organization to a team that is working: one step open at a time, each done with the same guided
// dialogs the rest of the app uses. Steps tick themselves off from what exists, so nothing here has to be "saved".
export function WelcomePage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const wanted = new URLSearchParams(window.location.search).get('project');
  const guide = useResource<Guide>(`/api/onboarding${wanted ? `?project=${encodeURIComponent(wanted)}` : ''}`);
  const providers = useResource<{ providers: Provider[] }>('/api/providers');
  useStream(event => /^(connection|provider|settings|task|turn|work_item|member|invite)\./.test(event.type), () => { guide.reload(); providers.reload(); });
  const [providerFlow, setProviderFlow] = useState<{ open: boolean; kind: string | null }>({ open: false, kind: null });
  // The sidebar's progress follows this page without waiting for the next event.
  useEffect(() => { window.dispatchEvent(new Event('guide:changed')); }, [guide.data?.done]);
  const data = guide.data, slug = data?.project?.slug ?? null;
  const step = (key: Key) => data?.steps.find(item => item.key === key);
  const current = data?.steps.find(item => !item.done && !item.optional)?.key ?? null;
  const card = (key: Key, number: number, title: string, why: string, body: ReactNode, doneText: string) => {
    const state = step(key);
    return <StepCard key={key} number={number} title={title} note={state?.done ? `${doneText}${state.detail ? `: ${state.detail}` : ''}` : why} state={state?.done ? 'done' : current === key ? 'current' : 'later'} optional={state?.optional ?? false} locked={key !== 'project' && !slug}>{body}</StepCard>;
  };

  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={null} roster={[]} teamName={null} links={[]} />}>
      <PageHeader title={data?.complete ? 'Your team is set up' : `Welcome, ${me.user.name.split(' ')[0]}`} crumbs={[{ label: me.org?.name ?? 'Organization', href: '/org' }]}>
        <div className="flex items-center gap-3 pb-3">
          <Text size="small" tone="muted" className="grow">{data?.complete ? 'Everything a team needs is connected. You can come back here from the sidebar at any time.' : `A few steps take you from here to a team that picks up work on its own. ${data ? `${data.done} of ${data.total} done.` : ''}`}</Text>
          {data?.canAdmin && !data.dismissed && <Button variant="ghost" onClick={() => { void api('/api/onboarding/dismiss', {}).then(guide.reload); }}>Hide this guide</Button>}
        </div>
      </PageHeader>
      <SettingsBody>
        <div className="flex max-w-3xl flex-col gap-3">
          {card('project', 1, 'Create your first project', 'A project is one product or body of work, with its own team of agents, board and discussion.', <NewProject projects={projects} primary to="welcome" />, 'Project')}
          {card('code', 2, 'Connect where the code lives', 'The team pushes branches and opens draft pull requests there. Nothing is merged without the checks and reviews you require.', slug && <ConnectFlow slug={slug} only={['code']} label="Connect a code host" connectedKinds={[]} onDone={guide.reload} />, 'Connected')}
          {card('board', 3, 'Connect your task board', 'If your tasks live in an issue tracker, they appear on the board within a minute. Skip this to keep tasks here.', slug && <ConnectFlow slug={slug} only={['issue-boards']} label="Connect a task board" connectedKinds={[]} onDone={guide.reload} />, 'Connected')}
          {card('provider', 4, 'Choose how the models are paid for', 'A plan you already have, pay per use, or models on your own machine. Any agent can then be given any of its models.', <Button variant="primary" onClick={() => setProviderFlow({ open: true, kind: null })}>Add a model provider</Button>, 'Added')}
          {card('worker', 5, 'Start a worker next to the code', 'A worker is the program that runs the agents. It runs on a machine that has the repository checked out and the engine signed in; the code and your keys never leave that machine.', slug && data && <WorkerStep slug={slug} url={data.url} />, 'Running')}
          {card('task', 6, 'Give the team something to do', 'Write the first task in the discussion, or let the board fill from your tracker. The project manager seat picks it up and hands it out.', slug && <Link href={`/p/${slug}/tasks`}><Button variant="primary">Open the board</Button></Link>, 'The board has work')}
          {card('people', 7, 'Invite the people you work with', 'Owners and admins decide; members work with the team; viewers follow along.', <Link href="/settings/members"><Button>Invite people</Button></Link>, 'Invited')}
        </div>
      </SettingsBody>
      <ProviderFlow open={providerFlow.open} kind={providerFlow.kind} providers={providers.data?.providers ?? []} onOpenChange={(open, kind) => setProviderFlow({ open, kind: kind ?? null })} onDone={() => { providers.reload(); guide.reload(); }} />
    </AppShell>
  );
}

// The one step done outside the browser. The token is made here, shown once, and goes into the environment of the worker's
// terminal, never onto a command line. The card turns green by itself when the worker first reports in.
function WorkerStep({ slug, url }: { slug: string; url: string }) {
  const [shell, setShell] = useState<'powershell' | 'bash'>(navigator.userAgent.includes('Windows') ? 'powershell' : 'bash');
  const [token, setToken] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [checkout, setCheckout] = useState('');
  const make = async () => { try { setToken((await api<{ token: string }>('/api/machine-tokens', { name: `Worker for ${slug}`, kind: 'worker' })).token); setError(null); } catch (failure) { setError(failure instanceof ApiError ? failure.message : 'The token could not be made'); } };
  const path = checkout.trim() || (shell === 'powershell' ? 'C:\\path\\to\\your\\checkout' : '/path/to/your/checkout');
  const lines = [shell === 'powershell' ? `$env:AGENT_TEAM_TOKEN = "${token ?? '<token>'}"` : `export AGENT_TEAM_TOKEN='${token ?? '<token>'}'`, `node bin/agent-team.ts work "${path}" --project ${slug} --url ${url}`];
  return (
    <div className="flex w-full flex-col gap-3">
      <Field label="Where is the repository checked out on that machine?" help="The folder that contains .git. It is only used to write the command below."><Input value={checkout} onChange={event => setCheckout(event.target.value)} placeholder={shell === 'powershell' ? 'C:\\code\\web-shop' : '~/code/web-shop'} /></Field>
      {!token ? <div><Button variant="primary" onClick={() => { void make(); }}>Make a token for this worker</Button></div> : <StatusLine tone="attention" boxed>This token is shown once. It is already in the command below; keep that terminal private.</StatusLine>}
      {error && <Text size="small" tone="stop">{error}</Text>}
      <div className="flex items-center gap-2"><Text size="small" tone="muted" className="grow">Run this in a terminal in the agent-team folder on that machine, and leave it running:</Text><Segmented value={shell} onChange={value => setShell(value as 'powershell' | 'bash')} options={[{ value: 'powershell', label: 'PowerShell' }, { value: 'bash', label: 'macOS / Linux' }]} /></div>
      <CodeBlock text={lines.join('\n')} />
      <StatusLine tone="off">Waiting for the worker to report in… this step ticks itself off when it does.</StatusLine>
    </div>
  );
}
