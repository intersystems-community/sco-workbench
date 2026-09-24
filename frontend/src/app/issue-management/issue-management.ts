import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { WorkbenchBridgeService, type GuidedFormController, type SetFieldResult } from '../core/workbench-bridge.service';
import {
  IssueService,
  type IssueBand,
  type IssueCategoryGroup,
  type IssueCounts,
  type IssueDetail,
  type IssueRow,
} from '../services/issue.service';

interface CategoryItem {
  group: IssueCategoryGroup;
  value: string;
  label: string;
}

interface NavGroup {
  id: IssueCategoryGroup;
  label: string;
  items: CategoryItem[];
  expanded: boolean;
}

/** SCO's severity/urgency integers are shown as three bands. */
const BANDS: readonly IssueBand[] = ['High', 'Medium', 'Low'];

/** The nav dimensions a `?item=` deep-link token may name — anything else in the
 *  URL is rejected rather than queried. */
const CATEGORY_GROUPS: readonly IssueCategoryGroup[] = ['kpi', 'severity', 'workqueue'];

/**
 * How many table rows the assistant's context snapshot lists. The snapshot goes
 * out with EVERY assistant turn and a category holds up to 1000 rows, so the
 * list is capped and the snapshot says how many were left out.
 */
export const SNAPSHOT_ROW_CAP = 25;

@Component({
  selector: 'app-issue-management',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './issue-management.html',
  styleUrl: './issue-management.css',
})
export class IssueManagementComponent implements OnInit, OnDestroy {
  navGroups: NavGroup[] = [];

  readonly counts = signal<IssueCounts | null>(null);
  readonly countsError = signal<string | null>(null);

  readonly selectedCategory = signal<CategoryItem | null>(null);
  readonly issues = signal<IssueRow[]>([]);
  /** Issues matching the category — larger than issues() when the list is capped. */
  readonly totalCount = signal(0);
  readonly truncated = signal(false);
  readonly listCap = signal(0);
  readonly loadingList = signal(false);
  readonly listError = signal<string | null>(null);

  readonly selectedIssue = signal<IssueDetail | null>(null);
  readonly loadingIssue = signal(false);
  readonly issueError = signal<string | null>(null);

  /**
   * Registered on the bridge so the assistant can see what is on screen — the nav
   * counts, the selected category, the rows in the table and the open issue — and
   * answer questions about them. The page has no editable form, so the form hooks
   * are stubs and setField reports that rather than silently doing nothing.
   */
  private readonly guidedController: GuidedFormController = {
    feature: 'issue-management',
    openNewForm: () => {},
    setField: () => ({ applied: false, detail: 'The Issue Management page has no editable form.' }),
    highlight: () => {},
    snapshot: () => this.pageSnapshot(),
    whenListReady: () => this.countsReady,
    openEntity: (name: string) => this.openKpiIssues(name),
    // Deep link: what is on screen (a category, and the issue open within it), and
    // how to get back to it on reload.
    currentItem: () => this.deepLinkToken(),
    restoreItem: (token) => this.restoreFromToken(token),
  };

  /**
   * This page's `?item=` token. Unlike the other features an "item" here is two
   * levels — the category slice and, optionally, the one issue open inside it — so
   * the token carries both: `kpi|Fill Rate` or `kpi|Fill Rate|#<uid>`. The shell
   * treats it as opaque; only `restoreFromToken` below reads it.
   */
  private deepLinkToken(): string | null {
    const cat = this.selectedCategory();
    if (!cat) return null;
    const issue = this.selectedIssue();
    return `${cat.group}|${cat.value}${issue ? `|#${issue.uid}` : ''}`;
  }

  /**
   * Re-open the category (and issue) a `?item=` token names after a page reload.
   * Returns false for a token this page can't read — an unknown category group, or a
   * missing category value — so the shell drops it and leaves the intro on screen.
   *
   * An issue that no longer exists is NOT a failure: the category is still valid and
   * restoring it is most of what the user wants, so we land there and let the URL
   * mirror drop the `#uid` on its own.
   */
  private async restoreFromToken(token: string): Promise<boolean> {
    const parts = token.split('|');
    const group = parts[0] ?? '';
    if (!isCategoryGroup(group)) return false;
    // The uid rides in a trailing `|#…` segment, so a category value containing a
    // "|" of its own still parses.
    const last = parts.length > 2 ? parts[parts.length - 1]! : '';
    const uid = last.startsWith('#') ? last.slice(1) : '';
    const value = (uid ? parts.slice(1, -1) : parts.slice(1)).join('|');
    if (!value) return false;

    // Prefer the nav's own label (the Work Queue entry reads "Pending Actions", not
    // "all"); fall back to the value for a KPI the nav hasn't listed.
    const listed = this.navGroups
      .find((g) => g.id === group)?.items
      .find((i) => i.value === value);
    this.selectCategory(listed ?? { group, value, label: value });
    if (uid) await this.reopenIssue(uid);
    return true;
  }

  /** Re-open one issue by uid for a deep link, reading its detail straight from SCO
   *  (the list row it would normally come from may not have loaded yet, and the
   *  detail read returns every field the row carries). A uid SCO no longer knows
   *  leaves the category's list on screen, with no error: the link is just stale. */
  private async reopenIssue(uid: string): Promise<void> {
    this.loadingIssue.set(true);
    try {
      const res = await firstValueFrom(this.issueService.get(uid));
      this.selectedIssue.set(res.issue);
    } catch {
      this.selectedIssue.set(null);
    } finally {
      this.loadingIssue.set(false);
    }
  }

  /** Resolves once the nav counts have loaded (or failed), so a guided navigate
   *  hands the assistant a settled page rather than a loading one. */
  private resolveCountsReady!: () => void;
  private readonly countsReady = new Promise<void>((res) => { this.resolveCountsReady = res; });

  constructor(
    private issueService: IssueService,
    private bridge: WorkbenchBridgeService,
  ) {}

  ngOnInit(): void {
    this.bridge.register(this.guidedController);
    // The KPI group is built from the data (which KPIs actually raised issues);
    // the other groups are fixed dimensions and render even if counts fail.
    this.buildNav([]);
    this.issueService.counts().subscribe({
      next: (res) => {
        this.counts.set(res.counts);
        this.buildNav(Object.keys(res.counts.byKpi).sort());
        this.resolveCountsReady();
      },
      error: (err) => {
        this.countsError.set(messageOf(err));
        this.resolveCountsReady();
      },
    });
  }

  ngOnDestroy(): void {
    this.bridge.unregister(this.guidedController);
  }

  /**
   * What the assistant sees of this page. Three states — the intro, a category's
   * issue list, one open issue — plus the nav counts in all three, so questions
   * like "how many high-severity issues are there?" are answerable from any of them.
   */
  private pageSnapshot(): Record<string, unknown> {
    const counts = this.counts();
    const nav: Record<string, unknown> = counts
      ? {
          totalIssues: counts.total,
          issuesByKpi: counts.byKpi,
          issuesBySeverity: counts.bySeverity,
          workQueueIssues: counts.workQueue,
        }
      : { navCounts: this.countsError() ?? 'still loading' };

    const issue = this.selectedIssue();
    if (issue) {
      return {
        mode: 'viewing one issue',
        ...nav,
        openIssue: issue,
        ...(this.loadingIssue() ? { detailStatus: 'still loading' } : {}),
        ...(this.issueError() ? { detailError: this.issueError() } : {}),
      };
    }

    const category = this.selectedCategory();
    if (!category) {
      return { mode: 'the page intro — no category selected yet', ...nav };
    }
    const rows = this.issues();
    return {
      mode: 'viewing the issue list',
      selectedCategory: `${this.categoryGroupLabel} — ${category.label}`,
      matchingIssues: this.totalCount(),
      ...(this.truncated() ? { rowsShownOnScreen: this.listCap() } : {}),
      ...(this.loadingList() ? { listStatus: 'still loading' } : {}),
      ...(this.listError() ? { listError: this.listError() } : {}),
      ...nav,
      visibleIssues: rows.slice(0, SNAPSHOT_ROW_CAP),
      ...(rows.length > SNAPSHOT_ROW_CAP
        ? {
            visibleIssuesNote:
              `only the first ${SNAPSHOT_ROW_CAP} of ${rows.length} rows on screen are listed here`,
          }
        : {}),
    };
  }

  private buildNav(kpis: string[]): void {
    const expanded = new Map(this.navGroups.map((g) => [g.id, g.expanded]));
    this.navGroups = [
      {
        id: 'kpi',
        label: 'By KPI',
        expanded: expanded.get('kpi') ?? true,
        items: kpis.map((k) => ({ group: 'kpi' as const, value: k, label: k })),
      },
      {
        id: 'severity',
        label: 'By Severity',
        expanded: expanded.get('severity') ?? true,
        items: BANDS.map((s) => ({ group: 'severity' as const, value: s, label: s })),
      },
      {
        id: 'workqueue',
        label: 'Work Queue',
        expanded: expanded.get('workqueue') ?? true,
        items: [{ group: 'workqueue' as const, value: 'all', label: 'Pending Actions' }],
      },
    ];
  }

  /** The badge count, or null while counts are loading or unavailable. */
  issueCount(item: CategoryItem): number | null {
    const c = this.counts();
    if (!c) return null;
    switch (item.group) {
      case 'kpi':
        return c.byKpi[item.value] ?? 0;
      case 'severity':
        return c.bySeverity[item.value as IssueBand] ?? 0;
      case 'workqueue':
        return c.workQueue;
    }
  }

  isActive(item: CategoryItem): boolean {
    const cat = this.selectedCategory();
    return !!cat && cat.group === item.group && cat.value === item.value;
  }

  /**
   * External deep-link entry (a Dashboard KPI-tile issue click, or the assistant's
   * open_entity directive): show the issues for KPI `name`. The slice is queried from
   * SCO by name, not from the nav's byKpi group, so a KPI with no matching issues lands
   * on its (empty) list — the existing "No issues in this category" state — rather than
   * crashing or bailing to the intro.
   *
   * selectCategory fires IMMEDIATELY, BEFORE awaiting countsReady (SC-2663 Bug 2): on a
   * large instance the counts() aggregation is slow, and awaiting it first left the user on
   * the intro with no feedback for the whole delay. Selecting first shows the "By KPI —
   * <kpi>" header and the list spinner at once; the nav badges (fed only by counts) fill in
   * later. We still await countsReady before returning so the assistant's tool result carries
   * a settled page snapshot rather than a still-loading one.
   */
  private async openKpiIssues(name: string): Promise<SetFieldResult> {
    const kpi = (name ?? '').trim();
    if (!kpi) return { applied: false, detail: 'A KPI name is required.' };
    this.selectCategory({ group: 'kpi', value: kpi, label: kpi });
    await this.countsReady;
    return { applied: true, detail: `Showing issues for KPI "${kpi}".` };
  }

  selectCategory(item: CategoryItem): void {
    this.selectedCategory.set(item);
    this.selectedIssue.set(null);
    this.issues.set([]);
    this.totalCount.set(0);
    this.truncated.set(false);
    this.listError.set(null);
    this.loadingList.set(true);
    this.issueService.list(item.group, item.value).subscribe({
      next: (page) => {
        // A category selected while an earlier request was in flight wins.
        if (!this.isActive(item)) return;
        this.issues.set(page.issues);
        this.totalCount.set(page.totalCount);
        this.truncated.set(page.truncated);
        this.listCap.set(page.cap);
        this.loadingList.set(false);
      },
      error: (err) => {
        if (!this.isActive(item)) return;
        this.listError.set(messageOf(err));
        this.loadingList.set(false);
      },
    });
  }

  /** The row carries only list fields; the detail pane needs a second read. */
  selectIssue(row: IssueRow): void {
    this.selectedIssue.set({
      ...row,
      triggerType: null,
      issueData: null,
      resolutionNote: null,
      latestAnalysis: null,
    });
    this.issueError.set(null);
    this.loadingIssue.set(true);
    this.issueService.get(row.uid).subscribe({
      next: (res) => {
        if (this.selectedIssue()?.uid !== row.uid) return;
        this.selectedIssue.set(res.issue);
        this.loadingIssue.set(false);
      },
      error: (err) => {
        if (this.selectedIssue()?.uid !== row.uid) return;
        this.issueError.set(messageOf(err));
        this.loadingIssue.set(false);
      },
    });
  }

  back(): void {
    this.selectedIssue.set(null);
    this.issueError.set(null);
  }

  /** Shown when SCO has no analysis detail for the issue — the Business Process
   *  page explains how issues get analyzed and resolved. */
  openBusinessProcess(): void {
    this.bridge.setActiveView('business-process');
  }

  toggleGroup(group: NavGroup): void {
    group.expanded = !group.expanded;
  }

  get categoryGroupLabel(): string {
    const cat = this.selectedCategory();
    return this.navGroups.find((g) => g.id === cat?.group)?.label ?? '';
  }

  /** A band that SCO has not set renders as a neutral chip, not as "Low". */
  bandClass(band: IssueBand | null): string {
    return band ? band.toLowerCase() : 'none';
  }

  bandLabel(band: IssueBand | null): string {
    return band ?? 'Not set';
  }

  statusClass(status: string): string {
    return status.toLowerCase().replace(/ /g, '-');
  }

  pluralIssues(n: number): string {
    return n === 1 ? '1 issue' : `${n} issues`;
  }
}

/** A `?item=` token comes from the URL, so its category group is untrusted text. */
function isCategoryGroup(value: string): value is IssueCategoryGroup {
  return (CATEGORY_GROUPS as readonly string[]).includes(value);
}

/** The backend's error envelope is { error, code } (see error-middleware.ts). */
function messageOf(err: unknown): string {
  const e = err as { error?: { error?: string }; message?: string } | null;
  return e?.error?.error || e?.message || 'Could not load issues.';
}
