import { z } from 'zod';
import { ActorKind, EventCategory } from '../enums.ts';

export const EventDraft = z.object({
  type: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/),
  category: EventCategory.default('domain'),
  projectId: z.string().nullish(),
  subprojectId: z.string().nullish(),
  agentId: z.string().nullish(),
  userId: z.string().nullish(),
  taskId: z.string().nullish(),
  threadId: z.string().nullish(),
  turnId: z.string().nullish(),
  actorKind: ActorKind,
  payload: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().max(200).nullish(),
});
export type EventDraft = z.input<typeof EventDraft>;

export const StoredEvent = z.object({
  seq: z.number().int(),
  id: z.string(),
  at: z.number().int(),
  type: z.string(),
  category: EventCategory,
  projectId: z.string().nullable(),
  subprojectId: z.string().nullable(),
  agentId: z.string().nullable(),
  userId: z.string().nullable(),
  taskId: z.string().nullable(),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  actorKind: ActorKind,
  payload: z.record(z.string(), z.unknown()),
});
export type StoredEvent = z.infer<typeof StoredEvent>;
