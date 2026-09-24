import { describe, it, expect } from 'vitest';
import {
  resolveClass,
  listProperties,
  listMethods,
  listForeignKeys,
  listListingColumns,
  matchProperty,
  closest,
  type SqlQuerier,
} from '../../src/iris/schema-ops.js';

/**
 * Fake Atelier querier backed by canned tables. Matches on the SQL text
 * fragment + the bound parameters, mirroring the real %Dictionary queries.
 */
function fakeQuerier(): SqlQuerier {
  const classes = [
    { Name: 'SC.Data.SalesOrder', SqlSchemaName: 'SC_Data', SqlTableName: 'SalesOrder' },
    { Name: 'SC.Data.Customer', SqlSchemaName: 'SC_Data', SqlTableName: 'Customer' },
    { Name: 'SC.Data.Product', SqlSchemaName: 'SC_Data', SqlTableName: 'Product' },
  ];
  const props: Record<string, Array<{ Name: string; RuntimeType?: string; Type?: string }>> = {
    'SC.Data.SalesOrder': [
      { Name: '%%OID', RuntimeType: '%Library.RawString' },
      { Name: 'customerId', RuntimeType: '%Library.String', Type: '%Library.String' },
      { Name: 'orderValue', RuntimeType: '%Library.Numeric', Type: '%Library.Numeric' },
      { Name: 'salesRegion', RuntimeType: '%Library.String' },
      { Name: 'customer', RuntimeType: 'SC.Data.Customer', Type: 'SC.Data.Customer' },
    ],
  };

  const methods: Record<
    string,
    Array<{ Name: string; ClassMethod?: unknown; FormalSpec?: string; ReturnType?: string; Description?: string }>
  > = {
    'SC.Core.Util.CubeUtil': [
      { Name: '%OnNew', ClassMethod: 0 }, // system → filtered out
      {
        Name: 'getCustomerName',
        ClassMethod: 1,
        FormalSpec: 'customerUid:%Library.String',
        ReturnType: '%Library.String',
        Description: 'Retrieve name a customer based on customer uid\nsecond line',
      },
      { Name: 'getProductBrand', ClassMethod: '1', FormalSpec: 'productId:%String', ReturnType: '%String' },
    ],
  };

  return {
    async query<Row = Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<Row[]> {
      if (sql.includes('CompiledClass') && sql.includes('WHERE Name = ?')) {
        return classes.filter((c) => c.Name === parameters[0]) as unknown as Row[];
      }
      if (sql.includes('CompiledClass') && sql.includes('SqlSchemaName = ?')) {
        return classes.filter(
          (c) => c.SqlSchemaName === parameters[0] && c.SqlTableName === parameters[1],
        ) as unknown as Row[];
      }
      if (sql.includes('CompiledClass') && sql.includes('%STARTSWITH')) {
        const prefix = String(parameters[0]);
        return classes.filter((c) => c.Name.startsWith(prefix)) as unknown as Row[];
      }
      if (sql.includes('CompiledClass')) {
        return classes as unknown as Row[];
      }
      if (sql.includes('CompiledProperty')) {
        return (props[String(parameters[0])] ?? []) as unknown as Row[];
      }
      if (sql.includes('CompiledMethod')) {
        return (methods[String(parameters[0])] ?? []) as unknown as Row[];
      }
      if (sql.includes('CompiledForeignKey')) {
        const fks: Record<string, Array<{ Name: string; ReferencedClass: string; Properties: string }>> = {
          'SC.Data.Customer': [
            { Name: 'primaryLocationIdFK', ReferencedClass: 'SC.Data.Location', Properties: 'primaryLocationId' },
            { Name: 'shipToLocationIdFK', ReferencedClass: 'SC.Data.Location', Properties: 'shipToLocationId' },
          ],
        };
        return (fks[String(parameters[0])] ?? []) as unknown as Row[];
      }
      return [] as Row[];
    },
  };
}

describe('resolveClass', () => {
  it('resolves an exact ObjectScript class name', async () => {
    const r = await resolveClass(fakeQuerier(), 'SC.Data.SalesOrder');
    expect(r).toMatchObject({ exists: true, className: 'SC.Data.SalesOrder', via: 'exact-class' });
    expect(r.sqlTableName).toBe('SC_Data.SalesOrder');
  });

  it('resolves a SQL table name (SC_Data.SalesOrder → SC.Data.SalesOrder)', async () => {
    const r = await resolveClass(fakeQuerier(), 'SC_Data.SalesOrder');
    expect(r.exists).toBe(true);
    expect(r.className).toBe('SC.Data.SalesOrder');
    expect(r.via).toBe('sql-table');
  });

  it('returns nearest candidates when unresolved', async () => {
    const r = await resolveClass(fakeQuerier(), 'SC.Data.SalesOrd');
    expect(r.exists).toBe(false);
    expect(r.candidates).toContain('SC.Data.SalesOrder');
  });
});

describe('listProperties', () => {
  it('lists non-system properties and flags references', async () => {
    const props = await listProperties(fakeQuerier(), 'SC.Data.SalesOrder');
    const names = props.map((p) => p.name);
    expect(names).not.toContain('%%OID');
    expect(names).toEqual(['customerId', 'orderValue', 'salesRegion', 'customer']);
    expect(props.find((p) => p.name === 'customerId')!.isReference).toBe(false);
    expect(props.find((p) => p.name === 'customer')!.isReference).toBe(true);
  });
});

describe('listForeignKeys', () => {
  it('lists a class foreign keys with referenced class + local columns', async () => {
    const fks = await listForeignKeys(fakeQuerier(), 'SC.Data.Customer');
    expect(fks).toEqual([
      { name: 'primaryLocationIdFK', referencedClass: 'SC.Data.Location', columns: ['primaryLocationId'] },
      { name: 'shipToLocationIdFK', referencedClass: 'SC.Data.Location', columns: ['shipToLocationId'] },
    ]);
  });

  it('returns [] for a class with no foreign keys', async () => {
    expect(await listForeignKeys(fakeQuerier(), 'SC.Data.SalesOrder')).toEqual([]);
  });
});

describe('listMethods', () => {
  it('lists non-system methods with a readable signature and doc line', async () => {
    const methods = await listMethods(fakeQuerier(), 'SC.Core.Util.CubeUtil');
    const names = methods.map((m) => m.name);
    expect(names).not.toContain('%OnNew'); // system method filtered
    expect(names).toEqual(['getCustomerName', 'getProductBrand']);
    const get = methods.find((m) => m.name === 'getCustomerName')!;
    expect(get.isClassMethod).toBe(true);
    expect(get.signature).toBe('(customerUid As %Library.String) As %Library.String');
    expect(get.returnType).toBe('%Library.String');
    expect(get.description).toBe('Retrieve name a customer based on customer uid'); // first line only
  });

  it('treats a "1" string ClassMethod flag as true', async () => {
    const methods = await listMethods(fakeQuerier(), 'SC.Core.Util.CubeUtil');
    expect(methods.find((m) => m.name === 'getProductBrand')!.isClassMethod).toBe(true);
  });
});

describe('matchProperty', () => {
  it('finds an exact match', async () => {
    const m = await matchProperty(fakeQuerier(), 'SC.Data.SalesOrder', 'orderValue');
    expect(m.exact).toBe('orderValue');
  });

  it('suggests the closest match for a typo (OrderVale → orderValue)', async () => {
    const m = await matchProperty(fakeQuerier(), 'SC.Data.SalesOrder', 'OrderVale');
    expect(m.exact).toBeUndefined();
    expect(m.closest[0]!.name).toBe('orderValue');
  });

  it('matches case-insensitively (OrderValue → orderValue on top)', async () => {
    const m = await matchProperty(fakeQuerier(), 'SC.Data.SalesOrder', 'OrderValue');
    expect(m.closest[0]!.name).toBe('orderValue');
  });
});

describe('closest', () => {
  it('ranks exact case-insensitive match first with score 1', () => {
    const r = closest('orderValue', ['salesRegion', 'ordervalue', 'customerId']);
    expect(r[0]).toEqual({ name: 'ordervalue', score: 1 });
  });

  it('returns empty for no candidates', () => {
    expect(closest('x', [])).toEqual([]);
  });
});

describe('listListingColumns', () => {
  /** A querier that returns canned %Dictionary.CompiledProperty rows and records the call. */
  function propQuerier(rows: Array<Record<string, unknown>>): SqlQuerier & { calls: Array<{ sql: string; params: unknown[] }> } {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return {
      calls,
      async query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> {
        calls.push({ sql, params });
        return rows as unknown as Row[];
      },
    };
  }

  it('returns the SQL column name of every stored property, in definition order', async () => {
    const q = propQuerier([
      { Name: 'uid', SqlFieldName: 'uid', Reserved: 0 },
      { Name: 'quantity', SqlFieldName: 'quantity' },
      { Name: 'renamed', SqlFieldName: 'RenamedCol' },
      { Name: 'group', SqlFieldName: 'group', Reserved: 1 },
    ]);
    expect(await listListingColumns(q, 'SC.Data.MfgOrder')).toEqual([
      { name: 'uid', reserved: false },
      { name: 'quantity', reserved: false },
      { name: 'RenamedCol', reserved: false },
      { name: 'group', reserved: true },
    ]);
    expect(q.calls[0]!.params).toEqual(['SC.Data.MfgOrder']);
    expect(q.calls[0]!.sql).toMatch(/ORDER BY SequenceNumber/);
    expect(q.calls[0]!.sql).toMatch(/%SYSTEM\.SQL_IsReservedWord\(SqlFieldName\)/);
  });

  it('skips properties that have no column in the base table', async () => {
    const q = propQuerier([
      { Name: '%%OID', SqlFieldName: '%%OID', Transient: 1 },
      { Name: '%Concurrency', SqlFieldName: '%Concurrency', Transient: 1 },
      { Name: 'scratch', SqlFieldName: 'scratch', Transient: '1' },
      { Name: 'derived', SqlFieldName: 'derived', Calculated: 1, SqlComputed: 0 },
      { Name: 'buffer', SqlFieldName: 'buffer', MultiDimensional: 1 },
      { Name: 'tags', SqlFieldName: 'tags', Collection: 'list' },
      { Name: 'lines', SqlFieldName: 'lines', Relationship: 1, Cardinality: 'children' },
      { Name: 'orders', SqlFieldName: 'orders', Relationship: 1, Cardinality: 'many' },
      { Name: 'uid', SqlFieldName: 'uid' },
    ]);
    expect((await listListingColumns(q, 'X')).map((c) => c.name)).toEqual(['uid']);
  });

  it('keeps SQL-computed calculated properties and the parent/one side of a relationship', async () => {
    const q = propQuerier([
      { Name: 'dailyDemand', SqlFieldName: 'dailyDemand', Calculated: 1, SqlComputed: 1 },
      { Name: 'header', SqlFieldName: 'header', Relationship: 1, Cardinality: 'parent' },
      { Name: 'owner', SqlFieldName: 'owner', Relationship: 1, Cardinality: 'one' },
    ]);
    expect((await listListingColumns(q, 'X')).map((c) => c.name)).toEqual(['dailyDemand', 'header', 'owner']);
  });

  it('falls back to the property name when SqlFieldName is absent', async () => {
    const q = propQuerier([{ Name: 'uid' }]);
    expect(await listListingColumns(q, 'X')).toEqual([{ name: 'uid', reserved: false }]);
  });

  it('returns [] for a class with no properties', async () => {
    expect(await listListingColumns(propQuerier([]), 'X')).toEqual([]);
  });
});
