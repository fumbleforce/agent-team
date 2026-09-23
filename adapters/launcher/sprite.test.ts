import test from 'node:test';
import assert from 'node:assert/strict';
import { create, jobScript } from './sprite.ts';

// A Sprites API that remembers its Sprites and files, and answers a service's status.
function api() {
  const calls: { method: string; url: string; body: string }[] = [], sprites = new Set<string>(), files = new Map<string, { body: string; mode: string | null }>();
  let service = 'running';
  const fake = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ method, url: String(input), body });
    const sprite = /\/v1\/sprites\/([^/?]+)/.exec(url.pathname)?.[1];
    if (method === 'GET' && /\/services\//.test(url.pathname)) return new Response(JSON.stringify({ name: 'agent-team-worker', state: { status: service } }));
    if (method === 'GET' && sprite) return sprites.has(sprite) ? new Response(JSON.stringify({ name: sprite, status: 'cold' })) : new Response('{}', { status: 404 });
    if (method === 'POST' && url.pathname === '/v1/sprites') { sprites.add((JSON.parse(body) as { name: string }).name); return new Response('{}', { status: 201 }); }
    if (method === 'PUT' && url.pathname.endsWith('/fs/write')) { files.set(url.searchParams.get('path')!, { body, mode: url.searchParams.get('mode') }); return new Response('{}'); }
    return new Response('{"type":"complete"}\n');
  }) as typeof fetch;
  return { calls, sprites, files, fetch: fake, stopService: () => { service = 'stopped'; } };
}
const publish = { scm: 'github', repository: 'acme/shop', base: 'main' };

test('a Sprite worker is refused unless publishing is authorized, as a worker run once must push its work', async () => {
  const sprites = api();
  const launcher = create({ spriteToken: 'sprite-token', fetch: sprites.fetch, coordinatorUrl: 'https://team.example', publish, manifest: { publishAuthorized: false } });
  await assert.rejects(launcher.start({ id: 'job-1', projectId: 'shop', token: 'job-token' }), /ephemeral sprite worker is refused: the project manifest does not authorize publishing/);
  assert.equal(sprites.calls.length, 0);
});

test('a Sprite is made once per project and kept; each launch writes its settings privately and runs the worker once, held awake', async () => {
  const sprites = api();
  const launcher = create({ spriteToken: 'sprite-token', fetch: sprites.fetch, coordinatorUrl: 'https://team.example', publish, manifest: { publishAuthorized: true }, codeToken: 'gh-secret', engine: 'claude' });
  const handle = await launcher.start({ id: 'job-1', projectId: 'shop', token: 'job-token' });
  assert.deepEqual([handle.kind, handle.instanceId], ['sprite', 'at-shop']);
  await launcher.start({ id: 'job-2', projectId: 'shop', token: 'job-token-2' });
  assert.equal(sprites.calls.filter(call => call.method === 'POST' && call.url.endsWith('/v1/sprites')).length, 1, 'the Sprite is made once and kept');
  const env = sprites.files.get('/home/sprite/agent-team/worker.env')!;
  assert.deepEqual([env.body, env.mode], ['AGENT_TEAM_TOKEN=job-token-2\nGH_TOKEN=gh-secret\n', '0600']);
  const config = JSON.parse(sprites.files.get('/home/sprite/agent-team/worker.json')!.body);
  assert.deepEqual([config.coordinatorUrl, config.projects.shop, config.publish.repository], ['https://team.example', '/home/sprite/agent-team/checkout', 'acme/shop']);
  assert.ok(!sprites.calls.some(call => /job-token|gh-secret/.test(call.url)), 'no secret is in an address');
  assert.deepEqual(sprites.calls.slice(-2).map(call => [call.method, new URL(call.url).pathname]), [['PUT', '/v1/sprites/at-shop/services/agent-team-worker'], ['POST', '/v1/sprites/at-shop/services/agent-team-worker/start']]);
  assert.deepEqual(await launcher.status(handle), { state: 'running' });
  sprites.stopService();
  assert.deepEqual(await launcher.status(handle), { state: 'stopped' });
  assert.deepEqual(await launcher.stop(handle), { stopped: true });
  assert.ok(!sprites.calls.some(call => call.method === 'DELETE'), 'the Sprite is never deleted');
});

test('the job script holds the Sprite awake for the turn, runs the worker once, and never twice for one job', () => {
  const script = jobScript({ job: { id: 'job-7', projectId: 'shop' }, toolkit: 'https://github.com/fumbleforce/agent-team.git', toolkitRef: 'abc123', repository: 'https://github.com/acme/shop.git', setup: 'npm ci', engine: 'claude' });
  assert.match(script, /\[ -e 'done-job-7' \] && exit 0/);
  assert.match(script, /--unix-socket \/\.sprite\/api\.sock -X POST http:\/\/sprite\/v1\/tasks .*"expire":"5m"/);
  assert.match(script, /while sleep 60; do curl .* -X PUT http:\/\/sprite\/v1\/tasks\/agent-team-turn/);
  assert.match(script, /trap .*-X DELETE http:\/\/sprite\/v1\/tasks\/agent-team-turn/);
  assert.match(script, /node toolkit\/packages\/worker\/src\/main\.ts --config \/home\/sprite\/agent-team\/worker\.json --once --job 'job-7'/);
  assert.ok(script.indexOf('--once') < script.indexOf("touch 'done-job-7'"));
});
