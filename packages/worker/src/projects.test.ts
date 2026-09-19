import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjects } from './projects.ts';

const ID = '01a0ba35-340e-7141-bb58-62ef077aff59';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('a project named the way people name it is looked up; an id is taken as it is; a name that appears late is waited for', async () => {
  let asked = 0;
  const fake = (async (url: string | URL) => { asked++; return String(url).endsWith('/machine/projects/web-shop') ? (asked < 3 ? json({}, 404) : json({ id: ID })) : json({}, 404); }) as typeof fetch;
  const found = await resolveProjects({ 'web-shop': '/code/shop', [ID.replace('01a0', '01a1')]: '/code/other', ghost: '/nowhere' }, { coordinatorUrl: 'http://c', token: 't', fetch: fake, waitMs: 400, pauseMs: 20 });
  assert.deepEqual(found.projects, { [ID]: '/code/shop', [ID.replace('01a0', '01a1')]: '/code/other' });
  assert.deepEqual(found.unknown, ['ghost']);
  await assert.rejects(resolveProjects({ x: '/y' }, { coordinatorUrl: 'http://c', token: 'bad', fetch: (async () => json({}, 401)) as typeof fetch }), /refused/);
});
