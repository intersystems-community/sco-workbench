// backend/src/dashboard/kpi-issues.ts
/**
 * Port: summarize the issues a KPI raised — total + a per-severity count. The dashboard
 * KPI health read model (kpi-health.ts) depends on THIS shape only; the concrete IRIS-SQL
 * backing lives in backend/src/iris/issues-ops.ts (repo-placement: SQL-over-IRIS ops sit
 * beside row-count-ops.ts). The issue↔KPI link key is the KPI's NAME, matched against an
 * issue's triggerObjectId (SC-2721 — it was keyed on `baseObject` until then, which counted
 * every KPI's issues over that object).
 */
export interface IssuesSummaryData {
  total: number;
  bySeverity: { severity: number; count: number }[];
}

export interface IssuesReader {
  summarize(kpiName: string): Promise<IssuesSummaryData>;
}
