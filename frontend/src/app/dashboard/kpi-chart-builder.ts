// frontend/src/app/dashboard/kpi-chart-builder.ts
import { Component, ChangeDetectionStrategy, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DashboardChartService, type ChartableKpi } from './services/dashboard-chart.service';
import { ChartBuilderPreviewComponent } from './chart-builder-preview';
import { kpiAllowedTypes } from './chart-source-types';
import type { ChartSelection } from './dashboard-config';

type KpiSelection = Extract<ChartSelection, { source: 'kpi' }>;

/**
 * The KPI chart builder (spec §5.3): the KPI + break-down pickers over the shared preview.
 * Its editorial allow-list flips with the breakdown — scalar (gauge/bullet) when there is no
 * breakdown dimension, the coherent single-series set once a breakdown is chosen
 * (kpiAllowedTypes). It builds a `baseSelection` (kpi + optional expandDimension, NO
 * chartType/useAi) and re-emits the preview's complete draftChange UNMODIFIED. Readiness
 * (`valid`) is owned HERE in an always-mounted effect as `baseSelection() != null`, NOT
 * passed through from the preview (which unmounts while baseSelection is null; A3-PLAN-01).
 * A KPI without a breakdown offering gauge/bullet — while a KPI
 * WITH a breakdown offers a single-series set and never the cube-only multi-dimensional types
 * — is exactly the source-blind leak A3 fixes (spec §5.2).
 */
@Component({
  selector: 'app-kpi-chart-builder',
  standalone: true,
  imports: [ChartBuilderPreviewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './kpi-chart-builder.html',
  styleUrl: './kpi-chart-builder.css',
})
export class KpiChartBuilderComponent implements OnInit {
  private readonly svc = inject(DashboardChartService);

  readonly selection = input<KpiSelection | null>(null);
  readonly selectionChange = output<ChartSelection>();
  readonly valid = output<boolean>();

  readonly kpis = signal<ChartableKpi[]>([]);
  readonly loadingKpis = signal(false);   // the KPI catalog fetch is in flight (cube parity; guards the empty state)
  readonly selectedKpi = signal<string | null>(null);
  readonly expandDimension = signal<string | null>(null);
  readonly selectedKpiDims = computed(() => this.kpis().find((k) => k.name === this.selectedKpi())?.dimensions ?? []);

  readonly seedType = signal<string | null>(null);
  readonly seedUseAi = signal<boolean>(false);

  /** The editorial allow-list, flipping scalar↔breakdown on the break-down pick (spec §5.4). */
  readonly allowedTypes = computed(() => kpiAllowedTypes(this.expandDimension() != null));

  /** The base selection (WITHOUT chartType/useAi) fed to the preview, or null while incomplete. */
  readonly baseSelection = computed<ChartSelection | null>(() => {
    const kpi = this.selectedKpi();
    if (!kpi) return null;
    const sel: ChartSelection = { source: 'kpi', kpi };
    const ed = this.expandDimension(); if (ed) sel.expandDimension = ed;
    return sel;
  });

  constructor() {
    effect(() => {
      const incoming = this.selection();
      if (incoming) untracked(() => this.initFrom(incoming));
    });
    // Readiness, owned by the always-mounted builder (A3-PLAN-01): false until a KPI is picked,
    // true once baseSelection completes. Emitting an output is not a signal write, so no loop.
    effect(() => this.valid.emit(this.baseSelection() != null));
  }

  ngOnInit(): void {
    this.loadingKpis.set(true);
    this.svc.getKpis().subscribe({
      next: (r) => { this.kpis.set(r?.kpis ?? []); this.loadingKpis.set(false); },
      error: () => { this.kpis.set([]); this.loadingKpis.set(false); },
    });
  }

  private initFrom(sel: KpiSelection): void {
    this.seedType.set(sel.chartType ?? null);
    this.seedUseAi.set(!!sel.useAi);
    this.selectedKpi.set(sel.kpi);
    this.expandDimension.set(sel.expandDimension ?? null);
  }

  onKpiChange(name: string): void {
    if (!name) return;
    this.selectedKpi.set(name);
    this.expandDimension.set(null); // a new KPI invalidates the old breakdown
    this.seedType.set(null);
  }
  onExpandDimensionChange(name: string): void { this.expandDimension.set(name || null); }

  // Pass the complete draft through UNMODIFIED (spec §5.3 / Round-2 note). Readiness is owned by
  // the always-mounted `valid` effect above (A3-PLAN-01), not passed through from the preview.
  onDraftChange(sel: ChartSelection): void { this.selectionChange.emit(sel); }
}
