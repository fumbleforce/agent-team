import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useResource } from './useResource';

const { api } = vi.hoisted(() => ({ api: vi.fn<(path: string) => Promise<unknown>>() }));
vi.mock('./client', () => ({ api }));

beforeEach(() => api.mockReset());

describe('useResource', () => {
  const Probe = () => {
    const view = useResource<{ items: string[] }>('/feed');
    return <>
      <ul>{(view.data?.items ?? []).map(item => <li key={item}>{item}</li>)}{view.error && <li>failed</li>}</ul>
      <button type="button" onClick={() => view.reload()}>reload</button>
    </>;
  };

  it('keeps what is on screen when a reload of the same view fails, and says the reload failed', async () => {
    api.mockResolvedValueOnce({ items: ['one'] });
    render(<Probe />);
    await waitFor(() => expect(screen.getByRole('list').textContent).toBe('one'));
    api.mockRejectedValueOnce(new Error('network blip'));
    fireEvent.click(screen.getByRole('button', { name: 'reload' }));
    await waitFor(() => expect(screen.getByRole('list').textContent).toBe('onefailed'), { timeout: 100 });
  });

  it('replaces the view when the next reload succeeds', async () => {
    api.mockResolvedValueOnce({ items: ['one'] }).mockResolvedValueOnce({ items: ['one', 'two'] });
    render(<Probe />);
    await waitFor(() => expect(screen.getByRole('list').textContent).toBe('one'));
    fireEvent.click(screen.getByRole('button', { name: 'reload' }));
    await waitFor(() => expect(screen.getByRole('list').textContent).toBe('onetwo'), { timeout: 100 });
  });

  it('shows nothing when the first load of a path fails', async () => {
    api.mockRejectedValueOnce(new Error('no route'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByRole('list').textContent).toBe('failed'), { timeout: 100 });
  });
});