import { z } from 'zod';

const Paths = z.object({ paths: z.array(z.string().min(1).max(200)).min(1).max(40) });

// What a role may do. Every key is ordered from least to most, so grants can be combined and capped.
export const PermissionGrant = z.object({
  repoRead: z.union([z.enum(['none', 'all']), Paths]).default('all'),
  codeWrite: z.union([z.enum(['none', 'all']), Paths]).default('none'),
  shell: z.enum(['none', 'restricted', 'full']).default('none'),
  browser: z.enum(['none', 'allowed']).default('none'),
  issues: z.enum(['none', 'comment', 'edit']).default('none'),
  comms: z.enum(['none', 'mirror', 'post']).default('none'),
  deploy: z.enum(['none', 'allowed']).default('none'),
  // Who is on the team: hiring, retiring and reshaping seats, inside what the owner allows.
  staffing: z.enum(['none', 'decide']).default('none'),
  secrets: z.array(z.string().max(80)).max(40).default([]),
  spendDailyCapMinor: z.number().int().min(0).default(0),
  delegate: z.boolean().default(false),
});
export type PermissionGrant = z.infer<typeof PermissionGrant>;
type Scope = PermissionGrant['repoRead'];

const ORDER = { shell: ['none', 'restricted', 'full'], browser: ['none', 'allowed'], issues: ['none', 'comment', 'edit'], comms: ['none', 'mirror', 'post'], deploy: ['none', 'allowed'], staffing: ['none', 'decide'] } as const;
type Ordered = keyof typeof ORDER;
const rank = (key: Ordered, value: string) => (ORDER[key] as readonly string[]).indexOf(value);
const pick = (key: Ordered, a: string, b: string, most: boolean) => ((rank(key, a) >= rank(key, b)) === most ? a : b);

const covers = (scope: string, file: string) => file === scope || file.startsWith(scope.endsWith('/') ? scope : `${scope}/`);
function joinScope(a: Scope, b: Scope): Scope {
  if (a === 'all' || b === 'all') return 'all';
  if (a === 'none') return b;
  if (b === 'none') return a;
  return { paths: [...new Set([...a.paths, ...b.paths])].sort() };
}
function meetScope(a: Scope, b: Scope): Scope {
  if (a === 'none' || b === 'none') return 'none';
  if (a === 'all') return b;
  if (b === 'all') return a;
  // A path survives when the other side covers it; the narrower of two nested paths wins.
  const kept = [...a.paths.filter(item => b.paths.some(scope => covers(scope, item))), ...b.paths.filter(item => a.paths.some(scope => covers(scope, item)))];
  return kept.length ? { paths: [...new Set(kept)].sort() } : 'none';
}

export const NO_PERMISSIONS: PermissionGrant = PermissionGrant.parse({ repoRead: 'none' });

// Roles stack: an agent may do whatever any of its roles allows.
export function join(grants: PermissionGrant[]): PermissionGrant {
  return grants.reduce((a, b) => ({
    repoRead: joinScope(a.repoRead, b.repoRead), codeWrite: joinScope(a.codeWrite, b.codeWrite),
    shell: pick('shell', a.shell, b.shell, true) as PermissionGrant['shell'], browser: pick('browser', a.browser, b.browser, true) as PermissionGrant['browser'],
    issues: pick('issues', a.issues, b.issues, true) as PermissionGrant['issues'], comms: pick('comms', a.comms, b.comms, true) as PermissionGrant['comms'],
    deploy: pick('deploy', a.deploy, b.deploy, true) as PermissionGrant['deploy'], staffing: pick('staffing', a.staffing, b.staffing, true) as PermissionGrant['staffing'], secrets: [...new Set([...a.secrets, ...b.secrets])],
    spendDailyCapMinor: Math.max(a.spendDailyCapMinor, b.spendDailyCapMinor), delegate: a.delegate || b.delegate,
  }), NO_PERMISSIONS);
}

// A ceiling caps: the result never exceeds either side. The committed project ceiling is applied last, by the worker too.
export function meet(a: PermissionGrant, b: PermissionGrant): PermissionGrant {
  return {
    repoRead: meetScope(a.repoRead, b.repoRead), codeWrite: meetScope(a.codeWrite, b.codeWrite),
    shell: pick('shell', a.shell, b.shell, false) as PermissionGrant['shell'], browser: pick('browser', a.browser, b.browser, false) as PermissionGrant['browser'],
    issues: pick('issues', a.issues, b.issues, false) as PermissionGrant['issues'], comms: pick('comms', a.comms, b.comms, false) as PermissionGrant['comms'],
    deploy: pick('deploy', a.deploy, b.deploy, false) as PermissionGrant['deploy'], staffing: pick('staffing', a.staffing, b.staffing, false) as PermissionGrant['staffing'], secrets: a.secrets.filter(name => b.secrets.includes(name)),
    spendDailyCapMinor: Math.min(a.spendDailyCapMinor, b.spendDailyCapMinor), delegate: a.delegate && b.delegate,
  };
}

export const effective = (roles: PermissionGrant[], ...ceilings: PermissionGrant[]): PermissionGrant => ceilings.reduce(meet, join(roles));

// The post-turn gate: every changed path must fall inside the write scope, whatever tool made the change.
export function outsideWriteScope(grant: PermissionGrant, changed: string[]): string[] {
  if (grant.codeWrite === 'all') return [];
  if (grant.codeWrite === 'none') return changed;
  const scopes = grant.codeWrite.paths;
  return changed.filter(file => !scopes.some(scope => covers(scope, file)));
}

export const Role = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), summary: z.string().max(200), perspective: z.string().max(800).default(''),
  skills: z.array(z.string().max(63)).max(40).default([]), permissions: PermissionGrant, knowledgeFirst: z.array(z.string().max(200)).max(8).default([]),
  decides: z.array(z.string().max(80)).max(12).default([]), approvalKinds: z.array(z.enum(['tester', 'reviewer', 'pm'])).max(3).default([]),
});
export type Role = z.infer<typeof Role>;
