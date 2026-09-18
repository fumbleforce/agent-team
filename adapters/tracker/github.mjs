import { validateIdeation, validateProposals } from '../../core/idea-schema.mjs';
export { validateIdeation } from '../../core/idea-schema.mjs';

// Tracker adapter for GitHub Issues: the repository's own issues are the board, so a project on
// GitHub needs no second account. Issues are addressed as GH-<number>. GitHub has open and closed
// only, so workflow states are labels: the ideation section's proposedState and approvedState
// name labels, rejectedState is a closed issue, and roles mark progress with agent:in-progress and
// agent:in-review. Closing an issue is the owner's act, never an agent's.
export const NAME = 'github';
export const ISSUE_PATTERN = /^GH-[1-9][0-9]*$/;
// A dedicated token when the owner wants issues and code separated; otherwise the SCM token serves.
export const API_KEY_VARIABLE = 'GITHUB_ISSUES_TOKEN';
export const CREDENTIAL_HINT = 'Export GITHUB_ISSUES_TOKEN, or let GH_TOKEN serve issues too';
// The SCM adapter whose token this tracker also accepts.
export const SHARES_TOKEN_WITH = 'github';
export const MANIFEST_KEYS = ['repository', 'readyLabel'];
export const PROGRESS_LABELS = { inProgress: 'agent:in-progress', inReview: 'agent:in-review' };
const HOLD_LABELS = ['agent:blocked', 'owner:decision'];
const INBOX_LABEL = 'agent:inbox';
const API = 'https://api.github.com';
const MCP_URL = 'https://api.githubcopilot.com/mcp/';
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/;

export function credential(env = process.env) { return env.GITHUB_ISSUES_TOKEN || env.GH_TOKEN || null; }
export const hasCredential = env => credential(env) !== null;

// GitHub's hosted MCP server; the token rides as a header on this server only.
export function mcpServers(tracker, env = process.env) {
  const token = credential(env);
  return { tracker: { type: 'http', url: MCP_URL, ...(token ? { headers: { Authorization: `Bearer ${token}`, 'X-MCP-Toolsets': 'issues' } } : {}) } };
}

export function validateManifest(tracker) {
  if (typeof tracker.repository !== 'string' || !REPOSITORY.test(tracker.repository)) throw new Error('Invalid tracker configuration: repository must be owner/name');
  if (typeof tracker.readyLabel !== 'string' || !tracker.readyLabel.trim()) throw new Error('Invalid tracker configuration: readyLabel is required');
  if (tracker.ownerInboxIssue !== undefined && !ISSUE_PATTERN.test(String(tracker.ownerInboxIssue))) throw new Error('Invalid tracker configuration: ownerInboxIssue must look like GH-12');
  // The neutral scope fields prompts and approvals read: one repository is workspace, team and project.
  tracker.workspaceId = tracker.repository; tracker.teamId = tracker.repository; tracker.projectId = tracker.repository;
  tracker.workspaceUrl = `https://github.com/${tracker.repository}`; tracker.projectUrl = `https://github.com/${tracker.repository}/issues`;
  return tracker;
}

export function scopeInstructions(tracker) {
  return `The issue tracker is GitHub Issues on ${tracker.repository} (${tracker.projectUrl}), reached through the tracker MCP tools; issue GH-12 is issue #12 of that repository and nothing else. Ready work carries the label ${tracker.readyLabel}. GitHub has no workflow states: mark progress with the labels ${PROGRESS_LABELS.inProgress} and ${PROGRESS_LABELS.inReview} (remove the previous one), never close an issue, and treat ${HOLD_LABELS.join(' or ')} as a hold.`;
}

// Guided setup: the repository's issues are the board; ideation states are labels `up` creates.
export async function setup({ ask, scm }) {
  let repository = scm?.kind === NAME && scm.repository ? scm.repository : null;
  while (!repository || !REPOSITORY.test(repository)) repository = String(await ask('GitHub repository whose issues are the backlog (owner/name)')).trim();
  return { tracker: { repository, readyLabel: 'agent:ready' },
    ideation: { enabled: true, backlogCap: 8, batchSize: 3, minimumIntervalHours: 24, ideaLabel: 'idea', proposedState: 'idea:proposed', approvedState: 'agent:approved', rejectedState: 'closed' } };
}
export const identifier = number => `GH-${number}`;
export const issueNumber = value => { const match = ISSUE_PATTERN.exec(String(value ?? '')); return match ? Number(value.slice(3)) : null; };
const terminal = state => ['completed', 'canceled'].includes(state?.type);
const titleKey = title => title.trim().normalize('NFKC').toLowerCase();

export function approvalStatus(manifest, issue) {
  const config = validateIdeation(manifest.ideation);
  if (!issue || issue.archivedAt || issue.parentId || issue.projectId !== manifest.projectId || !issue.labels.some(label => label.name === config.ideaLabel)) return { allowed: false, reason: 'Not an active repository idea' };
  if (issue.state?.name !== config.approvedState || terminal(issue.state)) return { allowed: false, reason: 'Owner approval required' };
  if (issue.labels.some(label => HOLD_LABELS.includes(label.name))) return { allowed: false, reason: 'Idea is on hold for a decision or repair' };
  return { allowed: true, reason: 'Owner approved' };
}

// A GitHub issue in the neutral shape intake, approvals and the PM read.
export function normalizeIssue(raw, manifest, config = null) {
  const labels = (raw.labels ?? []).map(label => ({ id: label.name ?? label, name: label.name ?? label }));
  const has = name => labels.some(label => label.name === name);
  const state = raw.state === 'closed'
    ? { id: 'closed', name: raw.state_reason === 'not_planned' && config ? config.rejectedState : 'Done', type: raw.state_reason === 'not_planned' ? 'canceled' : 'completed' }
    : config && has(config.approvedState) ? { id: config.approvedState, name: config.approvedState, type: 'unstarted' }
      : config && has(config.proposedState) ? { id: config.proposedState, name: config.proposedState, type: 'backlog' }
        : { id: 'open', name: 'Open', type: 'unstarted' };
  return { id: identifier(raw.number), number: raw.number, identifier: identifier(raw.number), title: raw.title ?? '', description: raw.body ?? '', url: raw.html_url ?? `https://github.com/${manifest.repository}/issues/${raw.number}`,
    updatedAt: raw.updated_at ?? null, archivedAt: null, state, labels, parentId: null, projectId: manifest.repository, teamId: manifest.repository, blocked: false };
}

export function createClient({ apiKey = credential(), fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /\s/.test(apiKey)) throw new Error('GITHUB_ISSUES_TOKEN (or GH_TOKEN) is required');
  // Never surface response bodies or fetch errors: they may carry the token or private text.
  async function request(method, route, body) {
    let response;
    try { response = await fetchImpl(`${API}${route}`, { method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-team', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('GitHub network request failed'); }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub HTTP request failed (${response.status})`);
    if (response.status === 204) return {};
    try { return await response.json(); } catch { throw new Error('Invalid GitHub response'); }
  }
  const repo = manifest => { if (typeof manifest.repository !== 'string' || !REPOSITORY.test(manifest.repository)) throw new Error('Missing GitHub tracker configuration'); return `/repos/${manifest.repository}`; };
  async function paged(route) {
    const items = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await request('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Invalid GitHub listing');
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error('GitHub listing too long');
  }
  async function context(manifest) {
    const config = validateIdeation(manifest.ideation);
    const labels = (await paged(`${repo(manifest)}/labels`)).map(label => ({ id: label.name, name: label.name }));
    const find = name => labels.find(label => label.name === name) ?? null;
    for (const name of [manifest.readyLabel, config.ideaLabel, config.approvedState]) if (!find(name)) throw new Error(`Required GitHub label "${name}" is missing in ${manifest.repository}; run agent-team up to create it`);
    if (config.ideaLabel === manifest.readyLabel) throw new Error('Idea and ready labels must differ');
    return { workspaceId: manifest.repository, projectId: manifest.repository, teamId: manifest.repository, config, labels, ideaLabel: find(config.ideaLabel), readyLabel: find(manifest.readyLabel) };
  }
  async function snapshot(manifest) {
    const ctx = await context(manifest);
    const raw = (await paged(`${repo(manifest)}/issues?state=all`)).filter(item => !item.pull_request);
    const allIssues = raw.map(item => normalizeIssue(item, manifest, ctx.config));
    const ideas = allIssues.filter(issue => issue.labels.some(label => label.name === ctx.config.ideaLabel));
    const unfinished = ideas.filter(issue => !terminal(issue.state)).length;
    return { context: ctx, ideas, remaining: Math.max(0, ctx.config.backlogCap - unfinished), existing: allIssues.map(issue => issue.title), allIssues };
  }
  async function publishProposals(manifest, proposals, { jobId, limit } = {}) {
    if (typeof jobId !== 'string' || !/^[\w.-]{1,128}$/.test(jobId)) throw new Error('Invalid ideation job ID');
    const config = validateIdeation(manifest.ideation);
    const validated = validateProposals(proposals, limit ?? config.batchSize);
    const created = []; let skipped = 0;
    for (const [index, proposal] of validated.entries()) {
      const current = await snapshot(manifest);
      const marker = `Agent-Team idea: ${jobId}:${index + 1}`;
      if (current.allIssues.some(issue => (issue.description ?? '').split('\n').includes(marker)) || current.existing.some(title => titleKey(title) === titleKey(proposal.title))) { skipped++; continue; }
      if (!current.remaining) { skipped += validated.length - index; break; }
      const body = [['Problem', proposal.problem], ['Benefit', proposal.benefit], ['Scope', proposal.scope], ['Success criteria', proposal.successCriteria.map(text => `- ${text}`).join('\n')], ['Size', `${proposal.effort} (relative scope, not a time estimate)`], ['Evidence', proposal.evidence.map(text => `- ${text}`).join('\n')], ['Why now', proposal.whyNow]].map(([heading, text]) => `## ${heading}\n${text}`).join('\n\n') + `\n\n${marker}`;
      const issue = await request('POST', `${repo(manifest)}/issues`, { title: proposal.title, body, labels: [config.ideaLabel, config.proposedState] });
      if (!issue?.number) throw new Error('GitHub idea creation failed');
      created.push({ id: identifier(issue.number), identifier: identifier(issue.number), url: issue.html_url });
    }
    return { created, skipped };
  }
  async function issueByIdentifier(manifest, value) {
    const number = issueNumber(value);
    if (!number) return null;
    const raw = await request('GET', `${repo(manifest)}/issues/${number}`);
    return raw && !raw.pull_request ? normalizeIssue(raw, manifest) : null;
  }
  async function issueComments(manifest, value, { limit = 30 } = {}) {
    const number = issueNumber(value);
    if (!number) return [];
    const comments = await paged(`${repo(manifest)}/issues/${number}/comments`).catch(() => []);
    return comments.filter(item => typeof item.body === 'string' && item.body.trim()).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).slice(-limit)
      .map(item => ({ id: String(item.id), createdAt: item.created_at, author: item.user?.login ?? 'unknown', body: item.body.slice(0, 1500) }));
  }
  const inboxComments = (manifest, options) => manifest.ownerInboxIssue ? issueComments(manifest, manifest.ownerInboxIssue, options) : Promise.resolve([]);
  async function postComment(manifest, value, body) {
    if (typeof body !== 'string' || !body.trim() || body.length > 6000) throw new Error('Invalid comment body');
    const issue = await issueByIdentifier(manifest, value);
    if (!issue) throw new Error('Issue is not in the configured repository');
    const comment = await request('POST', `${repo(manifest)}/issues/${issue.number}/comments`, { body });
    if (!comment?.id) throw new Error('GitHub comment creation failed');
    return { id: String(comment.id), issue: issue.identifier, title: issue.title };
  }
  async function checkApproved(manifest, value) {
    const current = await snapshot(manifest);
    return approvalStatus(manifest, current.ideas.find(issue => issue.identifier === value || issue.id === value));
  }
  async function prepareApproved(manifest, value) {
    const current = await snapshot(manifest);
    const issue = current.ideas.find(item => item.identifier === value || item.id === value);
    const approval = approvalStatus(manifest, issue);
    if (!approval.allowed) throw new Error(approval.reason);
    if (!issue.labels.some(label => label.name === manifest.readyLabel)) {
      const result = await request('POST', `${repo(manifest)}/issues/${issue.number}/labels`, { labels: [manifest.readyLabel] });
      if (!Array.isArray(result)) throw new Error('GitHub ready label update failed');
      issue.labels.push({ id: manifest.readyLabel, name: manifest.readyLabel });
    }
    return issue;
  }
  // Settings-form choices: one repository has no teams or projects, only labels.
  async function lookup({ repository = null } = {}) {
    const labels = repository ? (await paged(`/repos/${repository}/labels`)).map(label => ({ id: label.name, name: label.name })) : [];
    return { workspace: { id: repository, name: repository, url: repository ? `https://github.com/${repository}` : null }, teams: [], teamId: null, projects: [], labels, states: [] };
  }
  // Turnkey setup: every label the roles and the ideation workflow rely on, and an owner inbox
  // issue, created when missing. Returns what exists afterwards; never edits or closes anything.
  async function bootstrap(manifest, { log = () => {} } = {}) {
    const config = manifest.ideation?.enabled ? validateIdeation(manifest.ideation) : null;
    const wanted = [[manifest.readyLabel, '0e8a16', 'Approved and ready for the agent team'], ...HOLD_LABELS.map(name => [name, 'd93f0b', 'Waiting on a human decision or repair']),
      [PROGRESS_LABELS.inProgress, 'fbca04', 'An agent run is working on this'], [PROGRESS_LABELS.inReview, '1d76db', 'Implementation ready for review'], [INBOX_LABEL, '5319e7', 'Owner messages to the team'],
      ...(config ? [[config.ideaLabel, 'c5def5', 'Proposed by the ideation role'], [config.proposedState, 'ededed', 'Idea awaiting the owner'], [config.approvedState, '0e8a16', 'Idea approved by the owner']] : [])];
    const existing = new Set((await paged(`${repo(manifest)}/labels`)).map(label => label.name));
    const created = [];
    for (const [name, color, description] of wanted) {
      if (existing.has(name)) continue;
      const label = await request('POST', `${repo(manifest)}/labels`, { name, color, description });
      if (!label?.name) throw new Error(`GitHub label creation failed for ${name}`);
      created.push(name); existing.add(name);
    }
    if (created.length) log(`labels created: ${created.join(', ')}`);
    let inbox = manifest.ownerInboxIssue ?? null;
    if (!inbox) {
      const open = (await paged(`${repo(manifest)}/issues?state=open&labels=${encodeURIComponent(INBOX_LABEL)}`)).filter(item => !item.pull_request);
      if (open.length) inbox = identifier(open[0].number);
      else {
        const issue = await request('POST', `${repo(manifest)}/issues`, { title: 'Owner inbox', body: 'Messages from the owner to the agent team. Comment here to steer the team; the PM reads this at every checkpoint. Keep it open.', labels: [INBOX_LABEL] });
        if (!issue?.number) throw new Error('GitHub inbox issue creation failed');
        inbox = identifier(issue.number); log(`owner inbox issue created: ${inbox}`);
      }
    }
    return { labels: [...existing], created, ownerInboxIssue: inbox };
  }
  return { context, snapshot, publishProposals, prepareApproved, checkApproved, inboxComments, issueComments, postComment, approvalStatus, lookup, bootstrap };
}
