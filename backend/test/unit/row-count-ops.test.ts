import { describe, it, expect } from 'vitest';
import { countRows, countRowsMany, ClassNotFoundError } from '../../src/iris/row-count-ops.js';
import type { SqlQuerier } from '../../src/iris/schema-ops.js';

/**
 * Records every SQL statement it is asked to run, and answers the two shapes
 * `resolveClass` uses plus the COUNT(*) this module builds. Same injected-fake
 * style as `schema-ops.test.ts`.
 */
function fakeQuerier(opts: { resolves?: boolean; total?: number; throwOnCount?: boolean } = {}) {
  const { resolves = true, total = 7, throwOnCount = false } = opts;
  const log: string[] = [];
  const querier: SqlQuerier = {
    async query<Row = Record<string, unknown>>(sql: string): Promise<Row[]> {
      log.push(sql);
      if (sql.includes('WHERE Name = ?')) {
        return (resolves
          ? [{ Name: 'SC.Data.BOM', SqlSchemaName: 'SC_Data', SqlTableName: 'BOM' }]
          : []) as Row[];
      }
      if (sql.includes('SqlSchemaName = ?')) return [] as Row[];
      // The candidate-pool query: `%STARTSWITH` when the name has a package
      // prefix (`SC.Data.BOMM`), and the un-prefixed `SELECT Name FROM
      // %Dictionary.CompiledClass` when it has no dot at all (`Foo; DROP TABLE
      // Bar`). resolveClass takes the second branch for a dotless name, so the
      // fake must answer both or the ClassNotFoundError path never runs.
      if (sql.includes('%STARTSWITH') || sql === 'SELECT Name FROM %Dictionary.CompiledClass') {
        return [{ Name: 'SC.Data.BOM' }, { Name: 'SC.Data.Carrier' }] as Row[];
      }
      if (sql.startsWith('SELECT COUNT(*)')) {
        if (throwOnCount) throw new Error('Atelier query failed: <UNDEFINED>');
        return [{ total }] as Row[];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { querier, log };
}

describe('countRows', () => {
  it('resolves an ObjectScript class name and counts its SQL table', async () => {
    const { querier } = fakeQuerier({ total: 42 });
    const result = await countRows(querier, 'SC.Data.BOM');
    expect(result).toEqual({ className: 'SC.Data.BOM', sqlTableName: 'SC_Data.BOM', total: 42 });
  });

  it('builds the count query from the resolved SQL name, not from the input', async () => {
    const { querier, log } = fakeQuerier();
    await countRows(querier, 'SC.Data.BOM');
    const counts = log.filter((sql) => sql.startsWith('SELECT COUNT(*)'));
    expect(counts).toEqual(['SELECT COUNT(*) AS total FROM SC_Data.BOM']);
  });

  it('issues NO count query at all when the name does not resolve', async () => {
    const { querier, log } = fakeQuerier({ resolves: false });
    await expect(countRows(querier, 'Foo; DROP TABLE Bar')).rejects.toThrow(ClassNotFoundError);
    expect(log.filter((sql) => sql.startsWith('SELECT COUNT(*)'))).toEqual([]);
  });

  it('carries resolveClass candidates on the not-found error', async () => {
    const { querier } = fakeQuerier({ resolves: false });
    await expect(countRows(querier, 'SC.Data.BOMM')).rejects.toMatchObject({
      name: 'ClassNotFoundError',
      candidates: ['SC.Data.BOM', 'SC.Data.Carrier'],
    });
  });

  it('propagates a query failure instead of returning a total', async () => {
    const { querier } = fakeQuerier({ throwOnCount: true });
    await expect(countRows(querier, 'SC.Data.BOM')).rejects.toThrow(/Atelier query failed/);
  });

  it('reports a total of 0 for an empty table', async () => {
    const { querier } = fakeQuerier({ total: 0 });
    await expect(countRows(querier, 'SC.Data.BOM')).resolves.toMatchObject({ total: 0 });
  });
});

// A querier that resolves several known classes and counts each, and lets one
// named class be marked unresolvable so per-item isolation can be exercised.
function multiQuerier(opts: { unresolvable?: string[]; totals?: Record<string, number> } = {}) {
  const unresolvable = new Set(opts.unresolvable ?? []);
  const totals = opts.totals ?? {};
  // className -> { schema, table }
  const known: Record<string, { schema: string; table: string }> = {
    'SC.Data.BOM': { schema: 'SC_Data', table: 'BOM' },
    'SC.Data.Carrier': { schema: 'SC_Data', table: 'Carrier' },
    'SC.Data.Empty': { schema: 'SC_Data', table: 'Empty' },
  };
  const log: string[] = [];
  const querier: SqlQuerier = {
    async query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]> {
      log.push(sql);
      if (sql.includes('WHERE Name = ?')) {
        const name = String(params?.[0] ?? '');
        const hit = known[name];
        if (!hit || unresolvable.has(name)) return [] as Row[];
        return [{ Name: name, SqlSchemaName: hit.schema, SqlTableName: hit.table }] as Row[];
      }
      if (sql.includes('SqlSchemaName = ?')) return [] as Row[];
      if (sql.includes('%STARTSWITH') || sql === 'SELECT Name FROM %Dictionary.CompiledClass') {
        return [{ Name: 'SC.Data.BOM' }] as Row[];
      }
      if (sql.startsWith('SELECT COUNT(*)')) {
        // Recover which table from the SQL to look up its total.
        const table = sql.replace('SELECT COUNT(*) AS total FROM ', '').trim();
        const total = totals[table] ?? 0;
        return [{ total }] as Row[];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { querier, log };
}

describe('countRowsMany', () => {
  it('returns a total per resolved name, keyed by the input className', async () => {
    const { querier } = multiQuerier({ totals: { 'SC_Data.BOM': 42, 'SC_Data.Carrier': 3 } });
    const result = await countRowsMany(querier, ['SC.Data.BOM', 'SC.Data.Carrier']);
    expect(result).toEqual({
      'SC.Data.BOM': { ok: true, total: 42, sqlTableName: 'SC_Data.BOM' },
      'SC.Data.Carrier': { ok: true, total: 3, sqlTableName: 'SC_Data.Carrier' },
    });
  });

  it('reports a total of 0 for an empty table (0 is a value, not a miss)', async () => {
    const { querier } = multiQuerier({ totals: { 'SC_Data.Empty': 0 } });
    const result = await countRowsMany(querier, ['SC.Data.Empty']);
    expect(result['SC.Data.Empty']).toEqual({ ok: true, total: 0, sqlTableName: 'SC_Data.Empty' });
  });

  it('isolates a per-item failure — one unresolvable name does not sink the batch', async () => {
    const { querier } = multiQuerier({
      unresolvable: ['SC.Data.Carrier'],
      totals: { 'SC_Data.BOM': 42 },
    });
    const result = await countRowsMany(querier, ['SC.Data.BOM', 'SC.Data.Carrier']);
    expect(result['SC.Data.BOM']).toEqual({ ok: true, total: 42, sqlTableName: 'SC_Data.BOM' });
    expect(result['SC.Data.Carrier']?.ok).toBe(false);
  });

  it('builds NO count query for a name that does not resolve (injection stays closed)', async () => {
    const { querier, log } = multiQuerier({ unresolvable: ['SC.Data.Carrier'] });
    await countRowsMany(querier, ['SC.Data.Carrier']);
    expect(log.filter((sql) => sql.startsWith('SELECT COUNT(*)'))).toEqual([]);
  });

  it('returns an empty map for an empty input', async () => {
    const { querier } = multiQuerier();
    await expect(countRowsMany(querier, [])).resolves.toEqual({});
  });
});
