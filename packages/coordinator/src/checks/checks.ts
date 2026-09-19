import { HarnessChangeView, newId, type HarnessHealthView } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';
import { parseJUnit, type JUnitReport } from './junit.ts';

export interface RunInput { projectId: string; suite: string; kind?: 'test' | 'check'; branch: string; sha?: string | null; source: 'scm' | 'agent' | 'upload'; report: JUnitReport }

const HarnessChangePayload = HarnessChangeView.omit({ at: true });

export function createChecks(context: Context) {
  const { storage, events, now } = context;
  const db = storage.db;

  // The branch the harness is judged on: the one changes are delivered to. A sub-project without its own uses its parent's.
  const baseBranch = async (executor: Tx | typeof db, projectId: string): Promise<string> => {
    const project = await executor.selectFrom('projects').select(['manifest', 'parent_id']).where('id', '=', projectId).executeTakeFirst();
    const own = (JSON.parse(project?.manifest ?? '{}') as { delivery?: { baseBranch?: string } }).delivery?.baseBranch;
    if (own || !project?.parent_id) return own ?? 'main';
    return baseBranch(executor, project.parent_id);
  };
  const quarantinedOf = async (executor: Tx | typeof db, runId: string) => (await executor.selectFrom('check_cases').select('name').where('run_id', '=', runId).where('status', '=', 'quarantined').orderBy('name').execute()).map(row => row.name);

  return {
    parse: parseJUnit,

    async record(input: RunInput) {
      const id = newId(now());
      const status = input.report.failed > 0 ? 'failed' : input.report.total === 0 ? 'skipped' : 'passed';
      const quarantined = [...new Set((input.report.quarantined ?? []).map(item => item.name))].sort();
      const published = await storage.transaction(async tx => {
        // The harness changed when a suite on the base branch gained or lost cases, or its set of quarantined cases moved.
        const previous = input.branch === await baseBranch(tx, input.projectId) ? await tx.selectFrom('check_runs').select(['id', 'total']).where('project_id', '=', input.projectId).where('branch', '=', input.branch).where('suite', '=', input.suite).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst() : undefined;
        const before = previous ? await quarantinedOf(tx, previous.id) : [];
        const added = quarantined.filter(name => !before.includes(name)), removed = before.filter(name => !quarantined.includes(name));
        const changed = previous && (previous.total !== input.report.total || added.length > 0 || removed.length > 0);
        await tx.insertInto('check_runs').values({ id, project_id: input.projectId, suite: input.suite, kind: input.kind ?? 'test', branch: input.branch, sha: input.sha ?? null, status, passed: input.report.passed, failed: input.report.failed, skipped: input.report.skipped, total: input.report.total, duration_ms: input.report.durationMs, source: input.source, created_at: now() }).execute();
        for (const item of input.report.failing) await tx.insertInto('check_cases').values({ run_id: id, name: item.name, status: item.status, message: item.message }).execute();
        for (const name of quarantined) await tx.insertInto('check_cases').values({ run_id: id, name, status: 'quarantined', message: input.report.quarantined?.find(item => item.name === name)?.message ?? null }).execute();
        return events.append(tx, [...(changed ? [{ type: 'check.harness_changed', actorKind: 'system' as const, projectId: input.projectId, payload: { runId: id, suite: input.suite, branch: input.branch, totalBefore: previous.total, totalAfter: input.report.total, quarantinedAdded: added, quarantinedRemoved: removed } }] : []), { type: status === 'failed' ? 'check.failed' : 'check.run_reported', actorKind: 'system', projectId: input.projectId, payload: { runId: id, suite: input.suite, branch: input.branch, failed: input.report.failed } }]);
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
      const cases = failingRuns.length ? await db.selectFrom('check_cases').selectAll().where('run_id', 'in', failingRuns).where('status', '!=', 'quarantined').limit(200).execute() : [];
      // A failure on a task's branch belongs to whoever works on that task, and to the issue the task fixes.
      const branches = [...new Set(cells.filter(run => run.status === 'failed').map(run => run.branch))];
      const tasks = branches.length ? await db.selectFrom('tasks').leftJoin('agents', 'agents.id', 'tasks.assignee_agent_id').select(['tasks.id', 'tasks.key', 'tasks.branch', 'agents.id as agent_id', 'agents.name as agent_name']).where('tasks.project_id', '=', projectId).where('tasks.branch', 'in', branches).orderBy('tasks.updated_at', 'desc').execute() : [];
      const fixes = tasks.length ? await db.selectFrom('links').innerJoin('issues', 'issues.id', 'links.from_id').select(['links.to_id', 'issues.number', 'issues.title']).where('links.from_type', '=', 'issue').where('links.to_type', '=', 'task').where('links.to_id', 'in', tasks.map(task => task.id)).execute() : [];
      const behind = (branch: string) => {
        const task = tasks.find(item => item.branch === branch), issue = task && fixes.find(link => link.to_id === task.id);
        return { owner: task?.agent_id ? { id: task.agent_id, name: task.agent_name ?? '' } : null, taskKey: task?.key ?? null, issue: issue ? { number: issue.number, title: issue.title } : null };
      };
      return {
        suites: [...new Set(cells.map(run => run.suite))].sort(),
        branches: [...new Set(cells.map(run => run.branch))].map(branch => ({ branch, lastRunAt: Math.max(...cells.filter(run => run.branch === branch).map(run => Number(run.created_at))), runs: cells.filter(run => run.branch === branch).map(run => ({ id: run.id, suite: run.suite, status: run.status, passed: run.passed, total: run.total, failed: run.failed })) })),
        failing: cases.map(item => { const run = cells.find(cell => cell.id === item.run_id); return { ...item, branch: run?.branch ?? '', suite: run?.suite ?? '', ...behind(run?.branch ?? '') }; }),
      };
    },

    // Harness health, derived on read: the latest run of each suite on the base branch, the cases quarantined as flaky
    // in those runs, and what changed between runs, newest first.
    async health(projectId: string): Promise<HarnessHealthView> {
      const branch = await baseBranch(db, projectId);
      const runs = await db.selectFrom('check_runs').selectAll().where('project_id', '=', projectId).where('branch', '=', branch).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(500).execute();
      const latest = new Map<string, (typeof runs)[number]>();
      for (const run of runs) if (!latest.has(run.suite)) latest.set(run.suite, run);
      const current = [...latest.values()].sort((a, b) => a.suite.localeCompare(b.suite));
      const cases = current.length ? await db.selectFrom('check_cases').select(['run_id', 'name']).where('run_id', 'in', current.map(run => run.id)).where('status', '=', 'quarantined').orderBy('name').execute() : [];
      const changes = await db.selectFrom('events').select(['at', 'payload']).where('type', '=', 'check.harness_changed').where('project_id', '=', projectId).orderBy('seq', 'desc').limit(20).execute();
      return {
        branch,
        totalCases: current.reduce((sum, run) => sum + run.total, 0),
        quarantinedCases: cases.map(item => ({ suite: current.find(run => run.id === item.run_id)?.suite ?? '', name: item.name })),
        suites: current.map(run => ({ suite: run.suite, kind: run.kind, total: run.total, failed: run.failed, quarantined: cases.filter(item => item.run_id === run.id).length, durationMs: run.duration_ms, at: Number(run.created_at) })),
        changes: changes.map(row => { const payload = HarnessChangePayload.parse(JSON.parse(row.payload)); return { at: Number(row.at), suite: payload.suite, totalBefore: payload.totalBefore, totalAfter: payload.totalAfter, quarantinedAdded: payload.quarantinedAdded, quarantinedRemoved: payload.quarantinedRemoved }; }),
      };
    },
  };
}
