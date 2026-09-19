import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

// A short hint on hover or focus. It carries its own provider so a caller never has to mount one.
export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Provider delayDuration={300}>
      <Root>
        <Trigger asChild>{children}</Trigger>
        <Portal><Content side={side} sideOffset={5} className="z-50 max-w-60 rounded-chip border border-line-strong bg-active px-2 py-1 text-caption text-ink shadow-lg">{content}</Content></Portal>
      </Root>
    </Provider>
  );
}
