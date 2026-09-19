import { useResource } from '../../../data/useResource';
import { DecisionCallout } from '../../../patterns';
import type { Decision } from './model';

const OUTCOME: Record<string, string> = { accept: 'Agreed', accepted: 'Agreed', accept_with_changes: 'Agreed with changes', reject: 'Turned down', decline: 'Turned down', defer: 'Put off for now', escalate: 'Passed to a person', escalated: 'Passed to a person', answer: 'Answered', duplicate: 'Already covered' };
export const decisionState = (decision: Pick<Decision, 'outcome' | 'waitingForPerson'>) => (decision.waitingForPerson ? 'Waiting for a person to decide' : OUTCOME[decision.outcome] ?? 'Decided');

// A decision inside a page. The page only holds a pointer; what is shown is read now, so it is never out of date.
export function DecisionCard({ slug, id }: { slug: string; id: string }) {
  const found = useResource<{ decision: Decision }>(`/api/projects/${slug}/decisions/${id}`);
  if (found.error) return <DecisionCallout summary="This page points at a decision that can no longer be found." state="Missing" waiting />;
  const decision = found.data?.decision;
  if (!decision) return <DecisionCallout summary="Loading the decision…" state="…" />;
  const home = decision.projectSlug ?? slug;
  return <DecisionCallout summary={decision.summary} state={decisionState(decision)} waiting={decision.waitingForPerson} href={decision.issueNumber ? `/p/${home}/issues/${decision.issueNumber}` : `/p/${home}/tasks`} />;
}
