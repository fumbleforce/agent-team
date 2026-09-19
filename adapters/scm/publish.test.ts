import test from 'node:test';
import assert from 'node:assert/strict';
import { publish, PUBLISH_KINDS, type Exec } from './publish.ts';

const input = { worktree: '/w', repository: 'acme/app', branch: 'agents/ck-31', base: 'main', title: 'CK-31 Polish', body: 'Summary' };
const URLS: Record<string, string> = { github: 'https://github.com/acme/app/pull/12', gitlab: 'https://gitlab.com/acme/app/-/merge_requests/12' };

// Both hosts pass the same contract.
for (const kind of PUBLISH_KINDS) {
  test(`${kind}: pushes without force, then opens a draft against the base`, async () => {
    const calls: string[][] = [];
    const exec: Exec = async (bin, args) => { calls.push([bin, ...args]); return args.includes('create') ? `created ${URLS[kind]}\n` : ''; };
    assert.deepEqual(await publish(kind, input, exec), { url: URLS[kind], created: true });
    assert.deepEqual(calls[0], ['git', '-C', '/w', 'push', '--set-upstream', 'origin', 'agents/ck-31:agents/ck-31']);
    assert.ok(!calls.flat().some(arg => arg === '--force' || arg === '-f'));
    const create = calls.at(-1)!;
    assert.ok(create.includes('--draft') && create.includes('main') && create.includes('agents/ck-31'));
  });

  test(`${kind}: reuses the open change and refuses the base branch`, async () => {
    const exec: Exec = async (_bin, args) => (args.includes('list') ? `${URLS[kind]}\n` : '');
    assert.deepEqual(await publish(kind, input, exec), { url: URLS[kind], created: false });
    await assert.rejects(publish(kind, { ...input, branch: 'main' }, exec), /base branch/);
  });
}
