import type { EventBusPort } from '../contract.ts';

// In-process fan-out for a single coordinator process.
export function createBus(): EventBusPort {
  const listeners = new Set<(seq: number) => void>();
  return {
    notify(seq) { for (const listener of listeners) listener(seq); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
