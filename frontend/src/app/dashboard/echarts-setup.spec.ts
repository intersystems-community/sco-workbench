import { applyEChartsChrome, scaleGaugeToBox } from './echarts-setup';

// The scale ink for the gauge (inside `series`) and the radar (inside `radar`) is theme-dependent, so
// it lives in the theme merge — NOT hard-coded in the theme-neutral backend spec (a fixed grey was
// unreadable in dark mode, 2026-08-28 pixel review). These tests lock that: the ink follows the theme.
const LIGHT_INK = '#1d1d1f';

describe('applyEChartsChrome — gauge scale ink follows the theme', () => {
  // The minimal gauge spec shape the backend emits (theme-independent geometry only, no colour).
  const gaugeSpec = () => ({
    title: { text: 'Fill Rate %' },
    series: [{
      type: 'gauge', splitNumber: 5,
      axisLabel: { show: true, distance: 48, fontSize: 11 },
      splitLine: { show: true, length: 40 },
      detail: { formatter: '{value}' },
      title: { show: true },
      data: [{ value: 78, name: 'Fill Rate %' }],
    }],
  });

  it('applies light text ink to title / legend / axes', () => {
    const out = applyEChartsChrome({ xAxis: {}, yAxis: {}, series: [] });
    expect((out['textStyle'] as any).color).toBe(LIGHT_INK);
    expect(((out['xAxis'] as any).axisLine.lineStyle.color)).toBe('#e0e0e0');
    expect(((out['yAxis'] as any).splitLine.lineStyle.color)).toBe('#cccccc');
  });

  it('takes no mode argument (light is the only chrome)', () => {
    expect(applyEChartsChrome.length).toBe(1);
  });

  it('light mode: gauge scale ink is the dark-on-light ink', () => {
    const out = applyEChartsChrome(gaugeSpec()) as any;
    const s = out.series[0];
    expect(s.axisLabel.color).toBe(LIGHT_INK);
    expect(s.detail.color).toBe(LIGHT_INK);
    expect(s.title.color).toBe(LIGHT_INK);
    // Geometry the backend set is preserved through the merge.
    expect(s.axisLabel.distance).toBe(48);
    expect(s.splitLine.length).toBe(40);
  });

  it('leaves a non-gauge series untouched (no ink injected)', () => {
    const barSpec = { series: [{ type: 'bar', data: [1, 2, 3] }] };
    const out = applyEChartsChrome(barSpec) as any;
    expect(out.series[0]).toEqual({ type: 'bar', data: [1, 2, 3] });
  });

  it('pie direct-label TEXT takes the theme ink (never the slice hue), leader line keeps the slice colour', () => {
    // ECharts defaults pie label text to the slice colour (`inherit`), unreadable on the light-palette
    // hues on a light tile; the label wears theme ink instead. The leader LINE is left alone so it keeps
    // the slice colour and still ties each label to its wedge. Backend label geometry survives the merge.
    const pieSpec = () => ({ series: [{ type: 'pie', label: { show: true, formatter: '{b}' }, labelLine: { show: true }, data: [] }] });
    const light = applyEChartsChrome(pieSpec()) as any;
    expect(light.series[0].label.color).toBe(LIGHT_INK);
    expect(light.series[0].label.formatter).toBe('{b}');       // backend label geometry preserved
    expect(light.series[0].labelLine).toEqual({ show: true }); // leader line untouched → keeps slice colour
  });

  it('colours the target tick splitLine in the theme ink (dashed geometry preserved)', () => {
    // The tick is the only gauge layer with axisLine.show:false; its dashed splitLine takes the INK
    // colour (not the axis grey the fill/ring splitlines take), set where the theme is known.
    const withTick = () => ({ series: [
      { type: 'gauge', axisLabel: { show: true }, splitLine: { show: true }, detail: {}, title: {} }, // fill
      { type: 'gauge', axisLine: { show: false }, axisLabel: { show: false },
        splitLine: { show: true, length: 14, lineStyle: { width: 2, type: 'dashed' } } },            // tick
    ] });
    const light = applyEChartsChrome(withTick()) as any;
    expect(light.series[1].splitLine.lineStyle.color).toBe(LIGHT_INK);   // tick → ink, not axis grey
    expect(light.series[1].splitLine.lineStyle.type).toBe('dashed');      // backend geometry survives
    expect(light.series[1].splitLine.lineStyle.width).toBe(2);
    expect(light.series[0].splitLine.lineStyle.color).toBe('#e0e0e0');    // fill splitLine → axis grey (unchanged)
  });
});

describe('scaleGaugeToBox — the arc fills the box and its decorations follow the arc', () => {
  // The tuned pixel decorations the backend emits (see echarts-spec-builder gauge branch).
  const gaugeSpec = () => ({
    series: [{
      type: 'gauge', radius: '100%', center: ['50%', '80%'],
      axisLine: { lineStyle: { width: 40, color: [[0.8, '#4e79a7'], [1, '#888']] } },
      splitLine: { show: true, length: 40 },
      axisLabel: { show: true, distance: 48, fontSize: 11 },
      detail: { fontSize: 42, formatter: '{value}' },
      title: { fontSize: 13, show: true },
      data: [{ value: 48100, name: 'On-Hand Inventory' }],
    }],
  });

  it('reserves horizontal margin so the half-gauge does not touch the tile sides (like the sankey)', () => {
    // 1x1 tile box measured live on :3000: 406 x 288 → width-limited. An un-inset arc sizes the
    // radius to width/2 = 203, so the half-gauge spans 2R = 406 = the full box width and KISSES both
    // borders (Karsten 2026-09-18). Reserve a margin like the adjacent sankey: the DRAWN radius sits
    // inside width/2 by a real gap, so the arc clears the edges.
    const s = (scaleGaugeToBox(gaugeSpec(), 406, 288) as any).series[0];
    expect(typeof s.radius).toBe('number');
    expect(s.radius).toBeLessThan(203);                 // inset from width/2 — no longer edge-to-edge
    expect(203 - s.radius).toBeGreaterThanOrEqual(18);  // a real reserved margin (~24px), not a hairline
  });

  it('a wide-short tile grows the arc to fill the WIDTH, not the height-limited min-dim', () => {
    // 1x1 tile box measured live on :3000: 406 x 288. radius:'100%' would give min(w,h)/2 = 144
    // (height-limited), which is what collapsed the scale onto the value. The fix sizes the
    // radius off the width instead so the half-gauge fills sideways into the wasted space.
    const s = (scaleGaugeToBox(gaugeSpec(), 406, 288) as any).series[0];
    expect(typeof s.radius).toBe('number');
    expect(s.radius).toBeGreaterThan(150); // materially larger than the collapsed 144
    expect(s.radius).toBeLessThan(203);    // inset from width/2 (reserves the side margin)
    // The horizontal reserve keys off the FULL reference radius, so the flagship 1x1 tile keeps its
    // full-size scale + fonts — only the drawn arc pulls in from the edges.
    expect(s.axisLabel.show).toBe(true);
    expect(s.splitLine.show).toBe(true);
    expect(s.detail.fontSize).toBe(42);
  });

  it('keeps the scale numbers at their full-radius position so they do not crowd the inset value', () => {
    // ECharts positions each scale number at radial `radius - splitLine.length - axisLabel.distance`
    // from the centre (GaugeView _renderTicks). The pre-margin gauge drew the arc at the full R and its
    // numbers sat at R-40-48=115 — collision-free (that layout shipped). The side-margin inset pulls the
    // arc radius in to Rdrawn (< R) but the centre value keeps its full-size font, so leaving distance at
    // 48 drags the numbers 24px inward ONTO the value (Karsten 2026-09-21: "the KPI number collides with
    // the labeling"). Fix: shrink distance by the inset delta (R - Rdrawn) so the numbers keep their
    // proven radial position and clear the value; the arc still insets from the edges.
    const s = (scaleGaugeToBox(gaugeSpec(), 406, 288) as any).series[0];
    const R = 203, splitLenOrig = 40, distanceOrig = 48; // the backend-emitted values at this box (k=1)
    const labelRadial = s.radius - s.splitLine.length - s.axisLabel.distance;
    expect(labelRadial).toBe(R - splitLenOrig - distanceOrig); // 115 — the proven, pre-inset position
    expect(s.axisLabel.distance).toBeLessThan(distanceOrig);   // pulled in from the backend's 48
  });

  it('caps the radius at the center-y so a very wide, short tile cannot clip the arc top', () => {
    // 2x1 tile: wide + short. width/2 = 415 would push the arc top above the box; cap at the
    // center-y (0.8 * 288 = 230). Still far bigger than the collapsed 144 → the scale clears.
    const s = (scaleGaugeToBox(gaugeSpec(), 830, 288) as any).series[0];
    expect(s.radius).toBeLessThanOrEqual(230);
    expect(s.radius).toBeGreaterThan(180);
    expect(s.axisLabel.show).toBe(true);
    expect(s.splitLine.show).toBe(true);
  });

  it('a tall-narrow tile is width-limited (radius <= width/2)', () => {
    const s = (scaleGaugeToBox(gaugeSpec(), 288, 500) as any).series[0];
    expect(typeof s.radius).toBe('number');
    expect(s.radius).toBeLessThanOrEqual(144);
  });

  it('a genuinely tiny box shrinks the decorations DOWN and drops the speedometer scale', () => {
    const s = (scaleGaugeToBox(gaugeSpec(), 180, 130) as any).series[0];
    expect(s.detail.fontSize).toBeLessThan(42);
    expect(s.detail.fontSize).toBeGreaterThanOrEqual(16); // legibility floor
    expect(s.axisLine.lineStyle.width).toBeLessThan(40);
    // below the hide threshold the numbers + splitlines can't clear the value → hidden.
    expect(s.axisLabel.show).toBe(false);
    expect(s.splitLine.show).toBe(false);
    // the two-stop arc colour set by the builder survives the scale merge (arc still reads value).
    expect(s.axisLine.lineStyle.color).toEqual([[0.8, '#4e79a7'], [1, '#888']]);
  });

  it('a mid-size arc keeps the scale visible but shrinks the fonts', () => {
    const s = (scaleGaugeToBox(gaugeSpec(), 290, 400) as any).series[0]; // width-limited ~137
    expect(s.axisLabel.show).toBe(true);
    expect(s.splitLine.show).toBe(true);
    expect(s.detail.fontSize).toBeLessThan(42);
  });

  it('reads the center-y fraction from the spec (default 0.8 when absent)', () => {
    const noCenter = { series: [{ ...gaugeSpec().series[0], center: undefined }] };
    const s = (scaleGaugeToBox(noCenter, 406, 288) as any).series[0];
    expect(typeof s.radius).toBe('number'); // still sized, using the 0.8 default
    expect(s.radius).toBeGreaterThan(150);
    expect(s.radius).toBeLessThan(203);      // still inset from width/2 by the reserved margin
  });

  it('an unsized (0x0) host leaves the spec untouched — jsdom / pre-layout safe', () => {
    const before = gaugeSpec();
    const s = (scaleGaugeToBox(before, 0, 0) as any).series[0];
    expect(s.radius).toBe('100%');
    expect(s.detail.fontSize).toBe(42);
    expect(s.axisLabel.show).toBe(true);
  });

  it('a non-gauge series is returned untouched', () => {
    const bar = { series: [{ type: 'bar', data: [1, 2, 3] }] };
    expect(scaleGaugeToBox(bar, 300, 200)).toEqual(bar);
  });
});

describe('scaleGaugeToBox — a multi-layer (zone-ring) gauge scales each layer per-role', () => {
  // The three layers Task 2 emits for a threshold KPI: ring (100%/w10, ramp only), fill (86%/w28,
  // scale-bearer), target tick (100%, axisLine off, splitLine only).
  const zonedSpec = () => ({ series: [
    { type: 'gauge', radius: '100%', center: ['50%', '80%'],
      axisLine: { lineStyle: { width: 10, color: [[0.6, '#D55E00'], [0.8, '#E69F00'], [1, '#009E73']] } },
      splitLine: { show: false }, axisLabel: { show: false }, pointer: { show: false }, detail: { show: false }, title: { show: false } },
    { type: 'gauge', radius: '86%', center: ['50%', '80%'],
      axisLine: { lineStyle: { width: 28, color: [[0.9, '#0072B2'], [1, '#e6e6e6']] } },
      splitLine: { show: true, length: 40 }, axisLabel: { show: true, distance: 48, fontSize: 11 },
      detail: { fontSize: 42, formatter: '{value}' }, title: { fontSize: 13, show: true } },
    { type: 'gauge', radius: '100%', center: ['50%', '80%'], min: 40000, max: 40000,
      axisLine: { show: false }, axisLabel: { show: false },
      splitLine: { show: true, length: 14, lineStyle: { width: 2, type: 'dashed', color: '#f5f5f7' } } },
  ] });

  it('scales each layer radius by its OWN declared fraction, inset by the reserved side margin', () => {
    // 406x288 tile → R = min(203, 0.8*288) = 203; drawn radius = round(203 * (1 - 0.12)) = 179 so the
    // half-gauge clears the tile edges (the reserved side margin). Each layer's own fraction rides that
    // inset drawn radius, so the ring/fill/tick nesting is preserved.
    const series = (scaleGaugeToBox(zonedSpec(), 406, 288) as any).series;
    expect(series[0].radius).toBe(179);            // ring: 100% → Rdrawn
    expect(series[1].radius).toBe(Math.round(0.86 * 179)); // fill: 86% → 0.86·Rdrawn (154)
    expect(series[2].radius).toBe(179);            // tick: 100% → Rdrawn
  });

  it('keeps the ring/tick show:false — the uniform merge would re-light them at a large box', () => {
    // At 406x288 the fill's radius (203) is well above the 120px hide threshold, so showScale is true;
    // a naive uniform merge would force the ring's splitLine/axisLabel .show back to true. Per-role
    // must leave them false.
    const series = (scaleGaugeToBox(zonedSpec(), 406, 288) as any).series;
    expect(series[0].splitLine.show).toBe(false);  // ring stays a pure ramp
    expect(series[0].axisLabel.show).toBe(false);
    expect(series[1].axisLabel.show).toBe(true);   // fill (scale-bearer) shows the scale
    expect(series[1].splitLine.show).toBe(true);
  });

  it('scales each layer axisLine width by k — the thin ring stays distinct from the thick fill', () => {
    const series = (scaleGaugeToBox(zonedSpec(), 406, 288) as any).series;
    // k = min(1, 203/200) = 1 at this box → widths unchanged, and DISTINCT (not both forced to r(40)).
    expect(series[0].axisLine.lineStyle.width).toBe(10);
    expect(series[1].axisLine.lineStyle.width).toBe(28);
    expect(series[0].axisLine.lineStyle.width).not.toBe(series[1].axisLine.lineStyle.width);
    // and the ramp colours survive the merge on both.
    expect(series[0].axisLine.lineStyle.color).toEqual([[0.6, '#D55E00'], [0.8, '#E69F00'], [1, '#009E73']]);
    expect(series[1].axisLine.lineStyle.color).toEqual([[0.9, '#0072B2'], [1, '#e6e6e6']]);
  });

  it('shrinks widths on a tiny box but keeps them distinct, and drops the fill scale only', () => {
    // 180x130 → R = min(90, 104) = 90 < 120 → showScale false, k = 0.45.
    const series = (scaleGaugeToBox(zonedSpec(), 180, 130) as any).series;
    expect(series[0].axisLine.lineStyle.width).toBe(Math.round(10 * 0.45)); // 5 (thin)
    expect(series[1].axisLine.lineStyle.width).toBe(Math.round(28 * 0.45)); // 13 (thick) — still distinct
    expect(series[1].axisLabel.show).toBe(false); // fill scale hidden on the tiny arc
    expect(series[0].axisLabel.show).toBe(false); // ring stays off (was already off)
  });

  it('leaves the target tick splitLine geometry alone (furniture is scale-bearer only)', () => {
    const series = (scaleGaugeToBox(zonedSpec(), 406, 288) as any).series;
    expect(series[2].splitLine.length).toBe(14);        // not rescaled to r(40)
    expect(series[2].splitLine.lineStyle.type).toBe('dashed');
    expect(series[2].axisLine).toEqual({ show: false }); // no width injected on a layer that declares none
  });

  // A percentage-ring fill layer: full circle, scale OFF (axisLabel.show:false), but a centre readout.
  const ringSpec = () => ({
    series: [{
      type: 'gauge', radius: '100%', center: ['50%', '50%'],
      axisLine: { lineStyle: { width: 40, color: [[0.82, '#4e79a7'], [1, '#888']] } },
      splitLine: { show: false, length: 40 },
      axisLabel: { show: false, distance: 48, fontSize: 11 },
      detail: { fontSize: 42, formatter: '{value}%' },
      title: { fontSize: 13, show: true },
      data: [{ value: 82, name: 'Fill Rate' }],
    }],
  });

  it('scales the RING centre readout (detail/title) even though its speedometer scale is off', () => {
    const s = (scaleGaugeToBox(ringSpec(), 180, 130) as any).series[0]; // a small box forces a shrink
    expect(s.detail.fontSize).toBeLessThan(42);
    expect(s.detail.fontSize).toBeGreaterThanOrEqual(16); // legibility floor (GAUGE_DETAIL_MIN)
    expect(typeof s.radius).toBe('number');               // radius scaled off the ['50%','50%'] centre
    expect(s.axisLabel.show).toBe(false);                 // the ring never grows a scale
    expect(s.splitLine.show).toBe(false);
  });

  it('a ring at full size keeps the full detail font (scales DOWN only)', () => {
    const s = (scaleGaugeToBox(ringSpec(), 600, 600) as any).series[0];
    expect(s.detail.fontSize).toBe(42);
  });
});

describe('applyEChartsChrome — title subtext ink follows the theme (the truncation disclosure)', () => {
  const withSubtext = () => ({ title: { text: 'Value by Country and Status', subtext: 'Showing top 8 of 20 targets' }, series: [{ type: 'sankey', data: [], links: [] }] });

  it('light mode: subtext takes the dark-on-light ink', () => {
    const out = applyEChartsChrome(withSubtext()) as any;
    expect(out.title.subtextStyle.color).toBe(LIGHT_INK);
    expect(out.title.textStyle.color).toBe(LIGHT_INK);
  });
});

describe('applyEChartsChrome — sankey node-label ink follows the theme', () => {
  const sankeySpec = () => ({
    title: { text: 'Value by Country and Status' },
    tooltip: { trigger: 'item' },
    series: [{ type: 'sankey', data: [{ name: 'USA' }, { name: 'Closed' }], links: [{ source: 'USA', target: 'Closed', value: 5 }], label: { show: true }, lineStyle: { color: 'gradient', opacity: 0.5 } }],
  });

  it('light mode: node labels take the dark-on-light ink', () => {
    const out = applyEChartsChrome(sankeySpec()) as any;
    expect(out.series[0].label.color).toBe(LIGHT_INK);
    expect(out.series[0].label.show).toBe(true);                            // backend geometry preserved
    expect(out.series[0].lineStyle).toEqual({ color: 'gradient', opacity: 0.5 }); // ribbon left alone
  });

  it('injects no x/y-axis chrome for a sankey (it declares none)', () => {
    const out = applyEChartsChrome(sankeySpec()) as any;
    expect(out.xAxis).toBeUndefined();
    expect(out.yAxis).toBeUndefined();
  });
});

describe('applyEChartsChrome — radar ink follows the theme', () => {
  const radarSpec = () => ({
    title: { text: 'Score by Metric' },
    radar: { indicator: [{ name: 'Speed', max: 90 }, { name: 'Cost', max: 90 }, { name: 'Quality', max: 90 }], radius: '70%' },
    series: [{ type: 'radar', data: [{ name: 'Vendor A', value: [80, 60, 90] }] }],
  });

  it('light mode: axis names use the dark-on-light ink', () => {
    const out = applyEChartsChrome(radarSpec()) as any;
    expect(out.radar.axisName.color).toBe(LIGHT_INK);
    expect(out.radar.axisLine.lineStyle.color).toBe('#e0e0e0'); // CHROME light axis
    expect(out.radar.splitLine.lineStyle.color).toBe('#e0e0e0');
    expect(out.radar.splitArea.areaStyle.color).toBe('transparent'); // no opaque grey rings
    // Backend geometry preserved.
    expect(out.radar.radius).toBe('70%');
    expect(out.radar.indicator).toHaveLength(3);
  });

  it('a spec without a radar block is unaffected', () => {
    const pieSpec = { series: [{ type: 'pie', data: [{ name: 'a', value: 1 }] }] };
    const out = applyEChartsChrome(pieSpec) as any;
    expect(out.radar).toBeUndefined();
  });
});
