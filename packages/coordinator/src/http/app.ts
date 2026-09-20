import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono, type Context as Hc } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { AcceptInviteBody, CaptureBody, InviteBody, LoginBody, newId, ProductEnvBody, PostMessageBody, SetupBody, TaskState, type ProjectView, type StoredEvent, type ThreadMessagesView } from '@agent-team/protocol';
import { createAccounts } from '../auth/accounts.ts';
import { createOidc } from '../auth/oidc.ts';
import { can, canSeeProject, type Action, type Viewer } from '../auth/rbac.ts';
import { createMachineTokens } from '../auth/machineTokens.ts';
import { clientAddress, idempotency, ifMatch, onError, onNotFound, pageOf, parseBody, preconditioned } from './conventions.ts';
import { registerOrgRoutes } from './orgRoutes.ts';
import { registerRuleRoutes } from './ruleRoutes.ts';
import { registerKnowledgeRoutes } from './knowledgeRoutes.ts';
import { forbidden, HttpError, type Context } from '../context.ts';
import { mountSetupRoutes } from './setupRoutes.ts';
import { mountSsoSetupRoutes } from './ssoSetupRoutes.ts';
import { mountOnboardingRoutes } from './onboardingRoutes.ts';
import { mountWorkerSetupRoutes } from './workerSetupRoutes.ts';
import { ENGINES } from '../../../../adapters/engine/index.ts';
import { createControls } from '../runtime/controls.ts';
import { createNeedsYou, type NeedsYouKind } from '../runtime/needsYou.ts';
import { mountProviderRoutes } from './providerSetupRoutes.ts';
import { mountTaskRoutes } from './taskRoutes.ts';
import { deskOf } from '../runtime/desk.ts';
import { createWorkload } from '../runtime/workload.ts';
import { SCM_KINDS, scmAdapter } from '../../../../adapters/scm/index.ts';
import { TRACKER_KINDS } from '../../../../adapters/tracker/index.ts';
import { createWorkspace } from '../repos/workspace.ts';
import { createTurns } from '../runtime/turns.ts';
import { createMcp } from '../mcp/server.ts';
import { createDeliberation } from '../runtime/deliberation.ts';
import { createReviews } from '../runtime/reviews.ts';
import { createRetro } from '../runtime/retro.ts';
import { createMentions } from '../runtime/mentions.ts';
import { createKnowledge, httpEmbedder, type Scope } from '../knowledge/knowledge.ts';
import { createCosts } from '../costs/costs.ts';
import { createChecks } from '../checks/checks.ts';
import { createCursors } from '../sync/cursors.ts';
import { createProposals } from '../runtime/proposals.ts';
import { createIssues } from '../repos/issues.ts';
import { createCaptures } from '../runtime/captures.ts';
import { createSessions } from '../runtime/sessions.ts';
import { createTraceStore } from '../runtime/traceStore.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { AttachHandoffBody, ConnectionBody, createIntegrations, HandoffBody, HandoffResultBody } from '../repos/integrations.ts';
import { ClaimBody, FinishBody, GitAdminBody, LeaseBody, TaskStatesBody, SessionBody, StepArtifactKind, STREAM_ARTIFACT_SEQ, CreateIssueBody, RegisterProjectBody, CreateProjectBody, SeatProviderBody, StepsBody } from '@agent-team/protocol';

type Env = { Variables: { viewer: Viewer } };
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png' };

export function createApp(context: Context) {
  const accounts = createAccounts(context);
  const oidc = createOidc(context);
  const workspace = createWorkspace(context);
  const turns = createTurns(context);
  const deliberation = createDeliberation(context, turns);
  const reviews = createReviews(context, turns), workload = createWorkload(context, turns);
  let chased = 0;
  const retro = createRetro(context, turns);
  // Semantic search is on when an embeddings endpoint is named; otherwise search is lexical.
  const knowledge = createKnowledge(context, process.env.AGENT_TEAM_EMBEDDINGS_URL ? httpEmbedder(process.env.AGENT_TEAM_EMBEDDINGS_URL, process.env.AGENT_TEAM_EMBEDDINGS_MODEL ?? 'nomic-embed-text') : null);
  const costs = createCosts(context);
  const checks = createChecks(context);
  const proposals = createProposals(context);
  const issues = createIssues(context, path.join(context.dataDir, 'blobs'));
  const captures = createCaptures(context, turns, issues);
  const sessions = createSessions(context);
  const traceStore = createTraceStore(context);
  const docs = createVersionedDocs(context);
  const integrations = createIntegrations(context, turns);
  const mentions = createMentions(context, turns);
  const mcp = createMcp(context, { workspace, deliberation, reviews, knowledge, turns, issues, integrations, mentions });
  const LIBRARY = { type: 'library' as const, id: '' };
  const cookieName = context.secureCookies ? '__Host-session' : 'session';
  const app = new Hono<Env>();

  const machineTokens = createMachineTokens(context);
  const body = parseBody;
  const startSession = (c: Hc, token: string) => setCookie(c, cookieName, token, { httpOnly: true, sameSite: 'Lax', secure: context.secureCookies, path: '/', maxAge: 30 * 24 * 3600 });
  const allow = (c: Hc<Env>, action: Action, projectId?: string) => { if (!can(c.get('viewer'), action, projectId)) throw forbidden(); };
  // The root machine token or a named one that is not revoked.
  const machine = async (c: Hc) => { if (!await machineTokens.accepts(c.req.header('authorization'))) throw new HttpError(401, 'unauthorized', 'Machine token required'); };

  app.onError(onError);
  app.notFound(onNotFound);

  // Cookie-authenticated writes must come from this origin and carry JSON.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      const sameOrigin = site ? site === 'same-origin' || site === 'none' : !origin || origin === new URL(c.req.url).origin;
      if (!sameOrigin) throw new HttpError(403, 'cross_site', 'Cross-site request refused');
    }
    await next();
  });

  app.get('/health', c => c.json({ ok: true }));
  // A worker started by hand asks which project a name stands for.
  app.get('/machine/projects/:slug', async c => { await machine(c); const row = await context.storage.db.selectFrom('projects').select(['id', 'name']).where('slug', '=', c.req.param('slug')).executeTakeFirst(); if (!row) throw new HttpError(404, 'not_found', 'No such project'); return c.json(row); });
  // Assigned further down, where the guided setup is mounted; routes only run after that.
  let setup: ReturnType<typeof mountSetupRoutes>;
  let providerSetup: ReturnType<typeof mountProviderRoutes>;
  app.post('/machine/projects', async c => {
    await machine(c);
    const id = await workspace.registerProject(await body(c, RegisterProjectBody));
    await retro.ensureSchedule(id);
    await setup.adoptManifest(id, null);
    return c.json({ id });
  });
  app.post('/machine/setup-link', async c => { await machine(c); return c.json({ path: await accounts.setupLink() }); });

  // Worker routes: machine token plus, per turn, the lease. A lost lease answers 409 and the worker stops.
  app.use('/worker/*', async (c, next) => { await machine(c); await next(); });
  const servedBy = new Map<string, Map<string, number>>();
  app.post('/worker/claim', async c => {
    const claim = await body(c, ClaimBody);
    // Every poll records the worker as seen, with what it serves: the Team page and the launcher read it.
    // Two processes may still report under one name (configurations written before workers were named per project). What the name
    // serves is then everything reported under it in the last minutes, so they add to each other instead of overwriting each other.
    const reported = servedBy.get(claim.workerId) ?? new Map<string, number>();
    for (const projectId of claim.projects) reported.set(projectId, context.now());
    for (const [projectId, at] of reported) if (at < context.now() - 3 * 60_000) reported.delete(projectId);
    servedBy.set(claim.workerId, reported);
    const seen = { name: claim.workerId, lanes: JSON.stringify(claim.free), projects: JSON.stringify([...reported.keys()]), last_seen_at: context.now(), ...(claim.ready ? { providers: JSON.stringify(claim.ready) } : {}), ...(claim.isolation ? { isolation: claim.isolation } : {}) };
    await context.storage.db.insertInto('workers').values({ id: claim.workerId, isolation: 'isolated', providers: '[]', ...seen }).onConflict(oc => oc.column('id').doUpdateSet(seen)).execute();
    // Before handing out work: whatever review or merge was lost along the way is asked for again. At most twice a minute.
    if (context.now() - chased > 30_000) {
      chased = context.now();
      await reviews.chase().catch(error => console.error(`Chasing reviews failed: ${(error as Error).message}`));
      await workload.nudge().catch(error => console.error(`Looking at the workload failed: ${(error as Error).message}`));
      // This worker is here and asking for work, so whatever it was running when it lost contact is over: it ends its own processes when it
      // cannot confirm a lease, and again when it starts. Work it had in hand then is a known state and continues, without a person.
      const mine = await context.storage.db.selectFrom('quarantines').innerJoin('turns', 'turns.id', 'quarantines.turn_id').select('quarantines.id').where('quarantines.released_at', 'is', null).where('quarantines.scope', '=', 'task').where('turns.worker_id', '=', claim.workerId).where('turns.kind', '!=', 'deliver').where('quarantines.opened_at', '<', context.now() - 60_000).execute();
      for (const row of mine) await needsYou.releaseQuarantine(null, row.id, 'continue', 'Its worker is back and has ended what it was running, so the work continues from its worktree.').catch(() => {});
    }
    const turn = await turns.claim(claim);
    // A key entered in the app travels with the one turn that needs it, over the worker's own authenticated channel.
    return c.json({ turn: turn ? { ...turn, secrets: await providerSetup.turnSecrets(turn.turnId) } : turn });
  });
  app.post('/worker/turns/:id/heartbeat', async c => { const lease = await body(c, LeaseBody); await turns.heartbeat(c.req.param('id'), lease.workerId, lease.leaseToken); return c.json({ ok: true }); });
  app.post('/worker/turns/:id/git-admin', async c => { const input = await body(c, GitAdminBody); await turns.gitAdmin(c.req.param('id'), input.workerId, input.leaseToken, input.state); return c.json({ ok: true }); });
  // Which of the tasks a worker keeps review worktrees for are over: keys and states only, for the project the worker serves.
  app.post('/worker/tasks/states', async c => {
    const input = await body(c, TaskStatesBody);
    const rows = input.taskKeys.length ? await context.storage.db.selectFrom('tasks').select(['key', 'state']).where('project_id', '=', input.projectId).where('key', 'in', input.taskKeys).execute() : [];
    return c.json({ states: Object.fromEntries(rows.map(row => [row.key, row.state])) });
  });
  app.post('/worker/turns/:id/steps', async c => { const input = await body(c, StepsBody); await turns.steps(c.req.param('id'), input.workerId, input.leaseToken, input.steps); return c.json({ ok: true }); });
  app.post('/worker/turns/:id/delivery', async c => {
    const lease = await body(c, LeaseBody);
    await turns.heartbeat(c.req.param('id'), lease.workerId, lease.leaseToken);
    const turn = await context.storage.db.selectFrom('turns').select(['task_id', 'kind']).where('id', '=', c.req.param('id')).executeTakeFirstOrThrow();
    if (turn.kind !== 'deliver' || !turn.task_id) throw new HttpError(409, 'delivery', 'Not a delivery turn');
    return c.json(await reviews.deliveryFor(turn.task_id));
  });
  // The body is the captured image; the lease travels in headers because the body is not JSON.
  app.post('/worker/turns/:id/artifacts', async c => {
    // A trace step's text (a git diff, run output, think text) arrives the same way, named by the step it belongs to.
    const stepKind = StepArtifactKind.safeParse(c.req.header('x-step-kind')), seq = Number(c.req.header('x-step-seq'));
    if (stepKind.success && Number.isInteger(seq) && (stepKind.data === 'stream' ? seq === STREAM_ARTIFACT_SEQ : seq >= 0)) {
      // Large bodies, screenshots and the raw stream go to the artifact store; the row keeps the reference and the size.
      const stored = await traceStore.put(tx => turns.leased(tx, c.req.param('id'), c.req.header('x-worker-id') ?? '', c.req.header('x-lease-token') ?? ''), c.req.param('id'), { seq, kind: stepKind.data, bytes: new Uint8Array(await c.req.arrayBuffer()), mime: (c.req.header('content-type') ?? '').split(';')[0]!.trim(), truncated: c.req.header('x-step-truncated') === '1' });
      if (!stored) throw new HttpError(415, 'artifact', 'A step image is a PNG, JPEG or WebP within the size limit');
      return c.json({ ok: true });
    }
    const latency = Number(c.req.header('x-latency-ms'));
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await captures.artifact(c.req.param('id'), c.req.header('x-worker-id') ?? '', c.req.header('x-lease-token') ?? '', { mime: (c.req.header('content-type') ?? '').split(';')[0]!.trim(), bytes, latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null }));
  });
  app.post('/worker/turns/:id/session', async c => {
    const input = await body(c, SessionBody);
    context.events.published(await context.storage.transaction(async tx => sessions.record(tx, await turns.leased(tx, c.req.param('id'), input.workerId, input.leaseToken), input)));
    return c.json({ ok: true });
  });
  // A worker that starts and finds a turn of its own still recorded as running was restarted under it. It has ended that turn's process
  // itself before saying so, and the worktree is still on its disk: the state is known, so work simply continues there, and a person is not
  // asked to investigate. A delivery is the exception: whether the merge went through cannot be known from here, so that stays a person's call.
  app.post('/worker/turns/:id/orphaned', async c => {
    const lease = await body(c, LeaseBody), turnId = c.req.param('id')!;
    const turn = await turns.claimedBy(turnId, lease.workerId, lease.leaseToken);
    if (!turn) throw new HttpError(409, 'lease', 'Lease lost or invalid');
    const NOTE = 'The worker was restarted while this ran. It ended the process itself and the work so far is still in its worktree, so it continues from there.';
    if (turn.kind === 'deliver') { if (turn.state === 'running') await context.storage.transaction(async tx => sessions.orphaned(tx, await turns.leased(tx, turnId, lease.workerId, lease.leaseToken))); await turns.sweep(); return c.json({ ok: true, continued: false }); }
    if (turn.state === 'running' && Number(turn.lease_until) >= context.now()) await turns.finish(turnId, lease.workerId, lease.leaseToken, { state: 'deferred', stopReason: 'worker-restarted', summary: NOTE });
    else {
      // The lease ran out before the worker came back, so this was already put in front of a person: that is taken back.
      await turns.sweep();
      for (const open of await context.storage.db.selectFrom('quarantines').select('id').where('turn_id', '=', turnId).where('released_at', 'is', null).execute()) await needsYou.releaseQuarantine(null, open.id, 'continue', NOTE);
    }
    return c.json({ ok: true, continued: true });
  });
  app.post('/worker/turns/:id/finish', async c => { const input = await body(c, FinishBody); const finished = await turns.finish(c.req.param('id'), input.workerId, input.leaseToken, input.outcome);
    // A work turn that reported ready_for_review hands its head to the reviewers.
    if (finished.reviewTaskId && input.outcome.headSha) await reviews.request(finished.reviewTaskId, input.outcome.headSha);
    // A verdict recorded in this turn counts only now, and only if the head the worker verified is the task's head.
    await reviews.verify(c.req.param('id'), { start: input.outcome.headShaStart, end: input.outcome.headShaEnd });
    return c.json({ ok: true });
  });

  app.post('/mcp', async c => { const answer = await mcp.handle(c.req.header('authorization'), await c.req.json().catch(() => null)); return answer.body === null ? c.body(null, 202) : c.json(answer.body as object, answer.status as 200); });

  app.get('/demo/enter', async c => {
    if (!context.demoLogin) throw new HttpError(404, 'not_found', 'Not found');
    startSession(c, await accounts.login(context.demoLogin.email, context.demoLogin.password, 'demo'));
    return c.redirect('/');
  });

  app.post('/api/auth/setup', async c => { startSession(c, await accounts.setup(await body(c, SetupBody))); return c.json({ ok: true }); });
  app.post('/api/auth/login', async c => {
    const input = await body(c, LoginBody);
    startSession(c, await accounts.login(input.email, input.password, clientAddress(c)));
    return c.json({ ok: true });
  });
  app.post('/api/auth/invites/:token', async c => { startSession(c, await accounts.acceptInvite(c.req.param('token'), await body(c, AcceptInviteBody))); return c.json({ ok: true }); });
  const callbackUri = (c: Hc) => `${c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')}://${c.req.header('host')}/api/auth/oidc/callback`;
  app.get('/api/auth/oidc', async c => c.json({ enabled: await oidc.enabled() }));
  app.get('/api/auth/oidc/start', async c => c.redirect(await oidc.start(callbackUri(c))));
  app.get('/api/auth/oidc/callback', async c => {
    const url = new URL(callbackUri(c));
    url.search = new URL(c.req.url).search;
    startSession(c, await accounts.sessionFor(await oidc.finish(url)));
    return c.redirect('/');
  });
  app.post('/api/auth/logout', async c => {
    const token = getCookie(c, cookieName);
    if (token) await accounts.logout(token);
    deleteCookie(c, cookieName, { path: '/', secure: context.secureCookies });
    return c.json({ ok: true });
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next();
    let viewer = await accounts.viewer(getCookie(c, cookieName));
    // On a loopback bind an identity proxy may vouch for the person; that opens an ordinary session.
    const vouched = !viewer && context.trustedHeader ? c.req.header(context.trustedHeader) : undefined;
    if (vouched) {
      const token = await accounts.trustedSession(vouched);
      if (token) { startSession(c, token); viewer = await accounts.viewer(token); }
    }
    if (!viewer) throw new HttpError(401, 'unauthenticated', 'Sign in');
    c.set('viewer', viewer);
    await next();
  });
  app.use('/api/*', idempotency(context));

  app.get('/api/me', async c => {
    const viewer = c.get('viewer');
    const user = await context.storage.db.selectFrom('users').select(['id', 'email', 'name', 'org_role']).where('id', '=', viewer.userId).executeTakeFirstOrThrow();
    return c.json({ user: { id: user.id, email: user.email, name: user.name, orgRole: user.org_role }, org: await workspace.org(), seq: await context.events.head() });
  });
  app.post('/api/invites', async c => { allow(c, 'org.members'); return c.json({ path: await accounts.invite(c.get('viewer'), await body(c, InviteBody)) }); });

  app.get('/api/projects', async c => c.json({ projects: await workspace.projectTree(c.get('viewer')), seq: await context.events.head() }));
  app.get('/api/projects/:slug', async c => {
    const project = await workspace.project(c.req.param('slug'));
    const root = project.parent_id ?? project.id;
    allow(c, 'project.read', root);
    const parent = project.parent_id ? await context.storage.db.selectFrom('projects').select(['slug', 'name', 'team_id']).where('id', '=', project.parent_id).executeTakeFirst() : null;
    const teamId = project.team_id ?? parent?.team_id ?? null;
    const discussion = await workspace.discussion(project.id).catch(() => null);
    // Tools the team serves itself, set in the project's settings; only web addresses ever reach a link.
    const settings = await docs.get('project_settings', { type: 'project', id: root }, 'settings').catch(() => null);
    return c.json({
      customTabs: (settings?.doc.customTabs ?? []).filter(tab => /^https?:\/\//i.test(tab.url)),
      project: { id: project.id, slug: project.slug, name: project.name, kind: project.kind, status: project.status, parent: parent ? { slug: parent.slug, name: parent.name } : null },
      roster: teamId ? await workspace.roster(teamId) : [],
      board: await workspace.board(project.id),
      discussionThreadId: discussion?.id ?? null,
      seq: await context.events.head(),
    } satisfies ProjectView);
  });
  app.post('/api/tasks/:id/state', async c => {
    const task = await context.storage.db.selectFrom('tasks').innerJoin('projects', 'projects.id', 'tasks.project_id').select(['projects.id', 'projects.parent_id']).where('tasks.id', '=', c.req.param('id')).executeTakeFirst();
    if (!task) throw new HttpError(404, 'not_found', 'Task not found');
    allow(c, 'project.operate', task.parent_id ?? task.id);
    await workspace.moveTask(c.get('viewer'), c.req.param('id'), (await body(c, z.object({ state: TaskState }))).state);
    return c.json({ ok: true });
  });

  app.post('/api/tasks/:id/assign', async c => {
    const task = await context.storage.db.selectFrom('tasks').innerJoin('projects', 'projects.id', 'tasks.project_id').select(['projects.id', 'projects.parent_id']).where('tasks.id', '=', c.req.param('id')).executeTakeFirst();
    if (!task) throw new HttpError(404, 'not_found', 'Task not found');
    allow(c, 'project.operate', task.parent_id ?? task.id);
    const { agentId } = await body(c, z.object({ agentId: z.string() }));
    const projectId = await workspace.assignTask(c.get('viewer'), c.req.param('id'), agentId);
    await turns.enqueue({ agentId, projectId, kind: 'work', taskId: c.req.param('id'), dedupeKey: `work:${c.req.param('id')}` });
    return c.json({ ok: true });
  });

  const threadFor = async (c: Hc<Env>, action: Action) => {
    const thread = await workspace.thread(c.req.param('id')!);
    const viewer = c.get('viewer');
    if (thread.visibility === 'private') { if (thread.owner_user_id !== viewer.userId) throw forbidden(); return thread; }
    if (thread.project_id) {
      const project = await context.storage.db.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', thread.project_id).executeTakeFirstOrThrow();
      allow(c, action, project.parent_id ?? project.id);
    }
    return thread;
  };
  app.get('/api/threads/:id/messages', async c => {
    const thread = await threadFor(c, 'project.read');
    return c.json({ ...await (async () => { const page = pageOf(c), rows = await workspace.messages(thread.id, { after: page.after ?? 0, limit: page.limit + 1 }); return { messages: rows.slice(0, page.limit), next: rows.length > page.limit ? rows[page.limit - 1]!.seq : null }; })(), seq: await context.events.head() } satisfies ThreadMessagesView);
  });
  app.post('/api/threads/:id/messages', async c => {
    const thread = await threadFor(c, 'project.contribute');
    const input = await body(c, PostMessageBody);
    // Attached images are named on the message itself, so every reader of the thread gets them with it.
    const attachmentIds = [...new Set(input.attachmentIds)];
    if (attachmentIds.length && (await context.storage.db.selectFrom('attachments').select('id').where('id', 'in', attachmentIds).execute()).length !== attachmentIds.length) throw new HttpError(400, 'invalid', 'An attached image was not found; attach it again');
    const id = await workspace.postMessage({ kind: 'user', id: c.get('viewer').userId }, thread, { body: input.body, kind: input.kind, ...(attachmentIds.length ? { payload: { attachmentIds } } : {}) });
    // @agent and @role are directed requests under the same limits as an agent's; whoever is named answers instead of the PM.
    const named = thread.project_id && thread.visibility === 'team' ? await mentions.fromText({ projectId: thread.project_id, threadId: thread.id, message: { id }, author: { kind: 'user', id: c.get('viewer').userId }, body: input.body }) : [];
    // What a human raises in a team thread otherwise goes to the PM, who answers or opens a deliberation.
    const open = thread.project_id && thread.visibility === 'team' && named.length === 0, issueThread = open ? Boolean(await context.storage.db.selectFrom('issues').select('id').where('thread_id', '=', thread.id).executeTakeFirst()) : false;
    // A team with a front desk hears from it first, except on an issue, which is the PM's to settle. It answers, or passes it to the PM.
    const desk = open && !issueThread ? await deskOf(context.storage.db, thread.project_id!) : null;
    if (desk) { await turns.enqueue({ agentId: desk, projectId: thread.project_id!, kind: 'reply', threadId: thread.id, dedupeKey: `desk:${thread.id}:${id}` }); return c.json({ id }); }
    const pm = open ? await workspace.pm(thread.project_id!) : null;
    if (pm && thread.project_id) await turns.enqueue({ agentId: pm, projectId: thread.project_id, kind: 'triage', threadId: thread.id, dedupeKey: `triage:${thread.id}` });
    return c.json({ id });
  });

  // Resolves a project slug the viewer may act on, and its knowledge scope.
  const projectFor = async (c: Hc<Env>, action: Action) => {
    const project = await workspace.project(c.req.param('slug')!);
    allow(c, action, project.parent_id ?? project.id);
    return { project, scope: { type: project.parent_id ? 'subproject' : 'project', id: project.id } as Scope };
  };
  // Pages, memories, history, search and decisions: knowledgeRoutes.ts.
  registerKnowledgeRoutes(app, context, { workspace, knowledge });

  // One lane per agent: what it is on now, what is queued, what it owes teammates, and why anything waits.
  app.get('/api/projects/:slug/workload', async c => {
    const { project } = await projectFor(c, 'project.read');
    const root = project.parent_id ? await context.storage.db.selectFrom('projects').select(['id', 'team_id']).where('id', '=', project.parent_id).executeTakeFirstOrThrow() : project;
    const roster = root.team_id ? await workspace.roster(root.team_id) : [];
    const ids = roster.map(agent => agent.id);
    const items = ids.length ? await context.storage.db.selectFrom('work_items').leftJoin('tasks', 'tasks.id', 'work_items.task_id').select(['work_items.id', 'work_items.agent_id', 'work_items.kind', 'work_items.lane', 'work_items.state', 'work_items.defer_reason', 'tasks.key', 'tasks.title']).where('work_items.agent_id', 'in', ids).where('work_items.state', 'in', ['queued', 'leased']).orderBy('work_items.priority_class').orderBy('work_items.created_at').execute() : [];
    const limited = new Map((await context.storage.db.selectFrom('providers').select(['id', 'limited_until']).where('limited_until', '>', context.now()).execute()).map(row => [row.id, Number(row.limited_until)]));
    // Agents that went over their daily cap today and were moved to the fallback provider.
    const fellBack = new Set(ids.length ? (await context.storage.db.selectFrom('agents').select('id').where('id', 'in', ids).where('fallback_noticed_day', '=', new Date(context.now()).toISOString().slice(0, 10)).execute()).map(row => row.id) : []);
    const lanes = roster.map(seat => {
      // An agent whose provider hit its usage limit shows provider-limited until the reset.
      const agent = { ...seat, limitedUntil: seat.provider_id ? limited.get(seat.provider_id) ?? null : null, onFallbackToday: fellBack.has(seat.id) };
      const mine = items.filter(item => item.agent_id === agent.id);
      const view = (item: (typeof items)[number]) => ({ id: item.id, kind: item.kind, key: item.key, title: item.title ?? item.kind, deferReason: item.defer_reason });
      return { agent, now: mine.filter(item => item.state === 'leased').map(view), queued: mine.filter(item => item.state === 'queued' && item.lane === 'work').map(view), owed: mine.filter(item => item.state === 'queued' && item.lane !== 'work').map(view) };
    });
    return c.json({ lanes, busy: lanes.filter(lane => lane.now.length > 0).length, seq: await context.events.head() });
  });

  // Direct control over an agent, and the private 1:1 with it.
  const controls = createControls(context, turns);
  const agentHome = async (c: Hc<Env>, action: Action) => {
    const row = await context.storage.db.selectFrom('agents').innerJoin('projects', 'projects.team_id', 'agents.team_id').select(['projects.id']).where('agents.id', '=', c.req.param('id') ?? '').executeTakeFirst();
    if (!row) throw new HttpError(404, 'not_found', 'Agent not found');
    allow(c, action, row.id);
    return row.id;
  };
  app.post('/api/agents/:id/stop', async c => { await agentHome(c, 'project.operate'); return c.json(await controls.stopAgent(c.get('viewer').userId, c.req.param('id')!)); });
  app.get('/api/agents/:id/dm', async c => { const projectId = await agentHome(c, 'project.contribute'); return c.json(await controls.direct(c.get('viewer').userId, c.req.param('id')!, projectId)); });
  // One stream of what the whole team is doing and just did.
  app.get('/api/projects/:slug/feed', async c => { const { project } = await projectFor(c, 'project.read'); return c.json(await workload.feed(project.id)); });
  // Who answers the owner for this project: its front desk when it has one. The app offers to talk to them, by voice too.
  app.get('/api/projects/:slug/desk', async c => {
    const { project } = await projectFor(c, 'project.read'), id = await deskOf(context.storage.db, project.id);
    const agent = id ? await context.storage.db.selectFrom('agents').select(['id', 'name', 'title', 'initials', 'tint', 'model']).where('id', '=', id).executeTakeFirst() : null;
    return c.json({ desk: agent ?? null });
  });
  app.post('/api/agents/:id/dm', async c => { const projectId = await agentHome(c, 'project.contribute'); const input = await body(c, z.object({ body: z.string().trim().min(1).max(8000) })); return c.json(await controls.say(c.get('viewer').userId, c.req.param('id')!, projectId, input.body)); });
  app.post('/api/tasks/:id/merge-again', async c => {
    const task = await context.storage.db.selectFrom('tasks').innerJoin('projects', 'projects.id', 'tasks.project_id').select(['projects.id', 'projects.parent_id']).where('tasks.id', '=', c.req.param('id')).executeTakeFirst();
    if (!task) throw new HttpError(404, 'not_found', 'Task not found');
    allow(c, 'project.operate', task.parent_id ?? task.id);
    await reviews.deliverAgain(c.req.param('id')!);
    return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/stop', async c => {
    const task = await context.storage.db.selectFrom('tasks').innerJoin('projects', 'projects.id', 'tasks.project_id').select(['projects.id', 'projects.parent_id']).where('tasks.id', '=', c.req.param('id')).executeTakeFirst();
    if (!task) throw new HttpError(404, 'not_found', 'Task not found');
    allow(c, 'project.operate', task.parent_id ?? task.id);
    await controls.stopTask(c.get('viewer').userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  // What reaches a human, in one queue, limited to the projects they can see. Settling anything in it needs the right to decide for that project.
  const needsYou = createNeedsYou(context, turns);
  const rootOf = async (projectId: string) => { const row = await context.storage.db.selectFrom('projects').select(['id', 'parent_id']).where('id', '=', projectId).executeTakeFirst(); return row?.parent_id ?? projectId; };
  app.get('/api/needs-you', async c => {
    const viewer = c.get('viewer'), items = [];
    for (const item of await needsYou.list()) if (canSeeProject(viewer, await rootOf(item.projectId))) items.push({ ...item, canDecide: can(viewer, 'project.decide', await rootOf(item.projectId)) });
    return c.json({ items });
  });
  const deciding = async (c: Hc<Env>, kind: NeedsYouKind) => {
    const projectId = await needsYou.projectOf(kind, c.req.param('id') ?? '');
    if (!projectId) throw new HttpError(404, 'not_found', 'That is already settled');
    allow(c, 'project.decide', await rootOf(projectId));
    return c.get('viewer').userId;
  };
  app.post('/api/decisions/:id/resolve', async c => { const userId = await deciding(c, 'decision'); const input = await body(c, z.object({ answer: z.string().trim().min(1).max(4000) })); await needsYou.resolveDecision(userId, c.req.param('id')!, input.answer); return c.json({ ok: true }); });
  app.post('/api/quarantines/:id/release', async c => { const userId = await deciding(c, 'quarantine'); const input = await body(c, z.object({ resolution: z.enum(['continue', 'stop']), note: z.string().trim().max(1000).default('') })); await needsYou.releaseQuarantine(userId, c.req.param('id')!, input.resolution, input.note); return c.json({ ok: true }); });
  app.post('/api/deliveries/:id/reconcile', async c => { const userId = await deciding(c, 'delivery'); const input = await body(c, z.object({ merged: z.boolean() })); await needsYou.reconcileDelivery(userId, c.req.param('id')!, input.merged); return c.json({ ok: true }); });

  app.get('/api/projects/:slug/checks', async c => { const { project } = await projectFor(c, 'project.read'); return c.json(await checks.matrix(project.id)); });
  app.get('/api/projects/:slug/checks/health', async c => { const { project } = await projectFor(c, 'project.read'); return c.json(await checks.health(project.id)); });
  // A JUnit report uploaded by a person or a pipeline step; the body is the XML itself.
  app.post('/api/projects/:slug/checks/:suite', async c => {
    const { project } = await projectFor(c, 'project.contribute');
    const xml = await c.req.text();
    let parsed: ReturnType<typeof checks.parse>;
    try { parsed = checks.parse(xml); } catch (error) { throw new HttpError(400, 'junit', (error as Error).message); }
    return c.json(await checks.record({ projectId: project.id, suite: c.req.param('suite').slice(0, 60), branch: c.req.query('branch') ?? 'main', sha: c.req.query('sha') ?? null, source: 'upload', report: parsed }));
  });

  // The body is the image itself; the name travels in the query, never in a path.
  app.post('/api/attachments', async c => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json({ id: await issues.attach(c.get('viewer').userId, { name: c.req.query('name') ?? 'attachment', mime: (c.req.header('content-type') ?? '').split(';')[0]!.trim(), bytes }) });
  });
  app.get('/api/attachments/:id', async c => {
    const file = await issues.attachment(c.req.param('id'));
    return c.body(file.data, 200, { 'content-type': file.mime, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  });
  app.get('/api/projects/:slug/issues', async c => { const { project } = await projectFor(c, 'project.read'); const page = pageOf(c), rows = await issues.list(project.id, { after: page.after, limit: page.limit + 1 }); return c.json({ issues: rows.slice(0, page.limit), next: rows.length > page.limit ? rows[page.limit - 1]!.number : null, seq: await context.events.head() }); });
  app.post('/api/projects/:slug/issues', async c => {
    const { project } = await projectFor(c, 'project.contribute');
    const input = await body(c, CreateIssueBody);
    const created = await issues.create(c.get('viewer').userId, project.id, input);
    // Whoever the body names with @ is asked directly, under the same limits as in any thread; the PM still triages the issue.
    await mentions.fromText({ projectId: project.id, threadId: created.threadId, message: { id: created.messageId }, author: { kind: 'user', id: c.get('viewer').userId }, body: input.body });
    const pm = await workspace.pm(project.id);
    if (pm) await turns.enqueue({ agentId: pm, projectId: project.id, kind: 'triage', threadId: created.threadId, dedupeKey: `triage:${created.threadId}` });
    return c.json(created);
  });
  app.get('/api/projects/:slug/issues/:number', async c => { const { project } = await projectFor(c, 'project.read'); return c.json({ issue: await issues.get(project.id, Number(c.req.param('number'))) }); });
  app.post('/api/projects/:slug/issues/:number/accept', async c => {
    const { project } = await projectFor(c, 'project.contribute');
    const made = await issues.accept(c.get('viewer').userId, project.id, Number(c.req.param('number')), (await body(c, z.object({ agentId: z.string().max(60) }))).agentId);
    await turns.enqueue({ agentId: made.ownerId, projectId: project.id, kind: 'work', taskId: made.taskId, dedupeKey: `work:${made.taskId}` });
    return c.json({ ok: true, taskId: made.taskId });
  });
  app.post('/api/projects/:slug/issues/:number/close', async c => { const { project } = await projectFor(c, 'project.contribute'); await issues.close(c.get('viewer').userId, project.id, Number(c.req.param('number'))); return c.json({ ok: true }); });

  app.get('/api/projects/:slug/product', async c => {
    const { project } = await projectFor(c, 'project.read');
    const environments = await context.storage.db.selectFrom('product_envs').select(['id', 'name', 'branch', 'url', 'last_status', 'last_latency_ms']).where('project_id', '=', project.id).orderBy('created_at').execute();
    return c.json({ environments, snapshots: await captures.list(project.id), seq: await context.events.head(), raised: (await issues.list(project.id)).filter(issue => issue.source === 'product') });
  });
  app.post('/api/projects/:slug/product', async c => {
    const { project } = await projectFor(c, 'project.configure');
    const input = await body(c, ProductEnvBody);
    if (!/^https?:$/.test(new URL(input.url).protocol)) throw new HttpError(400, 'invalid', 'An environment is an http or https address');
    const id = newId(context.now());
    await context.storage.db.insertInto('product_envs').values({ id, project_id: project.id, name: input.name, branch: input.branch ?? null, url: input.url, source: 'manual', created_at: context.now() }).execute();
    return c.json({ id });
  });

  app.post('/api/projects/:slug/envs/:envId/capture', async c => {
    const { project } = await projectFor(c, 'project.contribute');
    const input = await body(c, CaptureBody);
    return c.json(await captures.request(c.get('viewer').userId, project, await workspace.pm(project.id), c.req.param('envId'), input.viewport));
  });

  const workerSetup = mountWorkerSetupRoutes(app, { context, engines: ENGINES.filter(name => name !== 'fake' || context.demoLogin !== null), tokens: machineTokens, body: (c, schema) => body(c as Hc<Env>, schema),
    cloneUrl: async projectId => { const row = await context.storage.db.selectFrom('projects').select('manifest').where('id', '=', projectId).executeTakeFirst(); const manifest = row ? JSON.parse(row.manifest) as { scm?: { kind?: string }; delivery?: { repository?: string } } : {}; return manifest.scm?.kind && manifest.delivery?.repository && SCM_KINDS.includes(manifest.scm.kind) ? scmAdapter(manifest.scm.kind).cloneUrl(manifest.delivery.repository) : null; },
    configuring: async c => ({ project: (await projectFor(c as Hc<Env>, 'project.configure')).project, viewer: (c as Hc<Env>).get('viewer') }) });
  process.once('exit', () => workerSetup.stop());
  mountOnboardingRoutes(app, { context, canAdmin: c => can((c as Hc<Env>).get('viewer'), 'org.members'), userId: c => (c as Hc<Env>).get('viewer').userId });
  setup = mountSetupRoutes(app, { context, integrations, projectFor: (c, action) => projectFor(c as Hc<Env>, action), body: (c, schema) => body(c as Hc<Env>, schema), userId: c => (c as Hc<Env>).get('viewer').userId });
  // What the installed adapters offer, so the app never has to name a provider itself.
  app.get('/api/adapters', c => c.json({ scm: SCM_KINDS, trackers: TRACKER_KINDS }));
  // A project made in the app. The manifest a checkout commits later (through `up`) replaces what is entered here.
  app.post('/api/projects', async c => {
    allow(c, 'org.members');
    const input = await body(c, CreateProjectBody);
    const slug = input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!slug) throw new HttpError(400, 'invalid', 'The name needs at least one letter or digit');
    const db = context.storage.db;
    if (await db.selectFrom('projects').select('id').where('slug', '=', slug).executeTakeFirst()) throw new HttpError(409, 'conflict', `A project called "${slug}" already exists`);
    const parent = input.parentSlug ? await db.selectFrom('projects').select(['id', 'parent_id']).where('slug', '=', input.parentSlug).executeTakeFirst() : null;
    if (input.parentSlug && (!parent || parent.parent_id)) throw new HttpError(400, 'invalid', 'A sub-project sits directly under a top-level project');
    const manifest = { name: input.name, ...(input.scm ? { scm: { kind: input.scm } } : {}), ...(input.repository ? { delivery: { repository: input.repository, baseBranch: input.baseBranch, requiredChecks: [], autoMergeAuthorized: false } } : {}), ...(input.tracker ? { tracker: { kind: input.tracker, ...(input.repository ? { repository: input.repository } : {}) } } : {}) };
    const id = await workspace.registerProject({ slug, name: input.name, kind: input.kind, manifest });
    if (parent) await db.updateTable('projects').set({ parent_id: parent.id }).where('id', '=', id).execute();
    const published = await context.storage.transaction(tx => context.events.append(tx, [{ type: 'settings.changed', category: 'audit', actorKind: 'user', userId: c.get('viewer').userId, projectId: id, payload: { what: 'project.created', slug } }]));
    context.events.published(published);
    return c.json({ id, slug });
  });
  app.post('/api/projects/:slug/integrations/:id/remove', async c => { const { project } = await projectFor(c, 'project.configure'); await integrations.disconnect(c.get('viewer').userId, project.id, c.req.param('id')); return c.json({ ok: true }); });
  app.get('/api/projects/:slug/integrations', async c => { const { project } = await projectFor(c, 'project.read'); return c.json({ connections: await integrations.connections(project.id), handoffs: await integrations.handoffs(project.id), sync: await createCursors(context).status(project.id) }); });
  app.post('/api/projects/:slug/integrations', async c => { const { project } = await projectFor(c, 'project.configure'); return c.json({ id: await integrations.connect(c.get('viewer').userId, project.id, await body(c, ConnectionBody)) }); });
  app.post('/api/projects/:slug/handoffs', async c => { const { project } = await projectFor(c, 'project.contribute'); return c.json({ id: await integrations.receive(c.get('viewer').userId, project.id, await body(c, HandoffBody)) }); });
  app.post('/api/projects/:slug/handoffs/:id/hand', async c => {
    const { project } = await projectFor(c, 'project.contribute');
    const discussion = await workspace.discussion(project.id).catch(() => null);
    await integrations.handToTeam(c.get('viewer').userId, project.id, c.req.param('id'), await workspace.pm(project.id), discussion?.id ?? null);
    return c.json({ ok: true });
  });
  app.post('/api/projects/:slug/handoffs/:id/attach', async c => { const { project } = await projectFor(c, 'project.contribute'); await integrations.attachToTask(c.get('viewer').userId, project.id, c.req.param('id'), (await body(c, AttachHandoffBody)).taskId); return c.json({ ok: true }); });
  app.post('/api/projects/:slug/handoffs/:id/result', async c => { const { project } = await projectFor(c, 'project.contribute'); await integrations.recordResult(c.get('viewer').userId, project.id, c.req.param('id'), (await body(c, HandoffResultBody)).result); return c.json({ ok: true }); });

  // Roles are organization-wide documents: everyone may read them, admins change them.
  app.get('/api/roles', async c => {
    const roles = await docs.list('role', LIBRARY);
    const wearers = await context.storage.db.selectFrom('agent_roles').innerJoin('agents', 'agents.id', 'agent_roles.agent_id').select(['agent_roles.role_slug', 'agents.id', 'agents.name', 'agents.initials', 'agents.tint']).where('agents.status', '!=', 'retired').execute();
    return c.json({ roles: roles.map(role => ({ ...role, wornBy: wearers.filter(row => row.role_slug === role.slug).map(row => ({ id: row.id, name: row.name, initials: row.initials, tint: row.tint })) })) });
  });
  app.get('/api/roles/:slug/history', async c => c.json({ history: await docs.history('role', LIBRARY, c.req.param('slug')) }));
  app.post('/api/roles/:slug', async c => {
    allow(c, 'org.members');
    const input = await body(c, z.object({ doc: z.record(z.string(), z.unknown()), note: z.string().max(200).optional(), expectedVersion: z.number().int().min(0).optional() }));
    const matched = ifMatch(c), expectedVersion = matched ?? input.expectedVersion;
    const user = await context.storage.db.selectFrom('users').select('name').where('id', '=', c.get('viewer').userId).executeTakeFirstOrThrow();
    return c.json({ version: await preconditioned(matched, () => docs.save('role', LIBRARY, c.req.param('slug'), { ...input.doc, slug: c.req.param('slug') }, { author: user.name, userId: c.get('viewer').userId, ...(input.note ? { note: input.note } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}) })) });
  });

  // The organization at a glance: every project the viewer can see with its team, open work and spend this month.
  app.get('/api/org', async c => {
    const tree = await workspace.projectTree(c.get('viewer'));
    const month = new Date(context.now()).toISOString().slice(0, 8);
    const overview = [];
    for (const project of tree) {
      const ids = [project.id, ...project.subprojects.map(sub => sub.id)];
      const open = await context.storage.db.selectFrom('tasks').select(eb => eb.fn.countAll<number>().as('n')).where('project_id', 'in', ids).where('state', 'not in', ['done', 'canceled']).executeTakeFirstOrThrow();
      const spend = await costs.summary(ids, month + '01', month + '31');
      overview.push({ ...project, roster: project.team ? await workspace.roster(project.team.id as string) : [], openTasks: Number(open.n), spendMinor: spend.totalMinor });
    }
    return c.json({ org: await workspace.org(), projects: overview });
  });

  app.get('/api/proposals', async c => {
    const tree = await workspace.projectTree(c.get('viewer'));
    return c.json({ proposals: await proposals.list(tree.flatMap(project => [project.id, ...project.subprojects.map(sub => sub.id)])) });
  });
  app.post('/api/proposals/:id/decide', async c => {
    const row = await context.storage.db.selectFrom('proposals').innerJoin('projects', 'projects.id', 'proposals.project_id').select(['projects.id', 'projects.parent_id']).where('proposals.id', '=', c.req.param('id')).executeTakeFirst();
    if (!row) throw new HttpError(404, 'not_found', 'Proposal not found');
    allow(c, 'project.decide', row.parent_id ?? row.id);
    const input = await body(c, z.object({ decision: z.enum(['approve', 'decline']), note: z.string().max(400).optional() }));
    await proposals.decide(c.get('viewer').userId, c.req.param('id'), input.decision, input.note ?? null);
    return c.json({ ok: true });
  });

  app.get('/api/costs', async c => {
    const tree = await workspace.projectTree(c.get('viewer'));
    const ids = tree.flatMap(project => [project.id, ...project.subprojects.map(sub => sub.id)]);
    const today = new Date(context.now()).toISOString().slice(0, 10);
    return c.json(await costs.summary(ids, c.req.query('from') ?? `${today.slice(0, 8)}01`, c.req.query('to') ?? today));
  });

  // Providers are organization-wide: which engine serves them, how they bill, and which models an agent may be given.
  providerSetup = mountProviderRoutes(app, context);
  mountTaskRoutes(app, context, turns);
  app.post('/api/agents/:id/provider', async c => {
    const agent = await context.storage.db.selectFrom('agents').innerJoin('projects', 'projects.team_id', 'agents.team_id').select(['agents.id', 'projects.id as project_id']).where('agents.id', '=', c.req.param('id')).executeTakeFirst();
    if (!agent) throw new HttpError(404, 'not_found', 'Agent not found');
    allow(c, 'project.configure', agent.project_id);
    const input = await body(c, SeatProviderBody);
    if (input.providerId) {
      const provider = await context.storage.db.selectFrom('providers').select('models').where('id', '=', input.providerId).executeTakeFirst();
      if (!provider) throw new HttpError(404, 'not_found', 'Provider not found');
      if (input.model && !(JSON.parse(provider.models) as string[]).includes(input.model)) throw new HttpError(400, 'invalid', 'That provider does not offer this model');
    }
    // A running turn keeps the engine and model it was claimed with; the change applies from the next turn.
    await context.storage.db.updateTable('agents').set({ provider_id: input.providerId, model: input.providerId ? input.model : null, ...(input.effort !== undefined ? { effort: input.effort } : {}) }).where('id', '=', agent.id).execute();
    return c.json({ ok: true });
  });

  app.get('/api/agents', async c => {
    const rows = await context.storage.db.selectFrom('agents').innerJoin('projects', 'projects.team_id', 'agents.team_id').select(['agents.id', 'agents.name', 'agents.initials', 'agents.tint', 'agents.title', 'agents.persona', 'agents.status', 'agents.provider_id', 'agents.model', 'agents.is_pm', 'agents.doing', 'projects.id as project_id']).execute();
    return c.json({ agents: rows.filter(row => canSeeProject(c.get('viewer'), row.project_id)) });
  });
  app.get('/api/agents/:id', async c => {
    const agent = await context.storage.db.selectFrom('agents').innerJoin('projects', 'projects.team_id', 'agents.team_id').select(['agents.id', 'agents.name', 'agents.initials', 'agents.tint', 'agents.title', 'agents.persona', 'agents.status', 'agents.model', 'agents.doing', 'projects.id as project_id']).where('agents.id', '=', c.req.param('id')).executeTakeFirst();
    if (!agent) throw new HttpError(404, 'not_found', 'Agent not found');
    allow(c, 'project.read', agent.project_id);
    const turns = await context.storage.db.selectFrom('turns').select(['id', 'kind', 'state', 'task_id', 'summary', 'tokens_in', 'tokens_out', 'cost_minor', 'started_at', 'finished_at']).where('agent_id', '=', agent.id).orderBy('started_at', 'desc').limit(10).execute();
    const steps = turns[0] ? await context.storage.db.selectFrom('trace_steps').selectAll().where('turn_id', '=', turns[0].id).orderBy('seq').limit(400).execute() : [];
    return c.json({ agent, turns, steps, seq: await context.events.head() });
  });

  // The machines that run turns, as each last described itself on a claim. Projects a viewer cannot see are left out of a worker's list.
  app.get('/api/workers', async c => {
    const viewer = c.get('viewer'), rows = await context.storage.db.selectFrom('workers').selectAll().orderBy('name').execute();
    const list = <T>(json: string, pick: (value: unknown) => T): T => { try { return pick(JSON.parse(json)); } catch { return pick(null); } };
    return c.json({ workers: rows.map(row => ({
      id: row.id, name: row.name, lastSeenAt: Number(row.last_seen_at), isolation: row.isolation === 'strict' ? 'strict' : 'isolated',
      lanes: list(row.lanes, value => (value && typeof value === 'object' ? value : {}) as Record<string, number>),
      projects: list(row.projects, value => (Array.isArray(value) ? value : []).filter((id): id is string => typeof id === 'string' && canSeeProject(viewer, id))),
      engines: list(row.providers, value => { const engines = (value as { engines?: unknown } | null)?.engines; return Array.isArray(engines) ? engines.filter((name): name is string => typeof name === 'string') : []; }),
    })), seq: await context.events.head() });
  });

  // The trace of one turn. The list says which steps carry an artifact; `?seq=` returns that step's diff, output or think text.
  app.get('/api/turns/:id/steps', async c => {
    const db = context.storage.db;
    const turn = await db.selectFrom('turns').select(['id', 'project_id', 'state']).where('id', '=', c.req.param('id')).executeTakeFirst();
    if (!turn) throw new HttpError(404, 'not_found', 'Turn not found');
    allow(c, 'project.read', turn.project_id);
    const seq = c.req.query('seq');
    if (seq !== undefined) {
      const artifact = await traceStore.read(turn.id, Number(seq) || 0);
      if (!artifact) throw new HttpError(404, 'not_found', 'This step has no artifact');
      const { data, mime, ...meta } = artifact;
      // An image, or any body asked for as it is, is served as bytes; text otherwise travels in the JSON, wherever it was stored.
      if (c.req.query('raw') !== undefined) return c.body(data as Uint8Array<ArrayBuffer>, 200, { 'content-type': mime ?? 'text/plain; charset=utf-8', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
      return c.json({ artifact: { ...meta, mime, body: mime ? '' : new TextDecoder().decode(data) } });
    }
    const steps = await db.selectFrom('trace_steps').leftJoin('step_artifacts', join => join.onRef('step_artifacts.turn_id', '=', 'trace_steps.turn_id').onRef('step_artifacts.seq', '=', 'trace_steps.seq'))
      .select(['trace_steps.seq', 'trace_steps.at', 'trace_steps.kind', 'trace_steps.title', 'trace_steps.detail', 'trace_steps.status', 'step_artifacts.kind as artifact_kind', 'step_artifacts.bytes as artifact_bytes']).where('trace_steps.turn_id', '=', turn.id).orderBy('trace_steps.seq').limit(400).execute();
    // The raw engine stream is filed under the turn, not under a step.
    const stream = await db.selectFrom('step_artifacts').select(['bytes', 'truncated']).where('turn_id', '=', turn.id).where('seq', '=', STREAM_ARTIFACT_SEQ).executeTakeFirst();
    return c.json({ turn, steps, stream: stream ? { seq: STREAM_ARTIFACT_SEQ, bytes: Number(stream.bytes), truncated: Number(stream.truncated) === 1 } : null, seq: await context.events.head() });
  });

  registerOrgRoutes(app, context, { workspace, docs, machineTokens });
  mountSsoSetupRoutes(app, { context, callbackUri });
  registerRuleRoutes(app, context, { workspace, docs, costs });

  // Snapshot-then-stream: a view returns the seq it is current to, the client subscribes from there.
  app.get('/api/stream', c => streamSSE(c, async stream => {
    const viewer = c.get('viewer');
    let cursor = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? 0);
    const roots = new Map<string, string>();
    for (const project of await context.storage.db.selectFrom('projects').select(['id', 'parent_id']).execute()) roots.set(project.id, project.parent_id ?? project.id);
    // A private thread's events reach its owner only; who owns a thread is looked up once per thread.
    const owners = new Map<string, string | null>();
    const mine = async (threadId: string) => {
      if (!owners.has(threadId)) { const thread = await context.storage.db.selectFrom('threads').select(['visibility', 'owner_user_id']).where('id', '=', threadId).executeTakeFirst(); owners.set(threadId, thread && thread.visibility !== 'team' ? thread.owner_user_id ?? '' : null); }
      const owner = owners.get(threadId);
      return owner === null || owner === undefined || owner === viewer.userId;
    };
    const visible = async (event: StoredEvent) => event.category !== 'audit' && canSeeProject(viewer, event.projectId ? (roots.get(event.projectId) ?? event.projectId) : null) && (!event.threadId || await mine(event.threadId));
    let wake: (() => void) | null = null;
    const unsubscribe = context.storage.bus.subscribe(() => wake?.());
    stream.onAbort(() => { unsubscribe(); wake?.(); });
    while (!stream.aborted) {
      const events = await context.events.read({ after: cursor });
      for (const event of events) {
        cursor = event.seq;
        if (await visible(event)) await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
      }
      if (events.length === 0) {
        await Promise.race([new Promise<void>(resolve => { wake = resolve; }), stream.sleep(15_000)]);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
    }
  }));

  // Prebuilt web assets, with the single-page app as the fallback for unknown paths.
  app.get('*', async c => {
    if (!context.webRoot || c.req.path.startsWith('/api/')) throw new HttpError(404, 'not_found', 'Not found');
    const relative = path.normalize(c.req.path).replace(/^([/\\]|\.\.)+/, '');
    const file = path.join(context.webRoot, relative);
    const target = file.startsWith(context.webRoot) && path.extname(file) ? file : path.join(context.webRoot, 'index.html');
    const data = await readFile(target).catch(() => null);
    if (!data) throw new HttpError(404, 'not_found', 'Not found');
    const immutable = target.includes(`${path.sep}assets${path.sep}`);
    return c.body(data, 200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  });

  return app;
}
export type AppType = ReturnType<typeof createApp>;
