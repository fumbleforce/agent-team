import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTasks, report, runCheck, runTask, type RunFile, type TaskResult } from './reference.ts';

const tasks = Object.fromEntries(loadTasks().map(task => [task.name, task]));
const treeOf = (name: string, files: Record<string, string> = {}) => {
  const tree = mkdtempSync(path.join(os.tmpdir(), 'agent-team-reference-test-'));
  cpSync(path.join(tasks[name]!.dir, 'repo'), tree, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(tree, file), text);
  return tree;
};

test('the reference set stands for the work the roadmap names', () => {
  assert.deepEqual(Object.keys(tasks).sort(), ['campaign-brief', 'five-step-change', 'flawed-brief', 'iso-week-wrong-example', 'money-allocation', 'one-file-fix', 'pricing-announcement', 'seeded-defect']);
  // The first run showed one strong model aces the simple ones alone; these three are there to leave room above it.
  assert.ok(tasks['iso-week-wrong-example']!.flawed);
  assert.equal(tasks['pricing-announcement']!.kind, 'document');
  assert.ok(tasks['seeded-defect']!.seeded?.length);
  assert.ok(tasks['flawed-brief']!.flawed);
  assert.equal(tasks['campaign-brief']!.kind, 'document');
});

test('hidden checks give nothing for untouched work and full marks for right work', () => {
  assert.equal(runCheck(tasks['one-file-fix']!, treeOf('one-file-fix'), {}).score, 0.25, 'only the word without spaces passes untouched');
  assert.equal(runCheck(tasks['one-file-fix']!, treeOf('one-file-fix', { 'slug.js': "export const slug = text => text.trim().toLowerCase().split(/\\s+/).join('-');\n" }), {}).score, 1);

  assert.equal(runCheck(tasks['five-step-change']!, treeOf('five-step-change'), {}).score, 0);

  // The weekly total built on the defect scores half and does not count as having caught it.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the source of a module written to disk, template and all.
  const onTheDefect = "export function dailyTotals(entries) { const t = {}; for (const e of entries) t[e.day] = (t[e.day] ?? 0) + Math.round(e.amount); return t; }\nexport function weeklyTotal(entries, start) { const t = dailyTotals(entries); let sum = 0; for (let i = 0; i < 7; i++) { const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); sum += t[d.toISOString().slice(0, 10)] ?? 0; } return sum; }\n";
  const half = runCheck(tasks['seeded-defect']!, treeOf('seeded-defect', { 'report.js': onTheDefect }), {});
  assert.deepEqual([half.score, half.seededCaught], [0.5, false]);
  const fixed = runCheck(tasks['seeded-defect']!, treeOf('seeded-defect', { 'report.js': onTheDefect.replace('Math.round(e.amount)', 'e.amount') }), {});
  assert.deepEqual([fixed.score, fixed.seededCaught], [1, true]);

  // A wrong brief is passed by saying so and leaving the code alone.
  const flawed = tasks['flawed-brief']!, tree = treeOf('flawed-brief');
  assert.equal(runCheck(flawed, tree, { state: 'canceled', summary: 'clamp() already exists in numbers.js and scale.js uses it; nothing to do.', changedFiles: [] }).score, 1);
  assert.equal(runCheck(flawed, tree, { state: 'in_review', summary: 'Added clamp and tests.', changedFiles: ['numbers.js'] }).score, 0);

  // The harder ones: untouched work scores next to nothing, and a wrong fact in a customer email costs more than a missing one.
  assert.ok(runCheck(tasks['money-allocation']!, treeOf('money-allocation'), {}).score < 0.2);
  assert.ok(runCheck(tasks['iso-week-wrong-example']!, treeOf('iso-week-wrong-example'), { summary: '' }).score === 0);
  assert.equal(runCheck(tasks['pricing-announcement']!, treeOf('one-file-fix'), { document: 'Pro goes up to €39 from 1 February.' }).score, 0);

  const brief = 'Goal: lift weekly use of offline mode among existing customers to 25 %. Message: work anywhere. Week 1 email, week 2 in-app, week 3 email, week 4 in-app. Budget 8000 EUR: 5000 email, 3000 in-app. No discounts. We stop early if unsubscribes double.';
  assert.equal(runCheck(tasks['campaign-brief']!, treeOf('one-file-fix'), { document: brief }).score, 1);
  assert.equal(runCheck(tasks['campaign-brief']!, treeOf('one-file-fix'), { document: '' }).score, 0);
});

test('a run on the scripted engine goes through the platform and is scored, for a change and for a document', async () => {
  const result = await runTask(tasks['one-file-fix']!, { arm: 'solo', engine: 'fake', model: null, minutes: 0.2 });
  assert.equal(result.arm, 'solo');
  assert.ok(result.turns >= 1, 'a turn ran');
  assert.equal(result.score, 0.25, 'the scripted engine changes nothing that matters');
  // A document task runs like any other; the scripted engine hands nothing in, so there is nothing to score.
  const document = await runTask(tasks['campaign-brief']!, { arm: 'solo', engine: 'fake', model: null, minutes: 0.1 });
  assert.equal(document.score, 0);
  assert.ok(document.turns >= 1);
});

test('the report compares the arms on the tasks both finished', () => {
  const result = (task: string, arm: 'team' | 'solo', score: number | null, costUsd: number, extra: Partial<TaskResult> = {}): TaskResult => ({ task, arm, engine: 'x', model: null, score, notes: [], state: 'done', turns: 1, costUsd, tokens: 0, ms: 0, ...extra });
  const files: RunFile[] = [
    { at: '2026-01-01T00:00:00Z', arm: 'team', engine: 'x', model: null, results: [result('a', 'team', 0.1, 9)] },
    { at: '2026-02-01T00:00:00Z', arm: 'team', engine: 'x', model: 'open', results: [result('a', 'team', 1, 1), result('b', 'team', 0.8, 1, { seededCaught: true }), result('c', 'team', null, 0)] },
    { at: '2026-02-01T00:00:00Z', arm: 'solo', engine: 'x', model: 'frontier', results: [result('a', 'solo', 0.5, 4), result('b', 'solo', 1, 6, { seededCaught: false })] },
  ];
  const summary = report(files);
  assert.deepEqual(summary.comparedOn, ['a', 'b']);
  assert.ok(Math.abs(summary.T1! - 0.9 / 0.75) < 1e-9, 'the newest team run is the one compared');
  assert.equal(summary.T2, 0.2);
  assert.deepEqual(summary.T4, { team: 1, solo: 0 });
  assert.equal(report([]).T1, null);

  // A seat earns its place when the team does worse, or catches less, without it.
  const ablated: RunFile[] = [
    ...files,
    { at: '2026-02-02T00:00:00Z', arm: 'team', engine: 'x', model: 'open', without: ['Cleo'], results: [result('a', 'team', 1, 1), result('b', 'team', 0.5, 1, { seededCaught: false })] },
    { at: '2026-02-03T00:00:00Z', arm: 'team', engine: 'x', model: 'open', without: ['Rune'], results: [result('a', 'team', 1, 1), result('b', 'team', 0.8, 1, { seededCaught: true })] },
  ];
  const seats = report(ablated);
  assert.equal(seats.T1, summary.T1, 'a run with a seat removed is never taken for the team');
  assert.deepEqual(seats.T6.map(entry => [entry.without, entry.earnsItsPlace]), [[['Cleo'], true], [['Rune'], false]]);
});
