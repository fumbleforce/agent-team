import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { STEP_ARTIFACT_LIMITS, type StepArtifactKind, type TraceStepInput } from '@agent-team/protocol';
import type { EngineStep } from '../../../adapters/engine/contract.ts';
import { clipBytes, type Redactor } from './redact.ts';

const run = promisify(execFile);
export interface StepArtifact { seq: number; kind: StepArtifactKind; body: string; truncated: boolean }

// Diffs come from git, never from what a tool said it would write. A private index beside the turn's files snapshots the whole worktree
// as a tree without touching the agent's own index: once before the engine starts (the first-touch baseline) and again after every edit or run step.
export function createTracer(options: { worktree: string | null; turnDir: string; redact: Redactor; onSteps(steps: TraceStepInput[]): void; onArtifact(artifact: StepArtifact): Promise<void> }) {
  const { worktree, redact } = options;
  const env = { ...process.env, GIT_INDEX_FILE: path.join(options.turnDir, 'trace-index'), GIT_TERMINAL_PROMPT: '0' };
  const git = async (args: string[]) => (await run('git', ['-C', worktree!, ...args], { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  // With a path only that file is taken into the snapshot, so whatever a shell changes meanwhile still counts for the run step that did it.
  const snapshot = async (only?: string) => { await git(['add', '-A', '--', only ?? '.']).catch(error => { if (!only) throw error; }); return (await git(['write-tree'])).trim(); };
  let chain: Promise<void> = Promise.resolve(), baseline: string | null = null, previous: string | null = null, open: EngineStep | null = null;

  const upload = (seq: number, kind: StepArtifactKind, text: string) => {
    const clipped = clipBytes(redact(text), STEP_ARTIFACT_LIMITS[kind]);
    return options.onArtifact({ seq, kind, body: clipped.text, truncated: clipped.truncated }).catch(() => {});
  };

  // A step's effects exist once the next step begins or the engine ends: that is when git is asked what changed.
  // A step has one artifact: the diff when files changed, otherwise a run step's output.
  async function settle(step: EngineStep) {
    let diff = '';
    if (worktree && baseline !== null && (step.kind === 'edit' || step.kind === 'run')) {
      const relative = step.kind === 'edit' && step.target ? path.relative(worktree, path.resolve(worktree, step.target)).split(path.sep).join('/') : null;
      const target = relative && !relative.startsWith('..') ? relative : null;
      const tree = await snapshot(target ?? undefined);
      // An edit step shows its file against the turn's baseline; a run step shows whatever the shell changed since the last look.
      diff = target ? await git(['diff', '--no-color', '--no-ext-diff', baseline, tree, '--', target]) : tree === previous ? '' : await git(['diff', '--no-color', '--no-ext-diff', previous ?? baseline, tree]);
      previous = tree;
    }
    if (diff.trim()) await upload(step.seq, 'diff', diff);
    else if (step.body && step.kind !== 'think') await upload(step.seq, 'output', step.body);
  }

  const enqueue = (work: () => Promise<void>) => { chain = chain.then(work).catch(() => {}); };

  return {
    // Called before the engine starts, so the baseline is the worktree as the turn found it.
    start() { if (worktree) enqueue(async () => { baseline = previous = await snapshot(); }); },
    steps(steps: EngineStep[]) {
      for (const step of steps) {
        const { target: _target, body, ...stored } = step;
        options.onSteps([{ ...stored, title: redact(stored.title), ...(stored.detail ? { detail: redact(stored.detail) } : {}) }]);
        const closing = open;
        open = step;
        enqueue(async () => {
          if (closing) await settle(closing);
          if (body && step.kind === 'think') await upload(step.seq, 'think', body);
        });
      }
    },
    // The last step is settled when the engine has exited.
    async finish() {
      const closing = open;
      open = null;
      if (closing) enqueue(() => settle(closing));
      await chain;
    },
  };
}
