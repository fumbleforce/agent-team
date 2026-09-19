import test from 'node:test';
import assert from 'node:assert/strict';
import type { OrgRole, ProjectRole } from '@agent-team/protocol';
import { can, type Action, type Viewer } from './rbac.ts';

const viewer = (orgRole: OrgRole, grant?: ProjectRole): Viewer => ({ userId: 'u', orgRole, projects: new Map(grant ? [['p', grant]] : []) });

// The matrix in docs/SPEC.md section 8, row by row.
const MATRIX: [Action, Record<string, boolean>][] = [
  ['project.read', { viewer: true, member: true, projectAdmin: true, orgAdmin: true, owner: true, outsider: false }],
  ['project.contribute', { viewer: false, member: true, projectAdmin: true, orgAdmin: true, owner: true, outsider: false }],
  ['project.operate', { viewer: false, member: true, projectAdmin: true, orgAdmin: true, owner: true, outsider: false }],
  ['project.configure', { viewer: false, member: false, projectAdmin: true, orgAdmin: true, owner: true, outsider: false }],
  ['project.decide', { viewer: false, member: false, projectAdmin: true, orgAdmin: true, owner: true, outsider: false }],
  ['project.members', { viewer: false, member: false, projectAdmin: true, orgAdmin: true, owner: true, outsider: false }],
  ['org.members', { viewer: false, member: false, projectAdmin: false, orgAdmin: true, owner: true, outsider: false }],
  ['org.settings', { viewer: false, member: false, projectAdmin: false, orgAdmin: false, owner: true, outsider: false }],
];
const SUBJECTS: Record<string, Viewer> = {
  viewer: viewer('viewer', 'viewer'), member: viewer('member', 'member'), projectAdmin: viewer('member', 'admin'),
  orgAdmin: viewer('admin'), owner: viewer('owner'), outsider: viewer('member'),
};

test('permission matrix', () => {
  for (const [action, row] of MATRIX) for (const [subject, expected] of Object.entries(row)) assert.equal(can(SUBJECTS[subject]!, action, 'p'), expected, `${subject} ${action}`);
});

test('an org viewer stays read-only even with a project admin grant', () => {
  assert.equal(can(viewer('viewer', 'admin'), 'project.contribute', 'p'), false);
});
