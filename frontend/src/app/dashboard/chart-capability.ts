// frontend/src/app/dashboard/chart-capability.ts
//
// FE mirror of the backend charting allow-list. MUST stay in lockstep with
// backend/src/dashboard/chart-type-advisor.ts CAPABILITY_TYPES — every type here
// needs its ECharts series/component module registered in echarts-setup.ts, or it
// renders blank (the silent-non-draw trap). If the backend list changes, change
// this list and echarts-setup.ts together.
export const CAPABILITY_TYPES = [
  'bar', 'column', 'line', 'area', 'pie',
  'scatter', 'heatmap', 'treemap', 'dumbbell', 'solidgauge',
  'stackedColumn', 'stackedArea', 'stackedColumn100',
  'radar', 'divergingBar', 'slope', 'bullet', 'sunburst',
  'bubble', 'funnel', 'bubbleHeatmap', 'sankey',
] as const;

export type ChartType = (typeof CAPABILITY_TYPES)[number];
