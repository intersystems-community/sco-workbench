import type { TileConfig, TileLayout } from './dashboard-config';

/**
 * Pure drag geometry for the dashboard grid — framework-free, exhaustively
 * unit-tested (the deterministic heart of live reflow + resize snapping; the
 * jsdom-invisible pointer animation is proven in the live render). Sibling of
 * dashboard-state.ts / page-state.ts.
 */

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(Math.round(v), hi));

/** The order tiles render in mid-drag: `draggedId` removed and re-inserted at `overIndex` (clamped). */
export function previewOrder(tiles: TileConfig[], draggedId: string, overIndex: number): TileConfig[] {
  const from = tiles.findIndex((t) => t.id === draggedId);
  if (from < 0) return tiles.slice(); // unknown id → unchanged order
  const to = Math.max(0, Math.min(overIndex, tiles.length - 1));
  const out = tiles.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/**
 * The nearest discrete span for a resize gesture. `px`/`py` are the pointer's
 * offset from the tile's top-left; `cellW`/`cellH` are the MEASURED unit-cell
 * size (never the 360px constant — columns grow with 1fr above the floor);
 * `gap` is the inter-cell gap. One unit = cell + gap, so N cells span
 * N*cell + (N-1)*gap; dividing (px + gap) by (cell + gap) rounds to N.
 */
export function snapSpan(px: number, py: number, cellW: number, cellH: number, gap: number): TileLayout {
  const w = clampInt((px + gap) / (cellW + gap), 1, 3) as 1 | 2 | 3;
  const h = clampInt((py + gap) / (cellH + gap), 1, 2) as 1 | 2;
  return { w, h };
}
