import { humanizeField, humanizeCubeName } from './humanize';
import type { DashboardConfig, TileConfig } from './dashboard-config';

/**
 * Pure shell state for the dashboard — every mutation is a function over
 * DashboardConfig returning a NEW config (no in-place edits), so the shell can
 * hold `saved` and `working` signals and diff them for `dirty`. Framework-free,
 * exhaustively unit-tested; the imperative shell (DashboardComponent) only holds
 * the signals and calls these. Mirrors the page-state.ts functional-core idiom.
 */

export function newTileId(existing: TileConfig[]): string {
  const used = new Set(existing.map((t) => t.id));
  for (let n = 0; ; n++) if (!used.has(`tile-${n}`)) return `tile-${n}`;
}

export function addTile(cfg: DashboardConfig, tile: TileConfig): DashboardConfig {
  return { ...cfg, tiles: [...cfg.tiles, tile] };
}
export function deleteTile(cfg: DashboardConfig, id: string): DashboardConfig {
  return { ...cfg, tiles: cfg.tiles.filter((t) => t.id !== id) };
}
export function updateTile(cfg: DashboardConfig, id: string, next: TileConfig): DashboardConfig {
  return { ...cfg, tiles: cfg.tiles.map((t) => (t.id === id ? next : t)) };
}
export function reorderTile(cfg: DashboardConfig, id: string, dir: 'left' | 'right'): DashboardConfig {
  const i = cfg.tiles.findIndex((t) => t.id === id);
  const j = dir === 'left' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= cfg.tiles.length) return cfg; // clamp at the ends
  const tiles = [...cfg.tiles];
  [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  return { ...cfg, tiles };
}
/**
 * Move the tile with `id` to array position `index` (clamped to [0, len-1]);
 * a value-equal no-op if it is already there or the id is unknown. Immutable —
 * returns a NEW config. Generalises reorderTile (which stays as the ⋯ menu's
 * single-step ◀ ▶ fallback); the drag gesture resolves to an absolute index.
 */
export function moveTileToIndex(cfg: DashboardConfig, id: string, index: number): DashboardConfig {
  const from = cfg.tiles.findIndex((t) => t.id === id);
  if (from < 0) return cfg; // unknown id
  const to = Math.max(0, Math.min(index, cfg.tiles.length - 1));
  if (to === from) return cfg; // already there
  const tiles = [...cfg.tiles];
  const [moved] = tiles.splice(from, 1);
  tiles.splice(to, 0, moved);
  return { ...cfg, tiles };
}
export function resizeTile(cfg: DashboardConfig, id: string, w: 1 | 2 | 3, h: 1 | 2): DashboardConfig {
  return updateTileLayout(cfg, id, { w, h });
}
function updateTileLayout(cfg: DashboardConfig, id: string, layout: TileConfig['layout']): DashboardConfig {
  return { ...cfg, tiles: cfg.tiles.map((t) => (t.id === id ? { ...t, layout } : t)) };
}

/** Structural inequality of two configs (JSON compare is enough for this flat, serializable shape). */
export function isDirty(saved: DashboardConfig, working: DashboardConfig): boolean {
  return JSON.stringify(saved) !== JSON.stringify(working);
}

/**
 * A deterministic default title derived from the SELECTION alone (no network,
 * unlike the render-time `whyLabel` which needs a built spec). User-overridable.
 * Table → the humanized short table name. Cube chart → "<Measure> by <Dimension>".
 * KPI chart → the humanized KPI, optionally "by <breakdown>".
 */
export function defaultTileTitle(tile: TileConfig): string {
  if (tile.kind === 'table') return humanizeCubeName(shortName(tile.selection.table));
  const s = tile.selection;
  if (s.source === 'cube') {
    const measure = humanizeField(s.measures[0] ?? '');
    const category = s.dimensions?.find((d) => d.role === 'category');
    return category ? `${measure} by ${humanizeField(category.name)}` : measure;
  }
  const kpi = humanizeField(s.kpi);
  return s.expandDimension ? `${kpi} by ${humanizeField(s.expandDimension)}` : kpi;
}

/** The trailing segment of a dotted class name (SC.Data.Product → Product). */
function shortName(className: string): string {
  const parts = className.split('.');
  return parts[parts.length - 1] || className;
}
