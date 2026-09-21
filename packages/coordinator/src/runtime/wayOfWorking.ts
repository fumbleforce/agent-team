import { WayOfWorking } from '@agent-team/protocol';
import type { Tx } from '@agent-team/storage';

// How a project's team works, as the team left it: what a kind of turn is told where that differs from what is shipped, and
// the numbers of the process. A project that never changed anything works the shipped way. Sub-projects work as their project does.
export async function wayOfWorking(tx: Tx, projectId: string): Promise<WayOfWorking> {
  const project = await tx.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', projectId).executeTakeFirst();
  const scopeId = project?.parent_id ?? projectId;
  const row = await tx.selectFrom('versioned_docs').select('doc').where('kind', '=', 'way_of_working').where('scope_type', '=', 'project').where('scope_id', '=', scopeId).where('slug', '=', 'current').executeTakeFirst();
  const parsed = WayOfWorking.safeParse(row ? JSON.parse(row.doc) : {});
  return parsed.success ? parsed.data : WayOfWorking.parse({});
}

export const WAY_SCOPE = (projectId: string) => ({ type: 'project' as const, id: projectId });
