import type { Kysely } from 'kysely';
import type { StorageAdapter } from '../contract.ts';

const CHUNK = 500;

// Tables ordered so that each comes after the tables it refers to; a table that refers to itself, or a cycle, keeps its place.
export function inLoadOrder(tables: string[], refs: Map<string, string[]>): string[] {
  const done: string[] = [], visiting = new Set<string>();
  const visit = (name: string) => {
    if (done.includes(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const ref of refs.get(name) ?? []) if (ref !== name && tables.includes(ref)) visit(ref);
    visiting.delete(name);
    done.push(name);
  };
  for (const name of [...tables].sort()) visit(name);
  return done;
}

// Every row of one coordinator's database into another, empty one of either dialect, in one transaction: tables in reference order,
// the columns both have, booleans and numbers as the target keeps them. Search and vector indexes are rebuilt by the target itself.
export async function copyDatabase(source: StorageAdapter, target: StorageAdapter, onTable?: (name: string, rows: number) => void): Promise<number> {
  const from = source.db as unknown as Kysely<Record<string, Record<string, unknown>>>, to = target.db as unknown as Kysely<Record<string, Record<string, unknown>>>;
  const sourcePlan = new Map((await source.copyPlan()).map(table => [table.name, table]));
  const columnsOf = async (db: Kysely<Record<string, Record<string, unknown>>>) => new Map((await db.introspection.getTables()).map(table => [table.name, new Map(table.columns.map(column => [column.name, column.dataType.toLowerCase()]))]));
  const sourceColumns = await columnsOf(from), targetColumns = await columnsOf(to);
  const plan = (await target.copyPlan()).filter(table => sourcePlan.has(table.name));
  for (const table of plan) {
    const found = await to.selectFrom(table.name).select(eb => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    if (Number(found.n) > 0) throw new Error(`The target database is not empty: ${table.name} has rows`);
  }
  let total = 0;
  await target.transaction(async tx => {
    const into = tx as unknown as Kysely<Record<string, Record<string, unknown>>>;
    for (const table of plan) {
      const types = targetColumns.get(table.name) ?? new Map<string, string>(), skip = new Set([...table.skip, ...(sourcePlan.get(table.name)?.skip ?? [])]);
      const columns = [...(sourceColumns.get(table.name)?.keys() ?? [])].filter(column => types.has(column) && !skip.has(column));
      const value = (column: string, raw: unknown) => {
        const type = types.get(column)!;
        if (raw === null || raw === undefined) return null;
        if (/bool/.test(type)) return typeof raw === 'boolean' ? raw : Boolean(Number(raw));
        if (typeof raw === 'boolean') return raw ? 1 : 0;
        if (/int|numeric|real|double|float/.test(type) && typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
        return raw;
      };
      let copied = 0;
      for (let offset = 0; ; offset += CHUNK) {
        // Ordered by every column, so the pages neither skip nor repeat a row whatever the table's key is.
        const rows = await columns.reduce((query, column) => query.orderBy(column), from.selectFrom(table.name).select(columns)).limit(CHUNK).offset(offset).execute();
        if (rows.length === 0) break;
        await into.insertInto(table.name).values(rows.map(row => Object.fromEntries(columns.map(column => [column, value(column, row[column])])))).execute();
        copied += rows.length;
        if (rows.length < CHUNK) break;
      }
      total += copied;
      onTable?.(table.name, copied);
    }
  });
  await target.afterCopy?.();
  return total;
}
