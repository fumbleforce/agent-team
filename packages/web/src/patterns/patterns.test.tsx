import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { Agent, Message as MessageData, ProjectNode } from '../data/client';
import { AppShell, CommandPalette, Composer, EmptyState, EntityLink, Markdown, mentionOptions, Message, openPalette, renderMarkdown } from './index';

// DOMPurify walks the tree with DOM APIs that happy-dom only approximates (it removes every node there), so the sanitizer
// is a pass-through here and these tests check that all markup goes through it. What it strips in a real browser is
// asserted by e2e/smoke.spec.ts against the gallery.
const { sanitize, purify } = vi.hoisted(() => {
  const sanitize = vi.fn((html: string, _policy: { ALLOWED_TAGS: string[]; ALLOWED_ATTR: string[] }) => html);
  return { sanitize, purify: { sanitize, addHook: vi.fn(), isSupported: true } };
});
vi.mock('dompurify', () => ({ default: purify }));

const agent = (id: string, name: string, title: string): Agent => ({ id, name, initials: name.slice(0, 2).toUpperCase(), tint: '1', title, persona: '', status: 'active', provider_id: null, model: null, is_pm: false, doing: null });
const ROSTER = [agent('a1', 'Maren', 'PM'), agent('a2', 'Cleo Vance', 'QA'), agent('a3', 'Milo', 'QA')];
const PROJECTS: ProjectNode[] = [{ id: 'p1', slug: 'web-shop', name: 'Web shop', kind: 'repo', status: 'active', team: null, progress: 0.5, subprojects: [{ id: 'p2', slug: 'checkout-v2', name: 'Checkout v2', progress: 0.2 }] }];

describe('Markdown', () => {
  it('parses the usual block and inline forms and hands them to the sanitizer with the allow-list', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    for (const part of ['<h1>Title</h1>', '<strong>bold</strong>', '<code>code</code>', '<li>one</li>', '<table>']) expect(html).toContain(part);
    const [, policy] = sanitize.mock.calls.at(-1)!;
    expect(policy.ALLOWED_TAGS).toContain('table');
    for (const tag of ['script', 'style', 'iframe', 'form', 'object', 'svg']) expect(policy.ALLOWED_TAGS).not.toContain(tag);
    for (const attribute of ['style', 'class', 'onclick', 'srcset']) expect(policy.ALLOWED_ATTR).not.toContain(attribute);
  });

  it('renders only what the sanitizer returns', () => {
    sanitize.mockReturnValueOnce('<p>kept</p>');
    const { container } = render(<Markdown>{'dropped <script>window.hacked = true</script>'}</Markdown>);
    expect(container.textContent).toBe('kept');
    expect(sanitize.mock.calls.at(-1)![0]).toContain('dropped');
  });

  it('shows the source as plain text where the sanitizer cannot run', () => {
    purify.isSupported = false;
    try { expect(renderMarkdown('<b>x</b>')).toBe('&#60;b&#62;x&#60;/b&#62;'); } finally { purify.isSupported = true; }
  });
});

describe('Message', () => {
  const message = (kind: string, body: string, payload: Record<string, unknown> = {}): MessageData => ({ id: kind, seq: 1, authorKind: 'agent', authorId: 'a1', kind, body, payload, createdAt: 0 });
  const author = { name: 'Maren', initials: 'MA', tint: '1', role: 'PM' };

  it('renders the body as markdown, the stance chip and the decision mark', () => {
    const { container } = render(<><Message author={author} message={message('feedback', 'Hides a **real** failure', { stance: 'against' })} /><Message author={author} message={message('decision', 'Ship it')} /></>);
    expect(container.querySelector('strong')?.textContent).toBe('real');
    expect(screen.getByText('against')).toBeTruthy();
    expect(screen.getByText('Decision')).toBeTruthy();
  });
});

describe('Composer', () => {
  it('sends the trimmed body on Ctrl + Enter and clears itself', async () => {
    const send = vi.fn(async () => {});
    render(<Composer placeholder="Write" action="Send" onSend={send} />);
    const box = screen.getByRole('textbox', { name: 'Write' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '  hello  ' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(send).toHaveBeenCalledWith('hello', []));
    await waitFor(() => expect(box.value).toBe(''));
  });

  it('offers agents and roles for an @word and completes the chosen one', () => {
    const options = mentionOptions(ROSTER);
    expect(options.map(option => `${option.kind}:${option.token}`)).toEqual(['agent:maren', 'agent:cleo', 'agent:milo', 'role:pm', 'role:qa']);
    render(<Composer placeholder="Write" action="Send" onSend={async () => {}} mentions={options} />);
    const box = screen.getByRole('textbox', { name: 'Write' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'ask @m', selectionStart: 6 } });
    const list = screen.getByRole('listbox', { name: 'Mention' });
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual([expect.stringContaining('Maren'), expect.stringContaining('Milo')]);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('ask @milo ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('matches a role by its token and closes on Escape', () => {
    render(<Composer placeholder="Write" action="Send" onSend={async () => {}} mentions={mentionOptions(ROSTER)} />);
    const box = screen.getByRole('textbox', { name: 'Write' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@q', selectionStart: 2 } });
    expect(screen.getByRole('option').textContent).toContain('@qa');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(box, { target: { value: 'mail me@q', selectionStart: 9 } });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('stores a pasted image, lists it, lets it be removed and sends the ids of what is left', async () => {
    const send = vi.fn(async () => {});
    let next = 0;
    const attach = vi.fn(async (file: File) => ({ id: `att-${++next}`, name: file.name }));
    render(<Composer placeholder="Write" action="Send" onSend={send} onAttach={attach} />);
    const box = screen.getByRole('textbox', { name: 'Write' });
    const files = [new File(['x'], 'one.png', { type: 'image/png' }), new File(['y'], 'two.png', { type: 'image/png' }), new File(['z'], 'notes.txt', { type: 'text/plain' })];
    fireEvent.paste(box, { clipboardData: { files } });
    await screen.findByText('two.png');
    expect(attach).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove one.png' }));
    fireEvent.change(box, { target: { value: 'see this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith('see this', ['att-2']));
  });

  it('says why an image could not be attached', async () => {
    render(<Composer placeholder="Write" action="Send" onSend={async () => {}} onAttach={async () => { throw new Error('Too large'); }} />);
    fireEvent.paste(screen.getByRole('textbox', { name: 'Write' }), { clipboardData: { files: [new File(['x'], 'big.png', { type: 'image/png' })] } });
    expect(await screen.findByText('Too large')).toBeTruthy();
  });
});

describe('CommandPalette', () => {
  const mount = () => {
    const location = memoryLocation({ path: '/', record: true });
    render(<Router hook={location.hook}><CommandPalette projects={PROJECTS} agents={ROSTER} pages={[{ href: '/p/web-shop/knowledge/k1', label: 'Runbook', note: 'ops/runbook.md' }]} screens={[{ href: '/costs', label: 'Costs' }]} /></Router>);
    return location;
  };

  it('opens on Ctrl + K, lists every group and closes on the same keys', async () => {
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    for (const name of ['Web shop', 'Checkout v2', 'Maren', 'Runbook', 'Costs']) expect(within(dialog).getAllByText(name).length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters as you type and goes to the chosen entry', async () => {
    const location = mount();
    act(() => openPalette());
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'cleo' } });
    await waitFor(() => expect(screen.queryByText('Web shop')).toBeNull());
    fireEvent.click(screen.getByText('Cleo Vance'));
    expect(location.history?.at(-1)).toBe('/agents/a2');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when nothing matches', async () => {
    mount();
    act(() => openPalette());
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'zzzz' } });
    expect(await screen.findByText('Nothing matches.')).toBeTruthy();
  });
});

describe('AppShell', () => {
  it('offers the sidebar as a drawer and the rail as a tab for narrow screens', () => {
    const location = memoryLocation({ path: '/', record: true });
    render(<Router hook={location.hook}><AppShell sidebar={<nav aria-label="Projects">tree</nav>} rail={<div>thread</div>} railLabel="Discussion"><p>board</p></AppShell></Router>);
    expect(screen.getAllByRole('navigation', { name: 'Projects' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getByRole('navigation', { name: 'Projects' })).toBeTruthy();
    act(() => location.navigate('/org'));
    expect(screen.queryByRole('dialog')).toBeNull();

    const rail = screen.getByRole('tab', { name: 'Discussion' });
    expect(rail.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(rail);
    expect(rail.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('main', { hidden: true }).className).toContain('hidden');
  });

  it('has no pane tabs without a rail', () => {
    render(<AppShell sidebar={<nav>tree</nav>}><p>board</p></AppShell>);
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});

describe('EntityLink and EmptyState', () => {
  it('link to the entity with its key, and state what is missing with an action', () => {
    render(<><EntityLink kind="task" href="/p/web-shop/tasks" code="CK-28">Fix double-submit</EntityLink><EmptyState title="No pages yet" note="Agents write them as they learn."><button type="button">Write one</button></EmptyState></>);
    expect(screen.getByRole('link', { name: /CK-28.*Fix double-submit/ }).getAttribute('href')).toBe('/p/web-shop/tasks');
    expect(screen.getByRole('heading', { name: 'No pages yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Write one' })).toBeTruthy();
  });
});
