import { useState } from 'react';
import { api, type Me, type ProjectNode } from '../../data/client';
import { useResource } from '../../data/useResource';
import { DataTable, EmptyState, KeyValueList, SettingsBody, SettingsSection } from '../../patterns';
import { Button, Card, Chip, Field, Input, Select, StatusDot, Text } from '../../ui';
import { ActionError, isOrgAdmin, OrgShell, useAction, useCreateKey } from '../org/OrgShell';

interface Grant { projectId: string; slug: string; name: string; role: string }
interface User { id: string; email: string; name: string; orgRole: string; status: string; signIn: string[]; lastLoginAt: number | null; projects: Grant[] }
interface Invite { id: string; email: string; orgRole: string; projects: { projectId: string; role: string }[]; expiresAt: number; invitedBy: string | null }
interface AuthSettings { oidc: { issuer: string; clientId: string; clientSecretEnv: string; allowedDomains: string[]; defaultRole: string } | null; password: { minimumLength: number }; trustedHeader: { enabled: boolean; header: string | null }; secureCookies: boolean; canEdit: boolean }
interface MachineToken { id: string; name: string; kind: string; createdBy: string | null; createdAt: number; revokedAt: number | null; lastUsedAt: number | null }

const day = (at: number | null) => (at ? new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'never');
const AdminsOnly = ({ me, projects, title }: { me: Me; projects: ProjectNode[]; title: string }) => <OrgShell me={me} projects={projects} title={title} active={null}><SettingsBody><EmptyState title="For administrators" note="Ask an owner or an administrator of the organization for access to this page." /></SettingsBody></OrgShell>;

export function MembersPage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const members = useResource<{ users: User[]; invites: Invite[] }>(isOrgAdmin(me) ? '/api/users' : null);
  const change = useAction(), invite = useAction(), grant = useAction(), inviteKey = useCreateKey();
  const [link, setLink] = useState<string | null>(null);
  if (!isOrgAdmin(me)) return <AdminsOnly me={me} projects={projects} title="Members" />;
  const owner = me.user.orgRole === 'owner';
  // Admins manage members and viewers; the owner manages everyone but themselves.
  const editable = (user: User) => user.id !== me.user.id && (owner || (user.orgRole !== 'owner' && user.orgRole !== 'admin'));
  const patch = (user: User, body: Record<string, string>) => { void change.run(() => api(`/api/users/${user.id}`, body)).then(members.reload); };
  const projectOptions = projects.map(project => <option key={project.id} value={project.slug}>{project.name}</option>);

  return (
    <OrgShell me={me} projects={projects} title="Members" active="/settings/members">
      <SettingsBody>
        <SettingsSection title={`People · ${members.data?.users.length ?? 0}`} note="The organization role is the ceiling; a project grant gives a member or viewer their standing on one project. Owners and administrators administer every project.">
          <DataTable rows={members.data?.users ?? []} rowKey={user => user.id} columns={[
            { label: 'Person', width: 'lg', cell: user => <span className="flex min-w-0 flex-col"><Text weight="medium" truncate>{user.name}{user.id === me.user.id ? ' (you)' : ''}</Text><Text size="caption" tone="muted" truncate>{user.email}</Text></span> },
            { label: 'Role', width: 'sm', cell: user => (editable(user)
              ? <Select compact aria-label={`Organization role of ${user.name}`} value={user.orgRole} onChange={event => patch(user, { orgRole: event.target.value })}>{(owner ? ['owner', 'admin', 'member', 'viewer'] : ['member', 'viewer']).map(role => <option key={role} value={role}>{role}</option>)}</Select>
              : <Chip tone={user.orgRole === 'owner' ? 'accent' : 'neutral'}>{user.orgRole}</Chip>) },
            { label: 'Projects', width: 'grow', cell: user => <span className="flex flex-wrap gap-1">{user.projects.map(item => <Chip key={item.projectId}>{item.name} · {item.role}</Chip>)}{user.projects.length === 0 && <Text size="caption" tone="faint">{user.orgRole === 'owner' || user.orgRole === 'admin' ? 'all projects' : 'none'}</Text>}</span> },
            { label: 'Signs in with', width: 'sm', cell: user => <Text size="caption" tone="muted">{user.signIn.join(', ') || 'trusted header'}</Text> },
            { label: 'Last sign-in', width: 'sm', cell: user => <Text size="caption" tone="muted" mono>{day(user.lastLoginAt)}</Text> },
            { label: 'Account', width: 'sm', cell: user => (editable(user) ? <Button size="sm" variant={user.status === 'active' ? 'ghost' : 'secondary'} onClick={() => patch(user, { status: user.status === 'active' ? 'disabled' : 'active' })}>{user.status === 'active' ? 'Disable' : 'Enable'}</Button> : <Text size="caption" tone="muted">{user.status}</Text>) },
          ]} />
          <ActionError error={change.error} />
        </SettingsSection>

        <SettingsSection title="Project grants" note="Give a person a role on one project, or take it away. A project's administrators can do the same from the project's settings.">
          <form className="flex flex-wrap items-end gap-2.5" onSubmit={grant.submit(async form => { await api(`/api/projects/${String(form.get('project'))}/members`, { userId: form.get('user'), role: form.get('role') === 'none' ? null : form.get('role') }); members.reload(); })}>
            <Field label="Person"><Select name="user">{members.data?.users.filter(user => user.orgRole !== 'owner' && user.orgRole !== 'admin').map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</Select></Field>
            <Field label="Project"><Select name="project">{projectOptions}</Select></Field>
            <Field label="Role"><Select name="role"><option value="viewer">viewer</option><option value="member">member</option><option value="admin">admin</option><option value="none">no access</option></Select></Field>
            <Button type="submit" disabled={grant.busy}>Set grant</Button>
          </form>
          <ActionError error={grant.error} />
        </SettingsSection>

        <SettingsSection title="Invitations" note="An invitation is a single-use link, good for seven days. Copy it to the person; nothing is emailed.">
          <DataTable rows={members.data?.invites ?? []} rowKey={item => item.id} empty={<Text size="small" tone="muted">Nobody is waiting on an invitation.</Text>} columns={[
            { label: 'Email', width: 'lg', cell: item => <Text size="small" truncate>{item.email}</Text> },
            { label: 'Role', width: 'sm', cell: item => <Chip>{item.orgRole}</Chip> },
            { label: 'Projects', width: 'grow', cell: item => <span className="flex flex-wrap gap-1">{item.projects.map(entry => <Chip key={entry.projectId}>{projects.find(project => project.id === entry.projectId)?.name ?? 'project'} · {entry.role}</Chip>)}</span> },
            { label: 'Expires', width: 'sm', cell: item => <Text size="caption" tone="muted" mono>{day(item.expiresAt)}</Text> },
            { label: '', width: 'sm', cell: item => <Button size="sm" variant="ghost" onClick={() => { void change.run(() => api(`/api/invites/${item.id}/revoke`, {})).then(members.reload); }}>Revoke</Button> },
          ]} />
          <form className="flex flex-wrap items-end gap-2.5" onSubmit={invite.submit(async form => {
            const project = projects.find(item => item.slug === form.get('project'));
            const created = await api<{ path: string }>('/api/invites', { email: form.get('email'), orgRole: form.get('orgRole'), projects: project ? [{ projectId: project.id, role: form.get('projectRole') }] : [] }, inviteKey.headers());
            inviteKey.renew(); setLink(new URL(created.path, window.location.origin).href); members.reload();
          })}>
            <Field label="Email" error={invite.error?.fields.email}><Input name="email" type="email" required placeholder="person@example.com" /></Field>
            <Field label="Organization role"><Select name="orgRole" defaultValue="member">{owner && <option value="admin">admin</option>}<option value="member">member</option><option value="viewer">viewer</option></Select></Field>
            <Field label="Project"><Select name="project"><option value="">none yet</option>{projectOptions}</Select></Field>
            <Field label="Role there"><Select name="projectRole" defaultValue="member"><option value="viewer">viewer</option><option value="member">member</option><option value="admin">admin</option></Select></Field>
            <Button type="submit" variant="primary" disabled={invite.busy}>Create invitation</Button>
          </form>
          <ActionError error={invite.error} />
          {link && <Card tone="decision" pad="sm" className="flex flex-wrap items-center gap-2.5"><Text size="small" mono className="min-w-0 grow break-all">{link}</Text><Button size="sm" onClick={() => { void navigator.clipboard.writeText(link); }}>Copy link</Button></Card>}
        </SettingsSection>
      </SettingsBody>
    </OrgShell>
  );
}

export function AuthPage({ me, projects }: { me: Me; projects: ProjectNode[] }) {
  const auth = useResource<AuthSettings>(isOrgAdmin(me) ? '/api/settings/auth' : null);
  const tokens = useResource<{ tokens: MachineToken[] }>(isOrgAdmin(me) ? '/api/machine-tokens' : null);
  const sso = useAction(), machine = useAction(), tokenKey = useCreateKey();
  const [secret, setSecret] = useState<string | null>(null);
  if (!isOrgAdmin(me)) return <AdminsOnly me={me} projects={projects} title="Sign-in" />;
  const data = auth.data, locked = !data?.canEdit;

  return (
    <OrgShell me={me} projects={projects} title="Sign-in" active="/settings/auth">
      <SettingsBody>
        <SettingsSection title="Passwords">
          <KeyValueList items={[['Minimum length', `${data?.password.minimumLength ?? 12} characters`], ['Failed sign-ins', 'an account locks for 15 minutes after 8, an address after 40'], ['Session cookie', data?.secureCookies ? 'Secure, __Host- prefixed' : 'plain HTTP (development)']]} />
        </SettingsSection>

        <SettingsSection title="Single sign-on" note={locked ? 'Only the owner changes how people sign in.' : 'OpenID Connect with discovery. The client secret stays in the coordinator\'s environment; only the name of the variable is kept here.'} aside={<Chip tone={data?.oidc ? 'working' : 'neutral'}>{data?.oidc ? 'on' : 'off'}</Chip>}>
          {data && (
            <form key={JSON.stringify(data.oidc)} className="flex flex-col gap-2.5" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void sso.run(() => api('/api/settings/auth', { oidc: { issuer: form.get('issuer'), clientId: form.get('clientId'), clientSecretEnv: form.get('clientSecretEnv') || undefined, allowedDomains: String(form.get('allowedDomains')).split(',').map(item => item.trim()).filter(Boolean), defaultRole: form.get('defaultRole') } })).then(auth.reload); }}>
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                <Field label="Issuer" error={sso.error?.fields['oidc.issuer']}><Input name="issuer" type="url" required disabled={locked} defaultValue={data.oidc?.issuer ?? ''} placeholder="https://id.example.com" /></Field>
                <Field label="Client ID" error={sso.error?.fields['oidc.clientId']}><Input name="clientId" required disabled={locked} defaultValue={data.oidc?.clientId ?? ''} /></Field>
                <Field label="Environment variable holding the client secret" error={sso.error?.fields['oidc.clientSecretEnv']}><Input name="clientSecretEnv" disabled={locked} defaultValue={data.oidc?.clientSecretEnv ?? 'AGENT_TEAM_OIDC_SECRET'} /></Field>
                <Field label="Role of a person who signs in for the first time"><Select name="defaultRole" disabled={locked} defaultValue={data.oidc?.defaultRole ?? 'viewer'}><option value="viewer">viewer</option><option value="member">member</option></Select></Field>
              </div>
              <Field label="Allowed email domains, comma-separated (empty allows any verified email)"><Input name="allowedDomains" disabled={locked} defaultValue={data.oidc?.allowedDomains.join(', ') ?? ''} placeholder="example.com, example.org" /></Field>
              {!locked && <div className="flex gap-2"><Button type="submit" variant="primary" disabled={sso.busy}>Save single sign-on</Button>{data.oidc && <Button variant="danger" disabled={sso.busy} onClick={() => { void sso.run(() => api('/api/settings/auth', { oidc: null })).then(auth.reload); }}>Turn off</Button>}</div>}
              <ActionError error={sso.error} />
            </form>
          )}
        </SettingsSection>

        <SettingsSection title="Trusted header" note="For an identity proxy on the same machine. It is set in the coordinator's configuration file (trustedHeader), is honoured only on a loopback bind, and cannot be changed from here.">
          <Card tone="raised" pad="sm" className="flex items-center gap-2"><StatusDot tone={data?.trustedHeader.enabled ? 'working' : 'off'} /><Text size="small">{data?.trustedHeader.enabled ? 'On' : 'Off'}</Text>{data?.trustedHeader.header && <Chip mono>{data.trustedHeader.header}</Chip>}</Card>
        </SettingsSection>

        <SettingsSection title="Machine credentials" note="Named tokens for additional workers and the command line, accepted next to the root machine token. A token is shown once and stored hashed; revoking it stops the worker that uses it at its next call.">
          <DataTable rows={tokens.data?.tokens ?? []} rowKey={token => token.id} empty={<Text size="small" tone="muted">No named tokens. The root token from the deployment is the only machine credential.</Text>} columns={[
            { label: 'Name', width: 'grow', cell: token => <Text size="small" weight="medium" truncate>{token.name}</Text> },
            { label: 'For', width: 'sm', cell: token => <Chip>{token.kind}</Chip> },
            { label: 'Created', cell: token => <Text size="caption" tone="muted">{day(token.createdAt)}{token.createdBy ? ` by ${token.createdBy}` : ''}</Text> },
            { label: 'Last used', width: 'sm', cell: token => <Text size="caption" tone="muted" mono>{day(token.lastUsedAt)}</Text> },
            { label: '', width: 'sm', cell: token => (token.revokedAt ? <Chip tone="stop">revoked</Chip> : <Button size="sm" variant="danger" onClick={() => { void machine.run(() => api(`/api/machine-tokens/${token.id}/revoke`, {})).then(tokens.reload); }}>Revoke</Button>) },
          ]} />
          <form className="flex flex-wrap items-end gap-2.5" onSubmit={machine.submit(async form => { const created = await api<{ token: string }>('/api/machine-tokens', { name: form.get('name'), kind: form.get('kind') }, tokenKey.headers()); tokenKey.renew(); setSecret(created.token); tokens.reload(); })}>
            <Field label="Name" error={machine.error?.fields.name}><Input name="name" required maxLength={60} placeholder="build box" /></Field>
            <Field label="For"><Select name="kind"><option value="worker">worker</option><option value="cli">command line</option></Select></Field>
            <Button type="submit" disabled={machine.busy}>Create token</Button>
          </form>
          <ActionError error={machine.error} />
          {secret && <Card tone="decision" pad="sm" className="flex flex-col gap-1.5"><Text size="small" tone="attention">Copy this now; it is not shown again. Give it to the worker as AGENT_TEAM_TOKEN.</Text><div className="flex flex-wrap items-center gap-2.5"><Text size="small" mono className="min-w-0 grow break-all">{secret}</Text><Button size="sm" onClick={() => { void navigator.clipboard.writeText(secret); }}>Copy</Button><Button size="sm" variant="ghost" onClick={() => setSecret(null)}>Done</Button></div></Card>}
        </SettingsSection>
      </SettingsBody>
    </OrgShell>
  );
}
