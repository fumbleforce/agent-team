import { z } from 'zod';
import { OrgRole, ProjectRole, ProjectStatus } from './enums.ts';

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

// Versioned documents of the organization: what a project is set to, a team that can be stamped out again, an agent that can be hired.
export const ProjectSettings = z.object({
  description: z.string().max(2000).default(''),
  // Tools the team serves itself, shown as extra project tabs.
  customTabs: z.array(z.object({ label: z.string().trim().min(1).max(40), url: z.url({ protocol: /^https?$/, error: 'An address starts with https:// or http://' }).max(500) })).max(8).default([]),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const TemplateSeat = z.object({ name: z.string().min(1).max(60), title: z.string().max(80).default(''), persona: z.string().max(2000).default(''), roles: z.array(Slug).max(12).default([]), isPm: z.boolean().default(false) });
export const TeamTemplate = z.object({ name: z.string().min(1).max(80), summary: z.string().max(400).default(''), seats: z.array(TemplateSeat).min(1).max(40) });
export type TeamTemplate = z.infer<typeof TeamTemplate>;
export const LibraryAgent = TemplateSeat.omit({ isPm: true }).extend({ summary: z.string().max(400).default('') });
export type LibraryAgent = z.infer<typeof LibraryAgent>;

export const MilestoneState = z.enum(['open', 'done', 'dropped']);
export const MilestoneBody = z.object({ label: z.string().min(1).max(80), dueAt: z.number().int().min(0).nullish(), state: MilestoneState.default('open') });
export const MilestonePatch = MilestoneBody.partial();
export const ProjectLinkKind = z.enum(['depends_on', 'blocks', 'relates_to']);
export const ProjectLinkBody = z.object({ fromProjectId: z.string(), toProjectId: z.string(), kind: ProjectLinkKind.default('depends_on'), note: z.string().max(200).default('') });
export const SeatLoanBody = z.object({ toProjectId: z.string(), note: z.string().max(200).default('') });
export const ProjectStatusBody = z.object({ status: ProjectStatus });
export const ProjectMemberBody = z.object({ userId: z.string(), role: ProjectRole.nullable() });
export const UserPatch = z.object({ orgRole: OrgRole.optional(), status: z.enum(['active', 'disabled']).optional() });
export const MachineTokenBody = z.object({ name: z.string().min(1).max(60), kind: z.enum(['worker', 'cli']).default('worker') });
export const SaveTemplateBody = z.object({ slug: Slug, name: z.string().min(1).max(80), summary: z.string().max(400).default('') });
export const FromTemplateBody = z.object({ template: Slug, mode: z.enum(['create', 'append']).default('create') });
// A seat made or changed by hand. The PM flag is not part of it: a team has exactly one PM and moving it is its own, explicit action.
const AgentFields = { name: z.string().trim().min(1).max(60), title: z.string().trim().max(80), persona: z.string().trim().max(2000), roles: z.array(Slug).max(12), providerId: z.string().nullable(), model: z.string().max(120).nullable() };
export const AgentBody = z.object({ ...AgentFields, title: AgentFields.title.default(''), persona: AgentFields.persona.default(''), roles: AgentFields.roles.default([]), providerId: AgentFields.providerId.default(null), model: AgentFields.model.default(null) });
export const AgentPatch = z.object(AgentFields).partial().extend({ status: z.enum(['active', 'paused', 'retired']).optional() });
export const TeamOrderBody = z.object({ agentIds: z.array(z.string()).min(1).max(80) });
export const HireBody = z.object({ library: Slug, name: z.string().min(1).max(60).optional() });

// Single sign-on as an owner sets it; the client secret is named by environment variable, never stored.
export const OidcSettings = z.object({
  issuer: z.url(), clientId: z.string().min(1), clientSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('AGENT_TEAM_OIDC_SECRET'),
  allowedDomains: z.array(z.string().min(1)).default([]), defaultRole: z.enum(['member', 'viewer']).default('viewer'),
  // Only for a test or development provider on plain HTTP.
  allowInsecure: z.boolean().default(false),
  // Which entry of the identity catalog this was set up through, so the app can name it; absent when entered by hand.
  provider: z.string().max(40).optional(),
});
export type OidcSettings = z.infer<typeof OidcSettings>;
export const AuthSettingsBody = z.object({ oidc: OidcSettings.nullable() });

export const PageQuery = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export type PageQuery = z.infer<typeof PageQuery>;
