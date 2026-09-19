import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '@agent-team/storage';
import { createContext } from '../context.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createChecks } from './checks.ts';

test('the matrix shows the latest run per branch and suite, with the failing cases of failed cells', async () => {
  const storage = await createStorage({ kind: 'sqlite', path: ':memory:' });
  await storage.migrate();
  let clock = 1000;
  const context = createContext({ storage, machineToken: 'x'.repeat(24), now: () => clock++ });
  const projectId = await createWorkspace(context).registerProject({ slug: 'shop', name: 'Shop', kind: 'repo', manifest: {} });
  const checks = createChecks(context);
  const report = (passed: number, failing: string[]) => ({ passed, failed: failing.length, skipped: 0, total: passed + failing.length, durationMs: 10, failing: failing.map(name => ({ name, status: 'failed' as const, message: 'boom' })) });
  await checks.record({ projectId, suite: 'e2e', branch: 'release/2.14', source: 'upload', report: report(90, ['old failure']) });
  await checks.record({ projectId, suite: 'e2e', branch: 'release/2.14', source: 'upload', report: report(94, ['pay button', 'webhook flag']) });
  await checks.record({ projectId, suite: 'unit', branch: 'release/2.14', source: 'upload', report: report(842, []) });
  await checks.record({ projectId, suite: 'unit', branch: 'main', source: 'agent', report: report(812, []) });

  const matrix = await checks.matrix(projectId);
  assert.deepEqual(matrix.suites, ['e2e', 'unit']);
  const release = matrix.branches.find(row => row.branch === 'release/2.14')!;
  assert.deepEqual(release.runs.map(run => [run.suite, run.status, run.passed, run.total]).sort(), [['e2e', 'failed', 94, 96], ['unit', 'passed', 842, 842]]);
  assert.deepEqual(matrix.failing.map(item => item.name).sort(), ['pay button', 'webhook flag']);
  const failed = await storage.db.selectFrom('events').select('type').where('type', '=', 'check.failed').execute();
  assert.equal(failed.length, 2);
  await storage.close();
});
