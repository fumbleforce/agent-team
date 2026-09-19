import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Card, Checkbox, Chip, Dialog, Field, IconButton, Input, KeyValue, ListRow, Menu, Meter, Popover, Segmented, Select, SelectMenu, StatTile, Tabs, Text, Tooltip } from './index';

// Radix opens its menus on pointer and key events rather than click.
const open = (trigger: HTMLElement) => { trigger.focus(); fireEvent.keyDown(trigger, { key: 'Enter' }); };

describe('primitives', () => {
  it('Text maps size and tone to token classes and never to raw values', () => {
    render(<Text size="title" tone="muted">Heading</Text>);
    const node = screen.getByText('Heading');
    expect(node.className).toContain('text-title');
    expect(node.className).toContain('text-ink-muted');
    expect(node.className).not.toMatch(/\[|#/);
  });

  it('Button defaults to type=button so it never submits a form by accident', () => {
    const submit = vi.fn();
    render(<form onSubmit={submit}><Button>Plain</Button></form>);
    fireEvent.click(screen.getByRole('button', { name: 'Plain' }));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('IconButton is named by its label', () => {
    const click = vi.fn();
    render(<IconButton icon="close" label="Dismiss" onClick={click} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(click).toHaveBeenCalledOnce();
  });

  it('Meter reports a clamped percentage', () => {
    render(<Meter value={1.4} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('140');
    expect((screen.getByRole('progressbar').firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('Card, Chip, StatTile and KeyValue render their content', () => {
    render(<Card tone="decision"><Chip tone="stop">blocked</Chip><StatTile label="Spend" value="€ 392" note="of € 600" /><dl><KeyValue label="Branch" mono>task/ck-28</KeyValue></dl></Card>);
    expect(screen.getByText('blocked').className).toContain('bg-stop-wash');
    expect(screen.getByText('€ 392')).toBeTruthy();
    expect(screen.getByText('task/ck-28').tagName).toBe('DD');
  });

  it('Field ties its label to the control and shows the error', () => {
    render(<Field label="Email" error="Required"><Input /></Field>);
    expect(screen.getByLabelText(/Email/)).toBeTruthy();
    expect(screen.getByText('Required')).toBeTruthy();
  });

  it('the native Select keeps working with option children', () => {
    const change = vi.fn();
    render(<Select aria-label="Billing" defaultValue="metered" onChange={event => change(event.target.value)}><option>metered</option><option>local</option></Select>);
    fireEvent.change(screen.getByLabelText('Billing'), { target: { value: 'local' } });
    expect(change).toHaveBeenCalledWith('local');
  });

  it('Checkbox toggles through its label', () => {
    const change = vi.fn();
    render(<Checkbox label="Publishing authorized" onChange={event => change(event.target.checked)} />);
    fireEvent.click(screen.getByLabelText('Publishing authorized'));
    expect(change).toHaveBeenCalledWith(true);
  });

  it('Segmented marks the chosen option and reports a change', () => {
    const change = vi.fn();
    render(<Segmented value="week" onChange={change} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }]} />);
    expect(screen.getByRole('radio', { name: '7 days' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Today' }));
    expect(change).toHaveBeenCalledWith('today');
  });

  it('Tabs mark the current page; an external tab opens its address in a new browser tab', () => {
    render(<Tabs items={[{ label: 'Tasks', href: '/p/x/tasks', active: true }, { label: 'Issues', href: '/p/x/issues' }, { label: 'Calendar', href: 'https://calendar.example.com', external: true }]} />);
    expect(screen.getByRole('link', { name: 'Tasks' }).getAttribute('aria-current')).toBe('page');
    const outside = screen.getByRole('link', { name: /Calendar/ });
    expect([outside.getAttribute('href'), outside.getAttribute('target'), outside.getAttribute('rel'), outside.getAttribute('aria-current')]).toEqual(['https://calendar.example.com', '_blank', 'noreferrer noopener', null]);
  });

  it('ListRow is a link, a button or plain depending on what it is given', () => {
    const click = vi.fn();
    render(<><ListRow title="Link" href="/org" /><ListRow title="Press" onClick={click} active /><ListRow title="Plain" /></>);
    expect(screen.getByRole('link', { name: 'Link' }).getAttribute('href')).toBe('/org');
    fireEvent.click(screen.getByRole('button', { name: 'Press' }));
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Press' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('overlay wrappers', () => {
  it('Menu opens from its trigger, runs the chosen item and skips disabled ones', () => {
    const reassign = vi.fn(), never = vi.fn();
    render(<Menu trigger={<Button>Actions</Button>} label="CK-28" items={[{ label: 'Reassign', onSelect: reassign }, 'separator', { label: 'Locked', onSelect: never, disabled: true }]} />);
    expect(screen.queryByRole('menu')).toBeNull();
    open(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('CK-28')).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Locked' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reassign' }));
    expect(reassign).toHaveBeenCalledOnce();
    expect(never).not.toHaveBeenCalled();
  });

  it('SelectMenu shows the chosen label and reports a new choice', () => {
    const change = vi.fn();
    render(<SelectMenu label="Billing" value="metered" onChange={change} options={[{ value: 'metered', label: 'Metered' }, { value: 'local', label: 'Local' }]} />);
    const trigger = screen.getByRole('combobox', { name: 'Billing' });
    expect(trigger.textContent).toContain('Metered');
    open(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Local' }));
    expect(change).toHaveBeenCalledWith('local');
  });

  it('Dialog is labelled by its title, shows its footer and closes', () => {
    function Host() { const [shown, setShown] = useState(true); return <Dialog open={shown} onOpenChange={setShown} title="Retire this agent?" description="Open work returns to the backlog." footer={<Button>Retire</Button>}>Body</Dialog>; }
    render(<Host />);
    const dialog = screen.getByRole('dialog', { name: 'Retire this agent?' });
    expect(within(dialog).getByText('Open work returns to the backlog.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Retire' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a bare Dialog keeps an accessible title without drawing a header', () => {
    render(<Dialog open title="Navigation" place="left"><nav>links</nav></Dialog>);
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('Popover shows its content when the trigger is pressed', () => {
    render(<Popover trigger={<Button>Budget</Button>}>€ 392 of € 600</Popover>);
    expect(screen.queryByText('€ 392 of € 600')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Budget' }));
    expect(screen.getByText('€ 392 of € 600')).toBeTruthy();
  });

  it('Tooltip appears when its trigger takes focus', () => {
    render(<Tooltip content="Copies the link"><Button>Copy</Button></Tooltip>);
    fireEvent.focus(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('tooltip').textContent).toBe('Copies the link');
  });
});
