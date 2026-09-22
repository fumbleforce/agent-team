import { useCallback, useRef } from 'react';

// A feed keeps the reader in charge of the view: new lines arrive underneath, and the view glues to the end only while the
// reader is already there. Scrolled up to read, nothing yanks the view down; back near the end, it follows again.
export function usePinnedTail() {
  const container = useRef<HTMLDivElement>(null), pinned = useRef(true);
  const onScroll = useCallback(() => {
    const el = container.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);
  const follow = useCallback(() => {
    const el = container.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, []);
  const pin = useCallback(() => { pinned.current = true; }, []);
  return { container, onScroll, follow, pin };
}