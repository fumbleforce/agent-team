import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Project memory: a git repository the coordinator process owns, one directory per project.
//   <project>/charter.md          durable framing, owner-edited
//   <project>/items/<id>.md       one fact per file with YAML-style frontmatter
//   <project>/runs/<ticket>.md    what a run did, written by the PM after the run
// Every write is one commit with a real author, so history, diff and revert are plain git. A
// SQLite FTS5 index is rebuilt from the working tree after each commit for search and assembly.
export const ITEM_TYPES = ['observation', 'gotcha', 'decision', 'run', 'convention'];
export const ITEM_STATUS = ['active', 'superseded', 'retired'];
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const ITEM_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHA = /^[0-9a-f]{7,40}$/;

export class MemoryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (message, status = 400) => { throw new MemoryError(status, message); };

// Frontmatter is a flat key: value block; scope is a JSON array on one line.
export function parseItem(text, fallbackId = null) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { id: fallbackId, type: 'observation', scope: [], source: 'unknown', confirmed: false, hits: 0, status: 'active', title: fallbackId ?? '', body: text.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (key === 'scope') { try { meta.scope = JSON.parse(raw); } catch { meta.scope = raw.split(',').map(value => value.trim()).filter(Boolean); } }
    else if (key === 'confirmed') meta.confirmed = raw === 'true';
    else if (key === 'hits') meta.hits = Number(raw) || 0;
    else meta[key] = raw.replace(/^"(.*)"$/, '$1');
  }
  return { id: meta.id ?? fallbackId, type: meta.type ?? 'observation', scope: Array.isArray(meta.scope) ? meta.scope : [], source: meta.source ?? 'unknown', confirmed: meta.confirmed === true,
    hits: meta.hits ?? 0, status: meta.status ?? 'active', title: meta.title ?? fallbackId ?? '', created: meta.created ?? null, updated: meta.updated ?? null, body: match[2].trim() };
}

export function renderItem(item) {
  const lines = ['---', `id: ${item.id}`, `title: ${JSON.stringify(item.title)}`, `type: ${item.type}`, `scope: ${JSON.stringify(item.scope)}`, `source: ${item.source}`,
    `confirmed: ${item.confirmed === true}`, `hits: ${item.hits ?? 0}`, `status: ${item.status ?? 'active'}`, `created: ${item.created}`, `updated: ${item.updated}`, '---', '', item.body.trim(), ''];
  return lines.join('\n');
}

export function slug(title) {
  const base = String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `${base || 'item'}-${randomUUID().slice(0, 6)}`;
}

// A scope matches a requested area when either is a path prefix of the other.
function scopeOverlaps(own, wanted) {
  return own === wanted || wanted.startsWith(`${own}/`) || own.startsWith(`${wanted}/`);
}

// Roughly four characters per token; assembly stays under the cap with this estimate.
export const estimateTokens = text => Math.ceil(String(text).length / 4);

export function validateItemInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('Invalid memory item');
  const { id, type = 'observation', title, body, scope = [], confirmed = false, status = 'active', source = 'owner' } = input;
  if (id !== undefined && !ITEM_ID.test(String(id))) reject('Invalid item id');
  if (!ITEM_TYPES.includes(type)) reject('Invalid item type');
  if (typeof title !== 'string' || !title.trim() || title.length > 160 || /[\r\n]/.test(title)) reject('Invalid item title');
  if (typeof body !== 'string' || !body.trim() || body.length > 8000) reject('Invalid item body');
  // Scopes are repository paths or ticket ids; dotfile directories are valid, parent traversal is not.
  if (!Array.isArray(scope) || scope.length > 12 || scope.some(value => typeof value !== 'string' || !/^[A-Za-z0-9.][A-Za-z0-9_./-]{0,79}$/.test(value) || value.split('/').some(part => part === '..' || part === ''))) reject('Invalid item scope');
  if (!ITEM_STATUS.includes(status)) reject('Invalid item status');
  if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _:./@-]{0,119}$/.test(source)) reject('Invalid item source');
  return { id, type, title: title.trim(), body: body.trim(), scope, confirmed: confirmed === true, status, source };
}

export function createMemory({ dataDir, indexPath, now = () => new Date() } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('Memory requires a data directory');
  const root = path.resolve(dataDir, 'memory');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const git = (...args) => {
    const settings = typeof args.at(-1) === 'object' ? args.pop() : {};
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', input: settings.input, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(settings.env ?? {}) }, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim() || `exit ${result.status}`}`);
    return settings.trim === false ? result.stdout : result.stdout.trim();
  };
  if (!fs.existsSync(path.join(root, '.git'))) {
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'agent-team memory'); git('config', 'user.email', 'memory@agent-team.invalid');
    fs.writeFileSync(path.join(root, 'README.md'), '# Project memory\n\nOne directory per project: charter.md, items/*.md, runs/*.md. Edited through the dashboard or by the resident PM; every change is a commit.\n');
    git('add', '-A'); git('commit', '--quiet', '-m', 'Initialize project memory');
  }
  const db = new DatabaseSync(indexPath ?? path.join(dataDir, 'memory-index.sqlite'));
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS items USING fts5(project UNINDEXED, id UNINDEXED, type UNINDEXED, scope, title, body, status UNINDEXED, confirmed UNINDEXED, hits UNINDEXED, tokenize='porter unicode61');`);

  const projectDir = project => { if (!PROJECT.test(String(project))) reject('Invalid project id'); return path.join(root, project); };
  const ensureProject = project => {
    const dir = projectDir(project);
    for (const sub of ['items', 'runs']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(dir, 'charter.md'))) fs.writeFileSync(path.join(dir, 'charter.md'), `# ${project}\n\nWhat this project is for, what matters, what is out of scope. Edit freely; this is read at the start of every run.\n`);
    return dir;
  };
  const readItems = project => {
    const dir = path.join(projectDir(project), 'items');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort().map(name => parseItem(fs.readFileSync(path.join(dir, name), 'utf8'), name.slice(0, -3)));
  };
  const reindex = () => {
    db.exec('DELETE FROM items');
    const insert = db.prepare('INSERT INTO items(project,id,type,scope,title,body,status,confirmed,hits) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const project of fs.readdirSync(root).filter(name => PROJECT.test(name) && fs.statSync(path.join(root, name)).isDirectory())) {
      for (const item of readItems(project)) insert.run(project, item.id, item.type, item.scope.join(' '), item.title, item.body, item.status, item.confirmed ? 1 : 0, item.hits);
    }
  };
  const head = () => git('rev-parse', 'HEAD');
  const commit = (message, author) => {
    git('add', '-A');
    if (!git('status', '--porcelain')) return head();
    const name = (author?.name ?? 'agent-team').replace(/[<>\n]/g, '');
    git('commit', '--quiet', '-m', message.slice(0, 400), `--author=${name} <${(author?.email ?? 'agent-team@agent-team.invalid').replace(/[<>\s]/g, '')}>`);
    reindex();
    return head();
  };
  reindex();

  const shaOf = sha => { if (sha !== undefined && !SHA.test(String(sha))) reject('Invalid sha'); return sha; };
  const safeRelative = file => {
    if (typeof file !== 'string' || !file || file.split('/').some(part => !part || part === '.' || part === '..') || !/\.md$/.test(file)) reject('Invalid memory file');
    return file;
  };

  return {
    root,
    close: () => db.close(),
    head,
    projects: () => fs.readdirSync(root).filter(name => PROJECT.test(name) && fs.statSync(path.join(root, name)).isDirectory()).sort(),
    ensureProject: project => { ensureProject(project); return commit(`Initialize memory for ${project}`, null); },
    // The whole project tree at a commit, as { path: content }.
    read(project, sha) {
      projectDir(project); shaOf(sha);
      const ref = sha ?? 'HEAD';
      let names;
      try { names = git('ls-tree', '-r', '--name-only', ref, '--', `${project}/`).split('\n').filter(Boolean); } catch { return {}; }
      return Object.fromEntries(names.map(name => [name.slice(project.length + 1), git('show', `${ref}:${name}`, { trim: false })]));
    },
    readFile(project, file, sha) {
      projectDir(project); safeRelative(file); shaOf(sha);
      try { return git('show', `${sha ?? 'HEAD'}:${project}/${file}`, { trim: false }); } catch { return null; }
    },
    items: project => readItems(project),
    charter: project => { const file = path.join(projectDir(project), 'charter.md'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; },
    // Search matches title, body and scope words; scope filters narrow to overlapping items.
    search(project, query, { scope = [], limit = 20, includeInactive = false } = {}) {
      projectDir(project);
      if (typeof query !== 'string' || !query.trim() || query.length > 400) reject('Invalid query');
      const terms = query.replace(/["*()^:{}]/g, ' ').split(/\s+/).filter(Boolean).map(term => `"${term}"`).join(' OR ');
      if (!terms) return [];
      const rows = db.prepare(`SELECT id, type, scope, title, body, status, confirmed, hits, bm25(items) AS rank FROM items WHERE project=? AND items MATCH ? ORDER BY rank LIMIT ?`).all(project, terms, Math.min(200, Math.max(1, limit)));
      return rows.filter(row => includeInactive || row.status === 'active').filter(row => !scope.length || !row.scope || row.scope.split(' ').some(own => scope.some(wanted => scopeOverlaps(own, wanted))))
        .map(row => ({ id: row.id, type: row.type, scope: row.scope ? row.scope.split(' ') : [], title: row.title, body: row.body, status: row.status, confirmed: row.confirmed === 1, hits: row.hits }));
    },
    // Charter first, then items by relevance to the ticket's scopes (confirmed and often-hit first),
    // trimmed to the token cap. Returns what was injected so the run journal can record it.
    assemble(project, scopes = [], capTokens = 4000) {
      projectDir(project);
      const charter = this.charter(project).trim();
      const sha = head();
      if (!capTokens) return { markdown: '', sha, itemIds: [] };
      const ranked = readItems(project).filter(item => item.status === 'active').map(item => {
        // Deeper matching scopes count more, so an item about one module outranks a repository-wide one.
        const overlap = item.scope.filter(value => scopes.some(wanted => scopeOverlaps(value, wanted))).reduce((sum, value) => sum + value.split('/').length, 0);
        const general = item.scope.length === 0 ? 1 : 0;
        return { item, score: overlap * 10 + general * 2 + (item.confirmed ? 3 : 0) + Math.min(item.hits, 5) + (item.type === 'gotcha' ? 2 : 0) + (item.type === 'run' ? -4 : 0) };
      }).filter(entry => entry.score > 0 || scopes.length === 0).sort((a, b) => b.score - a.score);
      const parts = ['# Project memory', charter ? `## Charter\n\n${charter}` : ''];
      let used = estimateTokens(parts.join('\n\n'));
      const itemIds = [];
      for (const { item } of ranked) {
        const block = `### ${item.title}\n_${item.type}${item.confirmed ? ', confirmed' : ', unconfirmed'}${item.scope.length ? `, scope: ${item.scope.join(', ')}` : ''}_ (${item.id})\n\n${item.body}`;
        const cost = estimateTokens(block);
        if (used + cost > capTokens) continue;
        used += cost; parts.push(block); itemIds.push(item.id);
      }
      if (itemIds.length) parts.splice(2, 0, '## Items');
      return { markdown: parts.filter(Boolean).join('\n\n'), sha, itemIds, tokens: used };
    },
    // Writes items and commits once. Existing ids are updated; unknown ids create files.
    write(project, inputs, { author, message } = {}) {
      const dir = ensureProject(project);
      const stamp = now().toISOString();
      const written = [];
      for (const raw of Array.isArray(inputs) ? inputs : [inputs]) {
        const input = validateItemInput(raw);
        const id = input.id ?? slug(input.title);
        const file = path.join(dir, 'items', `${id}.md`);
        const existing = fs.existsSync(file) ? parseItem(fs.readFileSync(file, 'utf8'), id) : null;
        const item = { ...existing, ...input, id, hits: raw.hits ?? existing?.hits ?? 0, created: existing?.created ?? stamp, updated: stamp };
        fs.writeFileSync(file, renderItem(item));
        written.push(id);
      }
      const sha = commit(message ?? `Update ${written.length} memory item${written.length === 1 ? '' : 's'} in ${project}`, author);
      return { sha, ids: written };
    },
    writeFile(project, file, content, { author, message } = {}) {
      const dir = ensureProject(project); safeRelative(file);
      if (typeof content !== 'string' || content.length > 200_000) reject('Invalid content');
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (file.startsWith('items/')) { const item = validateItemInput({ ...parseItem(content, file.slice(6, -3)), id: file.slice(6, -3) }); fs.writeFileSync(target, renderItem({ ...parseItem(content, item.id), ...item, updated: now().toISOString(), created: parseItem(content).created ?? now().toISOString() })); }
      else fs.writeFileSync(target, content);
      return { sha: commit(message ?? `Edit ${project}/${file}`, author) };
    },
    setStatus(project, ids, status, { author } = {}) {
      if (!ITEM_STATUS.includes(status)) reject('Invalid status');
      const dir = projectDir(project);
      for (const id of ids) {
        if (!ITEM_ID.test(String(id))) reject('Invalid item id');
        const file = path.join(dir, 'items', `${id}.md`);
        if (!fs.existsSync(file)) reject(`Unknown item ${id}`, 404);
        fs.writeFileSync(file, renderItem({ ...parseItem(fs.readFileSync(file, 'utf8'), id), status, updated: now().toISOString() }));
      }
      return { sha: commit(`Mark ${ids.length} item${ids.length === 1 ? '' : 's'} ${status} in ${project}`, author) };
    },
    // Injected items were useful in proportion to how often runs saw them; the PM bumps hits.
    bump(project, ids, { author } = {}) {
      const dir = projectDir(project);
      for (const id of ids) {
        const file = path.join(dir, 'items', `${id}.md`);
        if (!fs.existsSync(file)) continue;
        const item = parseItem(fs.readFileSync(file, 'utf8'), id);
        fs.writeFileSync(file, renderItem({ ...item, hits: (item.hits ?? 0) + 1 }));
      }
      return { sha: commit(`Record ${ids.length} memory hit${ids.length === 1 ? '' : 's'} in ${project}`, author) };
    },
    writeRun(project, ticket, content, { author } = {}) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(String(ticket))) reject('Invalid ticket');
      return this.writeFile(project, `runs/${ticket}.md`, content, { author, message: `Record run ${ticket} in ${project}` });
    },
    log(project, { limit = 50 } = {}) {
      projectDir(project);
      const raw = git('log', `-n${Math.min(500, Math.max(1, limit))}`, '--format=%H%x1f%an%x1f%aI%x1f%s', '--', `${project}/`);
      return raw ? raw.split('\n').map(line => { const [sha, author, at, subject] = line.split('\x1f'); return { sha, author, at, subject }; }) : [];
    },
    diff(project, sha, against) {
      projectDir(project); shaOf(sha); shaOf(against);
      return git('diff', against ?? `${sha}^`, sha, '--', `${project}/`, { trim: false });
    },
    // Restores the project directory as it was at `sha` in a new commit; nothing is rewritten.
    revert(project, sha, { author } = {}) {
      const dir = projectDir(project); shaOf(sha);
      fs.rmSync(dir, { recursive: true, force: true });
      try { git('checkout', sha, '--', `${project}/`); } catch { /* project did not exist at sha: leaves it removed */ }
      git('reset', '--quiet');
      return { sha: commit(`Revert ${project} memory to ${sha.slice(0, 8)}`, author) };
    },
    // Seeds items from repository instruction files: each file becomes one confirmed convention item.
    seed(project, files, { author } = {}) {
      const inputs = Object.entries(files).map(([file, content]) => ({ id: slug(file).replace(/-[a-f0-9]{6}$/, `-${file.length.toString(36)}`), type: 'convention', title: `Rules from ${file}`, body: String(content).trim().slice(0, 8000), scope: [path.dirname(file) === '.' ? file : path.dirname(file)], confirmed: true, source: `seed:${file}` }));
      return this.write(project, inputs, { author, message: `Seed ${project} memory from ${inputs.length} file${inputs.length === 1 ? '' : 's'}` });
    },
  };
}
