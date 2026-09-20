import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { api, ApiError, type Me, type ProjectNode } from '../../data/client';
import { useStream } from '../../data/stream';
import { useResource } from '../../data/useResource';
import { AppShell, NewProject, PageHeader, SettingsBody, Sidebar, StatusLine, StepCard } from '../../patterns';
import { Button, CodeBlock, Field, Input, Text } from '../../ui';
import { ConnectFlow } from '../integrations/ConnectFlow';
import { ProviderFlow, type Provider } from '../project/ProviderFlow';

type Key = 'project' | 'code' | 'board' | 'provider' | 'worker' | 'task' | 'people';
interface Guide { repository: string | null; project: { slug: string; name: string } | null; steps: { key: Key; done: boolean; optional: boolean; detail: string | null }[]; done: number; total: number; complete: boolean; dismissed: boolean; canAdmin: boolean }

// The way from an empty organization to a team that is working, in four steps. Each is done with the same guided dialogs the
// rest of the app uses, and ticks itself off from what exists, so nothing here has to be "saved".
export function WelcomePage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const wanted = new URLSearchParams(window.location.search).get('project');
  const guide = useResource<Guide>(`/api/onboarding${wanted ? `?project=${encodeURIComponent(wanted)}` : ''}`);
  const providers = useResource<{ providers: Provider[] }>('/api/providers');
  useStream(event => /^(connection|provider|settings|task|turn|work_item|member|invite)\./.test(event.type), () => { guide.reload(); providers.reload(); });
  // A worker reporting in is not an event anyone is sent, so the guide looks again while it waits for one.
  const waitingForWorker = Boolean(guide.data?.repository) && guide.data?.steps.find(item => item.key === 'code')?.done === false;
  useEffect(() => { if (!waitingForWorker) return; const timer = setInterval(guide.reload, 4000); return () => clearInterval(timer); }, [waitingForWorker, guide.reload]);
  // The sidebar's progress follows this page without waiting for the next event.
  useEffect(() => { window.dispatchEvent(new Event('guide:changed')); }, [guide.data?.done]);
  const [providerFlow, setProviderFlow] = useState<{ open: boolean; kind: string | null }>({ open: false, kind: null });
  const data = guide.data, slug = data?.project?.slug ?? null;
  const step = (key: Key) => data?.steps.find(item => item.key === key);
  const current = data?.steps.find(item => !item.done && !item.optional)?.key ?? null;
  const card = (key: Key, number: number, title: string, why: string, body: ReactNode, doneText: string) => {
    const state = step(key);
    return <StepCard key={key} number={number} title={title} note={state?.done ? `${doneText}${state.detail ? `: ${state.detail}` : ''}` : why} state={state?.done ? 'done' : current === key ? 'current' : 'later'} optional={false} locked={key !== 'project' && !slug}>{body}</StepCard>;
  };

  return (
    <AppShell sidebar={<Sidebar orgName={me.org?.name ?? 'Organization'} projects={projects} activeSlug={null} roster={[]} teamName={null} links={[]} />}>
      <PageHeader title={data?.complete ? 'Your team is set up' : `Welcome, ${me.user.name.split(' ')[0]}`} crumbs={[{ label: me.org?.name ?? 'Organization', href: '/org' }]}>
        <div className="flex items-center gap-3 pb-3">
          <Text size="small" tone="muted" className="grow">{data?.complete ? 'Everything a team needs is connected.' : `Four steps to a team that picks up work on its own. ${data ? `${data.done} of ${data.total} done.` : ''}`}</Text>
          {data?.canAdmin && !data.dismissed && <Button variant="ghost" onClick={() => { void api('/api/onboarding/dismiss', {}).then(guide.reload); }}>Hide this guide</Button>}
        </div>
      </PageHeader>
      <SettingsBody>
        <div className="flex max-w-3xl flex-col gap-3">
          {card('project', 1, 'Create your first project', 'One product or body of work, with its own team of agents, board and discussion.', <NewProject projects={projects} primary to="welcome" />, 'Project')}
          {card('code', 2, 'Connect the code', 'The team works on its own copy and opens draft pull requests.', slug && data && <CodeStep slug={slug} repository={data.repository} onChanged={guide.reload} />, 'Connected')}
          {card('provider', 3, 'Choose how the models are paid for', 'A plan you already have, pay per use, or models on your own machine.', <Button variant="primary" onClick={() => setProviderFlow({ open: true, kind: null })}>Add a model provider</Button>, 'Added')}
          {card('task', 4, 'Give the team something to do', 'Write the first task in the discussion, or let the board fill from your tracker.', slug && <Link href={`/p/${slug}/tasks`}><Button variant="primary">Open the board</Button></Link>, 'The board has work')}
          {slug && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Text size="small" tone="muted">Also useful:</Text>
              {!step('board')?.done && <ConnectFlow slug={slug} only={['issue-boards']} label="Connect a task board" quiet connectedKinds={[]} onDone={guide.reload} />}
              {!step('people')?.done && <Link href="/settings/members"><Button>Invite people</Button></Link>}
              <Link href={`/p/${slug}/integrations`}><Button>Chat, documents and other tools</Button></Link>
            </div>
          )}
        </div>
      </SettingsBody>
      <ProviderFlow open={providerFlow.open} kind={providerFlow.kind} providers={providers.data?.providers ?? []} onOpenChange={(open, kind) => setProviderFlow({ open, kind: kind ?? null })} onDone={() => { providers.reload(); guide.reload(); }} />
    </AppShell>
  );
}

interface Progress { phase: 'cloning' | 'starting' | 'waiting' | 'failed'; detail: string | null; error: string | null; since: number }

// What is happening right now, said out loud, with the steps already done ticked above it and how long the current one has taken.
function StartingUp({ progress, machine }: { progress: Progress; machine: string }) {
  const order = ['cloning', 'starting', 'waiting'] as const;
  const words = { cloning: 'Getting the code', starting: 'Starting the worker', waiting: 'Waiting for the worker to report in' };
  const done = { cloning: 'Got the code', starting: 'Worker started', waiting: '' };
  const seconds = Math.max(0, Math.round((Date.now() - progress.since) / 1000));
  const at = order.indexOf(progress.phase as (typeof order)[number]);
  return (
    <div className="flex flex-col gap-1.5">
      {order.slice(0, at).map(phase => <StatusLine key={phase} tone="working">{done[phase]}</StatusLine>)}
      <StatusLine tone="attention" busy>{words[order[at]!]} on {machine}{progress.detail ? `: ${progress.detail}` : '…'}{seconds >= 5 ? ` (${seconds} s)` : ''}</StatusLine>
      {progress.phase === 'waiting' && seconds >= 20 && <Text size="caption" tone="muted">If this stays, the worker may not reach this address.</Text>}
    </div>
  );
}

// One step for the code. First the repository; then something has to work on it. On the machine the app runs on that is one
// button: the app clones the repository and starts the worker. On any other machine it is one short command with a single-use link.
function CodeStep({ slug, repository, onChanged }: { slug: string; repository: string | null; onChanged(): void }) {
  const here = useResource<{ available: boolean; running: boolean; ready: boolean; progress: Progress | null; engines: string[]; machine: string }>(`/api/projects/${slug}/worker/here`);
  const [mode, setMode] = useState<'here' | 'folder' | 'elsewhere'>('here'), [link, setLink] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({}), [failure, setFailure] = useState<string | null>(null);
  // While something is under way the app looks again every second, so what it says keeps pace with what is happening.
  const active = here.data?.progress !== null && here.data?.progress !== undefined && here.data.progress.phase !== 'failed';
  const [, tick] = useState(0);
  useEffect(() => { if (!active) return; const timer = setInterval(() => { here.reload(); tick(value => value + 1); }, 1000); return () => clearInterval(timer); }, [active, here.reload]);
  useEffect(() => { if (here.data?.ready) onChanged(); }, [here.data?.ready]);
  if (!repository) return <ConnectFlow slug={slug} only={['code']} label="Connect a code host" connectedKinds={[]} onDone={onChanged} />;

  const fail = (problem: unknown) => { if (problem instanceof ApiError && Object.keys(problem.fields).length) setErrors(problem.fields as Record<string, string>); else setFailure(problem instanceof ApiError ? problem.message : 'That did not work; try again.'); };
  const start = async (checkout?: string) => { setBusy(true); setErrors({}); setFailure(null); try { await api(`/api/projects/${slug}/worker/here`, checkout ? { checkout } : {}); here.reload(); onChanged(); } catch (problem) { fail(problem); } finally { setBusy(false); } };
  const pair = async () => { setFailure(null); try { setLink((await api<{ link: string }>(`/api/projects/${slug}/worker/pair`, {})).link); } catch (problem) { fail(problem); } };
  const local = here.data?.available === true;

  return (
    <div className="flex w-full flex-col gap-3">
      <StatusLine tone="working">{repository} is connected.</StatusLine>
      {active && here.data?.progress ? <StartingUp progress={here.data.progress} machine={here.data.machine} /> : (
        <>
          {local && mode === 'here' && <div className="flex flex-wrap items-center gap-3"><Button variant="primary" disabled={busy} onClick={() => { void start(); }}>{busy ? 'Getting the code…' : 'Start working on it here'}</Button><Button variant="ghost" onClick={() => setMode('folder')}>I already have it in a folder</Button><Button variant="ghost" onClick={() => setMode('elsewhere')}>Use another machine</Button></div>}
          {local && mode === 'folder' && (
            <form className="flex w-full flex-col gap-3" onSubmit={event => { event.preventDefault(); void start(String(new FormData(event.currentTarget).get('checkout') ?? '')); }}>
              <Field label={`The folder on ${here.data?.machine}`} error={errors.checkout}><Input name="checkout" required autoFocus placeholder={navigator.userAgent.includes('Windows') ? String.raw`C:\code\web-shop` : '~/code/web-shop'} /></Field>
              <div className="flex flex-wrap items-center gap-3"><Button type="submit" variant="primary" disabled={busy}>Start working from that folder</Button><Button variant="ghost" onClick={() => setMode('here')}>Back</Button></div>
            </form>
          )}
          {(!local || mode === 'elsewhere') && (!link ? <div className="flex flex-wrap items-center gap-3"><Button variant="primary" onClick={() => { void pair(); }}>Get the command for the machine that has the code</Button>{local && <Button variant="ghost" onClick={() => setMode('here')}>Back</Button>}</div> : (
            <>
              <Text size="small" tone="muted">Run once in the project's folder there. Good for 15 minutes.</Text>
              <CodeBlock text={`agent-team connect ${link}`} />
              <StatusLine tone="off">Waiting for it to report in…</StatusLine>
            </>
          ))}
        </>
      )}
      {here.data?.progress?.phase === 'failed' && <StatusLine tone="stop" boxed>{here.data.progress.error}</StatusLine>}
      {failure && <Text size="small" tone="stop">{failure}</Text>}
    </div>
  );
}
