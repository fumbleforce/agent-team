import type { ReactNode } from 'react';
import { cx } from './cx';
import { Text } from './Text';

// A named value. Wrap several in a <dl>; `stack` puts the value under its name instead of at the end of the line.
export function KeyValue({ label, children, mono = false, stack }: { label: string; children: ReactNode; mono?: boolean; stack?: boolean }) {
  return (
    <div className={cx('flex', stack ? 'flex-col gap-0.5' : 'items-baseline gap-2')}>
      <Text as="dt" size={stack ? 'caption' : 'small'} tone="muted">{label}</Text>
      <Text as="dd" size="small" mono={mono} className={cx('m-0', !stack && 'ml-auto text-right')}>{children}</Text>
    </div>
  );
}
