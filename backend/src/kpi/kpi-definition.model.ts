/**
 * KPI definition model — mirrors SCO's IRIS classes so the Workbench can round-
 * trip a definition through the SCO KPI REST API (`/api/{ns}/scbi/v1/kpi/...`):
 *   - SC.Core.Analytics.KPI.KpiDefinition
 *   - SC.Core.Analytics.KPI.DeepseeKpiSpec
 *   - SC.Core.Analytics.KPI.KpiDimension
 *
 * Field-level rules encoded by the source classes (validated by the frontend
 * form and, ultimately, by IRIS %JSONImport/%Save on submit):
 *   - `cube` and `valueType` are Required on the DeepSee spec.
 *   - `baseConditions` is the denominator ONLY when valueType = 'percentage'.
 *   - `defaultIssueSeverity` / `analysisService` only apply when issueKpi = true.
 *   - `deepseeKpiSpec` only applies when type = 'DeepSee'.
 *
 * The backend itself only persists this shape as a draft (no IRIS write); the
 * types exist so drafts are stored and returned with a stable, documented shape.
 */

/** Value type of a DeepSee KPI: a raw measure, or a percentage (num/denom). */
export type KpiValueType = 'raw' | 'percentage';

/** A KPI drill-down / breakdown dimension (MDX-encoded cube dimension). */
export interface KpiDimension {
  /** Short name used as the REST filter parameter (e.g. "carrier"). */
  name: string;
  /** Display label. */
  label?: string;
  /** Cube dimension in MDX form, e.g. "[carrier].[H1].[name]". */
  cubeDimension?: string;
}

/** The DeepSee-cube-backed spec of a KPI. */
export interface DeepseeKpiSpec {
  namespace?: string;
  /** Required by IRIS. */
  cube: string;
  kpiMeasure?: string;
  /** Required by IRIS. */
  valueType: KpiValueType;
  /** Numerator MDX %FILTER conditions. */
  kpiConditions?: string[];
  /** Denominator MDX %FILTER conditions — only used when valueType = 'percentage'. */
  baseConditions?: string[];
  kpiDimensions?: KpiDimension[];
}

/** A full KPI definition. */
export interface KpiDefinition {
  name: string;
  label?: string;
  description?: string;
  /** KPI type; the Workbench only authors 'DeepSee'. */
  type?: string;
  /** Source object for the drill-through listing (e.g. "SupplyShipment"). */
  baseObject?: string;
  status?: string;
  /** "Watching" (yellow) threshold. */
  watchingThreshold?: number;
  /** "Warning" (red) threshold. */
  warningThreshold?: number;
  /** Whether crossing a threshold raises an issue for impacted records. */
  issueKpi?: boolean;
  /** Default severity of raised issues — only meaningful when issueKpi = true. */
  defaultIssueSeverity?: number;
  /** BPL service for issue analysis/resolution — only when issueKpi = true. */
  analysisService?: string;
  deepseeKpiSpec?: DeepseeKpiSpec;
}
