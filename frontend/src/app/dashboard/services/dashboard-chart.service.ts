// frontend/src/app/dashboard/services/dashboard-chart.service.ts
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../../core/api';
import type { DashboardConfig, CubeDimensionAssignment } from '../dashboard-config';

const BASE = (): string => apiUrl('/api/dashboard');

export type DimensionKind = 'temporal' | 'categorical' | 'scalar';
export interface ChartData {
  categories: string[];
  series: { name: string; data: (number | null)[] }[];
  // valueLabel/categoryLabel are the source-neutral titling labels (chart vocabulary,
  // not any one source's) — a cube maps measure→value, dimension→category; a KPI source
  // maps its own terms onto the same two. Kept in lockstep with backend chart-data.ts.
  meta: { truncated: boolean; shown: number; total?: number; dimensionKind: DimensionKind; valueLabel?: string; categoryLabel?: string;
    seriesDimensionName?: string; seriesTruncated?: boolean; seriesShown?: number; seriesTotal?: number;
    // A band's `to` is the upper bound of a quality zone. The terminal (open-ended) band is
    // `Infinity` in the backend, but `JSON.stringify(Infinity)` is `null`, so on the wire the
    // FE receives `null` for it — the honest type here, not `number` (the it-test pins this:
    // "terminal to=null, not Infinity"). The ECharts builder resolves that `null` upper bound to
    // a finite axis max when it paints the bullet's markArea.
    target?: number; bands?: { to: number | null; kind: 'ok' | 'watching' | 'warning' }[];
    // `unit: 'percent'` marks a percentage-typed source (a KPI whose valueType is 'percentage'):
    // its value reads on the 0–100 scale and it renders as a full-circle ring, not the half-circle
    // gauge. Additive-optional — absent for every non-percentage source. Mirrors backend chart-data.ts.
    unit?: 'percent'; };
  points?: { x: number; y: number; size: number | null; label?: string }[];
}
/** ChartData plus the types that can draw truthfully from it (drives the dropdown filter). */
export interface ChartDataResponse extends ChartData {
  applicableTypes?: string[];
}
// B-CUBE-15: mirror the backend CubeShapeDimension/CubeShapeLevel — each dimension
// carries its full level list so the builder can offer level options (grouped under
// the dimension) and send the chosen level's MDX spec. Kept in lockstep with
// backend chart-data.ts (CubeShapeLevel{name,caption?,spec}).
export interface CubeShape {
  cube: string;
  measures: { name: string; caption?: string }[];
  dimensions: { name: string; kind: DimensionKind; levels: { name: string; caption?: string; spec: string }[] }[];
}
export interface CubeMember { name: string; key?: string; caption?: string }
/**
 * A cube the picker offers. The backend /chartable-cubes endpoint now returns
 * EVERY cube with its measure/dimension counts (it no longer drops the
 * non-chartable ones); the panel partitions on `measureCount > 0 &&
 * dimensionCount > 0`, listing chartable cubes first and disabling the rest.
 * The counts ride along for that partition and the disabled-reason labels.
 */
export interface ChartableCube {
  cubeName: string;
  className: string;
  sourceClass?: string;
  editable: boolean;
  measureCount: number;
  dimensionCount: number;
}
/** A KPI the picker offers (from GET /api/dashboard/kpis). */
export interface ChartableKpi {
  name: string;
  label: string;
  dimensions: { name: string; label: string }[];
}
export interface ChartDataRequest {
  source: 'cube' | 'kpi';
  cube?: string;
  measures?: string[];
  dimensions?: CubeDimensionAssignment[];
  topN?: number;
  kpi?: string;
  expandDimension?: string;
}
export interface ChartSpecRequest {
  chartData: ChartData;
  type?: string;
  intent?: string;
  useAi?: boolean;
  funnelSort?: 'value' | 'source';
}
/** The proactive AI-breaker probe result: can the LLM be reached right now? */
export interface AiHealth {
  available: boolean;
  reason?: string;
  /**
   * Which Claude provider the backend probed (`bedrock`, `vertex`, `foundry`,
   * `claude-aws`, `anthropic`), or null when none is configured. Identity only —
   * the backend never puts credential material in this response.
   */
  provider?: 'anthropic' | 'bedrock' | 'claude-aws' | 'vertex' | 'foundry' | null;
  /** Human name of that provider, e.g. "Amazon Bedrock". */
  providerLabel?: string;
}
export interface ChartSpecResponse {
  spec: Record<string, unknown>;
  type: string;
  layer: '1a' | '1b' | '2';
  source?: 'matrix' | 'shape-default';
  fallback?: boolean;
  reason?: string;
  /**
   * The deterministic analytic intent (Change 10) — present ONLY on a Layer-1b recommendation; drives `whyExplanation`.
   */
  intent?: string;
  /**
   * True ONLY when the LLM itself could not be reached (auth/config/network threw),
   * NOT when it answered unusably. Drives the "Ask AI" circuit breaker: a genuine
   * outage greys the control out (retry won't help until config is fixed); a bad
   * answer leaves it enabled.
   */
  unavailable?: boolean;
  /**
   * The deterministic advisor's pick for this data, present on EVERY response. Lets the
   * "Recommended" option name what it would draw — "Recommended (Stacked Column)" — even
   * when the shown chart is an explicit override or an AI pick. Backend-sourced (the
   * advisor is backend-only), so the FE never re-derives the selection matrix.
   */
  recommendedType?: string;
}

/**
 * Client for the workbench's /api/dashboard charting routes. Unlike
 * DataBrowserService's never-errors count, these calls CAN error (a 422
 * QUERY_FAILED, a 404) and the panel renders that inline — so errors propagate
 * rather than collapsing to a null result.
 */
@Injectable({ providedIn: 'root' })
export class DashboardChartService {
  private readonly http = inject(HttpClient);

  getChartableCubes(): Observable<{ cubes: ChartableCube[] }> {
    return this.http.get<{ cubes: ChartableCube[] }>(`${BASE()}/chartable-cubes`);
  }
  getCubeShape(cube: string): Observable<CubeShape> {
    return this.http.get<CubeShape>(`${BASE()}/cube-shape/${encodeURIComponent(cube)}`);
  }
  // B-CUBE-15: forward the chosen level spec so the endpoint enumerates the SAME level the
  // builder will pin (a member picker for a filter/category level).
  getCubeMembers(cube: string, dimension: string, level?: string): Observable<{ members: CubeMember[] }> {
    const q = level ? `?level=${encodeURIComponent(level)}` : '';
    return this.http.get<{ members: CubeMember[] }>(`${BASE()}/cube-members/${encodeURIComponent(cube)}/${encodeURIComponent(dimension)}${q}`);
  }
  getChartData(req: ChartDataRequest): Observable<ChartDataResponse> {
    return this.http.post<ChartDataResponse>(`${BASE()}/chart-data`, req);
  }
  getChartSpec(req: ChartSpecRequest): Observable<ChartSpecResponse> {
    return this.http.post<ChartSpecResponse>(`${BASE()}/chart-spec`, req);
  }
  getAiHealth(): Observable<AiHealth> {
    return this.http.get<AiHealth>(`${BASE()}/ai-health`);
  }
  getKpis(): Observable<{ kpis: ChartableKpi[] }> {
    return this.http.get<{ kpis: ChartableKpi[] }>(`${BASE()}/kpis`);
  }

  // --- Track A persistence: load/save the saved dashboard. GET is a pure read
  //     (the backend never writes back); PUT is the only mutation. ---
  getLayout(): Observable<{ config: DashboardConfig }> {
    return this.http.get<{ config: DashboardConfig }>(`${BASE()}/layout`);
  }
  saveLayout(config: DashboardConfig): Observable<{ ok: boolean; updatedAt: string }> {
    return this.http.put<{ ok: boolean; updatedAt: string }>(`${BASE()}/layout`, { config });
  }
}
