import { cx } from './cx';
import { StatusDot, type DotTone } from './Chip';

const SIZE = { xs: 'size-4 rounded-chip text-tile-xs', sm: 'size-6 rounded-control text-tile-sm', md: 'size-7 rounded-control text-caption', lg: 'size-9 rounded-card text-body' } as const;
const TINT = ['bg-tint-1', 'bg-tint-2', 'bg-tint-3', 'bg-tint-4', 'bg-tint-5', 'bg-tint-6', 'bg-tint-7', 'bg-tint-8', 'bg-tint-9', 'bg-tint-10'] as const;

// Initials tile: portraits are placeholders by design. `tint` is a palette index, 1 to 10; `accent` marks the viewer.
export function Avatar({ initials, tint, size = 'md', status }: { initials: string; tint: string | number | 'accent'; size?: keyof typeof SIZE; status?: DotTone }) {
  const background = tint === 'accent' ? 'bg-accent' : TINT[(Number(tint) - 1 + TINT.length) % TINT.length];
  return (
    <span className={cx('relative inline-flex shrink-0 items-center justify-center font-semibold text-on-accent', SIZE[size], background)}>
      {initials}
      {status && <span className="absolute -right-0.5 -bottom-0.5 flex"><StatusDot tone={status} ring /></span>}
    </span>
  );
}
