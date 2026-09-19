import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Card, Chip, cx, Meter, Text } from '../ui';
import { Markdown } from './Markdown';

export function SidePanel({ label, side = 'left', wide, children }: { label: string; side?: 'left' | 'right'; wide?: boolean; children: ReactNode }) {
  return <aside aria-label={label} className={cx('flex shrink-0 flex-col gap-0.5 overflow-y-auto bg-rail px-2.5 py-3.5', wide ? 'w-85' : 'w-65', side === 'left' ? 'border-r border-line' : 'border-l border-line')}>{children}</aside>;
}

export function ListLink({ href, active, indent, mark, children, aside }: { href: string; active?: boolean; indent?: boolean; mark?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Link href={href} className={cx('flex items-center gap-2 rounded-control py-1.5 pr-2 hover:bg-active', indent ? 'pl-6.5' : 'pl-2', active && 'bg-active')}>
      {mark && <Text size="caption" tone="faint" mono>{mark}</Text>}
      <Text size="small" tone={active ? 'ink' : 'soft'} weight={active ? 'medium' : 'regular'} truncate>{children}</Text>
      {aside && <span className="ml-auto">{aside}</span>}
    </Link>
  );
}

// A page points at a decision with this token instead of copying its words, so the page always shows the decision as it stands.
const DECISION_TOKEN = /\[\[decision:([A-Za-z0-9_-]{1,64})\]\]/;
export const decisionToken = (id: string) => `[[decision:${id}]]`;
// For places that show a page's raw text to a reader, such as a comparison of two versions.
export const maskDecisionTokens = (text: string) => text.replace(new RegExp(DECISION_TOKEN.source, 'g'), '[a decision is shown here]');
export const hasDecisionToken = (text: string) => DECISION_TOKEN.test(text);

// Article body: a knowledge page's markdown, rendered and sanitized by Markdown. With `decision`, each decision token
// in the text becomes whatever the caller renders for that decision, in place.
export function Prose({ children, decision }: { children: string; decision?: (id: string) => ReactNode }) {
  if (!decision || !DECISION_TOKEN.test(children)) return <Markdown className="max-w-180">{children}</Markdown>;
  // Splitting on a pattern with one group leaves text at even positions and decision ids at odd ones.
  const parts = children.split(new RegExp(DECISION_TOKEN.source, 'g'));
  return <div className="flex max-w-180 flex-col gap-3">{parts.map((part, index) => (index % 2 ? <div key={index}>{decision(part)}</div> : part.trim() ? <Markdown key={index}>{part}</Markdown> : null))}</div>;
}

// A decision shown inside a page: what was decided, where it stands, and the way to the discussion it came from.
export function DecisionCallout({ summary, state, waiting, href }: { summary: string; state: string; waiting?: boolean; href?: string | undefined }) {
  return (
    <Card tone="decision" pad="sm" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2"><Text size="label">Decision</Text><Chip tone={waiting ? 'attention' : 'working'}>{state}</Chip></div>
      <Text size="small">{summary}</Text>
      {href && <Link href={href} className="self-start"><Text size="caption" tone="accent">Open the discussion it came from</Text></Link>}
    </Card>
  );
}

export function NoteCard({ children, meta, tag, tagTone, highlight }: { children: ReactNode; meta: ReactNode; tag?: string; tagTone?: 'neutral' | 'working' | 'attention'; highlight?: boolean }) {
  return <Card tone={highlight ? 'decision' : 'raised'} pad="sm" className="flex flex-col gap-1.5"><Text size="small" tone="soft">{children}</Text><div className="flex items-center gap-1.5"><Text size="caption" tone="muted">{meta}</Text>{tag && <span className="ml-auto"><Chip tone={tagTone ?? 'neutral'}>{tag}</Chip></span>}</div></Card>;
}

// A notice inside a form or a page: something went wrong or needs a choice. The buttons to act on it go in as children.
export function Notice({ tone = 'attention', title, children, actions }: { tone?: 'attention' | 'stop' | 'working'; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <Card tone="raised" pad="sm" className="flex flex-col gap-2">
      <Text size="small" weight="semibold" tone={tone}>{title}</Text>
      {children && <Text size="small" tone="soft">{children}</Text>}
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </Card>
  );
}

export function BarRow({ label, value, share, note, indent }: { label: ReactNode; value: string; share: number; note?: string; indent?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Text size="small" truncate className={cx('w-28 shrink-0', indent && 'pl-3.5')}>{label}</Text>
      <Meter value={share} tone="review" />
      <Text size="caption" mono className="w-14 shrink-0 text-right">{value}</Text>
      <Text size="caption" tone="muted" mono className="w-16 shrink-0 text-right">{note}</Text>
    </div>
  );
}

const KIND_MARK: Record<string, { mark: string; tone: 'neutral' | 'working' | 'review' | 'attention' }> = { read: { mark: 'R', tone: 'neutral' }, edit: { mark: 'E', tone: 'working' }, run: { mark: '$', tone: 'review' }, think: { mark: '…', tone: 'neutral' }, message: { mark: '@', tone: 'attention' } };

export function TraceRow({ at, kind, title, detail }: { at: number; kind: string; title: string; detail: string | null }) {
  const mark = KIND_MARK[kind] ?? KIND_MARK.think!;
  return (
    <div className="flex items-start gap-2.5 rounded-control px-2 py-1.5">
      <Text size="caption" tone="faint" mono className="w-14 shrink-0">{new Date(at).toLocaleTimeString([], { hour12: false })}</Text>
      <Chip tone={mark.tone} mono>{mark.mark}</Chip>
      <Text size="small" className="min-w-0">{title}</Text>
      {detail && <Text size="caption" tone="muted" mono className="ml-auto shrink-0 whitespace-nowrap">{detail}</Text>}
    </div>
  );
}
