// Writes through the tracker adapter against a real SCRATCH repository: creates an issue, comments, moves it through the
// board's states and closes it. Never point this at a repository you care about. Usage: node scripts/real-check-writes.ts <owner/name>
import { trackerClient } from '../adapters/tracker/index.ts';

const repository = process.argv[2];
if (!repository || !/scratch/.test(repository)) { console.error('Usage: node scripts/real-check-writes.ts <owner/name-with-"scratch"-in-it>'); process.exit(1); }
const client = trackerClient('github');
if (!client) { console.error('Set GH_TOKEN first'); process.exit(1); }
const manifest = { repository };
const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => { try { const value = await run(); console.log(`ok    ${name}`); return value; } catch (error) { console.log(`FAIL  ${name}: ${(error as Error).message}`); process.exitCode = 1; return null; } };

const created = await step('create an issue', () => client.createIssue(manifest, { title: `Adapter write check ${new Date().toISOString()}`, body: 'Created by scripts/real-check-writes.ts. Safe to delete.', labels: [], state: 'Backlog' }));
if (created) {
  await step('comment on it', () => client.comment(manifest, created.identifier, 'A comment written through the tracker adapter.'));
  await step('read the comment back', async () => { const comments = await client.comments(manifest, created.identifier, null); if (!comments.some(comment => /tracker adapter/.test(comment.body))) throw new Error('the comment is not there'); });
  await step('move it to in progress', () => client.setState(manifest, created.identifier, 'started'));
  await step('move it to review', () => client.setState(manifest, created.identifier, 'in_review'));
  await step('close it as done', () => client.setState(manifest, created.identifier, 'completed'));
  // The host's issue list can trail a change by a moment.
  await step('see it closed in a snapshot', async () => {
    for (let attempt = 0; ; attempt++) {
      const issue = (await client.snapshot(manifest)).allIssues.find(item => item.identifier === created.identifier);
      if (issue?.state.type === 'completed') return;
      if (attempt >= 5) throw new Error(`it reads as ${issue?.state.type}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  });
  console.log(`      ${created.identifier} at ${created.url ?? ''}`);
}
