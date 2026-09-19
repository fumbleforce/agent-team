import type { EventBusPort } from '../contract.ts';
import { createBus } from '../shared/bus.ts';

export const CHANNEL = 'agent_team_events';
const RECONNECT_MS = 1000;

// A notification says which process appended and how far the log got. Our own come back to us too and are dropped:
// local listeners already heard them in-process. Anything unreadable is dropped as well; the channel is not a trust boundary we parse loosely.
export const encode = (origin: string, seq: number) => `${origin}:${seq}`;
export function decode(payload: string | undefined, self: string): number | null {
  const match = /^([A-Za-z0-9_-]{1,64}):(\d{1,15})$/.exec(payload ?? '');
  return match && match[1] !== self ? Number(match[2]) : null;
}

// The part of a database client the listener needs; the real one is a direct connection, never one from the pool:
// a pooled connection goes back to the pool and a transaction pooler forgets LISTEN.
export interface ListenerClient {
  on(event: 'notification', handler: (message: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error' | 'end', handler: () => void): unknown;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface SharedBus extends EventBusPort { ready(): Promise<boolean>; stop(): Promise<void> }

// In-process fan-out plus the database's channel, so another coordinator process on the same database wakes its listeners too.
// The channel is a wake-up, not the record: whoever hears it reads the event log from where it left off, so after a dropped
// connection one wake-up with the last known position is enough to catch up.
export function createSharedBus(options: { origin: string; connect(): Promise<ListenerClient>; send(payload: string): Promise<void>; reconnectMs?: number }): SharedBus {
  const local = createBus();
  let client: ListenerClient | null = null, stopped = false, last = 0, timer: NodeJS.Timeout | null = null;

  async function open(): Promise<boolean> {
    let next: ListenerClient | null = null;
    try {
      const opened = next = await options.connect();
      const lost = () => { if (client !== opened) return; client = null; retry(); };
      opened.on('notification', message => { const seq = message.channel === CHANNEL ? decode(message.payload, options.origin) : null; if (seq !== null) { last = Math.max(last, seq); local.notify(seq); } });
      opened.on('error', lost);
      opened.on('end', lost);
      await opened.query(`listen ${CHANNEL}`);
      if (stopped) throw new Error('stopped');
      client = opened;
      return true;
    } catch { await next?.end().catch(() => {}); retry(); return false; }
  }
  function retry() {
    if (stopped || timer) return;
    timer = setTimeout(async () => { timer = null; if (await open()) local.notify(last); }, options.reconnectMs ?? RECONNECT_MS);
    timer.unref();
  }
  const first = open();

  return {
    notify(seq) { last = Math.max(last, seq); local.notify(seq); options.send(encode(options.origin, seq)).catch(() => {}); },
    subscribe: local.subscribe,
    ready: () => first,
    async stop() { stopped = true; if (timer) clearTimeout(timer); await first; const open = client; client = null; await open?.end().catch(() => {}); },
  };
}
