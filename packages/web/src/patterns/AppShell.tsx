import type { ReactNode } from 'react';
import { Link } from 'wouter';
import type { Agent, ProjectNode } from '../data/client';
import { Avatar, Button, cx, Meter, SectionLabel, Text, type DotTone } from '../ui';

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
          <Text weight="medium" tone={active ? 'ink' : 'soft'} truncate>{project.name}</Text>
          <Text size="caption" tone="muted" mono className="ml-auto whitespace-nowrap">{project.status === 'paused' ? 'paused' : project.team ? `${project.team.name} · ${project.team.seats}` : ''}</Text>
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

export function Sidebar({ orgName, projects, activeSlug, roster, teamName, links }: SidebarProps) {
  return (
    <nav aria-label="Projects and team" className="flex w-54 shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-rail px-3 py-4">
      <div className="flex items-center gap-2 px-1.5">
        <span aria-hidden className="size-5.5 rounded-control bg-accent" />
        <span className="flex min-w-0 flex-col"><Text size="body" weight="semibold" truncate>{orgName}</Text><Text size="caption" tone="muted">organization</Text></span>
      </div>
      <div className="flex flex-col gap-1">
        <div className="px-1.5 pb-1"><SectionLabel>Projects</SectionLabel></div>
        {projects.map(project => {
          const sub = project.subprojects.find(item => item.slug === activeSlug) ?? null;
          return <ProjectLink key={project.id} project={project} active={project.slug === activeSlug || sub !== null} activeSub={sub?.slug ?? null} />;
        })}
        <Button variant="dashed" block>+ New project</Button>
      </div>
      {roster.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="px-1.5 pb-1.5"><SectionLabel aside={<Link href="/org"><Text size="caption" tone="accent">All teams</Text></Link>}>{teamName ?? 'Team'} · {roster.length}</SectionLabel></div>
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

export function AppShell({ sidebar, children, rail }: { sidebar: ReactNode; children: ReactNode; rail?: ReactNode }) {
  return (
    <div className="flex h-full overflow-hidden bg-ground">
      <div className="hidden md:flex">{sidebar}</div>
      <main className="flex min-w-0 grow flex-col">{children}</main>
      {rail && <aside className="hidden w-100 shrink-0 flex-col border-l border-line bg-rail lg:flex">{rail}</aside>}
    </div>
  );
}

export function PageHeader({ crumbs, title, children }: { crumbs?: string[]; title: string; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-2 border-b border-line px-5 pt-3">
      <div className="flex items-center gap-2 whitespace-nowrap">
        {crumbs?.map(crumb => <span key={crumb} className="flex items-center gap-2"><Text tone="muted">{crumb}</Text><Text tone="faint">/</Text></span>)}
        <Text as="h1" size="title">{title}</Text>
      </div>
      {children}
    </header>
  );
}

export function RailHeader({ title, note, live }: { title: string; note?: string; live?: boolean }) {
  return (
    <div className="flex h-22.75 items-end gap-2.5 border-b border-line px-4 pb-2.5">
      <Text weight="semibold">{title}</Text>
      {note && <Text size="caption" tone="muted">{note}</Text>}
      {live && <span className="ml-auto flex items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-pill bg-working" /><Text size="caption" tone="working">live</Text></span>}
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
