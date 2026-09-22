import { z } from 'zod';

// A deliverable is one counted piece of what a team is for: a change merged, a card filed, a lead worth calling, an email ready to
// send, a deck, a campaign set up. A duty that comes round asks for a number of them; one counts once a teammate approved it.
// Changes are counted from the board as they merge; everything else, a document too, is handed in with deliverable.submit.
export const DeliverableKind = z.enum(['change', 'card', 'document', 'asset', 'record', 'message', 'campaign']);
export type DeliverableKind = z.infer<typeof DeliverableKind>;

interface KindSpec { one: string; many: string; /* What must be filled in beside the title and the body. */ fields: readonly string[]; /* Handed in with deliverable.submit, rather than counted from its own flow. */ submitted: boolean }
export const DELIVERABLE_KINDS: Record<DeliverableKind, KindSpec> = {
  change: { one: 'change', many: 'changes', fields: [], submitted: false },
  document: { one: 'document', many: 'documents', fields: [], submitted: true },
  card: { one: 'card', many: 'cards', fields: [], submitted: true },
  asset: { one: 'piece of material', many: 'pieces of material', fields: ['format'], submitted: true },
  record: { one: 'record', many: 'records', fields: ['name'], submitted: true },
  message: { one: 'message to send', many: 'messages to send', fields: ['to', 'subject'], submitted: true },
  campaign: { one: 'campaign', many: 'campaigns', fields: ['channel'], submitted: true },
};
export const deliverableWords = (kind: string, count: number) => { const spec = DELIVERABLE_KINDS[kind as DeliverableKind]; return spec ? (count === 1 ? spec.one : spec.many) : kind; };

// What a duty asks for each time it comes round.
export const DeliverableTarget = z.object({ kind: DeliverableKind, target: z.number().int().min(1).max(50) });
export type DeliverableTarget = z.infer<typeof DeliverableTarget>;

const Field = z.string().trim().max(400);
export const DeliverableSubmission = z.object({
  kind: DeliverableKind.exclude(['change']),
  title: z.string().trim().min(3).max(160),
  // The deliverable itself, as someone would act on it: the lead and why now, the email as it would go out, what the deck says.
  body: z.string().trim().min(1).max(8000),
  // Where it lives outside the platform, when it does: the record in the CRM, the file in the drive, the campaign in the ad console.
  link: z.url({ protocol: /^https?$/ }).max(500).optional(),
  fields: z.record(z.string().regex(/^[a-z][a-z_]{0,30}$/), Field).default({}),
});
export type DeliverableSubmission = z.infer<typeof DeliverableSubmission>;

export function missingFields(submission: Pick<DeliverableSubmission, 'kind' | 'fields'>): string[] {
  return DELIVERABLE_KINDS[submission.kind].fields.filter(key => !submission.fields[key]?.trim());
}
