// frontend/src/app/dashboard/chart-view.ts
import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { EChartsChartViewComponent } from './echarts-chart-view';

/** The ONE render seam (spec §8 rule 3). Highcharts is gone (round 5), so this is no longer a
 *  renderer router: it mounts the ECharts leaf directly and forwards the opaque spec + theming
 *  inputs. Nothing here inspects the spec's shape.
 *
 *  The ECharts leaf is @defer-loaded. EChartsChartViewComponent is standalone, imported below,
 *  and referenced ONLY inside the @defer block — the conditions under which Angular splits it,
 *  and its entire ECharts dependency (~161 kB gzip: echarts-chart-view → echarts-setup →
 *  echarts/*), into a lazy chunk that ships only when a tile actually renders a chart. `on
 *  immediate` starts the fetch as soon as the view renders (the user is already looking at this
 *  chart, so there is nothing to wait for). @error degrades honestly if the chunk fails to load:
 *  the tile must be retried; there is no other renderer to fall back to. */
@Component({
  selector: 'app-chart-view',
  standalone: true,
  imports: [EChartsChartViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [':host{display:block;height:100%;min-height:0}'],
  template: `@defer (on immediate) {
      <app-echarts-chart-view [spec]="spec()" [label]="label()" [bareTitle]="bareTitle()" />
    } @placeholder {
      <div class="chart-view-deferred">Loading chart…</div>
    } @error {
      <div class="chart-view-deferred" role="alert">Chart renderer failed to load. Retry the tile.</div>
    }`,
})
export class ChartViewComponent {
  readonly spec = input.required<Record<string, unknown>>();
  readonly label = input<string>('Chart');
  readonly bareTitle = input<boolean>(false);
}
