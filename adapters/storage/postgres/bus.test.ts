import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL, createSharedBus, decode, encode, type ListenerClient } from './bus.ts';

type Handler = (message: { channel: string; payload?: string }) => void;
function fakeClient() {
  const handlers: Record<string, ((...args: never[]) => void)[]> = {}, queries: string[] = [];
  const client = { ended: false, queries, on(event: string, handler: (...args: never[]) => void) { (handlers[event] ??= []).push(handler); }, async query(text: string) { queries.push(text); }, async end() { client.ended = true; } };
  const deliver = (channel: string, payload?: string) => { for (const handler of handlers.notification ?? []) (handler as unknown as Handler)({ channel, ...(payload === undefined ? {} : { payload }) }); };
  return { client, deliver, drop: () => { for (const handler of handlers.end ?? []) (handler as () => void)(); } };
}

test('a payload names its process and a position; our own and anything malformed are dropped', () => {
  assert.equal(encode('proc-a', 41), 'proc-a:41');
  assert.equal(decode('proc-a:41', 'proc-b'), 41);
  assert.equal(decode('proc-a:41', 'proc-a'), null);
  for (const payload of [undefined, '', '41', 'proc-a:', 'proc-a:-1', 'proc-a:4.5', 'proc-a:41:9', 'proc a:41', 'proc-a:1e9', `proc-a:${'9'.repeat(16)}`, '{"seq":41}']) assert.equal(decode(payload, 'proc-b'), null, String(payload));
});

test('the shared bus hears other processes on the channel, tells them of ours, and delivers ours once', async () => {
  const { client, deliver } = fakeClient(), sent: string[] = [], heard: number[] = [];
  const bus = createSharedBus({ origin: 'proc-a', connect: async () => client as unknown as ListenerClient, send: async payload => { sent.push(payload); } });
  assert.equal(await bus.ready(), true);
  assert.deepEqual(client.queries, [`listen ${CHANNEL}`]);
  const unsubscribe = bus.subscribe(seq => heard.push(seq));

  bus.notify(7);
  deliver(CHANNEL, 'proc-a:7');
  deliver(CHANNEL, 'proc-b:9');
  deliver('another_channel', 'proc-b:10');
  deliver(CHANNEL, 'not a payload');
  deliver(CHANNEL);
  assert.deepEqual([heard, sent], [[7, 9], ['proc-a:7']]);

  unsubscribe();
  deliver(CHANNEL, 'proc-b:11');
  assert.deepEqual(heard, [7, 9]);
  await bus.stop();
  assert.equal(client.ended, true);
});

test('without a listener connection the bus still works in-process, and a failed send is not an error', async () => {
  const heard: number[] = [];
  const bus = createSharedBus({ origin: 'proc-a', connect: async () => { throw new Error('one connection at a time'); }, send: async () => { throw new Error('down'); } });
  assert.equal(await bus.ready(), false);
  bus.subscribe(seq => heard.push(seq));
  bus.notify(3);
  assert.deepEqual(heard, [3]);
  await bus.stop();
});

test('after a dropped connection the bus listens again and wakes its listeners once to catch up', async () => {
  const clients = [fakeClient(), fakeClient()], heard: number[] = [];
  let opened = 0;
  const bus = createSharedBus({ origin: 'proc-a', reconnectMs: 5, connect: async () => clients[opened++]!.client as unknown as ListenerClient, send: async () => {} });
  await bus.ready();
  bus.subscribe(seq => heard.push(seq));
  clients[0]!.deliver(CHANNEL, 'proc-b:20');
  clients[0]!.drop();
  for (let waited = 0; opened < 2 && waited < 2000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(heard, [20, 20]);
  clients[1]!.deliver(CHANNEL, 'proc-b:21');
  assert.deepEqual(heard, [20, 20, 21]);
  await bus.stop();
  assert.equal(clients[1]!.client.ended, true);
});
