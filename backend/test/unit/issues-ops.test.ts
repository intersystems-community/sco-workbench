import { describe, it, expect } from 'vitest';
import {
  IrisIssuesReader, queryIssueCounts, ISSUE_CLASS, ISSUE_SEVERITY_COL,
  ISSUE_TRIGGER_TYPE_COL, ISSUE_TRIGGER_OBJECT_COL, KPI_TRIGGER_TYPE,
} from '../../src/iris/issues-ops.js';
import type { SqlQuerier } from '../../src/iris/schema-ops.js';
import { NotFoundError } from '../../src/iris/iris-error.js';

/** A fake SqlQuerier that resolves the class (exact-class lookup) then answers the GROUP BY. */
function fakeQuerier(groupRows: { severity: number; c: number }[]) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const q: SqlQuerier = {
    async query<Row>(sql: string, parameters?: unknown[]): Promise<Row[]> {
      calls.push({ sql, params: parameters });
      // resolveClass step 1: the exact-class lookup on %Dictionary.CompiledClass
      if (sql.includes('%Dictionary.CompiledClass')) {
        return [{ Name: ISSUE_CLASS, SqlSchemaName: 'SC_Data', SqlTableName: 'Issue' }] as unknown as Row[];
      }
      // the GROUP BY severity count
      return groupRows.map((r) => ({ severity: r.severity, c: r.c })) as unknown as Row[];
    },
  };
  return { q, calls };
}

describe('IrisIssuesReader.summarize (issues-ops)', () => {
  it('groups counts by severity and totals them', async () => {
    const { q } = fakeQuerier([{ severity: 2, c: 2 }, { severity: 3, c: 1 }]);
    const out = await new IrisIssuesReader(q).summarize('ProductInventory');
    expect(out.total).toBe(3);
    expect(out.bySeverity).toEqual([{ severity: 2, count: 2 }, { severity: 3, count: 1 }]);
  });

  it('no rows → total 0, empty bySeverity (the zero-issues first-class case, B-7)', async () => {
    const { q } = fakeQuerier([]);
    const out = await new IrisIssuesReader(q).summarize('ProductInventory');
    expect(out).toEqual({ total: 0, bySeverity: [] });
  });

  it('passes the KPI name as a BOUND parameter — never interpolated into the SQL (B-6 injection surface)', async () => {
    const { q, calls } = fakeQuerier([{ severity: 2, c: 1 }]);
    await new IrisIssuesReader(q).summarize("Foo'; DROP TABLE Bar--");
    const countCall = calls.find((c) => c.sql.includes(ISSUE_SEVERITY_COL) && c.sql.includes('GROUP BY'))!;
    expect(countCall.params).toEqual([KPI_TRIGGER_TYPE, "Foo'; DROP TABLE Bar--"]);
    expect(countCall.sql).not.toContain('DROP TABLE'); // the value never reaches the SQL string
    expect(countCall.sql).toContain('?');               // it is a bound placeholder
  });

  // SC-2721: the B-5 hypothesis was wrong. impactedObjectType is the object TYPE an issue
  // affects, so every KPI over the same baseObject counted every other KPI's issues.
  it('scopes to the issues the KPI itself raised, not every issue on its baseObject', async () => {
    const { q, calls } = fakeQuerier([{ severity: 1, c: 7 }]);
    await new IrisIssuesReader(q).summarize('LateSupplyShipments');
    const countCall = calls.find((c) => c.sql.includes('GROUP BY'))!;
    expect(countCall.sql).toContain(ISSUE_TRIGGER_OBJECT_COL);
    expect(countCall.sql).toContain(ISSUE_TRIGGER_TYPE_COL);
    expect(countCall.sql).not.toContain('impactedObjectType');
    expect(countCall.params).toEqual([KPI_TRIGGER_TYPE, 'LateSupplyShipments']);
  });

  it('an unresolved Issue class throws (→ the health reader degrades, Task 4)', async () => {
    const q: SqlQuerier = { async query() { return []; } }; // resolveClass finds nothing
    await expect(new IrisIssuesReader(q).summarize('X')).rejects.toBeInstanceOf(Error);
  });
});

/** A fake SqlQuerier that resolves the class then answers the nav-count GROUP BY. */
function countQuerier(rows: Record<string, unknown>[]) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const q: SqlQuerier = {
    async query<Row>(sql: string, parameters?: unknown[]): Promise<Row[]> {
      calls.push({ sql, params: parameters });
      if (sql.includes('%Dictionary.CompiledClass')) {
        return [{ Name: ISSUE_CLASS, SqlSchemaName: 'SC_Data', SqlTableName: 'Issue' }] as unknown as Row[];
      }
      return rows as unknown as Row[];
    },
  };
  return { q, calls };
}

describe('queryIssueCounts (issues-ops)', () => {
  it('reads every nav dimension in ONE query — a fan-out would exhaust the licence', async () => {
    const { q, calls } = countQuerier([]);
    await queryIssueCounts(q);
    const groupBys = calls.filter((c) => c.sql.includes('GROUP BY'));
    expect(groupBys).toHaveLength(1);
    expect(groupBys[0]!.sql).toContain('GROUP BY triggerType, triggerObjectId, severity, status');
  });

  it('un-collates the strings and stringifies the integers', async () => {
    // Without %EXACT a KPI name comes back upper-cased ("TESTKPI1"), and without
    // the CAST a NULL severity comes back as 0 and lands in the lowest band.
    const { q, calls } = countQuerier([]);
    await queryIssueCounts(q);
    const group = calls.find((c) => c.sql.includes('GROUP BY'))!;
    expect(group.sql).toContain('%EXACT(triggerObjectId)');
    expect(group.sql).toContain('%EXACT(triggerType)');
    expect(group.sql).toContain('%EXACT(status)');
    expect(group.sql).toContain('CAST(severity AS VARCHAR(12))');
  });

  it('does not read urgency — no nav category slices by it', () => {
    const { q, calls } = countQuerier([]);
    return queryIssueCounts(q).then(() => {
      const group = calls.find((c) => c.sql.includes('GROUP BY'))!;
      expect(group.sql).not.toContain('urgency');
    });
  });

  it('binds nothing and interpolates no identifier the caller supplied', async () => {
    const { q, calls } = countQuerier([]);
    await queryIssueCounts(q);
    const group = calls.find((c) => c.sql.includes('GROUP BY'))!;
    expect(group.params).toBeUndefined();
    expect(group.sql).toContain('FROM SC_Data.Issue'); // table name from resolveClass
  });

  it('maps the short SQL aliases onto the count-row shape', async () => {
    const { q } = countQuerier([
      { tt: 'KPI', toid: 'LateDelivery', sev: 2, st: 'open', c: 8281 },
    ]);
    expect(await queryIssueCounts(q)).toEqual([
      {
        triggerType: 'KPI',
        triggerObjectId: 'LateDelivery',
        severity: 2,
        status: 'open',
        count: 8281,
      },
    ]);
  });

  it('an unresolved Issue class throws instead of reporting an empty nav', async () => {
    const q: SqlQuerier = { async query() { return []; } };
    await expect(queryIssueCounts(q)).rejects.toBeInstanceOf(NotFoundError);
  });
});
