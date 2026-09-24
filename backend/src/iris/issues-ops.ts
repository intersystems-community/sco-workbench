/**
 * Count the issues a KPI raised, grouped by severity, over the SqlQuerier port. The
 * concrete IRIS-SQL backing of the dashboard `IssuesReader` port (kpi-issues.ts).
 * Sibling of row-count-ops.ts.
 *
 * Injection is closed on BOTH surfaces (B-6):
 *  - the TABLE NAME never reaches the SQL string — resolveClass looks the issue class up
 *    in %Dictionary and returns its real sqlTableName; an unresolved name throws first.
 *  - the KPI-name FILTER VALUE is a bound `?` parameter, never interpolated.
 *
 * SC-2721: the original B-5 hypothesis keyed the issue↔KPI link on the KPI's `baseObject`
 * via `impactedObjectType`. That column is the object TYPE an issue affects, so every KPI
 * over the same baseObject reported every other KPI's issues. The real link is
 * triggerType='KPI' + triggerObjectId=<KPI name>, which queryIssueCounts below already
 * groups on.
 */
import { resolveClass, type SqlQuerier } from './schema-ops.js';
import { NotFoundError } from './iris-error.js';
import type { IssuesReader, IssuesSummaryData } from '../dashboard/kpi-issues.js';
import type { IssueCountRow } from '../issues/issue-list.js';

/** Pinned live by the IT task (kpi-health.it.test.ts). */
export const ISSUE_CLASS = 'SC.Data.Issue';
export const ISSUE_SEVERITY_COL = 'severity';
export const ISSUE_TRIGGER_TYPE_COL = 'triggerType';
export const ISSUE_TRIGGER_OBJECT_COL = 'triggerObjectId';
/** The triggerType value marking an issue as raised by a KPI (cf. issues/issue-list.ts). */
export const KPI_TRIGGER_TYPE = 'KPI';

export class IrisIssuesReader implements IssuesReader {
  constructor(private readonly q: SqlQuerier) {}

  async summarize(kpiName: string): Promise<IssuesSummaryData> {
    const resolved = await resolveClass(this.q, ISSUE_CLASS);
    if (!resolved.exists || !resolved.sqlTableName) {
      throw new NotFoundError(`Issue class "${ISSUE_CLASS}" is not queryable on this instance.`);
    }
    // `AS c` so the alias survives (row-count-ops.ts precedent: an unaliased aggregate
    // returns as `Aggregate_1`). Table name from resolveClass (closed); both filters bound.
    const rows = await this.q.query<{ severity: number | string; c: number | string }>(
      `SELECT ${ISSUE_SEVERITY_COL} AS severity, COUNT(*) AS c FROM ${resolved.sqlTableName} ` +
        `WHERE ${ISSUE_TRIGGER_TYPE_COL} = ? AND ${ISSUE_TRIGGER_OBJECT_COL} = ? ` +
        `GROUP BY ${ISSUE_SEVERITY_COL}`,
      [KPI_TRIGGER_TYPE, kpiName],
    );
    const bySeverity = rows.map((r) => ({ severity: Number(r.severity), count: Number(r.c) }));
    const total = bySeverity.reduce((sum, r) => sum + r.count, 0);
    return { total, bySeverity };
  }
}

/**
 * Every nav badge on the Issue Management page in ONE round trip: a single GROUP BY
 * over the four dimensions the nav slices on. Doing it per-category instead would be
 * ~16 parallel REST calls, which exhausts the dev instance's licence connections.
 *
 * Row cardinality is one per distinct (triggerType, triggerObjectId, severity,
 * status) combination — tens of rows, not tens of thousands.
 *
 * Same injection guarantee as summarize(): the table name comes from resolveClass,
 * and this query binds no user input at all.
 */
export async function queryIssueCounts(q: SqlQuerier): Promise<IssueCountRow[]> {
  const resolved = await resolveClass(q, ISSUE_CLASS);
  if (!resolved.exists || !resolved.sqlTableName) {
    throw new NotFoundError(`Issue class "${ISSUE_CLASS}" is not queryable on this instance.`);
  }
  // Short aliases so no column name collides with a SQL keyword, and so the
  // returned keys are exactly what we read (an unaliased aggregate comes back
  // as `Aggregate_1` — see row-count-ops.ts).
  //
  // Two conversions the nav badges depend on:
  //  - %EXACT() returns the stored case. A plain string column comes back
  //    upper-cased by its collation, which would label a KPI "TESTKPI1".
  //  - CAST(... AS VARCHAR) returns '' for a NULL integer. Unconverted, a NULL
  //    severity arrives as 0 and would be counted in the lowest band.
  const rows = await q.query<{
    tt: unknown; toid: unknown; sev: unknown; st: unknown; c: unknown;
  }>(
    'SELECT %EXACT(triggerType) AS tt, %EXACT(triggerObjectId) AS toid, ' +
      'CAST(severity AS VARCHAR(12)) AS sev, ' +
      `%EXACT(status) AS st, COUNT(*) AS c FROM ${resolved.sqlTableName} ` +
      'GROUP BY triggerType, triggerObjectId, severity, status',
  );
  return rows.map((r) => ({
    triggerType: r.tt,
    triggerObjectId: r.toid,
    severity: r.sev,
    status: r.st,
    count: r.c,
  }));
}
