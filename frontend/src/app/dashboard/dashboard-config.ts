/**
 * The frontend mirror of the backend dashboard contract
 * (backend/src/dashboard/dashboard-config.ts). Same shapes, same schemaVersion —
 * this is the serializable TileConfig-as-contract the shell holds, the editor
 * writes, and persistence blobs. No guard on the FE: validation is the server's
 * job (validateDashboardConfig); this type IS the guard's mirror. Tracks B/C add
 * OPTIONAL fields to the selections (a tolerant parse on the backend lets them
 * ride without a migration), so keep additions optional here too.
 */
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
