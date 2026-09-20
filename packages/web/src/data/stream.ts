import { useEffect, useRef } from 'react';
import type { StreamEvent } from './client';

type Listener = (event: StreamEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let cursor = 0;

// One connection per tab. The browser reconnects by itself and sends Last-Event-ID, so the server backfills.
export function startStream(fromSeq: number) {
  cursor = Math.max(cursor, fromSeq);
  if (source) return;
  source = new EventSource(`/api/stream?after=${cursor}`);
  source.onmessage = message => {
    const event = JSON.parse(message.data as string) as StreamEvent;
    cursor = Math.max(cursor, event.seq);
    for (const listener of listeners) listener(event);
  };
}

// The thread an event is about: on the envelope for what is said in it, in the payload for work scheduled on it,
// which stays visible to the whole team rather than only to a private thread's owner.
export const threadOf = (event: StreamEvent): string | null => event.threadId ?? (typeof event.payload.threadId === 'string' ? event.payload.threadId : null);

// Calls `onEvent` for stream events that pass `match`; the view refetches or patches its own state.
export function useStream(match: (event: StreamEvent) => boolean, onEvent: (event: StreamEvent) => void) {
  const latest = useRef({ match, onEvent });
  latest.current = { match, onEvent };
  useEffect(() => {
    const listener: Listener = event => { if (latest.current.match(event)) latest.current.onEvent(event); };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
}
