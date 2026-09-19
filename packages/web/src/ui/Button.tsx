import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

const VARIANT = {
  primary: 'bg-accent text-on-accent font-semibold border border-transparent hover:brightness-110',
  secondary: 'bg-raised text-ink border border-line-strong hover:bg-active',
  ghost: 'bg-transparent text-ink-soft border border-transparent hover:bg-active',
  dashed: 'bg-transparent text-ink-muted border border-dashed border-line-dashed hover:text-ink',
  danger: 'bg-stop-wash text-stop-ink border border-stop/40 hover:brightness-110',
} as const;
const SIZE = { sm: 'h-6 px-2 text-caption rounded-control', md: 'h-7.5 px-3 text-small rounded-control', icon: 'size-7 justify-center rounded-control' } as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: keyof typeof VARIANT; size?: keyof typeof SIZE; block?: boolean; children?: ReactNode }

// The same control for a navigation or a download: an anchor that looks like its button.
export function LinkButton({ variant = 'secondary', size = 'md', className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: keyof typeof VARIANT; size?: keyof typeof SIZE }) {
  return <a className={cx('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap no-underline cursor-pointer', VARIANT[variant], SIZE[size], className)} {...rest} />;
}

export function Button({ variant = 'secondary', size = 'md', block, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={cx('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap disabled:opacity-50 cursor-pointer', VARIANT[variant], SIZE[size], block && 'w-full justify-center', className)} {...rest} />;
}
