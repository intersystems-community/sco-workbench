// frontend/src/app/dashboard/echarts-setup.ts
import * as echarts from 'echarts/core';
import { BarChart, PieChart, LineChart, ScatterChart, GaugeChart, HeatmapChart, RadarChart, TreemapChart, SunburstChart, FunnelChart, SankeyChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent, MarkLineComponent, MarkAreaComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
// Only the modules the 22 chart types need — tree-shaken, so the bundle carries the used chart +
// component set, not all of ECharts. Record the bundle delta in the findings write-up.
//   Series: BarChart draws bar/column/stackedColumn/stackedColumn100/divergingBar/bullet
//   (orientation + stacking are options, not distinct chart types; a bullet is a horizontal bar
//   with mark bands); LineChart draws line/area/stackedArea/slope (area = line + areaStyle);
//   ScatterChart draws scatter + the dumbbell endpoints; PieChart draws pie; FunnelChart draws
//   funnel; GaugeChart the solidgauge; HeatmapChart the heatmap; RadarChart the radar (it bundles
//   its own radar coordinate system — there is no separate RadarComponent); TreemapChart +
//   SunburstChart the two hierarchies; SankeyChart the sankey (flow) diagram — it bundles its own
//   sankey layout, so there is no separate coordinate-system component to register.
//   Components: Grid (cartesian axes), Legend, Title, Tooltip (round-1); VisualMap is the
//   heatmap's continuous colour scale; MarkLine + MarkArea are the marks the two Tier-4 dialect
//   seams draw declaratively — divergingBar's zero baseline + the dumbbell connectors + bullet's
//   target line (MarkLine), and bullet's quality bands (MarkArea). A missing mark component is
//   SILENT (the series still resolves), so the FE geometry probe asserts the rendered mark.
//
// SVG (not Canvas) renderer — a deliberate spike finding. ECharts' CanvasRenderer needs a real
// 2D canvas context, which jsdom does not provide, so it crashes on init/dispose under the unit
// tier and cannot be browserlessly probed. SVGRenderer resolves under jsdom (same as Highcharts,
// which is SVG here) and is fully production-viable for dashboard-scale data — a handful of series
// per tile, where SVG's per-node cost is irrelevant. This makes the adapter unit-testable AND
// keeps the app's renderer story uniform (both libraries emit SVG). See the Task-10 findings.
echarts.use([
  BarChart, PieChart, LineChart, ScatterChart, GaugeChart, HeatmapChart, RadarChart, TreemapChart, SunburstChart, FunnelChart, SankeyChart,
  GridComponent, LegendComponent, TitleComponent, TooltipComponent, VisualMapComponent, MarkLineComponent, MarkAreaComponent,
  SVGRenderer,
]);
export { echarts };

interface Chrome { text: string; axis: string; gridline: string; }
// gridline is one step darker than the axis line: the value-axis dividers (splitLine) are the
// reference lines a reader tracks a value against, so they read crisper than the axis frame.
// Only value axes draw splitLine by default (category axes do not), so this sharpens the
// number dividers without adding separators between bars/categories. (Tuned on review 2026-08-27.)
const CHROME: Chrome = { text: '#1d1d1f', axis: '#e0e0e0', gridline: '#cccccc' };

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isObj(base) || !isObj(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

/** The ECharts chrome (text/axis/gridline colours by theme), merged UNDER the spec so the
 *  data palette (`color`) is never overwritten — the applyChartChrome invariant, ECharts dialect.
 *  Axis chrome is dropped for any axis the spec does not declare (a pie has none). Pure. */
export function applyEChartsChrome(spec: Record<string, unknown>): Record<string, unknown> {
  const c = CHROME;
  const base: Record<string, unknown> = {
    textStyle: { color: c.text },
    title: { textStyle: { color: c.text }, subtextStyle: { color: c.text } },
    legend: { textStyle: { color: c.text } },
    xAxis: { axisLabel: { color: c.text }, nameTextStyle: { color: c.text }, axisLine: { lineStyle: { color: c.axis } }, splitLine: { lineStyle: { color: c.gridline } } },
    yAxis: { axisLabel: { color: c.text }, nameTextStyle: { color: c.text }, axisLine: { lineStyle: { color: c.axis } }, splitLine: { lineStyle: { color: c.gridline } } },
  };
  if (spec['xAxis'] === undefined) delete base['xAxis'];
  if (spec['yAxis'] === undefined) delete base['yAxis'];
  const merged = deepMerge(base, spec) as Record<string, unknown>;
  return themeSeriesInk(themeRadar(merged, c), c);
}

/** The gauge and radar carry their own axis chrome INSIDE the series / a `radar` block, not in the
 *  shared x/y-axis merge above — so a hard-coded grey there is theme-blind (it was unreadable in dark
 *  mode, 2026-08-28 pixel review). These two helpers inject the per-theme ink after the deep-merge:
 *  the spec sets only theme-independent geometry (band width, tick distance), the theme sets colour. */

/** Colour the radar's axis names + split rings/lines for the theme; a radar declares no x/y axis, so
 *  the merge above never reaches it. Also dims ECharts' default opaque grey splitArea rings — they
 *  dominate a dark tile (Highcharts draws none). Only touches a spec that actually has a `radar`. */
function themeRadar(spec: Record<string, unknown>, c: Chrome): Record<string, unknown> {
  if (!isObj(spec['radar'])) return spec;
  const radarInk = {
    axisName: { color: c.text },
    axisLine: { lineStyle: { color: c.axis } },
    splitLine: { lineStyle: { color: c.axis } },
    splitArea: { areaStyle: { color: 'transparent' } },
  };
  return { ...spec, radar: deepMerge(radarInk, spec['radar']) };
}

/** Colour the theme-dependent series text that the deep-merge cannot reach because the `series` array
 *  is replaced wholesale: the gauge scale (axisLabel/detail/title/splitlines) and the pie's direct
 *  pointing labels. The pie label text defaults to the SLICE colour (ECharts `inherit`), unreadable on
 *  the light-palette hues (yellow, light blue) on a light tile and against the "text wears text ink,
 *  not the series colour" rule — so its text takes the theme ink, while the leader LINE keeps the slice
 *  colour so it still ties each label to its wedge. Non-gauge/non-pie series pass through untouched. */
function themeSeriesInk(spec: Record<string, unknown>, c: Chrome): Record<string, unknown> {
  if (!Array.isArray(spec['series'])) return spec;
  const series = (spec['series'] as unknown[]).map((s) => {
    if (isObj(s) && s['type'] === 'pie') return deepMerge({ label: { color: c.text } }, s);
    // A sankey's node labels sit on the tile background, so they wear the theme text ink (not the node's
    // palette hue). The ribbon lineStyle gradient is left alone — it tints between endpoint hues, which
    // carries the flow direction. Mirrors the pie branch; deepMerge(ink, s) lets backend label.show survive.
    if (isObj(s) && s['type'] === 'sankey') return deepMerge({ label: { color: c.text } }, s);
    // A bubble-matrix's value numbers sit BELOW each dot on the tile background, so they wear the theme
    // text ink (not the dot's visualMap hue, which vanishes on the light-blue low cells / dark tile).
    if (isObj(s) && s['bubbleMatrix'] === true) return deepMerge({ label: { color: c.text } }, s);
    if (!isObj(s) || s['type'] !== 'gauge') return s;
    const axisLine = s['axisLine'];
    // The target tick is the one gauge layer with axisLine.show:false. Its dashed splitLine takes the
    // INK colour (a reference mark reads like text), NOT the axis grey the scale splitlines take. The
    // series wins the merge, so the backend's dashed `type`/`width` geometry survives.
    const isTargetTick = isObj(axisLine) && axisLine['show'] === false;
    const gaugeInk = isTargetTick
      ? { splitLine: { lineStyle: { color: c.text } } }
      : { axisLabel: { color: c.text }, splitLine: { lineStyle: { color: c.axis } }, detail: { color: c.text }, title: { color: c.text } };
    return deepMerge(gaugeInk, s);
  });
  return { ...spec, series };
}

// The gauge's decorations (center value, scale numbers + their inward offset, splitline + band
// widths) are ABSOLUTE PIXELS tuned for a large radius, but the backend emits `radius:'100%'`, which
// ECharts resolves to `min(width,height)/2`. A half-gauge (startAngle 180→0) is 2R WIDE but only R
// TALL, so on a short/wide tile the arc is HEIGHT-limited — R = min(w,h)/2 leaves the arc small with
// dead space to the sides, and the fixed 48px-inward scale numbers then collapse onto the big center
// value (the collision Karsten saw on the 1×1 tile: box 406×288 → R=144, ~86px dead above). A PORTRAIT
// tile is width-limited, so the same gauge fills sideways (R≈203) and the scale clears — his own
// observation. Attempt 1 shrank the fonts and hid the scale but NEVER touched `radius`, so it treated
// the symptom, not the cause. The real fix: size the radius to fill the WIDTH (R = min(width/2,
// center-y)), so every tile reaches the portrait's readable radius; then scale the pixel decorations
// off the ACHIEVED radius (not the box), so a full-size arc keeps the full tuned fonts and only a
// genuinely tiny arc shrinks/drops the scale. Fonts can't be `%` and the backend spec is static JSON,
// so this box-aware sizing can only happen here, where the rendered pixel box is known.
const GAUGE_REF_RADIUS_PX = 200;    // radius the tuned pixel decorations were sized for (≈ the portrait
                                    // tile that reads correctly); at/above this k=1 and fonts stay full
const GAUGE_SCALE_HIDE_RADIUS_PX = 120; // below this arc radius the speedometer scale (numbers +
                                        // splitlines) can't clear the center value → drop it; a clean
                                        // arc + value + label reads better small than an overlap
const GAUGE_CENTER_Y_DEFAULT = 0.8;  // matches the backend gauge center ['50%','80%']
// A half-gauge sized to width/2 spans 2R = the full box width, so its arc KISSES both tile borders
// (Karsten 2026-09-18: "should not touch the sides … like the adjacent sankey"). Reserve a horizontal
// margin by pulling the DRAWN radius in from the reference radius by this fraction, so the arc clears
// the edges. The reserve is applied to the RADIUS only — the pixel decorations (fonts, scale) still
// scale off the FULL reference radius R below, so the flagship 1×1 tile keeps its full-size scale and
// only the arc pulls in. (A sankey gets its side gap from ECharts' native layout; the gauge has none.)
const GAUGE_SIDE_MARGIN_FRACTION = 0.12;
const GAUGE_DETAIL_MIN = 16, GAUGE_TITLE_MIN = 11, GAUGE_LABEL_MIN = 9;

// The gauge center-y as a fraction of the box height — read from the series' `center:[x,'80%']` so a
// re-tuned center stays in sync, defaulting to the backend's 0.8. Governs the vertical radius budget.
function gaugeCenterYFraction(s: Record<string, unknown>): number {
  const center = s['center'];
  if (Array.isArray(center) && typeof center[1] === 'string') {
    const pct = parseFloat(center[1]);
    if (Number.isFinite(pct)) return pct / 100;
  }
  return GAUGE_CENTER_Y_DEFAULT;
}

// The layer's declared radius as a fraction (`'100%'` → 1.0, `'86%'` → 0.86). A numeric radius is
// already resolved (or absent) → null, and the layer's radius is left untouched.
function radiusFraction(radius: unknown): number | null {
  if (typeof radius === 'string' && radius.trim().endsWith('%')) {
    const pct = parseFloat(radius);
    if (Number.isFinite(pct)) return pct / 100;
  }
  return null;
}

// The layer's own declared axisLine width, if any — scaled per-layer so a thin ring and thick fill
// stay distinct. A layer that declares none (the target tick, axisLine.show:false) returns null.
function declaredAxisLineWidth(s: Record<string, unknown>): number | null {
  const al = s['axisLine'];
  if (isObj(al) && isObj(al['lineStyle']) && typeof al['lineStyle']['width'] === 'number') return al['lineStyle']['width'] as number;
  return null;
}

/** Size a gauge series' arc to fill its rendered box (radius by WIDTH, not the height-limited min-dim),
 *  and scale its pixel decorations to the achieved radius — dropping the speedometer scale only when
 *  the arc is genuinely too small to read it without colliding with the center value. Pure; the arc
 *  never grows past the tuned reference radius' fonts (scales DOWN only); a non-gauge spec or an
 *  unsized box (jsdom 0×0) is returned untouched, so the theme-neutral spec and the unit tier are
 *  unaffected. Applied AFTER theming, so the injected ink + the two-stop arc colour survive the merge. */
// A bubble-heatmap's dot must fill its GRID CELL, not a fixed pixel: the backend can only emit a
// √-area size off a constant BUBBLE_MAX_PX (60), which overflows a small dashboard cell (the dots
// "collapse onto each other") and underfills the wide zoom cell (the biggest bubble stays small,
// shrinking every other). Cell pitch = box / category-count is known ONLY once laid out, so — like
// the gauge — the real sizing happens here. We size the LARGEST value to fill a fraction of the cell
// and scale the rest by √(v/max) so encoded AREA stays proportional (Kirk area-honesty preserved).
const BUBBLE_MATRIX_MIN_PX = 8;   // legibility floor, matches the backend fallback
const BUBBLE_MATRIX_CELL_FILL = 0.82; // largest dot diameter as a fraction of the smaller cell pitch,
                                      // leaving a gap so adjacent max-cells don't touch + room for the label
// Below this x-cell pitch a compact value label ("170.1M", ~40px wide + a gap) cannot clear its
// neighbour, so on a small tile every label collides into an unreadable run ("170.1M108.2M46.2M…")
// — hideOverlap alone does not thin a grid this tight. Drop the labels there (the bubble SIZE + the
// visualMap COLOUR still encode the value, and the number stays on hover + in the zoom view — the
// "additional information" the zoom is for). Mirrors the gauge dropping its speedometer scale below
// a radius threshold. The threshold is on the CONSERVATIVE plot-width estimate below, which runs a
// touch wide of the real cell, so it clears the collision on a 1× tile and keeps labels in the zoom.
const BUBBLE_MATRIX_LABEL_MIN_CELL_PX = 70;

/** Re-size a bubble-matrix scatter series (marked `bubbleMatrix:true`) so its largest bubble fills its
 *  actual rendered grid cell and the rest scale area-honestly beneath it. Reads the pixel cell pitch
 *  from the two category-axis counts and the rendered box; pure; a non-bubble-matrix spec or an unsized
 *  box (jsdom 0×0) is returned untouched (the backend √-area fallback then stands). Applied after the
 *  gauge sizer, over the SAME rendered dimensions. */
export function scaleBubbleMatrixToBox(spec: Record<string, unknown>, width: number, height: number): Record<string, unknown> {
  if (!Array.isArray(spec['series'])) return spec;
  if (!(width > 0 && height > 0)) return spec;
  const xCount = Array.isArray(isObj(spec['xAxis']) ? spec['xAxis']['data'] : undefined) ? (spec['xAxis'] as Record<string, unknown>)['data'] as unknown[] : null;
  const yCount = Array.isArray(isObj(spec['yAxis']) ? spec['yAxis']['data'] : undefined) ? (spec['yAxis'] as Record<string, unknown>)['data'] as unknown[] : null;
  if (!xCount?.length || !yCount?.length) return spec;
  // The plot area is the box minus rough axis-gutter + title/label margins; ECharts' grid default is
  // ~10%/10% each side plus ~60px left / ~40px bottom for category labels. Approximate conservatively
  // so the dot never spills its cell: take 78% of each dimension as usable plot, then divide by count.
  const plotW = width * 0.78, plotH = height * 0.72;
  const xCellPitch = plotW / xCount.length; // labels stack HORIZONTALLY, so the x pitch governs collision
  const cellPitch = Math.min(xCellPitch, plotH / yCount.length);
  const maxDiameter = Math.max(BUBBLE_MATRIX_MIN_PX, cellPitch * BUBBLE_MATRIX_CELL_FILL);
  // Show the per-bubble value labels only when the cell is wide enough to hold one; below that they
  // collide into an unreadable run, so drop them (size + colour still encode the value; the number
  // stays on hover + in the zoom view). Per-datum label.show OVERRIDES the series, so both are set.
  const showLabels = xCellPitch >= BUBBLE_MATRIX_LABEL_MIN_CELL_PX;
  const series = (spec['series'] as unknown[]).map((s) => {
    if (!isObj(s) || s['bubbleMatrix'] !== true || !Array.isArray(s['data'])) return s;
    // Largest value in the series → fills maxDiameter; every other dot = maxDiameter·√(v/maxV), floored.
    let maxV = 0;
    for (const d of s['data'] as unknown[]) {
      const v = isObj(d) && Array.isArray(d['value']) ? d['value'][2] : undefined;
      if (typeof v === 'number' && v > maxV) maxV = v;
    }
    const mv = maxV > 0 ? maxV : 1;
    const data = (s['data'] as unknown[]).map((d) => {
      if (!isObj(d) || !Array.isArray(d['value'])) return d;
      const v = d['value'][2];
      const size = typeof v !== 'number'
        ? BUBBLE_MATRIX_MIN_PX
        : Math.max(BUBBLE_MATRIX_MIN_PX, maxDiameter * Math.sqrt(Math.max(0, v) / mv));
      // Only touch label.show when the datum carries a label (a non-null cell); a null cell has none.
      const label = isObj(d['label']) ? { label: { ...(d['label'] as Record<string, unknown>), show: showLabels } } : {};
      return { ...d, symbolSize: size, ...label };
    });
    return { ...s, data, label: { ...(isObj(s['label']) ? s['label'] : {}), show: showLabels } };
  });
  return { ...spec, series };
}

export function scaleGaugeToBox(spec: Record<string, unknown>, width: number, height: number): Record<string, unknown> {
  if (!Array.isArray(spec['series'])) return spec;
  if (!(width > 0 && height > 0)) return spec; // unsized host (jsdom, or pre-layout) — leave spec intact
  const series = (spec['series'] as unknown[]).map((s) => {
    if (!isObj(s) || s['type'] !== 'gauge') return s;
    // The box-derived reference radius (what a '100%' layer fills to); cap so the arc top never clips
    // above the box. k + showScale key on this reference, so a single-arc gauge behaves as before.
    const R = Math.round(Math.min(width / 2, gaugeCenterYFraction(s) * height));
    const k = Math.min(1, R / GAUGE_REF_RADIUS_PX);
    const showScale = R >= GAUGE_SCALE_HIDE_RADIUS_PX;
    const r = (base: number, min = 0) => Math.max(min, Math.round(base * k));
    const over: Record<string, unknown> = {};
    // The DRAWN radius pulls in from R by the reserved side margin so the arc clears the tile edges;
    // k/showScale/fonts stay keyed off the FULL R (only the arc geometry insets, not the decorations).
    const Rdrawn = Math.round(R * (1 - GAUGE_SIDE_MARGIN_FRACTION));
    // Radius: scale by the layer's OWN declared fraction (ring 100% → Rdrawn, fill 86% → 0.86·Rdrawn).
    const f = radiusFraction(s['radius']);
    if (f != null) over['radius'] = Math.round(f * Rdrawn);
    // axisLine width: scale the layer's OWN declared width by k (NOT a constant r(40)) so the thin
    // ring and thick fill stay distinct; a layer that declares no width (the tick) gets none.
    const w = declaredAxisLineWidth(s);
    if (w != null) over['axisLine'] = { lineStyle: { width: r(w) } };
    // Scale the centre readout + label on ANY layer that draws them — the fill / single-arc (half-circle)
    // AND the percentage ring (whose axisLabel is off). Behaviour-identical for the half-circle: its fill
    // layer has both a detail and axisLabel.show===true, so both blocks run exactly as before.
    const drawsReadout = isObj(s['detail']) ? s['detail']['show'] !== false : false;
    if (drawsReadout) {
      over['detail'] = { fontSize: r(42, GAUGE_DETAIL_MIN) };
      over['title'] = { fontSize: r(13, GAUGE_TITLE_MIN) };
    }
    // Scale the speedometer furniture ONLY on the scale-bearing layer (axisLabel.show:true) — never a
    // ring's or tick's declared show:false.
    if (isObj(s['axisLabel']) && s['axisLabel']['show'] === true) {
      // ECharts renders each scale number at radial `radius - splitLine.length - axisLabel.distance`
      // from the centre (GaugeView _renderTicks). The arc now draws at the INSET Rdrawn, but the centre
      // value keeps its full-size font, so a fixed distance drags the numbers inward by the inset delta
      // ONTO the value (Karsten 2026-09-21). Pull `distance` in by that same delta (f·(R−Rdrawn)) so the
      // numbers keep the pre-inset radial position (R−splitLen−48) and clear the value; the arc still
      // insets from the edges. f==null (a numeric radius we didn't rescale) → no inset → no compensation.
      const insetDelta = f != null ? Math.round(f * (R - Rdrawn)) : 0;
      over['splitLine'] = { show: showScale, length: r(40) };
      over['axisLabel'] = { show: showScale, distance: Math.max(0, r(48) - insetDelta), fontSize: r(11, GAUGE_LABEL_MIN) };
    }
    return deepMerge(s, over);
  });
  return { ...spec, series };
}
