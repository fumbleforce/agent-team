import type { ReactNode } from 'react';
import { cx } from './cx';

const TONE = {
  neutral: 'bg-active text-ink-soft',
  accent: 'bg-active text-accent',
  working: 'bg-working-wash text-working-ink',
  review: 'bg-review-wash text-review-ink',
  attention: 'bg-attention-wash text-attention-ink',
  stop: 'bg-stop-wash text-stop-ink',
} as const;
export type ChipTone = keyof typeof TONE;

export function Chip({ tone = 'neutral', pill, mono, children }: { tone?: ChipTone; pill?: boolean; mono?: boolean; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 px-1.5 py-px text-caption whitespace-nowrap', pill ? 'rounded-pill px-2' : 'rounded-chip', mono && 'font-mono', TONE[tone])}>{children}</span>;
}

const DOT = { working: 'bg-working', review: 'bg-review', attention: 'bg-attention', stop: 'bg-stop', idle: 'bg-idle', off: 'bg-ink-faint' } as const;
export type DotTone = keyof typeof DOT;

export function StatusDot({ tone, ring }: { tone: DotTone; ring?: boolean }) {
  return <span aria-hidden className={cx('inline-block size-1.75 shrink-0 rounded-pill', DOT[tone], ring && 'outline-2 outline-rail')} />;
}
