import { ValidationError } from '../iris/iris-error.js';

export interface TileLayout { w: 1 | 2 | 3; h: 1 | 2 }
export interface TableSelection { table: string; columns?: string[] } // Track B: optional ORDERED column subset
export type CubeDimensionRole = 'category' | 'series' | 'filter';
export interface CubeDimensionAssignment { name: string; role: CubeDimensionRole; level?: string; member?: string }
export type ChartSelection =
  | { source: 'cube'; cube: string; measures: string[]; dimensions?: CubeDimensionAssignment[]; topN?: number; chartType?: string; useAi?: boolean; funnelSort?: 'value' | 'source' }
  | { source: 'kpi';  kpi: string;  expandDimension?: string; chartType?: string; useAi?: boolean };
export type TileConfig =
  | { id: string; kind: 'table'; title?: string; layout: TileLayout; selection: TableSelection }
  | { id: string; kind: 'chart'; title?: string; layout: TileLayout; selection: ChartSelection };
export interface DashboardConfig { schemaVersion: number; tiles: TileConfig[] }

export const CURRENT_SCHEMA_VERSION = 1;
export function emptyDashboardConfig(): DashboardConfig {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, tiles: [] };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * The backend authority for "what a storable dashboard is" (the server-side
 * hexagon; the FE TileConfig type is its mirror). Pure: no db, no IRIS. Coerces
 * `raw` to a normalized DashboardConfig, dropping unknown fields (tolerant parse
 * so Tracks B/C can add optional fields without a migration), or throws
 * ValidationError. An unknown schemaVersion is rejected here so GET/layout can
 * treat "newer build wrote this" the same as a malformed blob (§3 DA-SPEC-06).
 */
export function validateDashboardConfig(raw: unknown): DashboardConfig {
  if (!isObj(raw)) throw new ValidationError('A dashboard config object is required.');
  if (raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported dashboard schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.tiles)) throw new ValidationError('config.tiles must be an array.');
  return { schemaVersion: CURRENT_SCHEMA_VERSION, tiles: raw.tiles.map(validateTile) };
}

function validateTile(raw: unknown, i: number): TileConfig {
  if (!isObj(raw)) throw new ValidationError(`tiles[${i}] must be an object.`);
  if (!str(raw.id)) throw new ValidationError(`tiles[${i}].id is required.`);
  const layout = validateLayout(raw.layout, i);
  const title = str(raw.title) ? raw.title : undefined;
  if (raw.kind === 'table') {
    return dropUndefined({ id: raw.id, kind: 'table', title, layout, selection: validateTableSelection(raw.selection, i) });
  }
  if (raw.kind === 'chart') {
    return dropUndefined({ id: raw.id, kind: 'chart', title, layout, selection: validateChartSelection(raw.selection, i) });
  }
  throw new ValidationError(`tiles[${i}].kind must be 'table' or 'chart'.`);
}

function validateLayout(raw: unknown, i: number): TileLayout {
  if (!isObj(raw)) throw new ValidationError(`tiles[${i}].layout is required.`);
  const w = raw.w, h = raw.h;
  if (w !== 1 && w !== 2 && w !== 3) throw new ValidationError(`tiles[${i}].layout.w must be 1, 2 or 3.`);
  if (h !== 1 && h !== 2) throw new ValidationError(`tiles[${i}].layout.h must be 1 or 2.`);
  return { w, h };
}

function validateTableSelection(raw: unknown, i: number): TableSelection {
  if (!isObj(raw) || !str(raw.table)) throw new ValidationError(`tiles[${i}] table selection needs a table.`);
  // Tolerant: an ordered subset of non-empty column names, or nothing. A malformed
  // `columns` degrades to "all columns" (undefined, dropped) — never a hard reject.
  const columns =
    Array.isArray(raw.columns) && raw.columns.length > 0 && raw.columns.every(str)
      ? (raw.columns as string[])
      : undefined;
  return dropUndefined({ table: raw.table, columns });
}

function validateChartSelection(raw: unknown, i: number): ChartSelection {
  if (!isObj(raw)) throw new ValidationError(`tiles[${i}] chart selection is required.`);
  const chartType = str(raw.chartType) ? raw.chartType : undefined;
  const useAi = raw.useAi === true ? true : undefined;
  if (raw.source === 'cube') {
    const measures = Array.isArray(raw.measures) && raw.measures.length > 0 && raw.measures.every(str)
      ? (raw.measures as string[]) : null;
    if (!str(raw.cube) || !measures) throw new ValidationError(`tiles[${i}] cube selection needs a cube and at least one measure.`);
    const funnelSort = raw['funnelSort'] === 'value' || raw['funnelSort'] === 'source' ? raw['funnelSort'] : undefined;
    return dropUndefined({
      source: 'cube', cube: raw.cube, measures,
      dimensions: validateCubeDimensions(raw.dimensions, i),
      topN: typeof raw.topN === 'number' && Number.isFinite(raw.topN) ? raw.topN : undefined,
      chartType, useAi, funnelSort,
    });
  }
  if (raw.source === 'kpi') {
    if (!str(raw.kpi)) throw new ValidationError(`tiles[${i}] kpi selection needs a kpi.`);
    return dropUndefined({ source: 'kpi', kpi: raw.kpi, expandDimension: str(raw.expandDimension) ? raw.expandDimension : undefined, chartType, useAi });
  }
  throw new ValidationError(`tiles[${i}] chart selection source must be 'cube' or 'kpi'.`);
}

const ROLES = new Set(['category', 'series', 'filter']);
/**
 * A tolerant, strict-per-item dimensions validator: an array of {name, role, member?} where a
 * 'filter' role REQUIRES a member. A non-array degrades to undefined (a measures-only chart);
 * but a present array with a malformed ITEM is a hard reject (a persisted role conflict must not
 * silently vanish). Structural only — name/member existence is the query layer's authority.
 */
function validateCubeDimensions(raw: unknown, i: number): CubeDimensionAssignment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((d) => {
    if (!isObj(d) || !str(d.name) || typeof d.role !== 'string' || !ROLES.has(d.role)) {
      throw new ValidationError(`tiles[${i}] has an invalid cube dimension assignment.`);
    }
    if (d.role === 'filter' && !str(d.member)) {
      throw new ValidationError(`tiles[${i}] filter on '${d.name}' requires a member.`);
    }
    // `level` (B-CUBE-15) is a tolerant per-field passthrough: a string spec is kept (its validity
    // against the cube is enforced by query()), a non-string degrades to undefined. Not required.
    return dropUndefined({
      name: d.name, role: d.role as CubeDimensionRole,
      level: str(d.level) ? d.level : undefined,
      member: str(d.member) ? d.member : undefined,
    });
  });
}

/** Strip keys whose value is undefined so the stored blob and equality checks stay clean. */
function dropUndefined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
