import type { ElementType, ReactNode } from 'react';
import { cx } from './cx';
import { Text } from './Text';

const TONE = { card: 'bg-card border-line', raised: 'bg-raised border-line', decision: 'bg-decision-wash border-decision-line', outline: 'bg-transparent border-dashed border-line-dashed' } as const;
const PAD = { none: '', sm: 'px-3 py-2.5', md: 'px-4 py-3.5' } as const;

export function Card({ as: Tag = 'div', tone = 'card', pad = 'md', className, children }: { as?: ElementType; tone?: keyof typeof TONE; pad?: keyof typeof PAD; className?: string; children: ReactNode }) {
  return <Tag className={cx('rounded-card border', TONE[tone], PAD[pad], className)}>{children}</Tag>;
}

export function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return <div className="flex items-baseline gap-2"><Text size="label" truncate className="min-w-0">{children}</Text>{aside && <span className="ml-auto shrink-0 whitespace-nowrap">{aside}</span>}</div>;
}

export function Meter({ value, tone = 'working', thin }: { value: number; tone?: 'working' | 'review' | 'idle' | 'attention'; thin?: boolean }) {
  const fill = { working: 'bg-working', review: 'bg-review-ink', idle: 'bg-ink-faint', attention: 'bg-attention' }[tone];
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} className={cx('w-full overflow-hidden rounded-pill bg-line-strong', thin ? 'h-0.75' : 'h-2')}>
      <div className={cx('h-full rounded-pill', fill)} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  );
}

export function StatTile({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return <Card tone="raised" pad="sm" className="flex flex-col gap-0.5"><Text size="caption" tone="muted">{label}</Text><Text size="heading" mono>{value}</Text>{note && <Text size="caption" tone="muted">{note}</Text>}</Card>;
}
