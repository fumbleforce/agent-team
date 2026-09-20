import type { Context as Hc, Hono } from 'hono';
import { z } from 'zod';
import { newId, ProviderBody } from '@agent-team/protocol';
import { PROVIDERS, providerEntry, type ModelChoice, type ProviderEntry } from '../../../../adapters/engine/providers.ts';
import { can, type Viewer } from '../auth/rbac.ts';
import { forbidden, HttpError, notFound, type Context } from '../context.ts';
import { WORKER_FRESH_MS } from '../runtime/scheduler.ts';
import { parseBody } from './conventions.ts';

type Env = { Variables: { viewer: Viewer } };
type Input = z.infer<typeof ProviderBody>;
interface Limits { maxConcurrentTurns?: number; windowTokens?: number; windowMs?: number }
interface Readiness { state: 'ready' | 'waiting' | 'none'; message: string; workers: string[]; /* What is still missing, for the page to offer the right next thing. */ need: 'worker' | 'tool' | 'key' | null }
const SetupBody = z.object({ kind: z.string().max(40), key: z.string().max(400).optional(), values: z.record(z.string().max(40), z.string().max(6000)).default({}) });
const HOUR = 3600_000;

// Model providers, organization-wide: which engine serves them, how they bill, which models an agent may be given and what the
// scheduler holds them to. The guided setup's words come from the engine adapters' catalog. A key is typed into the app, kept
// sealed and handed to a worker only with a turn on that provider; a sign-in stays with the tool on the worker.
export function mountProviderRoutes(app: Hono<Env>, context: Context) {
  const { storage, events, now } = context, db = storage.db;
  const admin = (c: Hc<Env>) => { if (!can(c.get('viewer'), 'org.members')) throw forbidden(); return c.get('viewer').userId; };
  const list = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

  // The one way a provider is written. How a provider bills never changes once it exists: a subscription login must not
  // become metered billing behind anyone's back, so that takes a new provider and an explicit routing rule.
  async function save(userId: string, input: Input, options: { id?: string; catalog?: string } = {}): Promise<string> {
    const limits: Limits = { maxConcurrentTurns: input.limits.concurrency ?? input.maxConcurrentTurns, ...(input.limits.windowTokens ? { windowTokens: input.limits.windowTokens, windowMs: input.limits.windowMs ?? 5 * HOUR } : {}) };
    const result = await storage.transaction(async tx => {
      const existing = options.id ? await tx.selectFrom('providers').select(['id', 'kind']).where('id', '=', options.id).executeTakeFirst() : undefined;
      if (existing && existing.kind !== input.kind) throw new HttpError(409, 'billing_fixed', 'How a provider bills cannot be changed. Add another provider instead and move agents to it on purpose.');
      const id = existing?.id ?? newId(now());
      const values = { name: input.name, engine: input.engine, models: JSON.stringify(input.models), limits: JSON.stringify(limits) };
      if (existing) await tx.updateTable('providers').set(values).where('id', '=', id).execute();
      else await tx.insertInto('providers').values({ id, kind: input.kind, billing: input.kind, engine_config: JSON.stringify(options.catalog ? { catalog: options.catalog } : {}), status: 'connected', status_detail: null, ...values }).execute();
      return { id, published: await events.append(tx, [{ type: existing ? 'provider.updated' : 'provider.added', category: 'audit', actorKind: 'user', userId, payload: { providerId: id, name: input.name, billing: input.kind, engine: input.engine, models: input.models, limits } }]) };
    });
    events.published(result.published);
    return result.id;
  }

  // What the workers seen lately said they can run. A worker that never said anything is an older one.
  async function workersNow() {
    const rows = await db.selectFrom('workers').select(['name', 'providers']).where('last_seen_at', '>', now() - WORKER_FRESH_MS).orderBy('name').execute();
    return rows.map(row => { const said = JSON.parse(row.providers) as { engines?: string[]; variables?: string[]; models?: Record<string, ModelChoice[]> } | unknown[]; return { name: row.name, reported: !Array.isArray(said), engines: Array.isArray(said) ? [] : said.engines ?? [], variables: Array.isArray(said) ? [] : said.variables ?? [], models: Array.isArray(said) ? {} : said.models ?? {} }; });
  }
  function readiness(workers: Awaited<ReturnType<typeof workersNow>>, engine: string, entry: ProviderEntry | null): Readiness {
    const variable = entry?.key?.variable, saved = Boolean(variable && context.secrets.has(variable)), withTool = workers.filter(worker => worker.engines.includes(engine));
    const ready = withTool.filter(worker => !variable || saved || (!entry?.key?.inAppOnly && worker.variables.includes(variable)));
    if (ready.length) return { state: 'ready', need: null, workers: ready.map(worker => worker.name), message: `Ready on ${list(ready.map(worker => worker.name))}` };
    if (withTool.length) return { state: 'waiting', need: 'key', workers: [], message: `Add the ${entry!.key!.label}` };
    if (workers.length === 0) return { state: 'none', need: 'worker', workers: [], message: 'No worker is running yet' };
    return { state: 'none', need: 'tool', workers: [], message: workers.every(worker => !worker.reported) ? `Update and restart ${list(workers.map(worker => worker.name))}` : `${list(workers.map(worker => worker.name))} still ${workers.length === 1 ? 'needs' : 'need'} the tool installed` };
  }
  const catalogKind = (engineConfig: string): string | null => { try { return (JSON.parse(engineConfig) as { catalog?: string }).catalog ?? null; } catch { return null; } };

  app.get('/api/providers', async c => {
    const rows = await db.selectFrom('providers').selectAll().orderBy('name').execute(), workers = await workersNow();
    const seats = await db.selectFrom('agents').select('provider_id').select(eb => eb.fn.countAll<number>().as('n')).where('status', '!=', 'retired').groupBy('provider_id').execute();
    return c.json({ canEdit: can(c.get('viewer'), 'org.members'), providers: rows.map(row => {
      const limits = JSON.parse(row.limits) as Limits, kind = catalogKind(row.engine_config);
      return { id: row.id, name: row.name, kind: row.kind, engine: row.engine, catalog: kind, models: JSON.parse(row.models) as string[], keyLabel: (kind ? providerEntry(kind)?.key?.label : undefined) ?? null, keySaved: Boolean(kind && providerEntry(kind)?.key && context.secrets.has(providerEntry(kind)!.key!.variable)), status: row.status, statusDetail: row.status_detail, limitedUntil: row.limited_until === null ? null : Number(row.limited_until),
        limits: { concurrency: limits.maxConcurrentTurns ?? null, windowTokens: limits.windowTokens ?? null, windowHours: limits.windowTokens ? (limits.windowMs ?? 5 * HOUR) / HOUR : null },
        agents: Number(seats.find(seat => seat.provider_id === row.id)?.n ?? 0), readiness: readiness(workers, row.engine, kind ? providerEntry(kind) : null) };
    }) });
  });
  app.post('/api/providers', async c => c.json({ id: await save(admin(c), await parseBody(c, ProviderBody)) }));

  // What the app is told about an entry: never its functions, and of a key only whether one is saved.
  const described = (entry: ProviderEntry) => { const { listModels, ...rest } = entry; return { ...rest, hasList: Boolean(listModels), keySaved: Boolean(entry.key && context.secrets.has(entry.key.variable)) }; };
  app.get('/api/providers/catalog', async c => {
    const workers = await workersNow();
    const added = new Map((await db.selectFrom('providers').select(['id', 'engine_config']).execute()).map(row => [catalogKind(row.engine_config), row.id]));
    return c.json({ entries: PROVIDERS.map(entry => ({ ...described(entry), providerId: added.get(entry.kind) ?? null, readiness: readiness(workers, entry.engine, entry) })) });
  });

  // The product's own list of models, fetched here so the page has something to pick from. Remembered for ten minutes.
  const lists = new Map<string, { at: number; models: ModelChoice[] }>();
  async function modelsOf(kind: string, typedKey: string | null) {
    const entry = providerEntry(kind);
    if (!entry) throw notFound('Provider');
    const aliases = (entry.aliases ?? []).map(id => ({ id, name: id }));
    // A tool that keeps its own list on the worker: what the workers reported is the list.
    const reported = [...new Map((await workersNow()).flatMap(worker => worker.models[entry.engine] ?? []).map(model => [model.id, model])).values()];
    if (!entry.listModels) return { models: [...aliases, ...reported.filter(model => !entry.aliases?.includes(model.id))], live: reported.length > 0, error: null };
    const key = typedKey ?? (entry.key ? context.secrets.get(entry.key.variable) ?? context.env[entry.key.variable] ?? null : null), cacheKey = `${entry.kind}:${key ? 'key' : ''}`, cached = typedKey ? undefined : lists.get(cacheKey);
    if (cached && cached.at > now() - 10 * 60_000) return { models: cached.models, live: true, error: null };
    try {
      const models = (await entry.listModels(key, context.fetch)).slice(0, 2000);
      if (models.length && !typedKey) lists.set(cacheKey, { at: now(), models });
      return { models: models.length ? models : aliases, live: models.length > 0, error: null };
    } catch (error) { return { models: aliases, live: false, error: (error as Error).message.slice(0, 200) }; }
  }
  app.get('/api/providers/catalog/:kind/models', async c => c.json(await modelsOf(c.req.param('kind'), null)));
  // The same, with a key that was typed but not saved yet, for a list that only opens with one.
  app.post('/api/providers/catalog/:kind/models', async c => { admin(c); return c.json(await modelsOf(c.req.param('kind'), (await parseBody(c, z.object({ key: z.string().trim().min(8).max(400).regex(/^\S+$/) }))).key)); });

  // What was typed, checked field by field in the person's words, then written through `save`.
  app.post('/api/providers/setup', async c => {
    const userId = admin(c), input = await parseBody(c, SetupBody), entry = providerEntry(input.kind);
    if (!entry) throw new HttpError(404, 'not_found', 'That provider is not supported');
    const fields: Record<string, string> = {}, value = (key: string) => ((key === 'name' && !entry.named) || (key.startsWith('window') && !entry.window) ? '' : (input.values[key] ?? '').trim());
    const LABELS: Record<string, string> = { concurrency: 'Turns at once', windowTokens: 'The allowance', windowHours: 'The hours' };
    const whole = (key: string, low: number, high: number): number | undefined => {
      const text = value(key).replace(/[\s,_]/g, ''), label = LABELS[key] ?? key;
      if (!text) return undefined;
      const number = Number(text);
      if (!Number.isInteger(number) || number < low || number > high) { fields[key] = `${label} should be a whole number between ${low.toLocaleString('en')} and ${high.toLocaleString('en')}`; return undefined; }
      return number;
    };
    const models = [...new Set(value('models').split(/[\n,]/).map(line => line.trim()).filter(Boolean))];
    if (models.length === 0) fields.models = 'Choose at least one model';
    else if (models.length > 40) fields.models = 'That is more than 40 models; keep the ones the team will really use';
    else { const odd = models.find(model => /\s/.test(model) || model.length > 120); if (odd) fields.models = `"${odd.slice(0, 40)}" does not look like a model name: a model name has no spaces`; }
    const key = input.key?.trim() ?? '';
    if (key && !entry.key) fields.key = 'This provider signs in on the worker; it takes no key';
    else if (key && (/\s/.test(key) || key.length < 8)) fields.key = 'That does not look like a key';
    const named = Boolean(entry.named), name = named ? value('name') : entry.title;
    if (named && !name) fields.name = 'Give it a name the team will recognise';
    if (name.length > 60) fields.name = 'Keep the name under 60 characters';
    const concurrency = whole('concurrency', 1, 64), windowTokens = whole('windowTokens', 1000, 10_000_000_000), windowHours = whole('windowHours', 1, 744);
    if (windowHours !== undefined && windowTokens === undefined && !fields.windowTokens) fields.windowTokens = 'Set the allowance too, or leave both empty';
    if (Object.keys(fields).length) throw new HttpError(400, 'invalid', 'Some fields need another look', fields);
    const existing = (await db.selectFrom('providers').select(['id', 'engine_config']).execute()).find(row => catalogKind(row.engine_config) === entry.kind);
    if (key && entry.key) { await context.secrets.set(entry.key.variable, key, userId); lists.clear(); }
    const body = ProviderBody.parse({ name, kind: entry.billing, engine: entry.engine, models, limits: { ...(concurrency ? { concurrency } : {}), ...(windowTokens ? { windowTokens, windowMs: (windowHours ?? 5) * HOUR } : {}) } });
    const id = await save(userId, body, { catalog: entry.kind, ...(existing ? { id: existing.id } : {}) });
    return c.json({ id, readiness: readiness(await workersNow(), entry.engine, entry) });
  });

  // One thing changed in place, from the provider's own row: the models, how many turns at once, or its key. Everything else stays as it was.
  const ChangeBody = z.object({ models: z.array(z.string().regex(/^\S{1,120}$/, 'A model name has no spaces')).max(40).optional(), concurrency: z.number().int().min(1).max(64).optional(), key: z.string().trim().min(8).max(400).regex(/^\S+$/).optional() });
  app.post('/api/providers/:id/change', async c => {
    const userId = admin(c), input = await parseBody(c, ChangeBody);
    const row = await db.selectFrom('providers').selectAll().where('id', '=', c.req.param('id')).executeTakeFirst();
    if (!row) throw notFound('Provider');
    const models = input.models ? [...new Set(input.models)] : JSON.parse(row.models) as string[], limits = JSON.parse(row.limits) as Limits, kind = catalogKind(row.engine_config);
    if (input.models) {
      if (models.length === 0) throw new HttpError(400, 'invalid', 'Keep at least one model', { models: 'Keep at least one model' });
      // A model an agent runs on is not taken away from under it.
      const used = await db.selectFrom('agents').select(['name', 'model']).where('provider_id', '=', row.id).where('status', '!=', 'retired').execute(), stranded = used.filter(agent => agent.model && !models.includes(agent.model));
      if (stranded.length) throw new HttpError(409, 'in_use', `${list(stranded.map(agent => agent.name))} still ${stranded.length === 1 ? 'runs' : 'run'} on ${list([...new Set(stranded.map(agent => agent.model!))])}. Give ${stranded.length === 1 ? 'that agent' : 'them'} another model first.`);
    }
    const variable = kind ? providerEntry(kind)?.key?.variable : undefined;
    if (input.key && !variable) throw new HttpError(400, 'invalid', 'This provider signs in on the worker; it takes no key', { key: 'This provider signs in on the worker; it takes no key' });
    if (input.key && variable) { await context.secrets.set(variable, input.key, userId); lists.clear(); }
    if (input.models || input.concurrency) await save(userId, ProviderBody.parse({ name: row.name, kind: row.kind, engine: row.engine, models, limits: { concurrency: input.concurrency ?? limits.maxConcurrentTurns, ...(limits.windowTokens ? { windowTokens: limits.windowTokens, windowMs: limits.windowMs } : {}) } }), { id: row.id });
    return c.json({ ok: true });
  });

  // Agents are never moved silently: a provider still in use stays until its agents were given another.
  app.post('/api/providers/:id/remove', async c => {
    const userId = admin(c), id = c.req.param('id');
    let forget: string | null = null;
    const published = await storage.transaction(async tx => {
      const provider = await tx.selectFrom('providers').select(['id', 'name', 'engine_config']).where('id', '=', id).executeTakeFirst();
      if (!provider) throw notFound('Provider');
      const seated = await tx.selectFrom('agents').select('name').where('provider_id', '=', id).where('status', '!=', 'retired').execute();
      if (seated.length) throw new HttpError(409, 'in_use', `${list(seated.map(agent => agent.name))} still ${seated.length === 1 ? 'runs' : 'run'} on ${provider.name}. Give ${seated.length === 1 ? 'that agent' : 'them'} another provider first.`);
      await tx.updateTable('agents').set({ provider_id: null, model: null }).where('provider_id', '=', id).execute();
      await tx.deleteFrom('providers').where('id', '=', id).execute();
      forget = providerEntry(catalogKind(provider.engine_config) ?? '')?.key?.variable ?? null;
      return events.append(tx, [{ type: 'provider.removed', category: 'audit', actorKind: 'user', userId, payload: { providerId: id, name: provider.name } }]);
    });
    events.published(published);
    if (forget) await context.secrets.remove(forget);
    return c.json({ ok: true });
  });

  // The key a worker needs for one turn, by the variable its tool reads it from. Nothing else is ever sent to a worker.
  return { async turnSecrets(turnId: string): Promise<Record<string, string>> {
    const row = await db.selectFrom('turns').innerJoin('providers', 'providers.id', 'turns.provider_id').select('providers.engine_config').where('turns.id', '=', turnId).executeTakeFirst();
    const variable = row ? providerEntry(catalogKind(row.engine_config) ?? '')?.key?.variable : undefined, value = variable ? context.secrets.get(variable) : null;
    return variable && value ? { [variable]: value } : {};
  } };
}
