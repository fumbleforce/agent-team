import type { OrgRole, ProjectRole } from '@agent-team/protocol';

export const ACTIONS = ['project.read', 'project.contribute', 'project.operate', 'project.configure', 'project.decide', 'project.members', 'org.members', 'org.settings'] as const;
export type Action = (typeof ACTIONS)[number];

export interface Viewer { userId: string; orgRole: OrgRole; projects: ReadonlyMap<string, ProjectRole> }

const PROJECT_LEVEL: Record<ProjectRole, number> = { viewer: 1, member: 2, admin: 3 };
const REQUIRED: Record<Exclude<Action, 'org.members' | 'org.settings'>, number> = {
  'project.read': 1, 'project.contribute': 2, 'project.operate': 2, 'project.configure': 3, 'project.decide': 3, 'project.members': 3,
};

// Org owners and admins act as project admins everywhere; everyone else needs a membership on the project.
export function projectLevel(viewer: Viewer, projectId: string): number {
  if (viewer.orgRole === 'owner' || viewer.orgRole === 'admin') return PROJECT_LEVEL.admin;
  const role = viewer.projects.get(projectId);
  if (!role) return 0;
  // An org viewer never gains write access through a project grant.
  return viewer.orgRole === 'viewer' ? Math.min(PROJECT_LEVEL[role], PROJECT_LEVEL.viewer) : PROJECT_LEVEL[role];
}

export function can(viewer: Viewer, action: Action, projectId?: string): boolean {
  if (action === 'org.settings') return viewer.orgRole === 'owner';
  if (action === 'org.members') return viewer.orgRole === 'owner' || viewer.orgRole === 'admin';
  return projectId !== undefined && projectLevel(viewer, projectId) >= REQUIRED[action];
}

export const canSeeProject = (viewer: Viewer, projectId: string | null): boolean => projectId === null || projectLevel(viewer, projectId) > 0;
