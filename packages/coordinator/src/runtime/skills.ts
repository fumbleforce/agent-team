import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseSkillMarkdown, Role, Skill, SkillSource, type SkillFile } from '@agent-team/protocol';
import type { Db, Tx } from '@agent-team/storage';

// Skills are organization-wide, like roles: one library, assigned to roles, read by every seat that wears one.
export const SKILL_SCOPE = { type: 'library', id: '' } as const;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

// The skills a seat has: those of every role it wears, in the order its roles list them, each once.
export async function skillsOf(tx: Tx | Db, agentId: string): Promise<Skill[]> {
  const roles = await tx.selectFrom('agent_roles').innerJoin('versioned_docs', 'versioned_docs.slug', 'agent_roles.role_slug').select('versioned_docs.doc').where('versioned_docs.kind', '=', 'role').where('agent_roles.agent_id', '=', agentId).orderBy('agent_roles.role_slug').execute();
  const slugs = [...new Set(roles.flatMap(row => Role.safeParse(JSON.parse(row.doc)).data?.skills ?? []))];
  if (slugs.length === 0) return [];
  const rows = await tx.selectFrom('versioned_docs').select(['slug', 'doc']).where('kind', '=', 'skill').where('scope_type', '=', SKILL_SCOPE.type).where('scope_id', '=', SKILL_SCOPE.id).where('slug', 'in', slugs).execute();
  const found = new Map(rows.flatMap(row => { const skill = Skill.safeParse(JSON.parse(row.doc)).data; return skill ? [[row.slug, skill] as const] : []; }));
  return slugs.flatMap(slug => found.get(slug) ?? []);
}

// Skills were written for one agent working with a person at the keyboard; this says once how their steps map onto a team.
const HOW = 'A skill is a written method for one kind of work. Before the work a skill is for, read it with skill.read and follow it. Skills were written for someone working with a person at the keyboard: where one says to ask or confirm with the user, decide yourself and say what you decided in your report (or ask a colleague with deliberation.propose when a second view is worth it; what is not yours to decide is blocked with the question); where it names another skill, read that one with skill.read; where it starts sub-agents or asks other models, do those steps yourself, one after another. Your permissions and the rules of your turn come first.';
const ALWAYS = 'Apply this to everything a person reads: chat replies, reports and task summaries, documents, pull request descriptions and commit messages.';

// The part of a seat's standing prompt that its skills add: the text of those always applied, and one line for each of the rest,
// which the agent reads when the work calls for it. Nothing when the seat has no skills. `brief` is for a turn whose words no person
// reads (a review's verdict, feedback to a colleague): an always-applied skill with an "In short" section gives only that.
export async function skillsPart(tx: Tx, agentId: string, options: { brief?: boolean } = {}): Promise<string | null> {
  const skills = await skillsOf(tx, agentId);
  if (skills.length === 0) return null;
  const always = skills.filter(skill => skill.always), listed = skills.filter(skill => !skill.always);
  const parts = [
    ...(listed.length ? [`# Your skills\n${HOW}\n${listed.map(skill => `- ${skill.slug}: ${clip(skill.description.replace(/\s+/g, ' '), 240)}`).join('\n')}`] : []),
    ...always.map(skill => `# Always apply: ${skill.slug}\n${ALWAYS}\n\n${(options.brief ? inShort(skill.body) : null) ?? skill.body}`),
  ];
  return parts.join('\n\n');
}

// The "In short" section of a skill, when it has one.
const inShort = (body: string): string | null => /^## In short\n+([\s\S]*?)(?=\n## |\n# |$)/m.exec(body)?.[1]?.trim() ?? null;

// A skill in full, or one file of it. Any skill of the library can be read: skills name each other.
export async function readSkill(db: Db, name: string, file?: string): Promise<{ name: string; description: string; body: string; files: string[] } | { name: string; file: string; content: string } | null> {
  const row = await db.selectFrom('versioned_docs').select('doc').where('kind', '=', 'skill').where('scope_type', '=', SKILL_SCOPE.type).where('scope_id', '=', SKILL_SCOPE.id).where('slug', '=', name).executeTakeFirst();
  const skill = row ? Skill.safeParse(JSON.parse(row.doc)).data : undefined;
  if (!skill) return null;
  if (file === undefined || file === '' || file === 'SKILL.md') return { name: skill.slug, description: skill.description, body: skill.body, files: skill.files.map(item => item.path) };
  // Skills link their files relative to themselves, sometimes with a leading ./ .
  const wanted = file.replace(/^\.\//, ''), found = skill.files.find(item => item.path === wanted);
  return found ? { name: skill.slug, file: found.path, content: found.content } : null;
}

// The skills shipped with the platform: `blueprints/skills/index.json` names each folder, where it came from and whether it is
// always applied; each folder holds the skill as its authors wrote it.
interface ShippedIndex { sources: Record<string, { repository: string; path: string; commit: string | null; license: string; author: string | null }>; skills: { slug: string; from: string; always?: boolean }[] }
const TEXT = /\.(md|txt|sh|ts|tsx|js|mjs|py|json|ya?ml|toml|html|css)$/i;
export function filesOf(folder: string, prefix = ''): SkillFile[] {
  const out: SkillFile[] = [];
  for (const entry of readdirSync(path.join(folder, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${entry}` : entry, full = path.join(folder, relative);
    if (statSync(full).isDirectory()) out.push(...filesOf(folder, relative));
    else if (relative !== 'SKILL.md' && TEXT.test(entry)) out.push({ path: relative, content: readFileSync(full, 'utf8') });
  }
  return out;
}
export function shippedSkills(root: string): Record<string, Skill> {
  const indexFile = path.join(root, 'index.json');
  if (!existsSync(indexFile)) return {};
  const index = JSON.parse(readFileSync(indexFile, 'utf8')) as ShippedIndex, out: Record<string, Skill> = {};
  for (const entry of index.skills) {
    const folder = path.join(root, entry.slug), source = index.sources[entry.from];
    if (!source) throw new Error(`Skill ${entry.slug} names an unknown source ${entry.from}`);
    const { meta, body } = parseSkillMarkdown(readFileSync(path.join(folder, 'SKILL.md'), 'utf8'));
    out[entry.slug] = Skill.parse({ slug: entry.slug, description: meta.description ?? entry.slug, body, files: filesOf(folder), always: entry.always ?? false, source: SkillSource.parse({ ...source, path: `${source.path}/${entry.slug}` }) });
  }
  return out;
}
