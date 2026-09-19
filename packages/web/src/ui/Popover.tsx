import { Content, Portal, Root, Trigger } from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { FLOATING } from './Menu';

// Free content anchored to its trigger. `trigger` must be a single element that takes a ref, such as Button.
export function Popover({ trigger, children, align = 'start', side = 'bottom', open, onOpenChange, label }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'center' | 'end'; side?: 'top' | 'bottom' | 'left' | 'right'; open?: boolean; onOpenChange?(open: boolean): void; label?: string }) {
  return (
    <Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <Trigger asChild>{trigger}</Trigger>
      <Portal><Content align={align} side={side} sideOffset={6} aria-label={label} className={cx(FLOATING, 'max-w-80 p-3 text-small text-ink-soft')}>{children}</Content></Portal>
    </Root>
  );
}
