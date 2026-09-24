import { Component, ChangeDetectionStrategy, ElementRef, effect, input, signal, viewChild } from '@angular/core';
import { echarts, applyEChartsChrome, scaleGaugeToBox, scaleBubbleMatrixToBox } from './echarts-setup';

/** The ECharts renderer leaf. Owns an echarts instance on its host element; pushes the
 *  themed option via setOption(_, true) so a structural change is a full replace (no stale
 *  geometry — the ECharts analogue of the Highcharts recreate-on-structure-change guard).
 *  a11y: the host is a role="img" figure labelled from `label`, mirroring the HC view. */
@Component({
  selector: 'app-echarts-chart-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [':host{display:block;height:100%;min-height:0}'],
  template: `<div #host role="img" [attr.aria-label]="label()" style="display:block;width:100%;height:100%"></div>`,
})
export class EChartsChartViewComponent {
  readonly spec = input.required<Record<string, unknown>>();
  readonly label = input<string>('Chart');
  readonly bareTitle = input<boolean>(false);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  readonly chartInstance = signal<echarts.ECharts | null>(null);
  // Bumped on every resize so the render effect re-runs and rescales the gauge to the new box.
  // (Only the gauge reads the box; other charts are box-agnostic and re-render harmlessly.)
  private readonly resizeTick = signal(0);

  constructor() {
    // Lifecycle: init once when the host exists; resize with the element; dispose on destroy.
    // ResizeObserver is guarded — every real browser has it, but the jsdom test env does
    // not, and its absence must not stop the chart from rendering (only from auto-resizing).
    effect((onCleanup) => {
      const el = this.host().nativeElement;
      const instance = echarts.init(el, undefined, { renderer: 'svg' });
      this.chartInstance.set(instance);
      const ro = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => { instance.resize(); this.resizeTick.update((n) => n + 1); })
        : null;
      ro?.observe(el);
      onCleanup(() => { ro?.disconnect(); instance.dispose(); this.chartInstance.set(null); });
    });
    // Render: push the themed option on any spec/theme/bareTitle change. notMerge:true = replace.
    effect(() => {
      const instance = this.chartInstance();
      if (!instance) return;
      this.resizeTick(); // re-run on resize so a gauge rescales to its new box
      const themed = applyEChartsChrome(this.spec());
      // Scale the gauge's pixel decorations to the ACTUAL rendered box (the only place the pixel
      // size is known). getWidth/Height reflect the sized instance; an unsized 0×0 host (jsdom,
      // pre-layout) leaves the spec untouched inside the helper.
      const w = instance.getWidth(), h = instance.getHeight();
      // Two box-aware sizers run over the SAME rendered dimensions: the gauge scales its pixel
      // decorations, the bubble-matrix fills each dot to its grid cell (both need the pixel box,
      // known only here). A spec is at most one of the two, so order is immaterial.
      const scaled = scaleBubbleMatrixToBox(scaleGaugeToBox(themed, w, h), w, h);
      const title = (scaled['title'] as Record<string, unknown> | undefined) ?? {};
      const opt = this.bareTitle() ? { ...scaled, title: { ...title, text: '' } } : scaled;
      instance.setOption(opt, true);
    });
  }
}
