import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePinnedTail } from './usePinnedTail';

// happy-dom has no layout, so the scroll geometry the hook reads is given to it directly on the element.
let position = 0;
const withGeometry = (el: HTMLElement, geometry: { scrollHeight: number; clientHeight: number }) => {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geometry.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geometry.clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => position, set: value => { position = value; } });
};

describe('usePinnedTail', () => {
  const Feed = () => {
    const tail = usePinnedTail();
    return <div ref={tail.container} onScroll={tail.onScroll} data-testid="feed" className="h-24 overflow-y-auto"><button type="button" onClick={tail.follow}>follow</button></div>;
  };

  it('follows the end while the reader is there, and stays put once they have scrolled up to read', () => {
    const { getByTestId, getByRole } = render(<Feed />);
    const el = getByTestId('feed');
    withGeometry(el, { scrollHeight: 1000, clientHeight: 100 });
    // At the bottom: the view follows.
    position = 900;
    fireEvent.scroll(el);
    fireEvent.click(getByRole('button', { name: 'follow' }));
    expect(position).toBe(1000);
    // Scrolled up to read: new content does not yank the view down.
    position = 200;
    fireEvent.scroll(el);
    fireEvent.click(getByRole('button', { name: 'follow' }));
    expect(position).toBe(200);
    // Back near the end: it follows again.
    position = 880;
    fireEvent.scroll(el);
    fireEvent.click(getByRole('button', { name: 'follow' }));
    expect(position).toBe(1000);
  });
});