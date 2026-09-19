import { newId, type MessageKind, type TaskState } from '@agent-team/protocol';
import { hashPassword } from '../auth/secrets.ts';
import type { Context } from '../context.ts';
import { createKnowledge } from '../knowledge/knowledge.ts';
import { createProposals } from '../runtime/proposals.ts';

export const DEMO_LOGIN = { email: 'demo@example.com', password: 'demo-password-1234' };

// The sample organization drawn on the design boards, so screens can be built and reviewed against them.
export async function seedDemo(context: Context): Promise<void> {
  const db = context.storage.db;
  const at = context.now();
  const userId = newId();
  await db.insertInto('org').values({ id: newId(), name: 'Acme', accent: 'amber', currency: 'EUR', settings: '{}', created_at: at }).execute();
  await db.insertInto('users').values({ id: userId, email: DEMO_LOGIN.email, name: 'Jorgen F', password_hash: await hashPassword(DEMO_LOGIN.password), org_role: 'owner', status: 'active', created_at: at, last_login_at: null }).execute();

  const teams = { product: newId(), mobile: newId(), studio: newId(), desk: newId() };
  await db.insertInto('teams').values([
    { id: teams.product, scope: 'project', project_id: null, name: 'Product team', template_slug: 'product-dev', template_version: 1 },
    { id: teams.mobile, scope: 'project', project_id: null, name: 'Mobile squad', template_slug: 'product-dev', template_version: 1 },
    { id: teams.studio, scope: 'project', project_id: null, name: 'Studio', template_slug: 'content-studio', template_version: 1 },
    { id: teams.desk, scope: 'project', project_id: null, name: 'Desk', template_slug: 'support-desk', template_version: 1 },
  ]).execute();

  const project = (slug: string, name: string, sort: number, teamId: string | null, options: { parent?: string; status?: string; kind?: string } = {}) =>
    ({ id: newId(), slug, name, kind: options.kind ?? 'repo', parent_id: options.parent ?? null, status: options.status ?? 'active', manifest: '{}', manifest_sha: null, team_id: teamId, sort, created_at: at });
  const shop = project('web-shop', 'Web shop', 0, teams.product);
  const checkout = project('checkout-v2', 'Checkout v2', 1, null, { parent: shop.id });
  const search = project('search-rework', 'Search rework', 2, null, { parent: shop.id });
  const others = [project('mobile-app', 'Mobile app', 3, teams.mobile), project('launch-promo', 'Launch promo', 4, teams.studio, { kind: 'campaign' }), project('customer-support', 'Customer support', 5, teams.desk, { kind: 'operation' }), project('data-pipeline', 'Data pipeline', 6, null, { status: 'paused' })];
  await db.insertInto('projects').values([shop, checkout, search, ...others]).execute();

  const seat = (name: string, tint: number, title: string, persona: string, doing: string | null, sort: number, isPm = false) =>
    ({ id: newId(), team_id: teams.product, name, initials: name.slice(0, 2).toUpperCase(), tint: String(tint), title, persona, status: 'active', provider_id: null, model: null, daily_cap_minor: null, is_pm: isPm, doing, sort, created_at: at });
  const maren = seat('Maren', 1, 'PM', 'Decisive, cuts scope, closes debates with a call and an owner.', 'Triaging your Safari report', 0, true);
  const ada = seat('Ada', 2, 'Backend', 'Careful with data integrity; asks "what happens on retry?" first.', 'webhooks.py · tests', 1);
  const bram = seat('Bram', 3, 'Frontend', 'Pushes for feel and polish; ships fast, takes feedback well.', 'PR #2293 in review', 2);
  const cleo = seat('Cleo', 4, 'QA', 'Skeptical by default; hunts the failure mode nobody mentioned.', 'staging run #4812', 3);
  const finn = seat('Finn', 5, 'Infra', 'Pragmatic, quiet, speaks up when something will page someone.', null, 4);
  await db.insertInto('agents').values([maren, ada, bram, cleo, finn]).execute();

  let priority = 0;
  const task = (key: string, title: string, tag: string, state: TaskState, owner: { id: string }) =>
    ({ id: newId(), project_id: checkout.id, key, source: 'tracker', title, brief: '', tag, priority: priority++, milestone_id: null, state, assignee_agent_id: owner.id, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: at, updated_at: at });
  await db.insertInto('tasks').values([
    task('CK-31', 'Pay button press animation polish', 'ui', 'backlog', bram), task('CK-32', 'Apple Pay on Safari 18 (spike)', 'payments', 'backlog', bram),
    task('CK-33', 'Retry queue dashboard for ops', 'billing', 'backlog', ada), task('CK-34', 'Load test checkout at 5× peak', 'infra', 'backlog', finn),
    task('CK-27', 'Migrate billing webhooks to v2 payload', 'billing', 'in_progress', ada), task('CK-29', 'Staging regression on 2.14-rc3', 'qa', 'in_progress', cleo),
    task('CK-30', 'Hang / timeout re-enable test for pay button', 'qa', 'in_progress', cleo),
    task('CK-28', 'Fix checkout double-submit on Safari', 'ui', 'in_review', bram), task('CK-26', 'Client-side idempotency key on mount', 'payments', 'in_review', bram),
    task('CK-25', 'Rotate staging secrets before deploy', 'infra', 'done', finn), task('CK-24', 'Cut release branch 2.14', 'release', 'done', finn), task('CK-23', 'Auth quickstart for v2 tokens', 'docs', 'done', maren),
  ]).execute();

  const threadId = newId();
  await db.insertInto('threads').values({ id: threadId, project_id: checkout.id, kind: 'discussion', subject_type: null, subject_id: null, title: '#checkout-v2', visibility: 'team', owner_user_id: null, created_at: at }).execute();
  const say = (agent: { id: string }, minute: number, kind: MessageKind, body: string, payload: Record<string, unknown> = {}) =>
    ({ id: newId(), thread_id: threadId, author_kind: 'agent', author_id: agent.id, kind, body, payload: JSON.stringify(payload), created_at: at - (20 - minute) * 60_000 });
  await db.insertInto('messages').values([
    say(bram, 14, 'proposal', 'Double-submit fix is in (#2293). Proposal: disable the button optimistically on tap — it feels snappier and users stop hammering it.'),
    say(cleo, 15, 'feedback', 'Optimistic disable hides a real failure: if the request hangs, the user is stuck with a dead button and no error. Condition: an 8 s timeout that re-enables it with a message.', { stance: 'against' }),
    say(ada, 16, 'feedback', 'Agree with Cleo. Risk: a re-enabled button can create a duplicate order unless the idempotency key exists before the first click. Generate it on mount; the API answers a reused key with 409 and the original order id.', { stance: 'for' }),
    say(bram, 17, 'revision', 'Revised: key on mount, 8 s timeout re-enable with an inline message, 409 treated as success.'),
    say(maren, 19, 'decision', 'Ship it as revised: key on mount, 8 s timeout re-enable. Cleo owns the hang test (CK-30). The press animation is polish, not 2.14 — moved to backlog.'),
    say(finn, 20, 'note', 'Deploy window opens 16:00. Secrets rotated; ping me if you want the load test pulled forward.'),
  ]).execute();

  const knowledge = createKnowledge(context);
  const scope = { type: 'subproject' as const, id: checkout.id };
  await knowledge.write({ kind: 'agent', id: ada.id }, { scope, path: 'payments/idempotency.md', title: 'Idempotency in checkout', body: "Every order submission carries an idempotency key generated on mount, not on click. The key lives for the lifetime of the checkout view; a page reload creates a new one, which is intended.\n\nThe API rejects a reused key with 409 Conflict and returns the original order_id in the body. Clients treat 409 as success and route to confirmation.\n\nVerified on staging, 2.14-rc3:\n- Duplicate key returns 409 with the original order id (Ada)\n- The key survives the 8 s timeout and retry (Cleo, CK-30)" });
  await knowledge.write({ kind: 'agent', id: ada.id }, { scope, path: 'payments/webhooks-v2.md', title: 'Billing webhooks v2', body: 'Signature verification comes first; v1 payloads stay behind the WEBHOOKS_V1 flag, default off in production.' });
  await knowledge.write({ kind: 'agent', id: bram.id }, { scope, path: 'conventions/frontend.md', title: 'Frontend conventions', body: 'Pair every fetch with an AbortController and a visible error state.' });
  await knowledge.fileMemory({ scope, agentId: bram.id, type: 'gotcha', title: 'Bram · today', body: 'Safari 18 keeps a fetch pending indefinitely after network loss — always pair fetch with AbortController.' });
  await knowledge.fileMemory({ scope, agentId: cleo.id, type: 'observation', title: 'Cleo · today', body: 'Staging regression takes about 14 min on the local model versus 9 min metered; fine for non-urgent sweeps.' });

  await db.insertInto('budgets').values({ scope: 'org', scope_id: '', period: 'month', amount_minor: 60_000 }).execute();
  const spend = [9, 11, 7, 14, 12, 4, 3, 16, 13, 41, 15, 18, 12, 9];
  const spenders = [bram, cleo, ada];
  await db.insertInto('cost_daily').values(spend.flatMap((amount, index) => {
    const day = new Date(at - (spend.length - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return spenders.map((agent, share) => ({ day, project_id: checkout.id, agent_id: agent.id, amount_minor: Math.round(amount * 100 * [0.5, 0.35, 0.15][share]!), tokens: amount * 90_000 }));
  })).execute();

  // Two team proposals through the real voting path: one inside the delegated bounds (applied by the team), one above them (waits for the owner).
  const proposals = createProposals(context);
  const voters = (await db.selectFrom('agents').select('id').where('team_id', '=', bram.team_id).where('status', '=', 'active').execute()).map(row => row.id);
  for (const [capMinor, title, why] of [[1200, 'Raise Cleo’s daily cap to 12', 'Regression sweeps stop at the cap mid-afternoon twice a week.'], [4000, 'Move Ada to the larger model for design reviews, cap 40', 'Three of the last five design decisions were revised after review found gaps the smaller model missed.']] as const) {
    const target = capMinor > 1500 ? ada : cleo;
    const { proposalId } = await proposals.create({ agent_id: bram.id, project_id: checkout.id }, { category: 'limits', title, why, whatChanges: `Daily cap for ${capMinor > 1500 ? 'Ada' : 'Cleo'} becomes ${capMinor / 100}.`, change: { kind: 'set_daily_cap', agentId: target.id, capMinor }, evidence: [{ label: 'Turns deferred by the cap, 14 days', value: capMinor > 1500 ? '9' : '6' }] });
    for (const id of voters.filter(id => id !== bram.id)) await proposals.vote({ agent_id: id }, proposalId, { stance: 'for', note: 'Agreed; the numbers support it.' });
  }
}
