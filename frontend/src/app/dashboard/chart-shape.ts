// frontend/src/app/dashboard/chart-shape.ts
import { humanizeField, humanizeCubeName } from './humanize';
import type { ChartData, ChartSpecResponse, ChartableCube } from './services/dashboard-chart.service';

/**
 * The pure, component-free shape/label helpers for dashboard charting. Extracted
 * from chart-panel.ts so the view tiles and builders can share them without
 * importing a 591-line component (spec §11). Bodies are unchanged from the panel;
 * nothing is re-derived (National-Park). Source-agnostic: they read only the
 * ChartData / cube-shape shapes, so they hold for a cube crossjoin and a KPI
 * breakdown alike.
 */

/** A cube can be charted only with BOTH a measure to plot and a dimension to break it down by. */
export function isCubeChartable(c: Pick<ChartableCube, 'measureCount' | 'dimensionCount'>): boolean {
  return c.measureCount > 0 && c.dimensionCount > 0;
}

/**
 * True when a ChartData carries at least one real number to plot. A cube that has
 * structure but zero fact rows (e.g. SC's IssueCube) still returns a well-formed,
 * successful ChartData — categories may be present (dimension members) but every
 * cell is `null`. That is not an error and not "unchartable" (the shape is fine);
 * it is simply nothing to draw. `null` is a first-class gap in this contract, and
 * `0` is real data — so the test is "any cell is a number", not "any cell is
 * truthy". Source-agnostic: it reads only the ChartData shape, so it holds for a
 * cube crossjoin and a KPI breakdown alike.
 */
export function hasPlottableData(data: ChartData): boolean {
  if (data.categories.length === 0 || data.series.length === 0) return false;
  return data.series.some((s) => s.data.some((v) => typeof v === 'number'));
}

/**
 * The disabled-option label for a non-chartable cube: its name plus the specific
 * reason derived from the counts, mirroring the Source dropdown's "(coming soon)"
 * honesty. Pure — the template calls it declaratively.
 */
export function disabledCubeLabel(c: Pick<ChartableCube, 'cubeName' | 'measureCount' | 'dimensionCount'>): string {
  const name = humanizeCubeName(c.cubeName);
  // Plain plural on both nouns for a clean read. When BOTH are missing, name only
  // "no measures": no measures is the binding reason (a cube cannot chart without one,
  // dimensions present or not), and the shorter label saves dropdown width — Karsten's steer.
  if (c.dimensionCount === 0 && c.measureCount > 0) return `${name} (no dimensions)`;
  return `${name} (no measures)`;
}

/**
 * The name of the split dimension when a "Split by" selection collapsed to a single
 * series, or null. A series is one distinct MEMBER-VALUE of the split dimension, not
 * the field itself — so splitting by a dimension that has one member in the data (e.g.
 * an unpopulated `inventoryType` whose only value is `<null>`) yields a single series,
 * not a breakdown. The chart is still valid, but no series-only types (stacked, sunburst,
 * nested treemap, heatmap) unlock — which reads as "nothing happened." Naming the
 * dimension lets the panel explain WHY, instead of a silent no-change. Pure; the template
 * calls it declaratively. Null when no split was requested or the split gave ≥2 series.
 */
/** A dimension as the shape carries it — a name, its analytic kind, and its full level list (B-CUBE-15). */
export interface ShapeDimension { name: string; kind: string; levels: { name: string; caption?: string; spec: string }[] }
/** A selectable level within a dimension: the display label and the MDX level spec (the <option> VALUE). */
export interface LevelOption { name: string; label: string; spec: string }
/** A dimension as an <optgroup>: the dimension label + kind, and its levels as <option>s. */
export interface DimensionLevelGroup { dimension: string; label: string; kind: string; levels: LevelOption[] }

/**
 * The text shown for a measure option: its caption when the cube provides one, else the
 * humanized field name. This is BOTH the display string and the alpha-sort key, so the
 * dropdown reads in the order the eye expects (`sortedMeasures`). Pure.
 */
export function measureLabel(m: { name: string; caption?: string }): string {
  return m.caption || humanizeField(m.name);
}

/**
 * Group a shape's dimensions into level-option optgroups for the Category / Series / Filter
 * dropdowns (B-CUBE-15). Each dimension is one <optgroup> (its humanized name as the label);
 * each of its levels is an <option> whose VALUE is the level's MDX spec ([dim].[hier].[level]).
 * Dimensions appear in shape (catalog) order; levels appear in catalog order WITHIN a dimension
 * (NOT alpha-sorted — a hierarchy reads top-down: Country ▸ Region ▸ Customer Name). A level's
 * label is its caption, else the humanized level name. A dimension with no resolvable level
 * (empty levels[]) is omitted — it has no spec to select. This REPLACES dimensionsByKind for these
 * dropdowns (spec §7): the grouping axis is the DIMENSION, not the kind; `kind` still rides each
 * group so chart-type inference (bar vs line) is unchanged. Pure.
 */
export function dimensionLevelGroups(dimensions: readonly ShapeDimension[]): DimensionLevelGroup[] {
  const groups: DimensionLevelGroup[] = [];
  for (const d of dimensions) {
    if (!d.levels || d.levels.length === 0) continue;
    groups.push({
      dimension: d.name,
      label: humanizeField(d.name),
      kind: d.kind,
      levels: d.levels.map((l) => ({ name: l.name, label: l.caption || humanizeField(l.name), spec: l.spec })),
    });
  }
  return groups;
}

export function seriesCollapsed(data: ChartData): string | null {
  const dim = data.meta.seriesDimensionName;
  if (!dim) return null;                 // no split requested — single-dimension view
  if (data.series.length >= 2) return null; // a real breakdown — nothing to explain
  return dim;
}

/** One entry in the nested-treemap branch key: a row member and the hue its tile is drawn in. */
export interface TreemapBranchSwatch {
  label: string;
  color: string;
}

/**
 * The branch colour-key for a NESTED treemap, or null when no strip is warranted.
 *
 * A sunburst labels its centre ring, so the branch (first-dimension) members read
 * straight off the chart — but a nested treemap labels only its leaf tiles, and the
 * squarified layout scatters the branches (one branch is a full-height column, the
 * next two stack in the remaining corner), so an on-tile header would land
 * unpredictably. Instead we render a small key below the chart naming each branch in
 * its tile hue — the same read the sunburst centre gives, in the one place a treemap
 * can show it reliably. The user's ask ("show it below, like the column-chart legend").
 *
 * The swatch colour is read off the RENDERED spec's own palette (`spec.colors`), the
 * exact array Highcharts cycles over the level-1 branches via `colorByPoint` in data
 * order — so branch i is drawn in `colors[i % colors.length]` and a swatch can never
 * drift from its tile. Re-declaring the palette here would be a second source of truth
 * that a backend palette change would silently desync.
 *
 * Null (no strip) when: no spec/data yet; the rendered type is not a treemap (a
 * sunburst self-labels, a bar/line has a real legend); the treemap is FLAT — a single
 * series with no split — because each tile is then its own labelled category; the split
 * collapsed to one series (no branches to key); or the spec carries no palette to read.
 */
export function treemapBranchKey(spec: ChartSpecResponse | null, data: ChartData | null): TreemapBranchSwatch[] | null {
  if (!spec || !data) return null;
  if (spec.type !== 'treemap') return null;            // sunburst self-labels; only treemap needs it
  if (!data.meta.seriesDimensionName || data.series.length < 2) return null; // flat/collapsed → tiles self-label
  const colors = (spec.spec as { colors?: unknown })?.['colors'];
  if (!Array.isArray(colors) || colors.length === 0) return null;
  const palette = colors as string[];
  return data.categories.map((label, i) => ({ label, color: palette[i % palette.length]! }));
}
