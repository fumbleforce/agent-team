import { Button, type ButtonProps } from './Button';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';

// A square button that shows only an icon. The label names it for assistive technology and is the hint on hover.
export function IconButton({ icon, label, variant = 'ghost', hint = true, ...rest }: Omit<ButtonProps, 'children' | 'size' | 'aria-label'> & { icon: IconName; label: string; hint?: boolean }) {
  const button = <Button variant={variant} size="icon" aria-label={label} {...rest}><Icon name={icon} /></Button>;
  return hint ? <Tooltip content={label}>{button}</Tooltip> : button;
}
