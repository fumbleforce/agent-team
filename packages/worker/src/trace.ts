import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { STEP_ARTIFACT_LIMITS, type StepArtifactKind, type TraceStepInput } from '@agent-team/protocol';
import type { EngineStep } from '../../../adapters/engine/contract.ts';
import { clipBytes, type Redactor } from './redact.ts';

const run = promisify(execFile);
export interface StepArtifact { seq: number; kind: StepArtifactKind; body: string | Uint8Array; mime: string; truncated: boolean }
const TEXT = 'text/plain; charset=utf-8';
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_SCREENSHOTS = 20;

// Diffs come from git, never from what a tool said it would write. A private index beside the turn's files snapshots the whole worktree
// as a tree without touching the agent's own index: once before the engine starts (the first-touch baseline) and again after every edit or run step.
//
// An engine may name several tool calls in one message and run them afterwards, so the moment a step closes says little about what it
// changed. A diff therefore belongs to an edit step only when that step's target is among the paths that changed; an edit step whose file
// has not changed yet keeps waiting for it. What no edit step accounts for belongs to the next run step that closes, and when none
// is left, to one "Other changes" step at the end of the turn.
export function createTracer(options: { worktree: string | null; turnDir: string; redact: Redactor; onSteps(steps: TraceStepInput[]): void; onArtifact(artifact: StepArtifact): Promise<void>; screenshotDir?: string }) {
  const { worktree, redact } = options;
  const env = { ...process.env, GIT_INDEX_FILE: path.join(options.turnDir, 'trace-index'), GIT_TERMINAL_PROMPT: '0' };
  const git = async (args: string[]) => (await run('git', ['-C', worktree!, ...args], { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  const snapshot = async () => { await git(['add', '-A', '--', '.']); return (await git(['write-tree'])).trim(); };
  const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-renames'];
  let chain: Promise<void> = Promise.resolve(), baseline: string | null = null, previous: string | null = null, open: EngineStep | null = null, lastSeq = -1;
  // Edit steps whose file has not changed yet.
  let waiting: { seq: number; target: string; body: string | undefined }[] = [];
  // Where the last run step left off, and the files edit steps have accounted for since.
  let restBase: string | null = null;
  const claimed = new Set<string>();
  // Everything that changed since the last run step and that no edit step accounts for; asking moves the mark.
  const unaccounted = async (tree: string) => {
    const rest = tree === restBase ? '' : await git([...DIFF, restBase ?? baseline!, tree, '--', '.', ...[...claimed].map(file => `:(exclude,literal)${file}`)]);
    restBase = tree;
    claimed.clear();
    return rest;
  };

  const upload = (seq: number, kind: StepArtifactKind, text: string) => {
    const clipped = clipBytes(redact(text), STEP_ARTIFACT_LIMITS[kind]);
    return options.onArtifact({ seq, kind, body: clipped.text, mime: TEXT, truncated: clipped.truncated }).catch(() => {});
  };
  const append = (step: Omit<TraceStepInput, 'seq'>): number => { const seq = ++lastSeq; options.onSteps([{ ...step, seq }]); return seq; };

  // A step's effects exist once the next step begins or the engine ends: that is when git is asked what changed.
  // A step has one artifact: the diff when files changed, otherwise its output.
  async function settle(step: EngineStep) {
    let hasDiff = false, held = false;
    if (worktree && baseline !== null && (step.kind === 'edit' || step.kind === 'run')) {
      const relative = step.kind === 'edit' && step.target ? path.relative(worktree, path.resolve(worktree, step.target)).split(path.sep).join('/') : null;
      if (relative && !relative.startsWith('..')) { waiting.push({ seq: step.seq, target: relative, body: step.body }); held = true; }
      const tree = await snapshot();
      if (tree !== previous) {
        const changed = new Set((await git([...DIFF, '--name-only', '-z', previous ?? baseline, tree])).split('\0').filter(Boolean));
        for (const entry of waiting.filter(item => changed.has(item.target))) {
          // An edit step shows its file against the turn's baseline.
          await upload(entry.seq, 'diff', await git([...DIFF, baseline, tree, '--', entry.target]));
          claimed.add(entry.target);
          if (entry.seq === step.seq) hasDiff = true;
        }
        waiting = waiting.filter(item => !changed.has(item.target));
        previous = tree;
      }
      // The step after an edit is often already running when the edit is closed, so what an edit step does not account for
      // is never pinned on it: it is left for the run step that follows.
      if (step.kind === 'run') {
        const rest = await unaccounted(tree);
        if (rest.trim()) { await upload(step.seq, 'diff', rest); hasDiff = true; }
      }
      held = held && waiting.some(item => item.seq === step.seq);
    }
    // A step still waiting for its file keeps its output back: the diff, if it comes, is the one artifact it has.
    if (!hasDiff && !held && step.body && step.kind !== 'think') await upload(step.seq, 'output', step.body);
  }

  // Screenshots the engine's browser tool left in the turn directory: one step and one image each, oldest first.
  async function screenshots(dir: string) {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter(name => IMAGES[path.extname(name).toLowerCase()]).map(name => ({ name, file: path.join(dir, name) })).map(entry => ({ ...entry, stat: statSync(entry.file) }))
      .filter(entry => entry.stat.isFile() && entry.stat.size > 0 && entry.stat.size <= STEP_ARTIFACT_LIMITS.image).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.name.localeCompare(b.name)).slice(0, MAX_SCREENSHOTS);
    for (const entry of files) {
      const seq = append({ kind: 'read', title: redact(`Screenshot ${entry.name}`), detail: `${Math.ceil(entry.stat.size / 1024)} KB`, status: 'ok' });
      await options.onArtifact({ seq, kind: 'image', body: readFileSync(entry.file), mime: IMAGES[path.extname(entry.name).toLowerCase()]!, truncated: false }).catch(() => {});
    }
  }

  const enqueue = (work: () => Promise<void>) => { chain = chain.then(work).catch(() => {}); };

  return {
    // Called before the engine starts, so the baseline is the worktree as the turn found it.
    start() { if (worktree) enqueue(async () => { baseline = previous = restBase = await snapshot(); }); },
    steps(steps: EngineStep[]) {
      for (const step of steps) {
        const { target: _target, body, ...stored } = step;
        lastSeq = Math.max(lastSeq, step.seq);
        options.onSteps([{ ...stored, title: redact(stored.title), ...(stored.detail ? { detail: redact(stored.detail) } : {}) }]);
        const closing = open;
        open = step;
        enqueue(async () => {
          if (closing) await settle(closing);
          if (body && step.kind === 'think') await upload(step.seq, 'think', body);
        });
      }
    },
    // The last step is settled when the engine has exited; then come what no step accounted for, and the screenshots.
    async finish() {
      const closing = open;
      open = null;
      enqueue(async () => {
        if (closing) await settle(closing);
        for (const entry of waiting) if (entry.body) await upload(entry.seq, 'output', entry.body);
        waiting = [];
        const rest = worktree && baseline !== null ? await snapshot().then(unaccounted).catch(() => '') : '';
        if (rest.trim()) await upload(append({ kind: 'run', title: 'Other changes', detail: 'made by no step that names them', status: 'ok' }), 'diff', rest);
        if (options.screenshotDir) await screenshots(options.screenshotDir);
      });
      await chain;
    },
  };
}
