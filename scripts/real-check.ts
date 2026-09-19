// Read-only checks of the adapters against real services, using credentials already in the environment. Nothing is written anywhere.
// Usage: node scripts/real-check.ts <owner/name>
import { setupEntry } from '../adapters/integration/catalog.ts';
import { scmApi } from '../adapters/scm/index.ts';
import { trackerClient } from '../adapters/tracker/index.ts';

const repository = process.argv[2];
if (!repository) { console.error('Usage: node scripts/real-check.ts <owner/name>'); process.exit(1); }
const token = process.env.GITHUB_ISSUES_TOKEN ?? process.env.GH_TOKEN;
if (!token) { console.error('Set GH_TOKEN first'); process.exit(1); }
const report = async (name: string, run: () => Promise<string>) => { try { console.log(`ok    ${name}: ${await run()}`); } catch (error) { console.log(`FAIL  ${name}: ${(error as Error).message}`); process.exitCode = 1; } };

await report('guided setup connection test', () => setupEntry('github-issues')!.test!({ repository }, token, fetch));
await report('tracker snapshot', async () => { const { allIssues } = await trackerClient('github')!.snapshot({ repository }); return `${allIssues.length} issues; states ${[...new Set(allIssues.map(issue => issue.state.type))].join(', ') || 'none'}`; });
await report('tracker comments (read)', async () => { const { allIssues } = await trackerClient('github')!.snapshot({ repository }); const first = allIssues[0]; return first ? `${(await trackerClient('github')!.comments({ repository }, first.identifier, null)).length} comments on ${first.identifier}` : 'no issue to read'; });
await report('code host environments', async () => `${(await scmApi('github')!.environments(repository)).length} environments`);
await report('code host test reports on main', async () => `${(await scmApi('github')!.testReports(repository, { branch: 'main' })).length} report(s)`);
