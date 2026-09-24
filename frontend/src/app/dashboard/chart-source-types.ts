// frontend/src/app/dashboard/chart-source-types.ts
//
// The EDITORIAL gate (spec §5.4/§6): a pure, per-source subset of CAPABILITY_TYPES
// answering "do we even OFFER this type for this source?" — distinct from the backend
// truthfulness gate (capabilityFor) which answers "can this type draw honestly for this
// data shape?". The source is known on the frontend, so this narrowing lives here and
// never leaks a cube/kpi marker into the source-agnostic ChartData contract. Every token
// is drawn from CAPABILITY_TYPES (a subset selector, never a fork); each list is a
// SUPERSET of what the deterministic advisor can recommend for that source, so the
// auto-"Recommended" type is always also manually selectable and no clamp is needed.
import { CAPABILITY_TYPES, type ChartType } from './chart-capability';

/** Cube: the full multi-dimensional set; never a single-value gauge/bullet (editorial —
 *  a cube is never a single scalar in this UI). Re-trimmable later; one pure constant. */
export const CUBE_ALLOWED_TYPES: readonly ChartType[] =
  CAPABILITY_TYPES.filter((t) => t !== 'solidgauge' && t !== 'bullet');

// KPI: a single value reads as a gauge (or a bullet when thresholds give target + bands —
// that derivation is shared with Track B, spec §5.6); a breakdown dimension yields one
// series over categories, so the coherent single-series set ("core + honest extras").
const KPI_SCALAR_TYPES: readonly ChartType[] = ['solidgauge', 'bullet'];
const KPI_BREAKDOWN_TYPES: readonly ChartType[] = ['bar', 'column', 'line', 'pie', 'slope', 'divergingBar'];

/** `hasBreakdown` is `expandDimension() != null` in the KPI builder. */
export function kpiAllowedTypes(hasBreakdown: boolean): readonly ChartType[] {
  return hasBreakdown ? KPI_BREAKDOWN_TYPES : KPI_SCALAR_TYPES;
}
