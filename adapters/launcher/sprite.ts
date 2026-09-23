import type { LaunchHandle, LaunchJob, Launcher } from './contract.ts';
import { refusal, type Ec2Options } from './ec2.ts';

// One Sprite per project (Fly's VMs for agents): a disk that is kept, a sleep that costs only that disk, a wake in a second or two. The
// Sprite keeps the toolkit, the checkout and its worktrees, and the engines' sign-ins between turns, so a turn starts without cloning or
// signing in. Each launch writes the worker's settings and a token of its own to private files and starts a supervised service that runs
// the worker for one turn, holding the Sprite awake while it works (a hold of five minutes, renewed every minute, let go at the end).
// Stopping stops the service; the Sprite is never deleted by the platform. The API's token comes from SPRITE_TOKEN on the control plane.
export const NAME = 'sprite';
const API = 'https://api.sprites.dev/v1', HOME = '/home/sprite/agent-team', SERVICE = 'agent-team-worker';
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const spriteName = (projectId: string) => `at-${projectId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)}`;

export interface SpriteOptions extends Ec2Options { spriteToken?: string; fetch?: typeof fetch; toolkitRef?: string; setup?: string; codeToken?: string }

// What the service runs: the toolkit and the checkout, fetched once and kept; the project's own setup; then one turn of the worker.
export function jobScript(input: { job: LaunchJob; toolkit: string; toolkitRef: string; repository: string; setup: string; engine: string }): string {
  const hold = (method: string, path: string, body?: string) => `curl -s --unix-socket /.sprite/api.sock -X ${method} http://sprite/v1/tasks${path} -H 'content-type: application/json'${body ? ` -d ${quote(body)}` : ''} >/dev/null 2>&1 || true`;
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `cd ${HOME}`,
    // A service may be started again after its script ends (a Sprite that wakes restarts its services): a job runs once.
    `[ -e ${quote(`done-${input.job.id}`)} ] && exit 0`,
    // The turn keeps the Sprite awake; a crash lets the hold lapse within five minutes.
    `${hold('POST', '', JSON.stringify({ name: 'agent-team-turn', expire: '5m' }))}`,
    `( while sleep 60; do ${hold('PUT', '/agent-team-turn', JSON.stringify({ expire: '5m' }))}; done ) & keeper=$!`,
    `trap 'kill $keeper 2>/dev/null; ${hold('DELETE', '/agent-team-turn')}' EXIT`,
    'set -a; . ./worker.env; set +a',
    // Git asks the environment for the code host's token; it is never written into a remote address or a file.
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=\'!f() { echo username=x-access-token; echo "password=${GH_TOKEN:-${GITLAB_TOKEN:-}}"; }; f\'',
    `[ -d toolkit/.git ] || git clone --quiet ${quote(input.toolkit)} toolkit`,
    `(cd toolkit && git fetch --quiet --depth 1 origin ${quote(input.toolkitRef)} && git checkout --quiet FETCH_HEAD && npm ci --silent --no-audit --no-fund)`,
    `[ -d checkout/.git ] || git clone --quiet ${quote(input.repository)} checkout`,
    '(cd checkout && git fetch --quiet origin)',
    ...(input.setup ? [`(cd checkout && ${input.setup})`] : []),
    `command -v ${input.engine === 'cursor' ? 'agent' : input.engine} >/dev/null || echo "The ${input.engine} tool is not installed on this Sprite" >&2`,
    `node toolkit/packages/worker/src/main.ts --config ${HOME}/worker.json --once --job ${quote(input.job.id)} || true`,
    `touch ${quote(`done-${input.job.id}`)}`,
  ].join('\n') + '\n';
}

export function create(options: SpriteOptions = {}): Launcher {
  const env = options.env ?? process.env, request = options.fetch ?? fetch;
  const token = options.spriteToken ?? env.SPRITE_TOKEN;
  const call = async (method: string, path: string, body?: string | object, contentType = 'application/json') => {
    if (!token) throw new Error('SPRITE_TOKEN is not set on the control plane');
    const response = await request(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': contentType }) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) })
      .catch(() => { throw new Error('The Sprites API could not be reached'); });
    return response;
  };
  const ok = async (response: Response, what: string) => { if (!response.ok) throw new Error(`${what}: the Sprites API answered ${response.status}`); await response.text(); };

  return {
    kind: NAME,
    async start(job: LaunchJob): Promise<LaunchHandle> {
      const refused = refusal(options);
      if (refused) throw new Error(refused.replace('ephemeral ec2 worker', 'ephemeral sprite worker'));
      if (!job.token || !options.coordinatorUrl) throw new Error('A Sprite worker needs the coordinator\'s address and a token for its job');
      const name = spriteName(job.projectId), publish = options.publish!;
      const found = await call('GET', `/sprites/${name}`);
      if (found.status === 404) await ok(await call('POST', '/sprites', { name, wait_for_capacity: true }), 'Creating the Sprite');
      else await ok(found, 'Reading the Sprite');
      const host = publish.scm === 'gitlab' ? (env.GITLAB_HOST ? `https://${env.GITLAB_HOST.replace(/^https?:\/\//, '')}` : 'https://gitlab.com') : 'https://github.com';
      const write = async (file: string, content: string, mode: string) => ok(await call('PUT', `/sprites/${name}/fs/write?path=${encodeURIComponent(`${HOME}/${file}`)}&mode=${mode}&mkdir=true`, content, 'application/octet-stream'), `Writing ${file}`);
      await write('worker.json', `${JSON.stringify({ coordinatorUrl: options.coordinatorUrl, workerId: `${name}.sprite`, stateDir: `${HOME}/state`, engine: options.engine ?? 'claude', projects: { [job.projectId]: `${HOME}/checkout` }, publish: { scm: publish.scm, repository: publish.repository, base: publish.base }, worktrees: { branchPrefix: 'agents/', base: `origin/${publish.base}` }, ...(options.workerConfig ?? {}) }, null, 2)}\n`, '0600');
      const code = options.codeToken ?? env.GH_TOKEN ?? env.GITLAB_TOKEN;
      await write('worker.env', `AGENT_TEAM_TOKEN=${job.token}\n${code ? `${publish.scm === 'gitlab' ? 'GITLAB_TOKEN' : 'GH_TOKEN'}=${code}\n` : ''}`, '0600');
      await write('job.sh', jobScript({ job, toolkit: options.toolkit ?? 'https://github.com/fumbleforce/agent-team.git', toolkitRef: options.toolkitRef ?? 'main', repository: `${host}/${publish.repository}.git`, setup: options.workerConfig?.setup as string ?? '', engine: options.engine ?? 'claude' }), '0700');
      await ok(await call('PUT', `/sprites/${name}/services/${SERVICE}`, { cmd: 'bash', args: [`${HOME}/job.sh`], dir: HOME }), 'Defining the worker service');
      await ok(await call('POST', `/sprites/${name}/services/${SERVICE}/start`), 'Starting the worker');
      return { kind: NAME, jobId: job.id, startedAt: Date.now(), instanceId: name };
    },
    async stop(handle) {
      if (!handle?.instanceId) return { stopped: false };
      const response = await call('POST', `/sprites/${handle.instanceId}/services/${SERVICE}/stop`);
      await response.text();
      return { stopped: response.ok || response.status === 404 };
    },
    // The service's own status; a Sprite or a service that is not there has ended.
    async status(handle) {
      if (!handle?.instanceId) return { state: 'gone' };
      const response = await call('GET', `/sprites/${handle.instanceId}/services/${SERVICE}`);
      if (response.status === 404) return { state: 'gone' };
      if (!response.ok) return { state: 'unknown' };
      const service = await response.json() as { state?: { status?: string } };
      return { state: service.state?.status === 'running' || service.state?.status === 'starting' ? 'running' : 'stopped' };
    },
  };
}
