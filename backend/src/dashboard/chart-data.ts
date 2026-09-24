// backend/src/dashboard/chart-data.ts
// The source-agnostic charting contracts + ports. Types only — no runtime,
// no Express, no IRIS. Every layer above the data core consumes ChartData.

/** The nature of the primary axis, carried from the source (never guessed). */
export type DimensionKind = 'temporal' | 'categorical' | 'scalar';

/** Bounding + axis metadata. `truncated` makes any top-N cap visible, never silent. */
export interface ChartMeta {
  truncated: boolean;
  shown: number;
  total?: number;
  dimensionKind: DimensionKind;
  /**
   * Human labels for titling, carried from the source (never guessed). The pure
   * builder needs these to title truthfully ("Count by Region") because /chart-spec
   * is a transform over the client-held ChartData and cannot re-read the source.
   * Named in CHART vocabulary, not any one source's, because ChartData is the
   * source-agnostic contract: `valueLabel` is what the number means (the value axis
   * / gauge label), `categoryLabel` is what the categories mean (the category axis
   * label). A cube maps measure→value, dimension→category; the D3 KPI source maps
   * KPI-name→value, expand-dimension→category. Both optional so a source with no
   * label still produces valid ChartData.
   */
  valueLabel?: string;
  categoryLabel?: string;
  /**
   * Set when the series are MEMBERS OF ONE DIMENSION (same measure, homogeneous,
   * additive) rather than multiple heterogeneous measures. Its presence is the
   * structural signal that makes part-to-whole real: stacking is honest, and the
   * category × series levels form a hierarchy sunburst / nested-treemap can nest.
   * Absent = today's behaviour (multi-series means multiple measures).
   */
  seriesDimensionName?: string;
  /** Series-axis disclosure — symmetric with the row-axis truncated/shown/total, which
   *  describe the category axis only. Without these a series cap could only be silent. */
  seriesTruncated?: boolean;
  seriesShown?: number;
  seriesTotal?: number;
  /** Bullet side-channel (Class A). `target` is the reference/goal marker; `bands` are
   *  the quality zones, ascending `to`, non-overlapping. Both optional: a source with no
   *  thresholds produces neither and offers no bullet. Populated by the KPI reader. */
  target?: number;
  bands?: { to: number; kind: 'ok' | 'watching' | 'warning' }[];
  /** The unit of the value axis, carried from the source (never guessed). 'percent' means the
   *  values are a 0–100 percentage; a percentage KPI's gauge renders as a full-circle ring capped
   *  at 100. Absent = a plain measure (today's behaviour). Additive-optional, exactly like
   *  target/bands: a non-percentage source omits it and every consumer is byte-identical. A future
   *  cube ratio measure could set it without a schema change. */
  unit?: 'percent';
}

/** One bubble datum: two value-axis coordinates, an optional third value that sizes the dot
 *  (null → the minimum legibility diameter), and an optional label. Populated by the cube bubble
 *  projection; consumed by plan(data,'bubble'). Additive-optional — absent for every other type. */
export interface ChartPoint { x: number; y: number; size: number | null; label?: string }

/**
 * The one structure every source produces and every layer consumes. `null` is a
 * first-class cell value: a missing MDX cell / NULL-under-SUM is `null`, never `0`.
 */
export interface ChartData {
  categories: string[];
  series: { name: string; data: (number | null)[] }[];
  meta: ChartMeta;
  points?: ChartPoint[];
}

/** The chart types any layer may emit — the capability allow-list, as a type. */
export type ChartType =
  | 'bar' | 'column' | 'line' | 'area' | 'pie'
  | 'scatter' | 'heatmap' | 'treemap' | 'dumbbell' | 'solidgauge'
  // chart-type-expansion (2026-08-23): stacked/radar/diverging/slope are flat tokens
  // (no base-type + modifier), so no consumer reasons about type×modifier combos.
  | 'stackedColumn' | 'stackedArea' | 'stackedColumn100'
  | 'radar' | 'divergingBar' | 'slope' | 'bullet' | 'sunburst' | 'bubble' | 'funnel' | 'bubbleHeatmap' | 'sankey';

/** A renderer-specific options object. Opaque to everything but the matching frontend renderer. */
export type RenderSpec = Record<string, unknown>;

/**
 * A per-library spec builder. `supports` is the renderer's capability set; `build` throws
 * BuilderRejection when the DATA cannot draw `type` truthfully (never for an unsupported type —
 * that is the registry's negotiation concern, not the adapter's).
 */
export interface ChartSpecBuilder {
  supports(type: ChartType): boolean;
  build(data: ChartData, type: ChartType, opts?: { funnelSort?: 'value' | 'source' }): RenderSpec;
}

/** Layer-2 advisor output: a chart-TYPE decision only (no built spec — the route builds). */
export interface ChartTypeAdvice {
  type: ChartType;
  fallback: boolean;
  reason?: string;
  /**
   * True ONLY when the LLM itself could not be reached (auth/config/network threw),
   * NOT when it answered unusably. Drives the FE "Ask AI" circuit breaker.
   */
  unavailable?: boolean;
}

/** A measure offered for charting (from the cube shape). */
export interface CubeShapeMeasure { name: string; caption?: string }

/** One selectable level of a dimension (B-CUBE-15): its name, optional caption, and the
 *  full MDX level spec `[dim].[hier].[level]`. The cube query and member reader enumerate
 *  `${spec}.MEMBERS` for the CHOSEN level — never the dimension-wide `[dim].MEMBERS`, which
 *  folds in the `[All]` member and every hierarchy level (double/quadruple-counting a SUM). */
export interface CubeShapeLevel { name: string; caption?: string; spec: string }

/** A dimension offered for charting, tagged with its axis nature. `kind` (temporal drives a
 *  line, categorical a bar) is a DIMENSION property and does NOT vary by level. `levels` is
 *  every hierarchy's every level in catalog order; `levels[0]` is the spec the pre-B-CUBE-15
 *  builder collapsed to. `[]` only when no level resolved — the query/member reader then fall
 *  back to `[dim].MEMBERS` (parallel to the old absent-`memberSpec` path). */
export interface CubeShapeDimension { name: string; kind: DimensionKind; levels: CubeShapeLevel[] }

/** What the builder UI needs to offer choices — measures + charting dimensions. */
export interface CubeShape {
  cube: string;
  measures: CubeShapeMeasure[];
  dimensions: CubeShapeDimension[];
}

/** The role a cube dimension plays in a query: the category axis, the series split, or a pinned filter. */
export type CubeDimensionRole = 'category' | 'series' | 'filter';

/** A dimension carrying its role. `level` (B-CUBE-15) is the chosen level's MDX spec
 *  `[dim].[hier].[level]`, one of that dimension's `levels[].spec`; absent → the dimension's
 *  FIRST level (so every pre-B-CUBE-15 assignment still resolves). `member` is REQUIRED iff
 *  role === 'filter' (the pinned slicer member). */
export interface CubeDimensionAssignment {
  name: string;
  role: CubeDimensionRole;
  level?: string;
  member?: string;
}

/**
 * The general axis-assignment query spec — domain terms only, NO MDX in the signature,
 * validated against CubeShape. `measures` is a list (N series); `dimensions` carry roles
 * (category / series / filter). This is the contract the builder constrains to a chart and
 * a future pivot tile consumes unconstrained; CubeQueryRunner collapses it internally to the
 * proven single-row/single-series/filters shape composeMdx already speaks.
 */
export interface CubeQuerySpec {
  cube: string;
  measures: string[];
  dimensions?: CubeDimensionAssignment[];
  topN?: number;
}

/** Domain terms for a KPI value read — NO scbi params in the signature. */
export interface KpiQuerySpec {
  kpi: string;
  /** A KPI dimension NAME (validated against the KPI's kpiDimensions); absent = scalar. */
  expandDimension?: string;
}

/** Layer 0 ports. */
export interface CubeShapeReader { shape(cube: string): Promise<CubeShape> }
export interface ChartDataSource { query(spec: CubeQuerySpec): Promise<ChartData> }

/** A single member value of a cube dimension, for a filter picker / filter validation.
 *  `key` is the stable MDX `&[key]` identity (from MemberInfo.memberID); absent → name-only. */
export interface CubeMember { name: string; key?: string; caption?: string }
/** Reads a dimension's member VALUES at the CHOSEN level (additivity-safe: one level, no [All]).
 *  `level` is an optional `[dim].[hier].[level]` spec; absent → the dimension's FIRST level.
 *  Lazy — the shape carries level SPECS, not enumerated members. */
export interface CubeMemberReader { members(cube: string, dimension: string, level?: string): Promise<CubeMember[]> }

/** A cube as listed for charting — identity only; measure/dimension counts are resolved separately. */
export interface CubeCatalogEntry {
  cubeName: string;
  className: string;
  sourceClass?: string;
  editable: boolean;
}

/** Lists the cubes defined in the namespace (identity only, no shape). */
export interface CubeCatalog { listCubes(): Promise<CubeCatalogEntry[]> }

/**
 * A cube that can draw a chart. A chart is a measure spread across a dimension,
 * so a chartable cube has BOTH ≥1 measure and ≥1 dimension — a cube with a
 * measure but no dimension can only produce a single scalar (no breakdown to
 * spread across), and a cube with neither (SCO test residue) produces nothing.
 * The counts ride along so the UI can label/order and a future view can group.
 */
export interface ChartableCube extends CubeCatalogEntry {
  measureCount: number;
  dimensionCount: number;
}

export interface ChartSpecAdvisor {
  advise(data: ChartData, prompt?: string): Promise<ChartTypeAdvice>;
}
