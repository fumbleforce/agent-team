import { newId } from '@agent-team/protocol';
import type { Context } from '../context.ts';
import { parseJUnit, type JUnitReport } from './junit.ts';

export interface RunInput { projectId: string; suite: string; kind?: 'test' | 'check'; branch: string; sha?: string | null; source: 'scm' | 'agent' | 'upload'; report: JUnitReport }

export function createChecks(context: Context) {
  const { storage, events, now } = context;
  const db = storage.db;

  return {
    parse: parseJUnit,

    async record(input: RunInput) {
      const id = newId(now());
      const status = input.report.failed > 0 ? 'failed' : input.report.total === 0 ? 'skipped' : 'passed';
      const published = await storage.transaction(async tx => {
        await tx.insertInto('check_runs').values({ id, project_id: input.projectId, suite: input.suite, kind: input.kind ?? 'test', branch: input.branch, sha: input.sha ?? null, status, passed: input.report.passed, failed: input.report.failed, skipped: input.report.skipped, total: input.report.total, duration_ms: input.report.durationMs, source: input.source, created_at: now() }).execute();
        for (const item of input.report.failing) await tx.insertInto('check_cases').values({ run_id: id, name: item.name, status: item.status, message: item.message }).execute();
        return events.append(tx, [{ type: status === 'failed' ? 'check.failed' : 'check.run_reported', actorKind: 'system', projectId: input.projectId, payload: { runId: id, suite: input.suite, branch: input.branch, failed: input.report.failed } }]);
      });
      events.published(published);
      return { id, status };
    },

    // Branch by suite, latest run in each cell, plus the failing cases of those runs.
    async matrix(projectId: string) {
      const runs = await db.selectFrom('check_runs').selectAll().where('project_id', '=', projectId).orderBy('created_at', 'desc').limit(500).execute();
      const latest = new Map<string, (typeof runs)[number]>();
      for (const run of runs) if (!latest.has(`${run.branch}\n${run.suite}`)) latest.set(`${run.branch}\n${run.suite}`, run);
      const cells = [...latest.values()];
      const failingRuns = cells.filter(run => run.status === 'failed').map(run => run.id);
      const cases = failingRuns.length ? await db.selectFrom('check_cases').selectAll().where('run_id', 'in', failingRuns).limit(200).execute() : [];
      return {
        suites: [...new Set(cells.map(run => run.suite))].sort(),
        branches: [...new Set(cells.map(run => run.branch))].map(branch => ({ branch, lastRunAt: Math.max(...cells.filter(run => run.branch === branch).map(run => Number(run.created_at))), runs: cells.filter(run => run.branch === branch).map(run => ({ id: run.id, suite: run.suite, status: run.status, passed: run.passed, total: run.total, failed: run.failed })) })),
        failing: cases.map(item => ({ ...item, branch: latest.size ? cells.find(run => run.id === item.run_id)?.branch ?? '' : '', suite: cells.find(run => run.id === item.run_id)?.suite ?? '' })),
      };
    },
  };
}
