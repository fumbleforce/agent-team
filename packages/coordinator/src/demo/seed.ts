import { newId, type MessageKind, type TaskState } from '@agent-team/protocol';
import { hashPassword } from '../auth/secrets.ts';
import type { Context } from '../context.ts';
import { createKnowledge } from '../knowledge/knowledge.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { createProposals } from '../runtime/proposals.ts';

export const DEMO_LOGIN = { email: 'demo@example.com', password: 'demo-password-1234' };

// The sample organization drawn on the design boards, so screens can be built and reviewed against them.
// A deployment holds one organization, so the boards' second one, Nordlys Studio, is here as a project that is not
// software: documents instead of a repository, checks instead of tests, a tab of its own and its own connections.
// `empty` stops after the organization and its owner: what a person sees right after their own first sign-in.
export async function seedDemo(context: Context, options: { empty?: boolean } = {}): Promise<void> {
  const db = context.storage.db;
  const at = context.now();
  const userId = newId();
  await db.insertInto('org').values({ id: newId(), name: 'Acme', accent: 'amber', currency: 'EUR', settings: '{}', created_at: at }).execute();
  await db.insertInto('users').values({ id: userId, email: DEMO_LOGIN.email, name: 'Jorgen F', password_hash: await hashPassword(DEMO_LOGIN.password), org_role: 'owner', status: 'active', created_at: at, last_login_at: null }).execute();
  if (options.empty) return;

  const teams = { product: newId(), mobile: newId(), studio: newId(), desk: newId(), nordlys: newId() };
  await db.insertInto('teams').values([
    { id: teams.product, scope: 'project', project_id: null, name: 'Product team', template_slug: 'product-dev', template_version: 1 },
    { id: teams.mobile, scope: 'project', project_id: null, name: 'Mobile squad', template_slug: 'product-dev', template_version: 1 },
    { id: teams.studio, scope: 'project', project_id: null, name: 'Studio', template_slug: 'content-studio', template_version: 1 },
    { id: teams.desk, scope: 'project', project_id: null, name: 'Desk', template_slug: 'support-desk', template_version: 1 },
    { id: teams.nordlys, scope: 'project', project_id: null, name: 'Nordlys editorial', template_slug: 'content-studio', template_version: 1 },
  ]).execute();

  const project = (slug: string, name: string, sort: number, teamId: string | null, options: { parent?: string; status?: string; kind?: string } = {}) =>
    ({ id: newId(), slug, name, kind: options.kind ?? 'repo', parent_id: options.parent ?? null, status: options.status ?? 'active', manifest: '{}', manifest_sha: null, team_id: teamId, sort, created_at: at });
  const shop = project('web-shop', 'Web shop', 0, teams.product);
  const checkout = project('checkout-v2', 'Checkout v2', 1, null, { parent: shop.id });
  const search = project('search-rework', 'Search rework', 2, null, { parent: shop.id });
  const others = [project('mobile-app', 'Mobile app', 3, teams.mobile), project('launch-promo', 'Launch promo', 4, teams.studio, { kind: 'campaign' }), project('customer-support', 'Customer support', 5, teams.desk, { kind: 'operation' }), project('data-pipeline', 'Data pipeline', 6, null, { status: 'paused' })];
  const nordlys = project('nordlys-studio', 'Nordlys Studio', 7, teams.nordlys, { kind: 'documents' });
  await db.insertInto('projects').values([shop, checkout, search, ...others, nordlys]).execute();

  const seat = (name: string, tint: number, title: string, persona: string, doing: string | null, sort: number, isPm = false, teamId = teams.product) =>
    ({ id: newId(), team_id: teamId, name, initials: name.slice(0, 2).toUpperCase(), tint: String(tint), title, persona, status: 'active', provider_id: null, model: null, daily_cap_minor: null, is_pm: isPm, doing, sort, created_at: at });
  const maren = seat('Maren', 1, 'PM', 'Decisive, cuts scope, closes debates with a call and an owner.', 'Triaging your Safari report', 0, true);
  const ada = seat('Ada', 2, 'Backend', 'Careful with data integrity; asks "what happens on retry?" first.', 'webhooks.py · tests', 1);
  const bram = seat('Bram', 3, 'Frontend', 'Pushes for feel and polish; ships fast, takes feedback well.', 'PR #2293 in review', 2);
  const cleo = seat('Cleo', 4, 'QA', 'Skeptical by default; hunts the failure mode nobody mentioned.', 'staging run #4812', 3);
  const finn = seat('Finn', 5, 'Infra', 'Pragmatic, quiet, speaks up when something will page someone.', null, 4);
  await db.insertInto('agents').values([maren, ada, bram, cleo, finn]).execute();

  let priority = 0;
  const task = (key: string, title: string, tag: string, state: TaskState, owner: { id: string }, projectId = checkout.id) =>
    ({ id: newId(), project_id: projectId, key, source: 'tracker', title, brief: '', tag, priority: priority++, milestone_id: null, state, assignee_agent_id: owner.id, author_agent_id: null, branch: null, head_sha: null, pr_url: null, blocked_reason: null, created_at: at, updated_at: at });
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
  const say = (agent: { id: string }, minute: number, kind: MessageKind, body: string, payload: Record<string, unknown> = {}, inThread = threadId) =>
    ({ id: newId(), thread_id: inThread, author_kind: 'agent', author_id: agent.id, kind, body, payload: JSON.stringify(payload), created_at: at - (20 - minute) * 60_000 });
  await db.insertInto('messages').values([
    say(bram, 14, 'proposal', 'Double-submit fix is in (#2293). Proposal: disable the button optimistically on tap — it feels snappier and users stop hammering it.'),
    say(cleo, 15, 'feedback', 'Optimistic disable hides a real failure: if the request hangs, the user is stuck with a dead button and no error. Condition: an 8 s timeout that re-enables it with a message.', { stance: 'against' }),
    say(ada, 16, 'feedback', 'Agree with Cleo. Risk: a re-enabled button can create a duplicate order unless the idempotency key exists before the first click. Generate it on mount; the API answers a reused key with 409 and the original order id.', { stance: 'for' }),
    say(bram, 17, 'revision', 'Revised: key on mount, 8 s timeout re-enable with an inline message, 409 treated as success.'),
    say(maren, 19, 'decision', 'Ship it as revised: key on mount, 8 s timeout re-enable. Cleo owns the hang test (CK-30). The press animation is polish, not 2.14 — moved to backlog.'),
    say(finn, 20, 'note', 'Deploy window opens 16:00. Secrets rotated; ping me if you want the load test pulled forward.'),
  ]).execute();

  // One call the team may not make alone, so the queue for a person is never empty in the demo.
  const escalation = say(maren, 20, 'decision', 'Finn wants the load test pulled forward, which moves the 2.14 deploy window by a day. That is outside what we may decide: keep Thursday and test after, or test first and ship Friday?');
  await db.insertInto('messages').values(escalation).execute();
  await db.insertInto('decisions').values({ id: newId(), project_id: checkout.id, thread_id: threadId, message_id: escalation.id, deliberation_id: null, kind: 'direction', outcome: 'escalated', summary: 'Keep the Thursday deploy and load-test after, or test first and ship Friday? Moving the window is outside the team’s bounds.', needs_human: true, resolved_by_user: null, resolved_at: null, created_at: at }).execute();

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

  // Nordlys Studio: a quarterly magazine made by an editorial team.
  const ingrid = seat('Ingrid', 6, 'Managing editor', 'Keeps the issue on schedule; decides what is cut when pages run out.', 'Planning the winter issue', 0, true, teams.nordlys);
  const sol = seat('Sol', 7, 'Writer', 'Writes plainly and warmly; asks who the reader is before the first line.', 'Draft: the lighthouse keepers', 1, false, teams.nordlys);
  const tuva = seat('Tuva', 8, 'Designer', 'Cares about rhythm across a spread; fights for white space.', null, 2, false, teams.nordlys);
  const emil = seat('Emil', 9, 'Fact checker', 'Trusts nothing without a source; polite and relentless.', 'Checking the ferry timetable piece', 3, false, teams.nordlys);
  await db.insertInto('agents').values([ingrid, sol, tuva, emil]).execute();
  const feature = task('NS-11', 'Feature: the last lighthouse keepers', 'copy', 'in_progress', sol, nordlys.id);
  await db.insertInto('tasks').values([
    task('NS-14', 'Pitch list for the winter issue', 'planning', 'backlog', ingrid, nordlys.id), task('NS-15', 'Photo essay: harbour at 4 a.m.', 'design', 'backlog', tuva, nordlys.id),
    feature, task('NS-12', 'Check the ferry timetable piece', 'facts', 'in_progress', emil, nordlys.id),
    task('NS-10', 'Cover and contents spread', 'design', 'in_review', tuva, nordlys.id), task('NS-9', 'Editor’s letter', 'copy', 'done', ingrid, nordlys.id),
  ]).execute();
  const studioThread = newId();
  await db.insertInto('threads').values({ id: studioThread, project_id: nordlys.id, kind: 'discussion', subject_type: null, subject_id: null, title: '#nordlys-studio', visibility: 'team', owner_user_id: null, created_at: at }).execute();
  await db.insertInto('messages').values([
    say(sol, 12, 'proposal', 'The lighthouse feature runs 400 words over. Proposal: keep the length and drop the sidebar on lamp oil instead of cutting the interviews.', {}, studioThread),
    say(tuva, 14, 'feedback', 'For it. Without the sidebar the opening spread can carry the full-width photo. Condition: the pull quote moves to page two.', { stance: 'for' }, studioThread),
    say(emil, 15, 'feedback', 'Neutral on length. Risk: two of the interview dates are unconfirmed; I need the parish register before it goes to layout.', { stance: 'neutral' }, studioThread),
    say(ingrid, 18, 'decision', 'Keep the length, drop the sidebar, pull quote on page two. Emil confirms the dates before Thursday or the paragraph is cut.', {}, studioThread),
  ]).execute();
  await knowledge.write({ kind: 'agent', id: ingrid.id }, { scope: { type: 'project', id: nordlys.id }, path: 'style/voice.md', title: 'House voice', body: 'Plain words, short sentences, the reader addressed as an equal. Place names in the local spelling. Every figure has a source in the margin notes.' });
  await createVersionedDocs(context).save('project_settings', { type: 'project', id: nordlys.id }, 'settings', { description: 'A quarterly magazine about life on the northern coast: features, photo essays and a letter from the editor.', customTabs: [{ label: 'Editorial calendar', url: 'https://calendar.nordlys.example/editorial' }] }, { author: 'Jorgen F', note: 'Added the editorial calendar' });

  // Checks, not tests: what the team verifies about an issue before it goes to print.
  const check = (suite: string, version: string, passed: number, failed: number, minutesAgo: number) => ({ id: newId(), project_id: nordlys.id, suite, kind: 'check', branch: version, sha: null, status: failed ? 'failed' : 'passed', passed, failed, skipped: 0, total: passed + failed, duration_ms: 0, source: 'agent', created_at: at - minutesAgo * 60_000 });
  const facts = check('Fact check', 'Autumn issue', 41, 2, 35);
  await db.insertInto('check_runs').values([check('Style guide', 'Autumn issue', 28, 0, 50), facts, check('Links and images', 'Autumn issue', 64, 0, 20), check('Style guide', 'Winter issue, draft', 9, 0, 300), check('Fact check', 'Winter issue, draft', 6, 0, 290)]).execute();
  await db.insertInto('check_cases').values([{ run_id: facts.id, name: 'Lighthouse feature: year the lamp was electrified', status: 'failed', message: 'Two sources disagree (1957 and 1959)' }, { run_id: facts.id, name: 'Ferry timetable: winter departures', status: 'failed', message: 'The operator’s page changed after the draft' }]).execute();

  // Its own connections, and handoffs in both directions.
  const connection = (kind: string, name: string, category: string, mode: string, status: string, detail: string | null) => ({ id: newId(), project_id: nordlys.id, kind, name, category, mode, config: '{}', status, status_detail: detail, credential_ref: null, last_sync_at: status === 'connected' ? at - 12 * 60_000 : null, created_at: at });
  await db.insertInto('connections').values([connection('documents', 'Manuscripts folder', 'storage', 'read and write', 'connected', 'Drafts and margin notes'), connection('chat', 'Editorial channel', 'comms', 'mirror', 'connected', 'Mirrors the discussion'), connection('images', 'Photo library', 'media', 'read', 'warning', 'Waiting for access from the picture desk')]).execute();
  const handoff = (direction: 'in' | 'out', source: string, title: string, summary: string, state: string, target: string | null, by: string | null) => ({ id: newId(), project_id: nordlys.id, direction, source, title, summary, context: '{}', attachment_id: null, target_task_id: target, target_type: target ? 'task' : null, target_id: target, state, picked_by_agent_id: by, created_by: direction === 'in' ? userId : null, created_at: at - 90 * 60_000 });
  await db.insertInto('handoffs').values([
    handoff('in', 'the archive', 'Interview transcripts, 1998', 'Three taped interviews with former keepers, transcribed. Names and dates are as spoken and need checking.', 'new', null, null),
    handoff('out', 'the print shop', 'Proofs for the autumn cover', 'Two paper stocks requested; waiting for the colour proofs.', 'outbox', feature.id, tuva.id),
  ]).execute();
  await db.insertInto('budgets').values({ scope: 'project', scope_id: nordlys.id, period: 'month', amount_minor: 12_000 }).execute();
  await db.insertInto('cost_daily').values([3, 5, 2, 6, 4].flatMap((amount, index) => [sol, emil].map((agent, share) => ({ day: new Date(at - (4 - index) * 86_400_000).toISOString().slice(0, 10), project_id: nordlys.id, agent_id: agent.id, amount_minor: Math.round(amount * 100 * [0.6, 0.4][share]!), tokens: amount * 60_000 })))).execute();
}
