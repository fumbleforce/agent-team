import { Close, Content, Description, Overlay, Portal, Root, Title, Trigger } from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon } from './Icon';

const PLACE = {
  center: 'top-1/2 left-1/2 flex max-h-5/6 w-11/12 max-w-120 -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-card border border-line-strong bg-card p-5',
  top: 'top-24 left-1/2 w-11/12 max-w-140 -translate-x-1/2 overflow-hidden rounded-card border border-line-strong bg-card',
  left: 'inset-y-0 left-0 flex max-w-5/6 border-r border-line bg-rail',
} as const;

export interface DialogProps { open?: boolean; onOpenChange?(open: boolean): void; trigger?: ReactNode; title: string; description?: string; place?: keyof typeof PLACE; bare?: boolean; footer?: ReactNode; children: ReactNode }

// A modal layer. `center` is the ordinary dialog, `top` holds the command palette and `left` is the drawer of the narrow shell.
// `bare` keeps the title for assistive technology only and leaves the whole surface to the children.
export function Dialog({ open, onOpenChange, trigger, title, description, place = 'center', bare = place !== 'center', footer, children }: DialogProps) {
  return (
    <Root {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      {trigger && <Trigger asChild>{trigger}</Trigger>}
      <Portal>
        <Overlay className="fixed inset-0 z-40 bg-ground/70" />
        <Content {...(description ? {} : { 'aria-describedby': undefined })} className={cx('fixed z-50 shadow-lg outline-none', PLACE[place])}>
          {bare ? <Title className="sr-only">{title}</Title> : (
            <div className="flex items-start gap-3">
              <div className="flex min-w-0 grow flex-col gap-1">
                <Title className="m-0 text-title font-semibold tracking-tight text-ink">{title}</Title>
                {description && <Description className="m-0 text-small text-ink-muted">{description}</Description>}
              </div>
              <Close aria-label="Close" className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-muted hover:bg-active hover:text-ink"><Icon name="close" /></Close>
            </div>
          )}
          {bare && description && <Description className="sr-only">{description}</Description>}
          {bare ? children : <div className="min-h-0 overflow-y-auto">{children}</div>}
          {footer && <div className="flex justify-end gap-2">{footer}</div>}
        </Content>
      </Portal>
    </Root>
  );
}
