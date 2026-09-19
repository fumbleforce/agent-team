import { newId } from '@agent-team/protocol';
import type { Context } from '../context.ts';
import { indexMessage } from '../knowledge/indexing.ts';

type Post = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

// Mirrors team discussion out to a chat channel. It starts from the head of the log at boot, so a restart never replays history.
// The token is read from the coordinator's environment by the name the connection gives; it is never stored.
export function createSlackMirror(context: Context, options: { env?: NodeJS.ProcessEnv; post?: Post } = {}) {
  const env = options.env ?? process.env, post = options.post ?? (fetch as unknown as Post);
  const db = context.storage.db;
  let cursor: number | null = null;

  return {
    async sync(): Promise<number> {
      cursor ??= await context.events.head();
      const events = (await context.events.read({ after: cursor, limit: 200 }));
      let sent = 0;
      for (const event of events) {
        cursor = event.seq;
        // What came in from the chat side is not sent back out.
        if (event.type !== 'message.posted' || !event.projectId || !event.threadId || event.payload.origin === 'slack') continue;
        const thread = await db.selectFrom('threads').select(['visibility', 'title']).where('id', '=', event.threadId).executeTakeFirst();
        if (thread?.visibility !== 'team') continue;
        const connection = await db.selectFrom('connections').select(['config', 'credential_ref']).where('kind', '=', 'slack').where('status', '=', 'connected').where(eb => eb.or([eb('project_id', '=', event.projectId), eb('project_id', 'is', null)])).executeTakeFirst();
        const token = connection?.credential_ref ? env[connection.credential_ref] : undefined;
        const channel = connection ? (JSON.parse(connection.config) as { channel?: string }).channel : undefined;
        if (!token || !channel) continue;
        const message = await db.selectFrom('messages').select(['body', 'kind', 'author_kind', 'author_id']).where('thread_id', '=', event.threadId).orderBy('seq', 'desc').executeTakeFirst();
        if (!message) continue;
        const agent = message.author_kind === 'agent' && message.author_id ? await db.selectFrom('agents').select('name').where('id', '=', message.author_id).executeTakeFirst() : null;
        const label = message.kind === 'decision' ? 'Decision — ' : '';
        const response = await post('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` }, body: JSON.stringify({ channel, text: `*${agent?.name ?? (message.author_kind === 'user' ? 'Owner' : 'System')}* (${thread.title}): ${label}${message.body}`.slice(0, 3000) }) }).catch(() => null);
        if (response?.ok) sent++;
      }
      return sent;
    },
  };
}

interface SocketLike { send(data: string): void; close(): void; onmessage: ((event: { data: unknown }) => void) | null; onclose: (() => void) | null }
type Open = (url: string) => SocketLike;

// Replies written in the chat channel come back into the project's discussion. Socket Mode is an outbound connection,
// so a coordinator on a private network needs no public address. Each envelope is acknowledged so it is not redelivered.
export function createSlackInbound(context: Context, options: { env?: NodeJS.ProcessEnv; post?: Post; open?: Open } = {}) {
  const env = options.env ?? process.env, post = options.post ?? (fetch as unknown as Post);
  const open = options.open ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const db = context.storage.db;

  async function receive(event: { type?: string; channel?: string; text?: string; user?: string; bot_id?: string; subtype?: string }) {
    // Only what a person wrote: the mirror's own posts and edits are skipped, or the two sides would echo each other.
    if (event.type !== 'message' || event.bot_id || event.subtype || !event.text?.trim() || !event.channel) return false;
    const connections = await db.selectFrom('connections').select(['project_id', 'config']).where('kind', '=', 'slack').where('status', '=', 'connected').execute();
    const connection = connections.find(row => { const config = JSON.parse(row.config) as { channel?: string; channelId?: string }; return config.channelId === event.channel || config.channel === event.channel; });
    if (!connection?.project_id) return false;
    const thread = await db.selectFrom('threads').select(['id', 'project_id']).where('project_id', '=', connection.project_id).where('kind', '=', 'discussion').executeTakeFirst();
    if (!thread) return false;
    const id = newId(context.now());
    const published = await context.storage.transaction(async tx => {
      await tx.insertInto('messages').values({ id, thread_id: thread.id, author_kind: 'user', author_id: null, kind: 'note', body: event.text!.slice(0, 8000), payload: JSON.stringify({ origin: 'slack', slackUser: event.user ?? null }), created_at: context.now() }).execute();
      await indexMessage(context.storage, tx, { id, threadId: thread.id, body: event.text!.slice(0, 8000) });
      return context.events.append(tx, [{ type: 'message.posted', actorKind: 'user', projectId: thread.project_id, threadId: thread.id, payload: { messageId: id, kind: 'note', origin: 'slack' } }]);
    });
    context.events.published(published);
    return true;
  }

  return {
    receive,
    // Opens the socket with the app-level token named by AGENT_TEAM_SLACK_APP_TOKEN; returns a function that closes it.
    async connect(): Promise<(() => void) | null> {
      const appToken = env.AGENT_TEAM_SLACK_APP_TOKEN;
      if (!appToken) return null;
      const response = await post('https://slack.com/api/apps.connections.open', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${appToken}` }, body: '' });
      const opened = await response.json() as { ok?: boolean; url?: string };
      if (!opened.ok || !opened.url) throw new Error('The chat service refused the socket connection');
      const socket = open(opened.url);
      socket.onmessage = message => {
        const envelope = JSON.parse(String(message.data)) as { envelope_id?: string; type?: string; payload?: { event?: Parameters<typeof receive>[0] } };
        if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (envelope.type === 'events_api' && envelope.payload?.event) void receive(envelope.payload.event).catch(error => console.error(`Inbound chat message failed: ${(error as Error).message}`));
      };
      return () => socket.close();
    },
  };
}
