import { TestBed, DeferBlockState, DeferBlockBehavior } from '@angular/core/testing';
import { ChartViewComponent } from './chart-view';
import { EChartsChartViewComponent } from './echarts-chart-view';

async function make() {
  TestBed.configureTestingModule({
    imports: [ChartViewComponent],
    // Manual defer behavior: the `on immediate` trigger does NOT auto-fire, so a block
    // advances ONLY when a test calls block.render(). Without this, rendering the echarts
    // view kicks off the deferred dynamic import() — which resolves async AFTER a test's
    // synchronous assertions and caches the ECharts chunk PROCESS-GLOBALLY (surviving
    // resetTestingModule()). That stale cache then robs a later test's placeholder of its
    // first-load, a cross-test pollution the manual mode makes impossible.
    deferBlockBehavior: DeferBlockBehavior.Manual,
  });
  // @defer in the template needs resolved async metadata — compile before creating.
  await TestBed.compileComponents();
  return TestBed.createComponent(ChartViewComponent);
}

describe('chart-view — mounts the ECharts view via @defer', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('shows the @defer placeholder before the ECharts chunk loads', async () => {
    const f = await make();
    // The @defer placeholder (`.chart-view-deferred`) is up and the leaf is not yet mounted.
    // This test deliberately does NOT drive the block to Complete — doing so eagerly loads
    // (and globally caches) the ECharts lazy chunk, which would rob the lifecycle test below
    // of the first-load its placeholder assertion depends on.
    f.componentRef.setInput('spec', { series: [{ type: 'pie', data: [{ name: 'a', value: 1 }] }] });
    f.detectChanges();
    expect(f.debugElement.nativeElement.querySelector('.chart-view-deferred')).toBeTruthy();
    expect(f.debugElement.nativeElement.querySelector('app-echarts-chart-view')).toBeNull();
  });
  it('@defer-loads then mounts the ECharts view', async () => {
    const f = await make();
    // A pie needs no cartesian coordinate system, so it is the minimal spec ECharts can render
    // without axes. The placeholder shows first, then rendering the Complete state mounts the
    // deferred component. Also proves the ECharts view is NOT eagerly present (which would
    // defeat the lazy-chunk split this @defer exists to create).
    f.componentRef.setInput('spec', { series: [{ type: 'pie', data: [{ name: 'a', value: 1 }] }] });
    f.detectChanges();
    expect(f.debugElement.nativeElement.querySelector('.chart-view-deferred')).toBeTruthy();
    expect(f.debugElement.nativeElement.querySelector('app-echarts-chart-view')).toBeNull();
    const [block] = await f.getDeferBlocks();
    await block.render(DeferBlockState.Complete);
    expect(f.debugElement.nativeElement.querySelector('app-echarts-chart-view')).toBeTruthy();
  });
});
