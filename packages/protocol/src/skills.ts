import { z } from 'zod';

// A skill is a written method an agent reads when the work calls for it: how to diagnose a bug, how to resolve a merge, how to
// write without the tells of generated prose. It is context, not enforcement: what an agent may do is still its grants. The shape
// is the one the common skill collections share (a SKILL.md with a name and a "use when" line, and files beside it), so a
// collection is imported as it is written and can be compared with its source later.
export const SkillSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lower-case letters, digits and dashes');
export const SkillFile = z.object({
  path: z.string().max(160).regex(/^(?!.*\.\.)[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, 'a relative path inside the skill'),
  content: z.string().max(60_000),
});
export type SkillFile = z.infer<typeof SkillFile>;
// Where an imported skill came from, so a later version can be compared with it and its license is never lost.
export const SkillSource = z.object({
  repository: z.string().min(1).max(200), path: z.string().max(300), commit: z.string().max(64).nullable(),
  license: z.string().max(60), author: z.string().max(120).nullable(),
});
export type SkillSource = z.infer<typeof SkillSource>;
export const Skill = z.object({
  slug: SkillSlug,
  // When to use it, in the words of the one who wrote it: this is what an agent sees before it decides to read the rest.
  description: z.string().trim().min(1).max(600),
  body: z.string().min(1).max(60_000),
  files: z.array(SkillFile).max(30).default([]),
  // Always applied: the whole text travels with every turn of the seats that have it, instead of being read when needed.
  always: z.boolean().default(false),
  source: SkillSource.nullable().default(null),
});
export type Skill = z.infer<typeof Skill>;

// The front matter of a SKILL.md, read without a YAML library: `key: value` lines, values plain, single- or double-quoted, or
// folded (`>-` and `|` followed by indented lines). Lists and nesting are kept as their raw text; nothing here needs them.
export function parseSkillMarkdown(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { meta: {}, body: normalized.trim() };
  const meta: Record<string, string> = {}, lines = match[1]!.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index]!);
    if (!line) continue;
    let value = line[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const folded: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) folded.push(lines[++index]!.trim());
      value = folded.join(value.startsWith('>') ? ' ' : '\n');
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1).replaceAll("''", "'");
    meta[line[1]!] = value;
  }
  return { meta, body: normalized.slice(match[0].length).trim() };
}

// A folder's name as a skill's slug: what the skill is called wherever other skills and roles name it.
export const skillSlugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
