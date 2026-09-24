// frontend/src/app/dashboard/cube-chart-builder.ts
import { Component, ChangeDetectionStrategy, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DashboardChartService, type CubeShape, type ChartableCube, type CubeMember } from './services/dashboard-chart.service';
import { ChartBuilderPreviewComponent } from './chart-builder-preview';
import { CUBE_ALLOWED_TYPES } from './chart-source-types';
import { dimensionLevelGroups, measureLabel, isCubeChartable, disabledCubeLabel } from './chart-shape';
import { humanizeField, humanizeCubeName } from './humanize';
import type { ChartSelection, CubeDimensionAssignment } from './dashboard-config';

type CubeSelection = Extract<ChartSelection, { source: 'cube' }>;

/**
 * The CUBE chart builder (spec §5.3): the cube picker + measures chips + decoupled
 * Category/Series axes + Filters, all level-granular (B-CUBE-11 / B-CUBE-15), over the
 * shared preview child + the CUBE editorial allow-list. It builds a general `baseSelection`
 * (cube + measures[] + role-tagged dimensions[], each carrying `level` only when NOT the
 * dimension's first level, NO chartType/useAi — the preview owns those) and hands it plus
 * `CUBE_ALLOWED_TYPES` to <app-chart-builder-preview>, re-emitting the preview's complete
 * draftChange upward UNMODIFIED. Readiness (`valid`) is owned HERE, in an always-mounted
 * effect, as `baseSelection() != null` (cube + ≥1 measure) — NOT passed through from the
 * preview, which mounts only while baseSelection is non-null and so could never signal a
 * complete→incomplete pick (A3-PLAN-01: pick a chartable cube, then one whose shape
 * errors/empties → measures empty → Save must disable). Single readiness source — the
 * always-mounted builder. The deferred combo (a series split + multiple measures) is
 * blocked symmetrically. Zoneless: every state change is a signal write.
 */
@Component({
  selector: 'app-cube-chart-builder',
  standalone: true,
  imports: [ChartBuilderPreviewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cube-chart-builder.html',
  styleUrl: './cube-chart-builder.css',
})
export class CubeChartBuilderComponent implements OnInit {
  private readonly svc = inject(DashboardChartService);

  readonly selection = input<CubeSelection | null>(null);
  readonly selectionChange = output<ChartSelection>();
  readonly valid = output<boolean>();

  readonly allowedTypes = CUBE_ALLOWED_TYPES;

  readonly chosenType = signal<string | null>(null);
  readonly isBubble = computed(() => this.chosenType() === 'bubble');
  readonly sizeMeasure = signal<string>('%COUNT');

  readonly cubes = signal<ChartableCube[]>([]);
  readonly loadingCubes = signal(false);                 // the catalog fetch is in flight (feedback, audit #2)
  readonly chartableCubes = computed(() => this.cubes().filter(isCubeChartable));
  readonly nonChartableCubes = computed(() => this.cubes().filter((c) => !isCubeChartable(c)));
  readonly cube = signal<string | null>(null);
  readonly shape = signal<CubeShape | null>(null);
  readonly measures = signal<string[]>([]);              // ordered, ≥1 for readiness
  readonly categoryLevel = signal<string | null>(null);  // role:'category' — the chosen LEVEL spec
  readonly seriesLevel = signal<string | null>(null);    // role:'series'   — the chosen LEVEL spec
  readonly filters = signal<{ name: string; level: string; member: string }[]>([]); // level = chosen level spec

  // --- Add-filter draft (chip port of the tree; spec §6.1) ---
  readonly draftFilterOpen = signal(false);
  readonly draftFilterLevel = signal<string | null>(null);
  // Member lists keyed by level spec. A SIGNAL (not a Map) so the <datalist> reacts on resolve — this is a
  // zoneless signal component; KPI's cdr.markForCheck() pattern does not apply here.
  private readonly memberCache = signal<Record<string, CubeMember[]>>({});
  private readonly membersInFlight = new Set<string>();

  /** True once the picked cube's shape has no measures/dimensions to chart at all. */
  readonly unchartable = signal(false);
  /** Shape-fetch feedback (audit #1/#2): distinct loading + error states so the one status line never lies. */
  readonly loadingShape = signal(false);
  readonly shapeError = signal(false);

  /**
   * The single builder status the template branches on (audit #1). Each state gets ITS OWN
   * message, so the old catch-all "Pick a cube to chart its data" can no longer stand in for a
   * picked-but-loading / errored / unchartable / measure-less cube (Norman Gulf of Evaluation).
   *   ready         → the preview mounts (baseSelection complete)
   *   idle          → no cube picked yet
   *   loading       → the shape is being fetched
   *   error         → the shape fetch failed (offers Retry)
   *   unchartable   → the cube has no measures/dimensions to chart
   *   needs-measure → a chartable cube with every measure removed (controls stay so one can be re-added)
   */
  readonly status = computed<'ready' | 'idle' | 'loading' | 'error' | 'unchartable' | 'needs-measure'>(() => {
    if (this.baseSelection()) return 'ready';
    if (this.cube() === null) return 'idle';
    if (this.loadingShape()) return 'loading';
    if (this.shapeError()) return 'error';
    if (this.unchartable()) return 'unchartable';
    return 'needs-measure';
  });

  /** The stored chartType/useAi to seed the preview with in edit mode. */
  readonly seedType = signal<string | null>(null);
  readonly seedUseAi = signal<boolean>(false);

  readonly sortedMeasures = computed(() =>
    [...(this.shape()?.measures ?? [])].sort((a, b) => measureLabel(a).localeCompare(measureLabel(b))),
  );
  readonly measureOptions = computed(() => (this.shape()?.measures ?? []).map((m) => m.name));

  /** Map a level spec back to its owning dimension name (for whole-dimension role exclusion). */
  private dimOf(levelSpec: string | null): string | null {
    if (!levelSpec) return null;
    return this.shape()?.dimensions.find((d) => d.levels.some((l) => l.spec === levelSpec))?.name ?? null;
  }
  /** The first (default) level spec of a dimension — the pick that emits NO `level` (byte-identical to today). */
  private firstLevelSpec(dim: string): string | undefined {
    return this.shape()?.dimensions.find((d) => d.name === dim)?.levels[0]?.spec;
  }

  /** The deferred-combo block: a series split is only offered with exactly one measure. */
  readonly seriesBlocked = computed(() => this.measures().length > 1);
  /** Symmetric block: a second measure cannot be added while a series split is chosen. */
  readonly addMeasureBlocked = computed(() => this.seriesLevel() != null);

  readonly availableMeasures = computed(() =>
    this.sortedMeasures().filter((m) => !this.measures().includes(m.name)));
  /** Dimension NAMES already used in a role — a dimension is on at most one channel, regardless of level. */
  private usedDims = computed(() => new Set<string>([
    ...(this.dimOf(this.categoryLevel()) ? [this.dimOf(this.categoryLevel())!] : []),
    ...(this.dimOf(this.seriesLevel()) ? [this.dimOf(this.seriesLevel())!] : []),
    ...this.filters().map((f) => f.name),
  ]));
  /** Level-option groups for a channel: this channel's own dimension stays; others used elsewhere are excluded. */
  private levelGroupsFor(ownLevel: string | null) {
    const own = this.dimOf(ownLevel);
    return dimensionLevelGroups((this.shape()?.dimensions ?? []).filter((d) => d.name === own || !this.usedDims().has(d.name)));
  }
  readonly categoryGroups = computed(() => this.levelGroupsFor(this.categoryLevel()));
  readonly seriesGroups = computed(() => this.levelGroupsFor(this.seriesLevel()));
  /** Levels offerable as a NEW filter: every dimension not already on a channel (levelGroupsFor(null) keeps
   *  none as "own", so all used dims — category/series/existing filters — are excluded). Role-exclusivity at
   *  the picker, replacing onTreeSelect's post-hoc usedDims guard. */
  readonly filterGroups = computed(() => this.levelGroupsFor(null));
  /** The draft level's members (pure cache read; the fetch is kicked off eagerly in onDraftFilterLevel). */
  readonly draftMemberOptions = computed<CubeMember[]>(() => {
    const spec = this.draftFilterLevel();
    return spec ? (this.memberCache()[spec] ?? []) : [];
  });

  /**
   * The base selection (WITHOUT chartType/useAi) fed to the preview, or null while incomplete.
   * General role model (B-CUBE-01): a channel emits `level` ONLY when it is NOT the dimension's
   * first level (so today's single-level picks round-trip byte-identical, §3).
   */
  readonly baseSelection = computed<ChartSelection | null>(() => {
    const cube = this.cube();
    const measures = this.measures();
    if (!cube || measures.length === 0) return null;
    const effectiveMeasures = this.isBubble() && measures.length === 2 ? [...measures, this.sizeMeasure()] : measures;
    const dimensions: CubeDimensionAssignment[] = [];
    const axis = (levelSpec: string, role: 'category' | 'series') => {
      const dim = this.dimOf(levelSpec)!;
      const a: CubeDimensionAssignment = { name: dim, role };
      if (levelSpec !== this.firstLevelSpec(dim)) a.level = levelSpec; // omit for the default level
      dimensions.push(a);
    };
    const c = this.categoryLevel(); if (c) axis(c, 'category');
    const s = this.seriesLevel(); if (s && !this.seriesBlocked()) axis(s, 'series');
    for (const f of this.filters()) {
      const a: CubeDimensionAssignment = { name: f.name, role: 'filter', member: f.member };
      if (f.level !== this.firstLevelSpec(f.name)) a.level = f.level;
      dimensions.push(a);
    }
    const sel: ChartSelection = { source: 'cube', cube, measures: effectiveMeasures } as ChartSelection;
    if (dimensions.length) (sel as any).dimensions = dimensions;
    return sel;
  });

  constructor() {
    // Adopt an incoming selection (edit mode). Reads ONLY the `selection` input; the picker
    // writes happen untracked so the effect never feeds its own dependencies.
    effect(() => {
      const incoming = this.selection();
      if (incoming) untracked(() => this.initFrom(incoming));
    });
    // Readiness, owned by the always-mounted builder (A3-PLAN-01): emit true when the pick is
    // complete, false the moment it goes incomplete (e.g. a later cube's shape errors/empties
    // and nulls `measure`). The preview cannot do this — it is unmounted while baseSelection is
    // null. Emitting an output is not a signal write, so this does not loop.
    effect(() => this.valid.emit(this.baseSelection() != null));
  }

  ngOnInit(): void {
    this.loadingCubes.set(true);
    this.svc.getChartableCubes().subscribe({
      next: (r) => { this.cubes.set(r?.cubes ?? []); this.loadingCubes.set(false); },
      error: () => { this.cubes.set([]); this.loadingCubes.set(false); },
    });
  }

  private initFrom(sel: CubeSelection): void {
    this.seedType.set(sel.chartType ?? null);
    this.seedUseAi.set(!!sel.useAi);
    this.cube.set(sel.cube);
    this.loadShape(sel.cube, sel);
  }

  onCubeChange(cube: string): void {
    if (!cube) return;
    this.cube.set(cube);
    this.seedType.set(null); // a fresh cube pick starts from Recommended
    this.loadShape(cube);
  }

  /**
   * Monotonic shape-load token (audit #5, mirrors chart-tile-view's reqToken): this builder can
   * re-pick a cube faster than a shape resolves, so two fetches can be in flight at once. Each
   * captures the token at start and re-checks it before every write; a superseded response is
   * dropped, so a slow earlier pick can never overwrite the shape of a fast later one.
   */
  private shapeToken = 0;

  /** Reset all picker state to empty (audit #9): clear the PRIOR cube's controls the moment a new
   *  shape starts loading, so nothing stale lingers under the loading indicator. Includes the ported
   *  filter draft + member cache (A-CTP-IMPL-01): members are cube-scoped, but the cache keys on level
   *  spec alone, so a shared spec would false-hit across cubes. The old tree shed this on unmount; the
   *  port moved it to the persistent parent, so the reset must be explicit here. */
  private clearPicks(): void {
    this.shape.set(null); this.measures.set([]); this.categoryLevel.set(null); this.seriesLevel.set(null);
    this.filters.set([]);
    this.draftFilterOpen.set(false); this.draftFilterLevel.set(null);
    this.memberCache.set({}); this.membersInFlight.clear();
  }

  /** Re-fetch the current cube's shape after an error (audit #1, the status' Retry). */
  retryShape(): void { const cube = this.cube(); if (cube) this.loadShape(cube); }

  /** Fetch the cube's SHAPE only (the preview tile owns the one /chart-data read). */
  private loadShape(cube: string, restore?: CubeSelection): void {
    const token = ++this.shapeToken;
    const current = () => token === this.shapeToken; // false once a newer load started
    this.clearPicks();
    this.unchartable.set(false); this.shapeError.set(false); this.loadingShape.set(true);
    this.svc.getCubeShape(cube).subscribe({
      next: (shape) => {
        if (!current()) return;                          // superseded pick — drop
        this.loadingShape.set(false);
        this.shape.set(shape);
        if (shape.measures.length === 0 || shape.dimensions.length === 0) {
          this.unchartable.set(true);
          return;
        }
        const specOf = (d: CubeDimensionAssignment): string | null =>
          d.level ?? this.firstLevelSpec(d.name) ?? null; // restore: explicit level, else first
        if (restore) {
          this.measures.set(restore.measures);
          const cat = restore.dimensions?.find((d) => d.role === 'category');
          const ser = restore.dimensions?.find((d) => d.role === 'series');
          this.categoryLevel.set(cat ? specOf(cat) : null);
          this.seriesLevel.set(ser ? specOf(ser) : null);
          this.filters.set((restore.dimensions ?? []).filter((d) => d.role === 'filter')
            .map((d) => ({ name: d.name, level: specOf(d)!, member: d.member! })));
        } else {
          this.measures.set([this.sortedMeasures()[0]!.name]);
          this.categoryLevel.set(this.categoryGroups()[0]!.levels[0]!.spec); // first dim's first level
          this.seriesLevel.set(null); this.filters.set([]);
        }
      },
      error: () => { if (!current()) return; this.loadingShape.set(false); this.shapeError.set(true); },
    });
  }

  addMeasure(name: string): void { if (name && !this.addMeasureBlocked() && !this.measures().includes(name)) this.measures.update((m) => [...m, name]); }
  removeMeasure(name: string): void { this.measures.update((m) => m.filter((x) => x !== name)); }
  onSizeMeasureChange(v: string): void { this.sizeMeasure.set(v); }
  onCategoryChange(levelSpec: string): void { this.categoryLevel.set(levelSpec || null); }
  onSeriesChange(levelSpec: string): void { if (!this.seriesBlocked()) this.seriesLevel.set(levelSpec || null); }

  /** Open the add-filter draft (a level picker + a member combobox). */
  openDraftFilter(): void { this.draftFilterOpen.set(true); this.draftFilterLevel.set(null); }

  /** Draft level chosen — eagerly fetch that level's members (never inside a getter → NG0100). */
  onDraftFilterLevel(levelSpec: string): void {
    this.draftFilterLevel.set(levelSpec || null);
    if (levelSpec) this.ensureMembers(levelSpec);
  }

  /** Commit the draft as a filter: {name: owning dim, level, member: <picked-or-typed value>}. The value may
   *  be a free-typed string the cube lacks (Karsten-approved value-space widening, spec §2). */
  commitFilter(value: string): void {
    const levelSpec = this.draftFilterLevel();
    const dim = this.dimOf(levelSpec);
    if (!levelSpec || !dim || !value) return;
    this.filters.update((f) => [...f, { name: dim, level: levelSpec, member: value }]);
    this.draftFilterOpen.set(false); this.draftFilterLevel.set(null);
  }
  removeFilter(name: string): void { this.filters.update((f) => f.filter((x) => x.name !== name)); }

  /** Fetch a level's members into the signal cache (idempotent; needs a loaded cube). Eager, never lazy.
   *  The response is dropped if the cube changed while it was in flight (A-CTP-IMPL-01, async): members
   *  are cube-scoped, so a slow prior-cube resolve must never write into the switched-to cube's cache
   *  (which clearPicks has already emptied) — mirrors loadShape's shapeToken supersede guard. */
  private ensureMembers(levelSpec: string): void {
    if (levelSpec in this.memberCache() || this.membersInFlight.has(levelSpec)) return;
    const cube = this.cube();
    const dim = this.dimOf(levelSpec);
    if (!cube || !dim) return;
    this.membersInFlight.add(levelSpec);
    this.svc.getCubeMembers(cube, dim, levelSpec).subscribe({
      next: (r) => {
        if (this.cube() !== cube) return;                        // superseded by a cube switch — drop the stale write
        this.memberCache.update((m) => ({ ...m, [levelSpec]: r.members })); this.membersInFlight.delete(levelSpec);
      },
      error: () => { this.membersInFlight.delete(levelSpec); },   // cache stays unset → datalist empty; free-type still commits
    });
  }

  // Pass the complete draft through UNMODIFIED (spec §5.3 / Round-2 note). Readiness is NOT
  // passed through — the always-mounted `valid` effect above owns it (A3-PLAN-01).
  onDraftChange(sel: ChartSelection): void {
    this.chosenType.set(sel.chartType ?? null);
    this.selectionChange.emit(sel);
  }

  humanizeField(name: string): string { return humanizeField(name); }
  humanizeCubeName(name: string): string { return humanizeCubeName(name); }
  disabledCubeLabel(c: ChartableCube): string { return disabledCubeLabel(c); }
}
