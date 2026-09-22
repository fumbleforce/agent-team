import { parseSkillMarkdown, skillSlugOf, type SkillFile } from '../../packages/protocol/src/skills.ts';
import { githubCredential } from '../tracker/githubCredential.ts';
import { SKILL_LIMITS, SKILL_TEXT, SkillSourceError, type SkillCollection, type SkillSource } from './contract.ts';

const API = 'https://api.github.com', RAW = 'https://raw.githubusercontent.com';
// https://github.com/owner/repo, optionally /tree/<ref>/<folder> or /blob/<ref>/<folder>/SKILL.md. A ref is one path segment.
const ADDRESS = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(?:\/([^\s?#]*))?)?\/?(?:[?#].*)?$/;
interface Entry { path: string; type: string; size?: number }
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentsOf = (dir: string) => { const out = [dir]; while (out.at(-1)) out.push(out.at(-1)!.split('/').slice(0, -1).join('/')); return out; };

// What a LICENSE file says, in a word, and whose it is.
function licenseOf(text: string): { license: string; author: string | null } {
  const first = text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  const license = /\bMIT\b/.test(first) ? 'MIT' : /Apache License/i.test(first) ? 'Apache-2.0' : /\bBSD\b/.test(first) ? 'BSD' : /ISC License/i.test(first) ? 'ISC' : first.slice(0, 60) || 'unknown';
  const author = /Copyright\s+(?:\(c\)|©)?\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?,?\s+)?(.+)$/im.exec(text)?.[1]?.trim().replace(/\.$/, '') ?? null;
  return { license, author: author ? author.slice(0, 120) : null };
}

// Skills in a public repository need no token; a token from GH_TOKEN or the GitHub command-line login is used when there is one,
// for private repositories and a higher rate limit. It is only ever sent to GitHub, and no answer or error repeats it.
export function githubSkills(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}): SkillSource {
  const request = options.fetch ?? fetch, token = githubCredential(options.env ?? process.env, { names: ['GH_TOKEN', 'GITHUB_ISSUES_TOKEN'] })?.token ?? null;
  const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  async function get(url: string, api: boolean): Promise<Response> {
    const headers = api ? { accept: 'application/vnd.github+json', 'user-agent': 'agent-team', 'x-github-api-version': '2022-11-28', ...auth } : { 'user-agent': 'agent-team', ...auth };
    const response = await request(url, { headers, signal: AbortSignal.timeout(30_000) }).catch(() => { throw new SkillSourceError('GitHub could not be reached'); });
    if (response.status === 404) throw new SkillSourceError('Nothing is at that address, or it is private and this machine has no access to it');
    if (response.status === 403 || response.status === 429) throw new SkillSourceError('GitHub refused for now, most likely its rate limit. Sign in with the GitHub command line or set GH_TOKEN on the coordinator, then try again');
    if (!response.ok) throw new SkillSourceError(`GitHub answered ${response.status}`);
    return response;
  }
  const json = async <T>(url: string) => (await (await get(url, true)).json().catch(() => { throw new SkillSourceError('GitHub sent an answer that could not be read'); })) as T;
  const text = async (repository: string, commit: string, file: string) => (await get(`${RAW}/${repository}/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`, false)).text();

  return {
    name: 'github',
    title: 'GitHub',
    example: 'https://github.com/owner/repo/tree/main/skills',
    matches: url => ADDRESS.test(url.trim()),
    async read(url): Promise<SkillCollection> {
      const found = ADDRESS.exec(url.trim());
      if (!found) throw new SkillSourceError('Give the address of a folder on GitHub, like https://github.com/owner/repo/tree/main/skills');
      const [, owner, name, ref, rawPath] = found, repository = `${owner}/${name}`;
      const folder = decodeURIComponent(rawPath ?? '').replace(/(^|\/)SKILL\.md$/, '').replace(/^\/+|\/+$/g, '');
      const repo = await json<{ default_branch?: string; license?: { spdx_id?: string | null } | null }>(`${API}/repos/${repository}`);
      const commit = (await json<{ sha?: string }>(`${API}/repos/${repository}/commits/${encodeURIComponent(ref ?? repo.default_branch ?? 'HEAD')}`)).sha;
      if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new SkillSourceError('GitHub did not say which commit that is');
      const tree = await json<{ tree?: Entry[]; truncated?: boolean }>(`${API}/repos/${repository}/git/trees/${commit}?recursive=1`);
      const blobs = (tree.tree ?? []).filter(entry => entry.type === 'blob'), skipped: string[] = [];
      if (tree.truncated) skipped.push('The repository is too large to list in one go; give the address of the skills folder itself');
      const within = (path: string) => !folder || path.startsWith(`${folder}/`) || path === folder;
      const all = blobs.filter(entry => within(entry.path) && (entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'))).map(entry => entry.path.slice(0, -'SKILL.md'.length).replace(/\/$/, ''));
      // A skill folder inside another belongs to that one (a playbook, an example), not to the list.
      const dirs = all.filter(dir => !all.some(other => other !== dir && (other === '' || dir.startsWith(`${other}/`))));
      if (dirs.length === 0) throw new SkillSourceError('There is no SKILL.md at or below that address');

      // The closest LICENSE at or above the folder says whose the text is; else the repository's own license.
      const licensePath = parentsOf(folder).flatMap(dir => blobs.filter(entry => entry.path.split('/').length === (dir ? dir.split('/').length + 1 : 1) && (dir === '' || entry.path.startsWith(`${dir}/`)) && /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(entry.path.split('/').at(-1)!)))[0]?.path;
      const declared = repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : null;
      const fromFile = licensePath ? licenseOf(await text(repository, commit, licensePath)) : null;
      const source = { repository, path: folder, commit, license: fromFile?.license ?? declared ?? 'none', author: fromFile?.author ?? owner!, url: url.trim() };

      const skills: SkillCollection['skills'] = [];
      let total = 0;
      for (const dir of dirs) {
        const slug = skillSlugOf(dir.split('/').at(-1) || name!);
        if (skills.length >= SKILL_LIMITS.skills) { skipped.push(`${slug}: past the limit of ${SKILL_LIMITS.skills} skills in one import`); continue; }
        const { meta, body } = parseSkillMarkdown(await text(repository, commit, join(dir, 'SKILL.md')));
        if (!meta.description?.trim() || !body) { skipped.push(`${slug}: its SKILL.md has no description or no text`); continue; }
        const files: SkillFile[] = [];
        for (const entry of blobs.filter(item => (dir === '' || item.path.startsWith(`${dir}/`)) && item.path !== join(dir, 'SKILL.md'))) {
          const relative = dir ? entry.path.slice(dir.length + 1) : entry.path;
          // Another tool's display metadata, and anything that is not text, stay behind.
          if (relative.startsWith('agents/') || !SKILL_TEXT.test(relative)) continue;
          if ((entry.size ?? 0) > SKILL_LIMITS.fileBytes) { skipped.push(`${slug}/${relative}: larger than ${SKILL_LIMITS.fileBytes / 1000} kB`); continue; }
          if (files.length >= SKILL_LIMITS.filesPerSkill) { skipped.push(`${slug}/${relative}: past ${SKILL_LIMITS.filesPerSkill} files`); continue; }
          if (total + (entry.size ?? 0) > SKILL_LIMITS.totalBytes) { skipped.push(`${slug}/${relative}: past ${SKILL_LIMITS.totalBytes / 1_000_000} MB for the whole import`); continue; }
          const content = await text(repository, commit, entry.path);
          total += content.length;
          files.push({ path: relative, content });
        }
        total += body.length;
        skills.push({ slug, path: dir, description: meta.description.trim().slice(0, 600), body: body.slice(0, 60_000), files });
      }
      return { source, skills, skipped };
    },
  };
}
