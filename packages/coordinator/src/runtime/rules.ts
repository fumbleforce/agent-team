import { CostRules, RoutingRules, type DeferReason } from '@agent-team/protocol';
import type { RouteChoice, Snapshot, TurnDraft } from './scheduler.ts';

export interface Rules { cost: CostRules; routing: RoutingRules }
export const DEFAULT_RULES: Rules = { cost: CostRules.parse({}), routing: RoutingRules.parse({}) };

export type Notice =
  | { type: 'budget.threshold'; projectId: string; scope: string; scopeId: string; percent: number; threshold: number }
  | { type: 'cap.fallback'; agentId: string; providerId: string };
export interface Verdict { allow: boolean; route?: RouteChoice; deferReason?: DeferReason; notices: Notice[] }

// A rule names a provider by id or by its display name.
const named = (snapshot: Snapshot, name: string) => Object.values(snapshot.providers).find(provider => provider.id === name || provider.name === name);

// The one place rules are applied. Pure: the same draft and snapshot always give the same verdict.
export function evaluate(draft: TurnDraft, snapshot: Snapshot): Verdict {
  const { cost, routing } = snapshot.rules, notices: Notice[] = [];
  const agent = snapshot.agents[draft.agentId], task = draft.taskId ? snapshot.tasks[draft.taskId] : undefined, project = snapshot.projects[draft.projectId];
  let route: RouteChoice = { providerId: agent?.providerId ?? null, model: agent?.model ?? null };

  // Routing: a work turn stays on the route its task already ran on; otherwise the first matching rule decides.
  const sticky = draft.kind === 'work' ? task?.sticky : null;
  if (sticky?.providerId && snapshot.providers[sticky.providerId]) route = sticky;
  else for (const rule of routing.routes) {
    if (!rule.enabled || (rule.kinds.length > 0 && !rule.kinds.includes(draft.kind)) || (rule.tags.length > 0 && !rule.tags.some(tag => task?.tags.includes(tag)))) continue;
    const provider = named(snapshot, rule.provider);
    if (!provider) continue;
    route = { providerId: provider.id, model: rule.model ?? (provider.id === agent?.providerId ? agent.model : provider.models[0] ?? null) };
    break;
  }

  // Budget: warn once at the threshold; at 100 % only replies to humans and work that unblocks others runs.
  if (project && project.budgetPct !== null) {
    if (cost.budgetWarn.enabled && project.budgetPct >= cost.budgetWarn.percent && !project.warned && project.budget) notices.push({ type: 'budget.threshold', projectId: draft.projectId, scope: project.budget.scope, scopeId: project.budget.scopeId, percent: Math.floor(project.budgetPct), threshold: cost.budgetWarn.percent });
    if (project.budgetPct >= 100 && draft.priorityClass > 2) return { allow: false, deferReason: 'over-budget', notices };
  }

  // Daily cap: over it the agent waits for tomorrow, unless a fallback provider is named and known.
  if (cost.dailyCap.enabled && agent && agent.dailyCapMinor !== null && draft.priorityClass > 1 && agent.spentTodayMinor >= agent.dailyCapMinor) {
    const fallback = cost.dailyCap.fallbackProvider ? named(snapshot, cost.dailyCap.fallbackProvider) : undefined;
    if (!fallback || fallback.id === route.providerId) return { allow: false, deferReason: 'over-cap', notices };
    route = { providerId: fallback.id, model: fallback.models[0] ?? null };
    notices.push({ type: 'cap.fallback', agentId: draft.agentId, providerId: fallback.id });
  }

  // A paused project keeps its agents only while the provider's usage window has room.
  const window = route.providerId ? snapshot.providers[route.providerId]?.windowPct ?? null : null;
  if (project?.status === 'paused' && cost.windowPause.enabled && window !== null && window >= cost.windowPause.percent) return { allow: false, deferReason: 'project-paused', notices };

  return { allow: true, route, notices };
}
