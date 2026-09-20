import type { ReactNode } from 'react';
import type { Agent } from '../data/client';
import { Avatar, Card, cx, SectionLabel, Text } from '../ui';

export interface PipelineStep { label: string; who: string; agentId: string | null; at: number | null; state: 'done' | 'now' | 'todo' }
const clock = (at: number | null) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

// Who has had a task, in order, with the step it is at lit. The same strip serves a report in the inbox and a task being worked on.
export function Pipeline({ steps, roster }: { steps: PipelineStep[]; roster: Agent[] }) {
  return (
    <ol aria-label="Where this is" className="m-0 flex list-none items-stretch overflow-hidden rounded-card border border-line bg-card p-0">
      {steps.map(step => {
        const agent = roster.find(item => item.id === step.agentId);
        return (
          <li key={step.label} aria-current={step.state === 'now' ? 'step' : undefined} className={cx('flex min-w-0 flex-1 items-center gap-2.5 border-r border-line px-3.5 py-2.5 last:border-r-0', step.state === 'now' && 'bg-active')}>
            <span className={cx('shrink-0', step.state === 'todo' && 'opacity-40')}><Avatar initials={agent?.initials ?? '·'} tint={agent?.tint ?? 8} size="sm" {...(step.state === 'now' ? { status: 'working' as const } : {})} /></span>
            <span className="flex min-w-0 flex-col">
              <Text size="label" tone={step.state === 'now' ? 'accent' : step.state === 'done' ? 'muted' : 'faint'}>{step.label}</Text>
              <Text size="small" tone={step.state === 'todo' ? 'faint' : step.state === 'now' ? 'ink' : 'soft'} truncate>{step.who}</Text>
              <Text size="caption" tone="faint" mono>{step.state === 'now' && !step.at ? 'now' : clock(step.at)}</Text>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// One entry of a task's work log: who, in what role, what state, when, and what they reported.
export function LogCard({ agent, line, at, live, children }: { agent: Agent | undefined; line: string; at: number; live?: boolean; children?: ReactNode }) {
  return (
    <Card as="article" tone={live ? 'raised' : 'card'} pad="sm" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Avatar initials={agent?.initials ?? '·'} tint={agent?.tint ?? 8} size="sm" {...(live ? { status: 'working' as const } : {})} />
        <Text size="small" weight="semibold">{agent?.name ?? 'Someone'}</Text>
        <Text size="caption" tone={live ? 'working' : 'muted'} truncate>{[agent?.title, line].filter(Boolean).join(' · ')}</Text>
        <Text size="caption" tone="faint" mono className="ml-auto">{clock(at)}</Text>
      </div>
      {children}
    </Card>
  );
}

// The frame of a page about one thing: a header with its own bottom line, and a rail beside the main column.
export function DetailHeader({ children }: { children: ReactNode }) { return <header className="flex flex-col gap-2 border-b border-line px-6 pt-3 pb-3.5">{children}</header>; }
export function DetailRail({ label, children }: { label: string; children: ReactNode }) { return <aside aria-label={label} className="flex w-full shrink-0 flex-col overflow-y-auto border-t border-line bg-rail lg:w-88 lg:border-t-0 lg:border-l">{children}</aside>; }

// The right rail of a page about one thing: labelled facts, then sections.
export function RailFacts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="m-0 grid grid-cols-3 items-center gap-x-2 gap-y-2.5">{rows.map(([label, value]) => <div key={label} className="contents"><Text as="dt" size="small" tone="muted">{label}</Text><dd className="col-span-2 m-0 flex min-w-0 flex-wrap items-center gap-1.5">{value}</dd></div>)}</dl>;
}
export function RailSection({ label, children }: { label: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2 border-t border-line px-4 py-3.5"><SectionLabel>{label}</SectionLabel>{children}</section>;
}
