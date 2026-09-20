import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import type { Agent, ProjectNode } from '../data/client';
import { Avatar, Chip, cx, Dialog, IconButton, Meter, SectionLabel, Text, type DotTone } from '../ui';
import { useStream } from '../data/stream';
import { useResource } from '../data/useResource';
import { openPalette } from './CommandPalette';
import { NewProject } from './NewProject';

const agentStatus = (agent: Agent): DotTone => (agent.status === 'paused' ? 'attention' : agent.doing ? 'working' : 'idle');

export function AgentLine({ agent }: { agent: Agent }) {
  return (
    <Link href={`/agents/${agent.id}`} className="flex items-center gap-2.5 rounded-control p-1.5 hover:bg-active">
      <Avatar initials={agent.initials} tint={agent.tint} status={agentStatus(agent)} />
      <span className="flex min-w-0 flex-col">
        <Text size="small" weight="medium">{agent.name}</Text>
        <Text size="caption" tone="muted" truncate>{agent.doing ?? 'idle'}</Text>
      </span>
    </Link>
  );
}

function ProjectLink({ project, active, activeSub }: { project: ProjectNode; active: boolean; activeSub: string | null }) {
  return (
    <>
      <Link href={`/p/${project.slug}/tasks`} className={cx('flex flex-col gap-1.5 rounded-control px-2.5 py-2 hover:bg-active', active && !activeSub && 'bg-active')}>
        <span className="flex items-center gap-2">
          {/* The name keeps its room; the seat count is what the narrow rail can afford beside it. */}
          <Text weight="medium" tone={active ? 'ink' : 'soft'} truncate className="min-w-0 grow">{project.name}</Text>
          <Text size="caption" tone="muted" mono className="shrink-0 whitespace-nowrap">{project.status === 'paused' ? 'paused' : project.team ? `${project.team.seats} seats` : ''}</Text>
        </span>
        <Meter thin value={project.progress} tone={active ? 'working' : 'idle'} />
      </Link>
      {project.subprojects.map(sub => (
        <Link key={sub.id} href={`/p/${sub.slug}/tasks`} className={cx('flex items-center gap-2 rounded-control py-1.5 pr-2.5 pl-5.5 hover:bg-active', activeSub === sub.slug && 'bg-active')}>
          <Text size="caption" tone="faint" mono>└</Text>
          <Text size="small" tone={activeSub === sub.slug ? 'ink' : 'soft'}>{sub.name}</Text>
        </Link>
      ))}
    </>
  );
}

export interface SidebarProps { orgName: string; projects: ProjectNode[]; activeSlug: string | null; roster: Agent[]; teamName: string | null; links: { href: string; label: string; aside?: ReactNode }[] }

// Until the organization is set up (or the guide is hidden), the way back to it and how far along it is.
function GuideLink() {
  const [location] = useLocation();
  const guide = useResource<{ done: number; total: number; complete: boolean; dismissed: boolean }>('/api/onboarding');
  useStream(event => /^(connection|provider|settings|task|turn)\./.test(event.type), guide.reload);
  useEffect(() => { window.addEventListener('guide:changed', guide.reload); return () => window.removeEventListener('guide:changed', guide.reload); }, [guide.reload]);
  useEffect(() => { guide.reload(); }, [location]);
  if (!guide.data || guide.data.complete || guide.data.dismissed) return null;
  return (
    <Link href="/welcome" className={cx('flex flex-col gap-1.5 rounded-control border border-accent px-2.5 py-2 hover:bg-active', location === '/welcome' && 'bg-active')}>
      <span className="flex items-center gap-2"><Text weight="medium" className="grow">Get started</Text><Text size="caption" tone="muted" mono>{guide.data.done} of {guide.data.total}</Text></span>
      <Meter thin value={guide.data.done / guide.data.total} tone="working" />
    </Link>
  );
}

// Always in sight: how many things wait for a person, and the way to them.
function NeedsYouLink() {
  const [location] = useLocation();
  const queue = useResource<{ items: unknown[] }>('/api/needs-you');
  useStream(event => /^(decision|quarantine|delivery|proposal|task|turn)\./.test(event.type), queue.reload);
  const count = queue.data?.items.length ?? 0;
  return (
    <Link href="/needs-you" className={cx('flex items-center gap-2 rounded-control px-2.5 py-2 hover:bg-active', location === '/needs-you' && 'bg-active')}>
      <Text weight="medium" tone={count ? 'ink' : 'soft'} className="grow">Needs you</Text>
      {count > 0 && <Chip tone="attention" pill>{count}</Chip>}
    </Link>
  );
}

export function Sidebar({ orgName, projects, activeSlug, roster, teamName, links }: SidebarProps) {
  return (
    <nav aria-label="Projects and team" className="flex w-54 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-rail px-3 py-4">
      <div className="flex items-center gap-2 px-1.5">
        <span aria-hidden className="size-5.5 rounded-control bg-accent" />
        <span className="flex min-w-0 flex-col"><Text size="body" weight="semibold" truncate>{orgName}</Text><Text size="caption" tone="muted">organization</Text></span>
      </div>
      <GuideLink />
      <NeedsYouLink />
      <div className="flex flex-col gap-1">
        <div className="px-1.5 pb-1"><SectionLabel>Projects</SectionLabel></div>
        {projects.map(project => {
          const sub = project.subprojects.find(item => item.slug === activeSlug) ?? null;
          return <ProjectLink key={project.id} project={project} active={project.slug === activeSlug || sub !== null} activeSub={sub?.slug ?? null} />;
        })}
        <NewProject projects={projects} />
      </div>
      {roster.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="px-1.5 pb-1.5"><SectionLabel aside={<Link href="/org" className="shrink-0 whitespace-nowrap"><Text size="caption" tone="accent">All teams</Text></Link>}>{teamName ?? 'Team'} · {roster.length}</SectionLabel></div>
          {roster.map(agent => <AgentLine key={agent.id} agent={agent} />)}
        </div>
      )}
      <div className="mt-auto flex flex-col gap-0.5">
        {links.map(link => (
          <Link key={link.href} href={link.href} className="flex items-center gap-2 rounded-control p-1.5 hover:bg-active">
            <Text size="small" tone="soft">{link.label}</Text><span className="ml-auto">{link.aside}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

// Three panes from the shell breakpoint up. Below it the sidebar is a drawer behind the menu button and the rail is a tab beside the main area.
export function AppShell({ sidebar, children, rail, railLabel = 'Discussion' }: { sidebar: ReactNode; children: ReactNode; rail?: ReactNode; railLabel?: string }) {
  const [drawer, setDrawer] = useState(false);
  const [pane, setPane] = useState<'main' | 'rail'>('main');
  const [location] = useLocation();
  useEffect(() => setDrawer(false), [location]);
  const railOpen = pane === 'rail' && Boolean(rail);
  const tab = (value: 'main' | 'rail', label: string) => (
    <button type="button" role="tab" aria-selected={pane === value} onClick={() => setPane(value)} className={cx('h-7.5 cursor-pointer border-0 border-b-2 bg-transparent px-2.5 text-small', pane === value ? 'border-accent font-semibold text-ink' : 'border-transparent font-medium text-ink-soft')}>{label}</button>
  );
  return (
    <div className="flex h-full flex-col overflow-hidden bg-ground shell:flex-row">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-rail px-2.5 py-1.5 shell:hidden">
        <IconButton icon="menu" label="Open navigation" hint={false} onClick={() => setDrawer(true)} />
        {rail && <div role="tablist" aria-label="Panes" className="flex gap-0.5">{tab('main', 'Board')}{tab('rail', railLabel)}</div>}
        <span className="ml-auto"><IconButton icon="search" label="Search" hint={false} onClick={openPalette} /></span>
      </div>
      <Dialog open={drawer} onOpenChange={setDrawer} title="Navigation" place="left">{sidebar}</Dialog>
      <div className="hidden shell:flex">{sidebar}</div>
      <main className={cx('min-h-0 min-w-0 grow flex-col', railOpen ? 'hidden shell:flex' : 'flex')}>{children}</main>
      {rail && <aside aria-label={railLabel} className={cx('min-h-0 shrink-0 flex-col bg-rail shell:flex shell:w-100 shell:grow-0 shell:border-l shell:border-line', railOpen ? 'flex grow' : 'hidden')}>{rail}</aside>}
    </div>
  );
}

export type Crumb = string | { label: string; href: string };
export function PageHeader({ crumbs, title, aside, children }: { crumbs?: Crumb[]; title: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2 border-b border-line px-5 pt-3">
      <div className="flex items-center gap-2 whitespace-nowrap">
        {crumbs?.map(crumb => {
          const label = typeof crumb === 'string' ? crumb : crumb.label;
          return <span key={label} className="flex items-center gap-2">{typeof crumb === 'string' ? <Text tone="muted">{label}</Text> : <Link href={crumb.href} className="rounded-chip text-ink-muted hover:text-ink hover:underline">{label}</Link>}<Text tone="faint">/</Text></span>;
        })}
        <Text as="h1" size="title">{title}</Text>
        {aside && <span className="ml-auto flex items-center gap-2">{aside}</span>}
      </div>
      {children}
    </header>
  );
}

export function RailHeader({ title, note, live, aside }: { title: string; note?: string; live?: boolean; aside?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-line px-4">
      <Text weight="semibold">{title}</Text>
      {note && <Text size="caption" tone="muted">{note}</Text>}
      {aside && <span className="ml-auto">{aside}</span>}
      {live && !aside && <span className="ml-auto flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-pill bg-working" /><Text size="caption" tone="working">live</Text></span>}
    </div>
  );
}

export function CenteredPanel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-ground p-4">
      <div className="flex w-full max-w-90 flex-col gap-5 rounded-card border border-line bg-card p-6">
        <div className="flex flex-col gap-1"><Text as="h1" size="heading">{title}</Text>{note && <Text size="small" tone="muted">{note}</Text>}</div>
        {children}
      </div>
    </div>
  );
}
