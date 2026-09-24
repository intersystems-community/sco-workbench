import { TestBed } from '@angular/core/testing';
import { EChartsChartViewComponent } from './echarts-chart-view';
import { EChartsSpecBuilder } from '../../../../backend/src/dashboard/echarts-spec-builder';
import type { ChartData, ChartType } from '../../../../backend/src/dashboard/chart-data';

const b = new EChartsSpecBuilder();
const oneSeries: ChartData = { categories: ['Normal', 'AboveMaximum'], series: [{ name: 'Count', data: [360, 165] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Count', categoryLabel: 'Region' } };
const seriesData: ChartData = { categories: ['North', 'South'], series: [{ name: '24', data: [10, 20] }, { name: '25', data: [12, 18] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Year', valueLabel: 'Rev', categoryLabel: 'Region', seriesShown: 2, seriesTotal: 2, seriesTruncated: false } };
const scalar: ChartData = { categories: [], series: [{ name: 'Count', data: [42] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Count' } };
const negCats: ChartData = { categories: ['A', 'B', 'C'], series: [{ name: 'Delta', data: [4, -2, 6] }], meta: { truncated: false, shown: 3, dimensionKind: 'categorical', valueLabel: 'Delta', categoryLabel: 'Item' } };
const twoCats: ChartData = { categories: ['Before', 'After'], series: [{ name: 'A', data: [3, 8] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', valueLabel: 'Score', categoryLabel: 'Phase' } };
const bulletData: ChartData = { categories: [], series: [{ name: 'Late', data: [7] }], meta: { truncated: false, shown: 1, dimensionKind: 'scalar', valueLabel: 'Late Orders', target: 5, bands: [{ to: 5, kind: 'ok' }, { to: 10, kind: 'watching' }, { to: Infinity, kind: 'warning' }] } };
const sankeyMatrix: ChartData = { categories: ['USA', 'DEU'], series: [{ name: 'Closed', data: [170, 31] }, { name: 'Open', data: [10, 3] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Order Status', valueLabel: 'Total Order Value', categoryLabel: 'Customer Country', seriesShown: 2, seriesTotal: 2, seriesTruncated: false } };

async function mount(spec: Record<string, unknown>) {
  const f = TestBed.createComponent(EChartsChartViewComponent);
  f.componentRef.setInput('spec', spec);
  f.detectChanges();
  await f.whenStable();
  f.componentInstance.chartInstance()?.resize({ width: 400, height: 300 }); // size the instance so geometry lays out (jsdom host is 0x0)
  await f.whenStable();
  return f;
}

// The serialized SVG the ECharts SVGRenderer emits under the host, lowercased. A geometry/colour
// search runs case-insensitively over this (verified this cycle that ECharts 6.1.0's SVGRenderer
// writes the injected band/mark colours as literal hex).
function svgMarkup(f: any): string {
  const svg = (f.nativeElement as HTMLElement).querySelector('svg');
  return (svg?.outerHTML ?? '').toLowerCase();
}
function nonEmptyPaths(f: any): number {
  const svg = (f.nativeElement as HTMLElement).querySelector('svg');
  return [...(svg?.querySelectorAll('path') ?? [])].filter((p) => (p.getAttribute('d') ?? '').trim().length > 0).length;
}

describe('echarts-chart-view — the builder output resolves the expected series type', () => {
  afterEach(() => TestBed.resetTestingModule());
  // All 18 families feed the live ECharts view under jsdom, so the module set in echarts-setup is
  // verified end-to-end. The probe is three-part: a missing SERIES module renders no series and
  // getOption would not resolve the expected type; an unsized host renders at 0x0 (path `d` is
  // non-empty even then, so size is asserted separately); a missing MARK component (MarkArea/
  // MarkLine) leaves the mark silently absent (dedicated probes below). The expected ECharts
  // series token per family: bar/column/stackedColumn/stackedColumn100/divergingBar → 'bar',
  // line/area/stackedArea/slope → 'line', scatter/dumbbell → 'scatter', pie → 'pie', and the
  // round-2 natives resolve to their own token (gauge/heatmap/radar/treemap/sunburst/bar-for-bullet).
  const cases: [string, ChartData, ChartType, string][] = [
    ['bar', oneSeries, 'bar', 'bar'], ['column', oneSeries, 'column', 'bar'],
    ['line', seriesData, 'line', 'line'], ['area', oneSeries, 'area', 'line'],
    ['scatter', oneSeries, 'scatter', 'scatter'], ['pie', oneSeries, 'pie', 'pie'],
    ['stackedColumn', seriesData, 'stackedColumn', 'bar'], ['stackedArea', seriesData, 'stackedArea', 'line'],
    ['stackedColumn100', seriesData, 'stackedColumn100', 'bar'],
    ['solidgauge', scalar, 'solidgauge', 'gauge'], ['heatmap', seriesData, 'heatmap', 'heatmap'],
    ['radar', negCats, 'radar', 'radar'], ['treemap', oneSeries, 'treemap', 'treemap'],
    ['treemap-nested', seriesData, 'treemap', 'treemap'], ['sunburst', seriesData, 'sunburst', 'sunburst'],
    ['dumbbell', seriesData, 'dumbbell', 'scatter'], // first series resolves to scatter
    ['divergingBar', negCats, 'divergingBar', 'bar'], ['slope', twoCats, 'slope', 'line'],
    ['bullet', bulletData, 'bullet', 'bar'], // horizontal bar carries the markArea bands + markLine target
    ['sankey', sankeyMatrix, 'sankey', 'sankey'], // native sankey series; a missing SankeyChart module renders nothing
  ];
  for (const [label, data, type, expected] of cases) {
    it(`${label}: renders non-zero-size geometry and resolves series type '${expected}'`, async () => {
      const f = await mount(b.build(data, type) as Record<string, unknown>);
      const inst = f.componentInstance.chartInstance()!;
      expect(inst.getWidth()).toBeGreaterThan(0);   // unsized-host catch (path d is non-empty even at 0x0)
      expect(inst.getHeight()).toBeGreaterThan(0);
      const opt = inst.getOption() as any;
      expect(opt.series[0].type).toBe(expected);    // missing-series-module catch
      expect(nonEmptyPaths(f)).toBeGreaterThan(0);  // real geometry rendered
    });
  }

  // Mark-geometry probes — the ONLY signal that catches a missing MarkArea/MarkLine component
  // (the series type still resolves without it). A case-insensitive search of the serialized SVG
  // for the injected mark colour, grounded in this cycle's verified ECharts 6.1.0 SVG output.
  it('divergingBar renders its zero-baseline mark (catches a missing MarkLineComponent)', async () => {
    const f = await mount(b.build(negCats, 'divergingBar') as Record<string, unknown>);
    expect(svgMarkup(f)).toContain('#000000'); // the markLine baseline colour, present only if MarkLine registered
  });
  it('bullet renders its band fills + target line (catches a missing MarkArea/MarkLine component)', async () => {
    const f = await mount(b.build(bulletData, 'bullet') as Record<string, unknown>);
    const svg = svgMarkup(f);
    expect(svg).toContain('#009e73'); // BAND_COLORS.ok band fill  (search lowercased → tolerant of SVG case)
    expect(svg).toContain('#e69f00'); // BAND_COLORS.watching
    expect(svg).toContain('#d55e00'); // BAND_COLORS.warning → MarkArea registered
  });

  it('a gauge on a small tile box drops the speedometer scale (box-aware scaling, through the leaf)', async () => {
    // Reproduces the on-tile collision (the ECharts gauge decorations are absolute pixels; the arc
    // is radius:100%). The leaf scales them to the RENDERED box: shrink to a tile-sized box and
    // re-render (a resize re-runs the render effect, which reads getWidth/getHeight).
    const f = await mount(b.build(scalar, 'solidgauge') as Record<string, unknown>);
    const inst = f.componentInstance.chartInstance()!;
    inst.resize({ width: 200, height: 200 }); // min-dim 200 < the 260 hide threshold
    f.detectChanges();
    await f.whenStable();
    const s = (inst.getOption() as any).series[0];
    expect(s.axisLabel.show).toBe(false);         // scale numbers hidden — no overlap with the value
    expect(s.splitLine.show).toBe(false);
    expect(s.detail.fontSize).toBeLessThan(42);    // center value shrunk to the box
  });

  it('a gauge on a large box keeps the full speedometer scale', async () => {
    const spec = b.build(scalar, 'solidgauge') as Record<string, unknown>;
    const f = await mount(spec);
    const inst = f.componentInstance.chartInstance()!;
    inst.resize({ width: 600, height: 500 });
    f.componentRef.setInput('spec', { ...spec }); // force effect re-run
    f.detectChanges();
    await f.whenStable();
    const s = (inst.getOption() as any).series[0];
    expect(s.axisLabel.show).toBe(true);
    expect(s.splitLine.show).toBe(true);
  });

  it('theming sets themed text colour under light without overwriting the data palette', async () => {
    const f = await mount(b.build(oneSeries, 'bar') as Record<string, unknown>);
    const opt = f.componentInstance.chartInstance()?.getOption() as any;
    expect(opt.color).toBeDefined();                 // Okabe-Ito palette survives
    expect(opt.textStyle[0]?.color ?? opt.textStyle.color).toBe('#1d1d1f'); // light text merged in
  });

  it('the adapter tooltip config survives into the live ECharts instance (hover parity is on)', async () => {
    // Highcharts ships hover on; the ECharts adapter opts in explicitly. Confirm the live
    // instance accepts and resolves the axis tooltip (getOption normalizes it to an array).
    const f = await mount(b.build(oneSeries, 'bar') as Record<string, unknown>);
    const opt = f.componentInstance.chartInstance()?.getOption() as any;
    const tt = Array.isArray(opt.tooltip) ? opt.tooltip[0] : opt.tooltip;
    expect(tt.trigger).toBe('axis');
  });

  // A bubble-heatmap's dots are sized to their GRID CELL by the box-aware leaf (the backend can only
  // emit a fixed-pixel √-area fallback, which collapses on a small tile and underfills a wide one).
  const matrixData: ChartData = { categories: ['A', 'B'], series: [{ name: 'North', data: [1, 4] }, { name: 'South', data: [9, 16] }], meta: { truncated: false, shown: 2, dimensionKind: 'categorical', seriesDimensionName: 'Region' } };
  const maxBubblePx = (inst: any) => Math.max(...(inst.getOption().series[0].data as any[]).map((d) => d.symbolSize));

  it('a bubble-heatmap fills its largest dot to the rendered cell — bigger box → bigger max dot', async () => {
    const spec = b.build(matrixData, 'bubbleHeatmap') as Record<string, unknown>;
    const f = await mount(spec);
    const inst = f.componentInstance.chartInstance()!;
    inst.resize({ width: 300, height: 240 }); f.componentRef.setInput('spec', { ...spec }); f.detectChanges(); await f.whenStable();
    const small = maxBubblePx(inst);
    inst.resize({ width: 900, height: 700 }); f.componentRef.setInput('spec', { ...spec }); f.detectChanges(); await f.whenStable();
    const large = maxBubblePx(inst);
    // The max dot tracks the cell pitch: a 3× box gives a materially larger max dot (not a fixed 60).
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(60); // proves it is NOT clamped to the backend BUBBLE_MAX_PX fallback
  });

  it('bubble-heatmap sizing stays area-honest: dot diameter ∝ √value (size 16 → 4× the √ of size 1)', async () => {
    const spec = b.build(matrixData, 'bubbleHeatmap') as Record<string, unknown>;
    const f = await mount(spec);
    const inst = f.componentInstance.chartInstance()!;
    inst.resize({ width: 800, height: 600 }); f.componentRef.setInput('spec', { ...spec }); f.detectChanges(); await f.whenStable();
    const data = (inst.getOption() as any).series[0].data;
    const byV = (v: number) => data.find((d: any) => d.value[2] === v).symbolSize;
    // √16 / √1 = 4, well above the floor at this box → the ratio is preserved after cell-fill scaling.
    expect(byV(16)).toBeCloseTo(4 * byV(1), 4);
  });

  it("bubble-heatmap value labels take the theme ink (readable on the tile background, both themes)", async () => {
    const spec = b.build(matrixData, 'bubbleHeatmap') as Record<string, unknown>;
    const f = await mount(spec);
    const inst = f.componentInstance.chartInstance()!;
    // Size to a roomy box so the render effect re-runs the box-sizer (labels are shown
    // only when the cell is wide enough; the mount's default box + no re-render would leave them off).
    inst.resize({ width: 800, height: 600 }); f.componentRef.setInput('spec', { ...spec }); f.detectChanges(); await f.whenStable();
    const s = (inst.getOption() as any).series[0];
    expect(s.label.show).toBe(true);
    expect(s.label.color).toBe('#1d1d1f'); // light text ink merged in (not the visualMap dot hue)
  });

  it('bubble-heatmap drops the value labels on a cell too narrow to hold one, and shows them when wide', async () => {
    // The labels ("170.1M" ~40px) collide into an unreadable run when the x-cell is tight — hideOverlap
    // alone does not thin a grid this dense, so the box-sizer drops them below the cell threshold (the
    // size + colour still encode the value; the number stays on hover + in the zoom). Mirrors the gauge.
    const spec = b.build(matrixData, 'bubbleHeatmap') as Record<string, unknown>;
    const f = await mount(spec);
    const inst = f.componentInstance.chartInstance()!;
    inst.resize({ width: 150, height: 150 }); f.componentRef.setInput('spec', { ...spec }); f.detectChanges(); await f.whenStable();
    const small = (inst.getOption() as any).series[0];
    expect(small.label.show).toBe(false);                       // tile too tight → labels dropped
    expect(small.data.every((d: any) => d.label?.show !== true)).toBe(true); // per-datum override cleared too
    inst.resize({ width: 900, height: 600 }); f.componentRef.setInput('spec', { ...spec }); f.detectChanges(); await f.whenStable();
    const large = (inst.getOption() as any).series[0];
    expect(large.label.show).toBe(true);                        // roomy box (zoom) → labels return
    expect(large.data.some((d: any) => d.label?.show === true)).toBe(true);
  });

  it('bareTitle blanks the title TEXT but keeps the SUBTEXT (the truncation disclosure survives on a tile)', async () => {
    const truncated: ChartData = { ...sankeyMatrix, meta: { ...sankeyMatrix.meta, seriesTruncated: true, seriesShown: 8, seriesTotal: 20 } };
    const f = await mount(b.build(truncated, 'sankey') as Record<string, unknown>);
    f.componentRef.setInput('bareTitle', true);
    f.detectChanges();
    await f.whenStable();
    const opt = f.componentInstance.chartInstance()?.getOption() as any;
    const title = Array.isArray(opt.title) ? opt.title[0] : opt.title;
    expect(title.text).toBe('');                               // tile blanks the title text
    expect(title.subtext).toBe('Showing top 8 of 20 targets'); // but the disclosure remains
  });
});
