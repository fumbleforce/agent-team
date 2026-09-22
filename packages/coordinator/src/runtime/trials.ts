import { newId, ProcessKnobs, Role, type ProposalChange, type WayOfWorking } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';
import type { Context } from '../context.ts';
import { HttpError } from '../context.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { createScorecard, FIGURE_IDS, formatFigure, type ScorecardOptions } from './scorecard.ts';
import { wayOfWorking, WAY_SCOPE } from './wayOfWorking.ts';

// A change to how the team works is a trial. It takes effect at once, names the figure of the scorecard it expects to move and
// which way, and is judged when its time is up: kept if the figure moved that way, put back if it did not or could not be
// measured. Nothing stays changed without having been judged, and what keeps the work safe is not among what can be changed.
export type WayChange = Extract<ProposalChange, { kind: 'change_role_text' | 'change_instructions' | 'change_process' }>;
export const isWayChange = (change: ProposalChange): change is WayChange => ['change_role_text', 'change_instructions', 'change_process'].includes(change.kind);

const DAY = 24 * 3600_000;
const LIBRARY = { type: 'library' as const, id: '' };
const refuse = (message: string) => new HttpError(409, 'trial', message);

export const targetOf = (change: WayChange) => (change.kind === 'change_role_text' ? `role:${change.role}` : change.kind === 'change_instructions' ? `instructions:${change.turnKind}` : `knob:${change.knob}`);

export function createTrials(context: Context, options: ScorecardOptions = {}) {
  const { storage, events, now } = context;
  const docs = createVersionedDocs(context);
  const scorecard = createScorecard(context, options);

  async function roleDoc(tx: Tx, slug: string) {
    const row = await tx.selectFrom('versioned_docs').select('doc').where('kind', '=', 'role').where('scope_type', '=', LIBRARY.type).where('scope_id', '=', LIBRARY.id).where('slug', '=', slug).executeTakeFirst();
    return row ? Role.parse(JSON.parse(row.doc)) : null;
  }

  // Writes one part of the way of working, leaving every other part as it is now: a revert never undoes someone else's change.
  async function writeWay(tx: Tx, projectId: string, change: (way: WayOfWorking) => WayOfWorking, note: string) {
    const project = await tx.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', projectId).executeTakeFirstOrThrow();
    const next = change(await wayOfWorking(tx, projectId));
    await docs.writeWithin(tx, 'way_of_working', WAY_SCOPE(project.parent_id ?? project.id), 'current', next, 'team', note);
  }

  return {
    // Refused before anything is recorded, so nothing waits for the owner that could never apply.
    async check(tx: Tx, projectId: string, change: WayChange, maxTrialDays: number) {
      if (change.trial.days > maxTrialDays) throw refuse(`A trial here runs ${maxTrialDays} days at most`);
      if (!(FIGURE_IDS as readonly string[]).includes(change.trial.measure)) throw refuse(`${change.trial.measure} is not a figure of the scorecard. Name one of: ${FIGURE_IDS.join(', ')}`);
      if (await tx.selectFrom('trials').select('id').where('project_id', '=', projectId).where('target', '=', targetOf(change)).where('state', '=', 'running').executeTakeFirst()) throw refuse(`A trial on ${targetOf(change)} is already running; it is judged before another starts`);
      if (change.kind === 'change_role_text' && !await roleDoc(tx, change.role)) throw refuse(`There is no role called ${change.role}`);
      if (change.kind === 'change_process' && !ProcessKnobs.partial().safeParse({ [change.knob]: change.value }).success) throw refuse(`${change.value} is outside what ${change.knob} may be`);
    },

    // Makes the change and opens its trial, in the caller's transaction.
    async start(tx: Tx, projectId: string, proposalId: string | null, change: WayChange) {
      let before: unknown, after: unknown;
      if (change.kind === 'change_role_text') {
        const role = (await roleDoc(tx, change.role))!;
        before = role.perspective;
        after = change.perspective;
        await docs.writeWithin(tx, 'role', LIBRARY, change.role, { ...role, perspective: change.perspective }, 'team', `trial: ${change.trial.measure} ${change.trial.expect}`);
      } else if (change.kind === 'change_instructions') {
        before = (await wayOfWorking(tx, projectId)).instructions[change.turnKind] ?? null;
        after = change.text;
        await writeWay(tx, projectId, way => ({ ...way, instructions: { ...way.instructions, [change.turnKind]: change.text } }), `trial: ${change.trial.measure} ${change.trial.expect}`);
      } else {
        before = (await wayOfWorking(tx, projectId)).knobs[change.knob];
        after = change.value;
        await writeWay(tx, projectId, way => ({ ...way, knobs: { ...way.knobs, [change.knob]: change.value } }), `trial: ${change.trial.measure} ${change.trial.expect}`);
      }
      const id = newId(now());
      await tx.insertInto('trials').values({ id, project_id: projectId, proposal_id: proposalId, kind: change.kind, target: targetOf(change), before: JSON.stringify(before), after: JSON.stringify(after), measure: change.trial.measure, expect: change.trial.expect, baseline: null, started_at: now(), ends_at: now() + change.trial.days * DAY, state: 'running', result: null, verdict: null, judged_at: null }).execute();
      return { trialId: id, draft: { type: 'trial.started', category: 'audit' as const, actorKind: 'system' as const, projectId, payload: { trialId: id, target: targetOf(change), measure: change.trial.measure, expect: change.trial.expect, days: change.trial.days, proposalId } } };
    },

    // Judges every trial whose time is up: the figure over the trial against the same figure over as long a time before it.
    async sweep(): Promise<number> {
      const due = await storage.db.selectFrom('trials').selectAll().where('state', '=', 'running').where('ends_at', '<=', now()).execute();
      for (const trial of due) {
        const started = Number(trial.started_at), ended = Number(trial.ends_at), length = ended - started;
        const figureOver = async (from: number, to: number) => (await scorecard.compute(trial.project_id, { from, to })).figures.find(figure => figure.id === trial.measure) ?? null;
        const baseline = await figureOver(started - length, started), result = await figureOver(started, ended);
        const measured = baseline?.value !== null && baseline?.value !== undefined && result?.value !== null && result?.value !== undefined;
        const moved = measured && (trial.expect === 'up' ? result!.value! > baseline!.value! : result!.value! < baseline!.value!);
        const verdict = !measured
          ? `${trial.measure} could not be measured before and during the trial, so nothing shows the change helped; it was put back.`
          : `${trial.measure} went from ${formatFigure(baseline!)} to ${formatFigure(result!)}, expected ${trial.expect}: ${moved ? 'the change is kept' : 'the change was put back'}.`;
        const published = await storage.transaction(async tx => {
          if (!moved) {
            const before = JSON.parse(trial.before) as unknown;
            const [what, name] = trial.target.split(':') as [string, string];
            if (what === 'role') {
              const role = await roleDoc(tx, name);
              if (role) await docs.writeWithin(tx, 'role', LIBRARY, name, { ...role, perspective: before as string }, 'team', `trial ${trial.id} put back`);
            } else if (what === 'instructions') {
              await writeWay(tx, trial.project_id, way => { const instructions = { ...way.instructions } as Record<string, string>; if (before === null) delete instructions[name]; else instructions[name] = before as string; return { ...way, instructions }; }, `trial ${trial.id} put back`);
            } else {
              await writeWay(tx, trial.project_id, way => ({ ...way, knobs: { ...way.knobs, [name]: before as number } }), `trial ${trial.id} put back`);
            }
          }
          await tx.updateTable('trials').set({ state: moved ? 'kept' : 'reverted', baseline: baseline?.value ?? null, result: result?.value ?? null, verdict, judged_at: now() }).where('id', '=', trial.id).execute();
          const thread = await tx.selectFrom('threads').select('id').where('project_id', '=', trial.project_id).where('kind', '=', 'discussion').executeTakeFirst();
          const drafts: Parameters<typeof events.append>[1] = [{ type: moved ? 'trial.kept' : 'trial.reverted', category: 'audit', actorKind: 'system', projectId: trial.project_id, payload: { trialId: trial.id, target: trial.target, measure: trial.measure, baseline: baseline?.value ?? null, result: result?.value ?? null } }];
          if (thread) {
            const messageId = newId(now());
            await tx.insertInto('messages').values({ id: messageId, thread_id: thread.id, author_kind: 'system', author_id: null, kind: 'system', body: `Trial of a change to ${trial.target.replace(':', ' ')}: ${verdict}`, payload: JSON.stringify({ trial: trial.id }), created_at: now() }).execute();
            drafts.push({ type: 'message.posted', actorKind: 'system', projectId: trial.project_id, threadId: thread.id, payload: { messageId, kind: 'system' } });
          }
          return events.append(tx, drafts);
        });
        events.published(published);
      }
      return due.length;
    },
  };
}
export type Trials = ReturnType<typeof createTrials>;
