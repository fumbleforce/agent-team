import { z } from 'zod';
import { MessageKind, OrgRole, ProjectRole, Viewport } from './enums.ts';

export const Password = z.string().min(12).max(200);
export const LoginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });
export const SetupBody = z.object({ token: z.string().min(20), email: z.email(), name: z.string().min(1).max(80), password: Password, orgName: z.string().min(1).max(80) });
export const InviteBody = z.object({
  email: z.email(),
  orgRole: OrgRole.exclude(['owner']),
  projects: z.array(z.object({ projectId: z.string(), role: ProjectRole })).default([]),
});
export const AcceptInviteBody = z.object({ name: z.string().min(1).max(80), password: Password });

export const ProjectBody = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(80),
  kind: z.string().max(40).default('repo'),
  parentId: z.string().nullish(),
});
export const PostMessageBody = z.object({
  body: z.string().min(1).max(8000),
  kind: MessageKind.extract(['note', 'question']).default('note'),
  attachmentIds: z.array(z.string()).max(10).default([]),
});
export const VersionedDocBody = z.object({ doc: z.record(z.string(), z.unknown()), note: z.string().max(200).optional() });
export const RegisterProjectBody = z.object({ slug: ProjectBody.shape.slug, name: z.string().min(1).max(80), kind: z.string().max(40).default('repo'), manifest: z.record(z.string(), z.unknown()).default({}) });
export const CreateProjectBody = z.object({ name: z.string().trim().min(1).max(80), slug: ProjectBody.shape.slug.optional(), kind: z.string().max(40).default('repo'), parentSlug: z.string().max(60).optional(),
  // Where the code lives and where its issues are; both can be left out and set later by the committed manifest.
  scm: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).optional(), repository: z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/).max(200).optional(), baseBranch: z.string().max(100).default('main'), tracker: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).optional() });
export const WritePageBody = z.object({ path: z.string().max(200), title: z.string().min(1).max(160), body: z.string().max(200_000), note: z.string().max(200).optional(), expectedRev: z.number().int().min(0).optional() });
export const MemoryActionBody = z.object({ action: z.enum(['confirm', 'retire', 'promote']), path: z.string().max(200).optional() });
export const CreateIssueBody = z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(8000), source: z.enum(['discussion', 'product']).default('discussion'), attachmentId: z.string().nullish(),
  // Spots marked on a product snapshot, as fractions of the image so they hold at any size.
  markers: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), note: z.string().max(200).default('') })).max(12).default([]), environment: z.string().max(80).nullish() });
export const ProductEnvBody = z.object({ name: z.string().min(1).max(60), branch: z.string().max(200).nullish(), url: z.url().max(500) });
export const CaptureBody = z.object({ viewport: Viewport });
export const ProviderBody = z.object({ name: z.string().min(1).max(60), kind: z.enum(['subscription', 'metered', 'local']), engine: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), models: z.array(z.string().min(1).max(120)).min(1).max(40), maxConcurrentTurns: z.number().int().min(1).max(64).default(2) });
export const SeatProviderBody = z.object({ providerId: z.string().nullable(), model: z.string().max(120).nullable() });
