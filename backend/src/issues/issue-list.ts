/**
 * Read model for the Issue Management page: turns SCO's raw issue records into the
 * rows the page renders, and turns a nav-category selection into the SCO query
 * filters that fetch it.
 *
 * Two facts about the SCO data drive the whole mapping:
 *  - `severity` and `urgency` are OPEN INTEGERS ("the higher the value, the more
 *    severe" — SC.Core.Data.Internal.Issue), not an enum. The page shows three
 *    bands, so an integer is banded here and a band is turned back into an integer
 *    RANGE filter (SCO numeric filters accept `min..max`) for querying.
 *  - empty values are OMITTED from SCO's JSON, and the Atelier SQL path returns
 *    them as '', so "absent" arrives as undefined, null or ''. Every conversion
 *    below treats all three as absent — Number('') is 0, which would band an
 *    unset urgency as Low.
 */
import { ValidationError } from '../iris/iris-error.js';
import type { ScoIssue } from '../iris/issue-rest-client.js';

export type IssueBand = 'High' | 'Medium' | 'Low';
export type IssueCategoryGroup = 'kpi' | 'severity' | 'workqueue';

export const ISSUE_BANDS: readonly IssueBand[] = ['High', 'Medium', 'Low'];

/** SCO's status VALUELIST → the label the page shows. */
const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  workflow: 'Workflow',
  closed: 'Closed',
};

/** Work Queue = issues parked in a workflow task, waiting on a person. */
export const WORK_QUEUE_STATUS = 'workflow';

/** One row of the issue table. */
export interface IssueRow {
  uid: string;
  description: string;
  /** The triggering KPI's name — only KPI-triggered issues carry one. */
  kpi: string | null;
  severity: IssueBand | null;
  urgency: IssueBand | null;
  status: string;
  created: string | null;
  impactedObjectType: string | null;
  impactedObjectId: string | null;
}

/** An issue row plus the fields only the detail pane shows. */
export interface IssueDetail extends IssueRow {
  triggerType: string | null;
  issueData: string | null;
  resolutionNote: string | null;
  latestAnalysis: Record<string, unknown> | null;
}

/** Nav badge counts, all derived from one grouped query. */
export interface IssueCounts {
  total: number;
  byKpi: Record<string, number>;
  bySeverity: Record<IssueBand, number>;
  workQueue: number;
}

/** One row of the grouped count query (see iris/issues-ops.ts). */
export interface IssueCountRow {
  triggerType: unknown;
  triggerObjectId: unknown;
  severity: unknown;
  status: unknown;
  count: unknown;
}

/** Band an SCO severity/urgency integer. Absent or non-numeric → null. */
export function bandOf(value: unknown): IssueBand | null {
  const n = asNumber(value);
  if (n === null) return null;
  if (n >= 3) return 'High';
  if (n === 2) return 'Medium';
  return 'Low';
}

/**
 * The SCO numeric filter that selects a band. `3..` is >= 3, `..1` is <= 1
 * (SC.Core.API.ApiBaseImpl splits on ".." and emits >=/<= accordingly). NULL
 * severities match no band, so they appear under no severity category.
 */
export function bandFilter(band: IssueBand): string {
  switch (band) {
    case 'High':
      return '3..';
    case 'Medium':
      return '2..2';
    case 'Low':
      return '..1';
  }
}

/** Parse a band label from the client. Anything else is a 400, not a silent empty list. */
export function parseBand(value: string): IssueBand {
  const match = ISSUE_BANDS.find((b) => b.toLowerCase() === value.toLowerCase());
  if (!match) {
    throw new ValidationError(`Unknown band "${value}". Use one of: ${ISSUE_BANDS.join(', ')}.`);
  }
  return match;
}

/**
 * Translate a nav selection into SCO query filters. The page never sends raw SCO
 * attribute names, so a bad category is rejected here rather than becoming an
 * unknown query parameter — SCO IGNORES parameters it doesn't recognize, which
 * would quietly return every issue instead of erroring.
 */
export function categoryFilters(
  group: string,
  value: string,
): Record<string, string | number> {
  switch (group) {
    case 'kpi':
      if (!value) throw new ValidationError('A kpi category needs a KPI name.');
      return { triggerType: 'KPI', triggerObjectId: value };
    case 'severity':
      return { severity: bandFilter(parseBand(value)) };
    case 'workqueue':
      return { status: WORK_QUEUE_STATUS };
    default:
      throw new ValidationError(
        `Unknown issue category "${group}". Use kpi, severity or workqueue.`,
      );
  }
}

/** Map one SCO issue onto a table row. */
export function toIssueRow(iss: ScoIssue): IssueRow {
  return {
    uid: asString(iss.uid) ?? '',
    description: asString(iss.description) ?? '',
    kpi: iss.triggerType === 'KPI' ? asString(iss.triggerObjectId) : null,
    severity: bandOf(iss.severity),
    urgency: bandOf(iss.urgency),
    status: statusLabel(iss.status),
    created: asString(iss.recordCreatedTime),
    impactedObjectType: asString(iss.impactedObjectType),
    impactedObjectId: asString(iss.impactedObjectId),
  };
}

/** Map one SCO issue onto the detail shape. */
export function toIssueDetail(iss: ScoIssue): IssueDetail {
  return {
    ...toIssueRow(iss),
    triggerType: asString(iss.triggerType),
    issueData: asString(iss.issueData),
    resolutionNote: asString(iss.resolutionNote),
    latestAnalysis:
      iss.latestAnalysis && typeof iss.latestAnalysis === 'object' ? iss.latestAnalysis : null,
  };
}

/**
 * Fold the grouped count query into every nav badge. One issue contributes to its
 * KPI, its severity band and (if parked in a workflow) the work queue, so the
 * dimension totals overlap by design and only `total` sums the rows.
 */
export function foldCounts(rows: IssueCountRow[]): IssueCounts {
  const counts: IssueCounts = {
    total: 0,
    byKpi: {},
    bySeverity: { High: 0, Medium: 0, Low: 0 },
    workQueue: 0,
  };
  for (const row of rows) {
    const n = asNumber(row.count) ?? 0;
    if (n <= 0) continue;
    counts.total += n;
    const kpi = row.triggerType === 'KPI' ? asString(row.triggerObjectId) : null;
    if (kpi) counts.byKpi[kpi] = (counts.byKpi[kpi] ?? 0) + n;
    const sev = bandOf(row.severity);
    if (sev) counts.bySeverity[sev] += n;
    if (asString(row.status) === WORK_QUEUE_STATUS) counts.workQueue += n;
  }
  return counts;
}

function statusLabel(status: unknown): string {
  const raw = asString(status);
  if (!raw) return 'Unknown';
  return STATUS_LABELS[raw] ?? raw;
}

/** '' / null / undefined all mean "SCO omitted this value". */
function asString(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
