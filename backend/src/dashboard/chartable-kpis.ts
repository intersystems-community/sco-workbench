// backend/src/dashboard/chartable-kpis.ts
import type { KpiDefinition } from '../kpi/kpi-definition.model.js';
import { humanizeLabel } from './humanize-label.js';

/** A KPI the chart picker offers: identity + its breakdown dimensions. */
export interface ChartableKpi {
  name: string;
  label: string;
  dimensions: { name: string; label: string }[];
}

/**
 * Map raw KPI definitions to the picker shape. A KPI is chartable through the cube-value
 * path iff it carries a DeepSee spec (`deepseeKpiSpec`); a non-DeepSee KPI has no cube to
 * query and is dropped. Each dimension carries its own label (humanized name as fallback)
 * so the frontend expand-dimension picker reads human terms. Source-agnostic sibling of
 * `chartable-cubes.ts` — same "filter at the source so the UI cannot drift" seam.
 */
export function toChartableKpis(defs: KpiDefinition[]): ChartableKpi[] {
  return defs
    .filter((d) => !!d.deepseeKpiSpec)
    .map((d) => ({
      name: d.name,
      label: d.label || humanizeLabel(d.name),
      dimensions: (d.deepseeKpiSpec?.kpiDimensions ?? []).map((dim) => ({
        name: dim.name,
        label: dim.label || humanizeLabel(dim.name),
      })),
    }));
}
