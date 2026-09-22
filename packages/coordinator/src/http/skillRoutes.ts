import type { Context as Hc, Hono } from 'hono';
import { z } from 'zod';
import { SkillSlug, type Skill } from '@agent-team/protocol';
import { readSkillCollection, skillSources, SkillSourceError } from '../../../../adapters/skills/index.ts';
import { can, type Viewer } from '../auth/rbac.ts';
import { forbidden, HttpError, type Context } from '../context.ts';
import { createVersionedDocs } from '../repos/versionedDocs.ts';
import { SKILL_SCOPE } from '../runtime/skills.ts';
import { ifMatch, parseBody, preconditioned } from './conventions.ts';

type Env = { Variables: { viewer: Viewer } };
const Saved = z.object({ doc: z.record(z.string(), z.unknown()), note: z.string().max(200).optional(), expectedVersion: z.number().int().min(0).optional() });
const same = (a: Pick<Skill, 'description' | 'body' | 'files'>, b: Pick<Skill, 'description' | 'body' | 'files'>) => a.description === b.description && a.body === b.body && JSON.stringify(a.files) === JSON.stringify(b.files);

// Skills are organization-wide documents, like roles: everyone may read them, admins write, import and revert them. Every change
// is a new version with its author and note, and any version can be put back.
export function mountSkillRoutes(app: Hono<Env>, context: Context) {
  const docs = createVersionedDocs(context), db = context.storage.db;
  const admin = async (c: Hc<Env>) => {
    if (!can(c.get('viewer'), 'org.members')) throw forbidden();
    return (await db.selectFrom('users').select('name').where('id', '=', c.get('viewer').userId).executeTakeFirstOrThrow()).name;
  };
  // Which roles name each skill: a skill no role names reaches no seat.
  const usedBy = async () => {
    const byskill = new Map<string, string[]>();
    for (const role of await docs.list('role', SKILL_SCOPE)) for (const slug of role.doc.skills ?? []) byskill.set(slug, [...(byskill.get(slug) ?? []), role.slug]);
    return byskill;
  };

  app.get('/api/skills', async c => {
    const skills = await docs.list('skill', SKILL_SCOPE), used = await usedBy();
    // Where skills can be imported from, as the page names them.
    const sources = skillSources({ env: {} }).map(source => ({ title: source.title, example: source.example }));
    return c.json({ canEdit: can(c.get('viewer'), 'org.members'), sources, skills: skills.map(skill => ({ slug: skill.slug, version: skill.version, author: skill.author, updatedAt: skill.updatedAt, description: skill.doc.description, always: skill.doc.always, source: skill.doc.source, files: skill.doc.files.length, usedBy: used.get(skill.slug) ?? [] })) });
  });
  app.get('/api/skills/:slug', async c => {
    const skill = await docs.get('skill', SKILL_SCOPE, c.req.param('slug'));
    return c.json({ ...skill, usedBy: (await usedBy()).get(skill.slug) ?? [], history: await docs.history('skill', SKILL_SCOPE, skill.slug) });
  });
  // Importing is two steps: a look at what is at the address (new, changed or the same as here), then the ones chosen.
  const read = (url: string) => readSkillCollection(url, { env: context.env, fetch: context.fetch }).catch(error => {
    if (error instanceof SkillSourceError) throw new HttpError(400, 'invalid', error.message, { url: error.message });
    throw error;
  });
  const Address = z.object({ url: z.string().trim().url('Give the address of a folder of skills').max(500) });
  app.post('/api/skills/import/preview', async c => {
    await admin(c);
    const found = await read((await parseBody(c, Address)).url), here = new Map((await docs.list('skill', SKILL_SCOPE)).map(skill => [skill.slug, skill.doc]));
    return c.json({ source: found.source, skipped: found.skipped, skills: found.skills.map(skill => { const current = here.get(skill.slug); return { slug: skill.slug, description: skill.description, files: skill.files.map(file => file.path), state: !current ? 'new' : same(current, skill) ? 'same' : 'changed' }; }) });
  });
  app.post('/api/skills/import', async c => {
    const author = await admin(c), input = await parseBody(c, Address.extend({ slugs: z.array(SkillSlug).min(1).max(80) }));
    const found = await read(input.url), chosen = found.skills.filter(skill => input.slugs.includes(skill.slug));
    const gone = input.slugs.filter(slug => !chosen.some(skill => skill.slug === slug));
    if (gone.length) throw new HttpError(409, 'conflict', `Not at that address any more: ${gone.join(', ')}`);
    const here = new Map((await docs.list('skill', SKILL_SCOPE)).map(skill => [skill.slug, skill.doc]));
    for (const skill of chosen) {
      const { repository, commit, license, author: owner } = found.source;
      // Whether it is always applied is this organization's choice, and survives a new version of the text.
      await docs.save('skill', SKILL_SCOPE, skill.slug, { slug: skill.slug, description: skill.description, body: skill.body, files: skill.files, always: here.get(skill.slug)?.always ?? false, source: { repository, path: skill.path, commit, license, author: owner } }, { author, userId: c.get('viewer').userId, note: `Imported from ${repository}${commit ? ` at ${commit.slice(0, 7)}` : ''}` });
    }
    return c.json({ imported: chosen.map(skill => skill.slug) });
  });

  // After the import routes: `/api/skills/import` is not a skill called import.
  app.post('/api/skills/:slug', async c => {
    const author = await admin(c), named = SkillSlug.safeParse(c.req.param('slug')), input = await parseBody(c, Saved);
    if (!named.success) throw new HttpError(400, 'invalid', 'A skill is named in lower-case letters, digits and dashes', { slug: 'lower-case letters, digits and dashes' });
    const slug = named.data;
    const matched = ifMatch(c), expectedVersion = matched ?? input.expectedVersion;
    return c.json({ version: await preconditioned(matched, () => docs.save('skill', SKILL_SCOPE, slug, { ...input.doc, slug }, { author, userId: c.get('viewer').userId, ...(input.note ? { note: input.note } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}) })) });
  });
  app.post('/api/skills/:slug/revert', async c => {
    const author = await admin(c), { version } = await parseBody(c, z.object({ version: z.number().int().min(1) }));
    return c.json({ version: await docs.revert('skill', SKILL_SCOPE, c.req.param('slug'), version, author) });
  });
}
