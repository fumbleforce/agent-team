import { randomBytes } from 'node:crypto';
import type { Notifier, NotifierEntry } from './contract.ts';

// ntfy: a message posted to a topic reaches every phone and browser subscribed to it. The public server needs no account; a topic
// name that nobody can guess is the privacy, or a server of your own with an access token.
export const ntfy: NotifierEntry = {
  kind: 'ntfy', title: 'ntfy', summary: 'A push message on your phone or desktop through the ntfy app.',
  steps: ['Install the ntfy app on your phone (or open the server in a browser) and subscribe to the topic below.', 'Keep the topic name hard to guess: anyone who knows it can read what is sent to it. On a server of your own, add an access token.'],
  fields: [
    { key: 'server', label: 'Server', placeholder: 'https://ntfy.sh', required: true, pattern: 'https?://[^\\s]+' },
    { key: 'topic', label: 'Topic', placeholder: 'agent-team-…', required: true, pattern: '[A-Za-z0-9_-]{1,64}', suggest: () => `agent-team-${randomBytes(9).toString('base64url')}` },
  ],
  credential: { variable: 'NTFY_TOKEN', label: 'Access token', optional: true, placeholder: 'tk_…' },
  create(values, token, request): Notifier {
    const server = (values.server ?? 'https://ntfy.sh').replace(/\/+$/, ''), topic = values.topic ?? '';
    return {
      async send(notice) {
        // The JSON form carries any text safely; the header form would have to fit the title into a header.
        const response = await request(server, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ topic, title: notice.title.slice(0, 200), message: notice.body.slice(0, 3500), ...(notice.url ? { click: notice.url, actions: [{ action: 'view', label: 'Open', url: notice.url }] } : {}), priority: notice.urgent ? 4 : 3 }), signal: AbortSignal.timeout(15_000) })
          .catch(() => { throw new Error('ntfy could not be reached'); });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? `ntfy did not accept the access token (${response.status})` : `ntfy answered ${response.status}`);
      },
    };
  },
};
