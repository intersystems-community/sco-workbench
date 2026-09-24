// frontend/src/app/dashboard/chart-builder-preview.ts
import { Component, ChangeDetectionStrategy, computed, effect, input, output, signal, untracked } from '@angular/core';
import { ChartTileViewComponent, type RenderedChart } from './chart-tile-view';
import { CAPABILITY_TYPES } from './chart-capability';
import {
  initialBuilderState, onTypeOverride, onAiToggle, whyLabel, whyExplanation, type BuilderState,
} from './chart-builder-state';
import { chartTypeLabel, chartTypeHelp, disabledTypeLabel } from './chart-type-labels';
import { seriesCollapsed, treemapBranchKey } from './chart-shape';
import type { ChartSelection } from './dashboard-config';

/**
 * The SHARED chart-builder preview (spec §5.3): the source-independent half of the old
 * chart builder. Given a source builder's `baseSelection` (picks WITHOUT chartType/useAi)
 * and its editorial `allowedTypes`, this owns everything downstream of the pickers — the
 * chart-type dropdown, the AI toggle, the live preview tile (the ONE render seam), the two
 * stale-override drops, and the five explanatory affordances — and emits the COMPLETE draft
 * `ChartSelection` back up. State (typeOverride/useAi) lives HERE with the dropdown, so the
 * two stale-drops live in ONE place and cannot diverge (spec §5.3/§5.4).
 */
@Component({
  selector: 'app-chart-builder-preview',
  standalone: true,
  imports: [ChartTileViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chart-builder-preview.html',
  styleUrl: './chart-builder-preview.css',
})
export class ChartBuilderPreviewComponent {
  /** The source builder's picks WITHOUT chartType/useAi (cube+measure+dims, or kpi+breakdown); null while incomplete. */
  readonly baseSelection = input<ChartSelection | null>(null);
  /** The source's editorial allow-list (spec §5.4). */
  readonly allowedTypes = input<readonly string[]>([]);
  /** A stored chartType to adopt on edit-open (seeds the override; dropped if outside allowedTypes). */
  readonly seedType = input<string | null>(null);
  /** A stored useAi to adopt on edit-open. */
  readonly seedUseAi = input<boolean>(false);

  readonly draftChange = output<ChartSelection>();
  // NO `valid` output: this preview mounts only behind the source builder's @if (baseSelection()),
  // so it could never emit the complete→incomplete `false`. Readiness is owned by the always-mounted
  // source builder (A3-PLAN-01) — a single readiness source, just not this (conditional) component.

  readonly state = signal<BuilderState>(initialBuilderState());

  readonly isFunnel = computed(() => this.state().typeOverride === 'funnel');
  readonly funnelSort = signal<'value' | 'source'>('value');

  // --- fed back from the preview tile ---
  /** The backend's applicable-type allow-list (from the tile's /chart-data), full list before a load. */
  readonly applicableTypes = signal<readonly string[]>(CAPABILITY_TYPES);
  private readonly applicableSet = computed(() => new Set(this.applicableTypes()));
  isTypeApplicable(type: string): boolean { return this.applicableSet().has(type); }
  private readonly rendered = signal<RenderedChart | null>(null);
  readonly renderedSpec = computed(() => this.rendered()?.spec ?? null);
  readonly renderedData = computed(() => this.rendered()?.data ?? null);
  readonly whyLine = computed(() => { const s = this.renderedSpec(); return s ? whyLabel(s) : ''; });
  readonly whyExplanationLine = computed(() => { const s = this.renderedSpec(); return s ? whyExplanation(s) : ''; });
  readonly treemapKey = computed(() => treemapBranchKey(this.renderedSpec(), this.renderedData()));
  readonly seriesCollapseDim = computed(() => { const d = this.renderedData(); return d ? seriesCollapsed(d) : null; });

  /** The dropdown lists the source's allow-list, sorted by label (was `allTypes`, now scoped by source). */
  readonly offeredTypes = computed(() =>
    [...this.allowedTypes()].sort((a, b) => chartTypeLabel(a).localeCompare(chartTypeLabel(b))),
  );
  readonly recommendedLabel = computed(() => {
    const rec = this.renderedSpec()?.recommendedType;
    return rec ? `Recommended (${chartTypeLabel(rec)})` : 'Recommended';
  });

  /** Master switch for the AI feature (Change 2): default OFF, control hidden, no /ai-health probe. */
  aiEnabled = false;

  /** The COMPLETE draft = baseSelection + the resolved chartType/useAi, or null while incomplete. */
  readonly draft = computed<ChartSelection | null>(() => {
    const base = this.baseSelection();
    if (!base) return null;
    const s = this.state();
    const sel: ChartSelection = { ...base }; // base carries no chartType/useAi (the source builder omits them)
    if (s.typeOverride) sel.chartType = s.typeOverride;
    if (s.useAi) sel.useAi = true;
    if (this.isFunnel() && sel.source === 'cube') sel.funnelSort = this.funnelSort();
    return sel;
  });

  constructor() {
    // Adopt the seed (edit-open) ONCE, guarded against the editorial allow-list: a stored
    // chartType outside allowedTypes resets to Recommended on open (spec §5.4 edit-migration).
    // Reads seed inputs; the allowedTypes read is untracked so this stays a one-time adoption
    // and later allowedTypes changes are handled by the drop effect below.
    effect(() => {
      const t = this.seedType();
      const useAi = this.seedUseAi();
      untracked(() => {
        const allowed = this.allowedTypes();
        // Spread the initial state (not a bare literal) so this compiles against BOTH the current
        // 6-field BuilderState — while chart-builder.ts is still co-compiled, pre-Task-10 — and the
        // pruned 2-field shape (Task 10). Only typeOverride/useAi are ever read here; identical behaviour.
        this.state.set({ ...initialBuilderState(), typeOverride: t && allowed.includes(t) ? t : null, useAi });
      });
    });

    // Drop a held override when the EDITORIAL gate changes and no longer offers it (spec §5.4:
    // the in-session breakdown→scalar flip). Depends on allowedTypes; reads/writes state untracked.
    effect(() => {
      const allowed = this.allowedTypes();
      untracked(() => {
        const held = this.state().typeOverride;
        if (held && !allowed.includes(held)) this.state.update((s) => ({ ...s, typeOverride: null }));
      });
    });

    // Emit the complete draft whenever it changes (emitting an output is not a signal write,
    // so no loop). Readiness (`valid`) is NOT emitted here — the always-mounted source builder
    // owns it (A3-PLAN-01). This effect only runs while mounted, i.e. while baseSelection is
    // non-null, so `draft` is always non-null here; the guard is belt-and-braces.
    effect(() => {
      const draft = this.draft();
      if (draft) this.draftChange.emit(draft);
    });
  }

  onTypeOverride(type: string): void { this.state.update((s) => onTypeOverride(s, type)); }
  onAiToggle(on: boolean): void { this.state.update((s) => onAiToggle(s, on)); }
  onFunnelSortChange(v: 'value' | 'source'): void { this.funnelSort.set(v); }

  // --- fed back from the preview tile ---
  onApplicableTypesChange(types: string[] | undefined): void {
    const applicable = types && types.length ? types : [...CAPABILITY_TYPES];
    this.applicableTypes.set(applicable);
    // Drop a stale override the new SHAPE can no longer draw (the backend gate; kept from today).
    const chosen = this.state().typeOverride;
    if (chosen && !applicable.includes(chosen)) this.state.update((s) => ({ ...s, typeOverride: null }));
  }
  onRendered(r: RenderedChart | null): void { this.rendered.set(r); }

  // --- display helpers (moved with the dropdown, unchanged) ---
  typeLabel(token: string): string { return chartTypeLabel(token); }
  typeHelp(token: string): string { return chartTypeHelp(token); }
  disabledTypeLabel(token: string): string { return disabledTypeLabel(token); }
}
