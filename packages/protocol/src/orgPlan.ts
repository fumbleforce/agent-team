import { z } from 'zod';
import { DeliverableTarget } from './deliverables.ts';
import { ProjectLinkKind, TeamTemplate } from './org.ts';
import { NewSeat } from './proposals.ts';

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
// A team is named by its short name, or, when an earlier step of the same plan makes it, by the $name that step gave it.
const NewRef = z.string().regex(/^\$[a-z][a-z0-9-]{0,30}$/, 'A new team is named like $sales');
const TeamRef = z.union([Slug, NewRef]);
// A seat is named by its id, or by its name on the team, for a seat an earlier step of the plan brings in.
const SeatRef = z.string().trim().min(1).max(60);

// What a team is for: the area it owns without being told, and what it should show for it.
export const Charter = z.object({ area: z.string().trim().min(3).max(300), outcomes: z.array(z.string().trim().min(3).max(200)).max(6).default([]) });
export type Charter = z.infer<typeof Charter>;

// One change to the organisation, as data the platform applies step by step. Each maps onto an action a person can take by hand.
export const OrgChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_team'), ref: NewRef, name: z.string().trim().min(1).max(80), charter: Charter, template: Slug.optional(), seats: z.array(NewSeat.extend({ isPm: z.boolean().default(false) })).min(1).max(12).optional(),
    // Where its code lives, for a team that works on a repository: the code host by its short name, and the repository there.
    code: z.object({ host: Slug, repository: z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/) }).optional() }),
  z.object({ kind: z.literal('hire'), team: TeamRef, library: Slug.optional(), seat: NewSeat.optional(), count: z.number().int().min(1).max(5).default(1) }),
  z.object({ kind: z.literal('retire'), agentId: z.string() }),
  z.object({ kind: z.literal('change_seat'), agentId: z.string(), title: z.string().trim().max(80).optional(), persona: z.string().trim().max(2000).optional(), roles: z.array(Slug).min(1).max(12).optional() }),
  z.object({ kind: z.literal('set_team_model'), team: TeamRef, providerId: z.string(), model: z.string().max(120) }),
  z.object({ kind: z.literal('set_charter'), team: TeamRef, charter: Charter }),
  z.object({ kind: z.literal('set_duty'), team: TeamRef, owner: SeatRef, title: z.string().trim().min(3).max(120), brief: z.string().trim().min(1).max(2000), everyHours: z.number().int().min(0).max(24 * 31), deliverable: DeliverableTarget }),
  z.object({ kind: z.literal('connect_integration'), team: TeamRef, integration: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), roles: z.array(Slug).max(12).default([]) }),
  z.object({ kind: z.literal('link_teams'), from: TeamRef, to: TeamRef, link: ProjectLinkKind.default('depends_on'), note: z.string().max(200).default('') }),
  z.object({ kind: z.literal('lend_seat'), agentId: z.string(), to: TeamRef, note: z.string().max(200).default('') }),
  z.object({ kind: z.literal('add_template'), slug: Slug, template: TeamTemplate }),
]).superRefine((change, context) => {
  if (change.kind === 'hire' && Boolean(change.library) === Boolean(change.seat)) context.addIssue({ code: 'custom', message: 'A hire names either someone from the library or a new seat' });
  if (change.kind === 'create_team' && change.template && change.seats) context.addIssue({ code: 'custom', message: 'A new team starts from a template or from seats, not both' });
});
export type OrgChange = z.infer<typeof OrgChange>;

export const OrgPlan = z.object({ title: z.string().trim().min(3).max(160), why: z.string().trim().min(1).max(1600), steps: z.array(OrgChange).min(1).max(20) });
export type OrgPlan = z.infer<typeof OrgPlan>;

// How each step went when the plan was applied, in the order of the plan.
export const StepOutcome = z.object({ ok: z.boolean(), note: z.string().max(400) });
export type StepOutcome = z.infer<typeof StepOutcome>;
