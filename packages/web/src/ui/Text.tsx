import type { ElementType, ReactNode } from 'react';
import { cx } from './cx';

const SIZE = {
  label: 'text-label font-semibold uppercase',
  caption: 'text-caption',
  small: 'text-small',
  body: 'text-body',
  title: 'text-title font-semibold tracking-tight',
  heading: 'text-heading font-semibold tracking-tight',
  display: 'text-display font-semibold tracking-tight',
  metric: 'text-metric font-semibold font-mono tracking-tight',
} as const;
const TONE = { ink: 'text-ink', soft: 'text-ink-soft', muted: 'text-ink-muted', faint: 'text-ink-faint', accent: 'text-accent', working: 'text-working-ink', review: 'text-review-ink', attention: 'text-attention-ink', stop: 'text-stop-ink', inherit: '' } as const;
const WEIGHT = { regular: 'font-normal', medium: 'font-medium', semibold: 'font-semibold' } as const;

export type TextSize = keyof typeof SIZE;
export type Tone = keyof typeof TONE;

export interface TextProps { as?: ElementType; size?: TextSize; tone?: Tone; weight?: keyof typeof WEIGHT; mono?: boolean; truncate?: boolean; className?: string; children?: ReactNode }

// The only component that sets type size, weight and text colour.
export function Text({ as: Tag = 'span', size = 'body', tone = size === 'label' ? 'muted' : 'ink', weight, mono, truncate, className, children }: TextProps) {
  return <Tag className={cx(SIZE[size], TONE[tone], weight && WEIGHT[weight], mono && 'font-mono', truncate && 'truncate', className)}>{children}</Tag>;
}
