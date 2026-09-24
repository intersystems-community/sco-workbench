import { Component, OnInit, OnDestroy, ViewChild, HostListener, inject, afterEveryRender, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { WorkbenchBridgeService, type FeatureKey, type AgentPromptRequest, type WorkbenchPage, FEATURE_LABELS } from '../core/workbench-bridge.service';
import { KpiComponent } from '../kpi/kpi';
import { BiCubesComponent } from '../bi-cubes/bi-cubes';
import { DataIntegrationComponent } from '../data-integration/data-integration';
import { BusinessProcessComponent } from '../business-process/business-process';
import { IntroductionComponent } from '../introduction/introduction';
import { ResourcesComponent } from '../resources/resources';
import { DashboardComponent } from '../dashboard/dashboard';
import { OthersComponent } from '../others/others';
import { IssueManagementComponent } from '../issue-management/issue-management';
import { LoadSampleDataComponent } from '../load-sample-data/load-sample-data';
import { AssistantPanelComponent } from '../assistant/assistant-panel';
import { ToastHostComponent } from '../shared/toast-host';

interface NavItem {
  label: string;
  /** The activeView key this item maps to. Absent on a GROUP header: it's a
   *  heading over its children, not a page of its own. */
  view?: FeatureKey;
  /** A group header's own handle for tests/selectors — it has no view to name it
   *  by, and there is more than one heading, so "the group" is not an identity. */
  groupId?: string;
  /** This item is the current page. Never true for a group header — it owns no
   *  page, and its children are always visible to carry the highlight themselves. */
  active: boolean;
  /** Present on a group header only — the entries nested under it, always shown. */
  children?: NavItem[];
}

/** Docked assistant panel width bounds (px). */
const CHAT_MIN_WIDTH = 340;
/** Absolute ceiling on a huge display; the live max is also capped by viewport. */
const CHAT_MAX_WIDTH = 1200;
/**
 * Default/max are derived from the viewport so the dock is proportional to the
 * screen instead of a fixed 660px that swamps a laptop. The default is a share
 * of window width, the max never exceeds a larger share (so the workbench keeps
 * usable room), and both are clamped to sane pixel bounds.
 */
const CHAT_DEFAULT_FRACTION = 0.3; // ~30% of window width
const CHAT_MAX_FRACTION = 0.7; // dock can't exceed 70% of the viewport
const CHAT_DEFAULT_MAX_PX = 560; // don't start wider than this even on 4K
const CHAT_MIN_MAX_WIDTH = 480; // ensure the resize max is always usable

/** Pick a starting dock width proportional to the current viewport. */
function defaultChatWidth(viewportWidth: number): number {
  const proportional = Math.round(viewportWidth * CHAT_DEFAULT_FRACTION);
  return Math.min(CHAT_DEFAULT_MAX_PX, Math.max(CHAT_MIN_WIDTH, proportional));
}

/** The largest the dock may be dragged, given the current viewport. */
function maxChatWidth(viewportWidth: number): number {
  return Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_MAX_WIDTH, Math.round(viewportWidth * CHAT_MAX_FRACTION)));
}

@Component({
  selector: 'app-workbench',
  standalone: true,
  imports: [CommonModule, FormsModule, ResourcesComponent, DashboardComponent, DataIntegrationComponent, BiCubesComponent, KpiComponent, BusinessProcessComponent, IntroductionComponent, OthersComponent, IssueManagementComponent, LoadSampleDataComponent, AssistantPanelComponent, ToastHostComponent],
  templateUrl: './workbench.html',
  styleUrl: './workbench.css',
})
export class WorkbenchComponent implements OnInit, OnDestroy {
  private readonly bridge = inject(WorkbenchBridgeService);
  private readonly cdr = inject(ChangeDetectorRef);
  /** The page on screen. Typed as FeatureKey so the shell, the bridge and the
   *  assistant's page keys can never drift apart. */
  activeView: FeatureKey = 'introduction';

  /** Shown at the bottom of the sidebar. */
  readonly appVersion = '1.0.0';

  private navSub?: Subscription;
  private agentPromptSub?: Subscription;

  // Two-level nav: a "Getting Started" heading over the pages you read/run first,
  // then the feature pages under "Features", then Dashboard. Labels come from
  // FEATURE_LABELS so the sidebar and the assistant context badge never drift; a
  // group header has no FeatureKey because it is a heading, not a page.
  navItems: NavItem[] = [
    {
      label: 'Getting Started', groupId: 'getting-started', active: false,
      children: [
        { view: 'introduction',      label: FEATURE_LABELS['introduction'],      active: true  },
        { view: 'load-sample-data', label: FEATURE_LABELS['load-sample-data'], active: false },
      ],
    },
    {
      label: 'Features', groupId: 'features', active: false,
      children: [
        { view: 'data-model',       label: FEATURE_LABELS['data-model'],       active: false },
        { view: 'data-integration', label: FEATURE_LABELS['data-integration'], active: false },
        { view: 'bi-cubes',         label: FEATURE_LABELS['bi-cubes'],         active: false },
        { view: 'kpi',              label: FEATURE_LABELS['kpi'],              active: false },
        { view: 'issue-management', label: FEATURE_LABELS['issue-management'], active: false },
        { view: 'business-process', label: FEATURE_LABELS['business-process'], active: false },
        { view: 'others',           label: FEATURE_LABELS['others'],           active: false },
      ],
    },
    { view: 'dashboard',        label: FEATURE_LABELS['dashboard'],        active: false },
  ];

  /** Assistant docking state. */
  chatOpen = false;
  /** Dock width — seeded proportional to the viewport (falls back to a mid value
   *  during SSR/no-window), then kept responsive until the user drags it. */
  chatWidth = typeof window !== 'undefined' ? defaultChatWidth(window.innerWidth) : 480;
  /** Once the user drags the divider we stop auto-adjusting the width on resize. */
  private userSizedChat = false;
  private resizing = false;
  private resizeStartX = 0;
  private resizeStartWidth = 0;

  /**
   * Floating-assistant-button position. null = the default CSS corner
   * (bottom-right); once the user drags it we pin explicit right/bottom offsets
   * (measured from the viewport edges so it stays put on resize).
   */
  fabPos: { right: number; bottom: number } | null = null;
  private fabDragging = false;
  private fabMoved = false;
  private fabStartX = 0;
  private fabStartY = 0;
  private fabStartRight = 0;
  private fabStartBottom = 0;
  /** Past this px of movement a press counts as a drag (not a click that opens chat). */
  private static readonly FAB_DRAG_THRESHOLD = 4;
  /** FAB size + viewport margin, used to clamp it on-screen. */
  private static readonly FAB_SIZE = 52;
  private static readonly FAB_MARGIN = 8;

  @ViewChild(AssistantPanelComponent) private assistant?: AssistantPanelComponent;

  // ── URL state (`?view=` + `?item=`) ──────────────────────────────
  /** What the query string currently says, as last written by this component. Kept
   *  so the mirror only navigates when something actually changed. */
  private urlView: FeatureKey | null = null;
  private urlItem: string | null = null;
  /** True while a `?item=` read off the URL is being re-opened. The page reports no
   *  open item until that lands, so mirroring during the restore would strip the
   *  token from the URL — and a refresh mid-restore would then lose it for good. */
  private restoringItem = false;

  constructor(private router: Router, private route: ActivatedRoute) {
    // Mirror the on-screen page + item into the URL after every render. This is a
    // READ of the mounted feature's own state (see WorkbenchBridgeService.
    // currentItemToken) rather than a push from each place a selection changes — a
    // feature selects, clears, deletes and reloads items from many call sites, and
    // any one of them forgetting to notify would leave the URL pointing at an item
    // that is no longer on screen. A render is exactly when that state can have
    // changed, and the guard below makes a no-change render free.
    afterEveryRender(() => this.syncUrl());
  }

  ngOnInit(): void {
    // Publish the nav we actually render, so the assistant's page list (and every
    // guided navigation) follows the sidebar instead of a hardcoded copy of it.
    this.bridge.setPages(this.navPages());

    const view = this.route.snapshot.queryParamMap.get('view');
    let viewRestored = false;
    if (view) {
      // Only adopt a `?view=` that names a real nav entry — an unknown value must
      // leave the sidebar highlight (and the page) alone.
      if (this.markActiveNav(view)) {
        this.activeView = view as FeatureKey;
        viewRestored = true;
      }
    }
    // Keep the shared bridge in sync so the assistant knows the current page.
    this.bridge.activeView.set(this.activeView);
    // `?item=` belongs to the page in `?view=` — re-open it so a refresh lands back
    // on the item the user was looking at, not the page's overview. Ignored when the
    // view wasn't restored: the token would name an item on a page we're not on.
    const item = this.route.snapshot.queryParamMap.get('item');
    if (viewRestored && item) this.restoreItemFromUrl(item);
    // Guided mode drives the UI: when a directive requests a page, switch to it.
    this.navSub = this.bridge.navRequests$.subscribe((view) => {
      if (view !== this.activeView) {
        this.selectView(view);
        // A guided navigate often opens the assistant to show the guidance — but
        // never where the chat is disallowed (Dashboard, SC-2685).
        if (this.chatAllowed) this.chatOpen = true;
        // Zoneless: chatOpen/activeView here are plain fields, so mutating them
        // from this RxJS callback marks nothing dirty. Request a CD pass so the
        // dock open state and `--toast-offset` re-render (mirrors the markForCheck
        // in runPromptWhenPanelReady, which flags the same NG0100 hazard).
        this.cdr.markForCheck();
      }
    });
    // A feature button (e.g. Data Integration Deploy) delegates work to the
    // agent: open the chat so the user watches progress, then run the prompt. The
    // panel is always mounted (hidden with a class when closed), so the @ViewChild
    // resolves immediately; runPromptWhenPanelReady still tolerates a not-yet-
    // resolved ViewChild on very first paint.
    this.agentPromptSub = this.bridge.agentPrompts$.subscribe((req) => {
      // Feature buttons that delegate to the agent live on non-Dashboard pages;
      // guard anyway so the chat never opens where it's disallowed (SC-2685).
      if (this.chatAllowed) this.chatOpen = true;
      this.runPromptWhenPanelReady(req);
    });
  }

  /**
   * Dispatch a programmatic prompt to the docked assistant. The panel is always
   * mounted (hidden via a class when closed), so its @ViewChild is normally already
   * resolved; we still poll briefly for the very first paint. This app is ZONELESS,
   * so we request a CD pass (markForCheck) and retry on a macrotask rather than
   * force a reentrant tick() (which throws NG0100 as `--toast-offset` changes with
   * chatOpen). Bounded so it can't spin forever.
   */
  private runPromptWhenPanelReady(req: AgentPromptRequest, attempt = 0): void {
    this.cdr.markForCheck();
    if (this.assistant) {
      this.assistant.runPrompt(req.prompt, req.displayText, req.freshSession);
      return;
    }
    if (attempt >= 50) return; // ~5s ceiling; give up rather than loop forever
    setTimeout(() => this.runPromptWhenPanelReady(req, attempt + 1), 100);
  }

  ngOnDestroy(): void {
    this.navSub?.unsubscribe();
    this.agentPromptSub?.unsubscribe();
  }

  /**
   * A guided highlight persists until the user takes an action. Any click
   * outside the assistant panel counts as "taking action" and clears it — so it
   * survives the assistant's own streaming/rendering (which happens inside the
   * panel) but goes away the moment the user clicks the highlighted control (or
   * anywhere else on the workbench).
   */
  @HostListener('document:click', ['$event'])
  onWorkbenchClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('.assistant-dock')) return; // clicks in the chat don't clear
    this.bridge.clearHighlight();
  }

  /** The AI Assistant chat is unavailable on the Dashboard page (SC-2685). This
   *  gates the launcher, the dock, and every programmatic open path in one place. */
  get chatAllowed(): boolean {
    return this.chatAllowedOn(this.activeView);
  }

  /** The same rule for an arbitrary page — used when publishing the page list, so
   *  the assistant knows which page would close the dock underneath it. */
  private chatAllowedOn(view: FeatureKey): boolean {
    return view !== 'dashboard';
  }

  /**
   * Flatten the rendered sidebar into the page list the assistant is told about:
   * one entry per navigable page, with its group heading and whether the assistant
   * dock survives there. `navItems` is the single source of truth — a page added
   * to or removed from it changes what the assistant sees on the very next turn,
   * with nothing else to update.
   */
  private navPages(): WorkbenchPage[] {
    const pages: WorkbenchPage[] = [];
    const add = (item: NavItem, group?: string): void => {
      // A group header owns no page (no `view`), so it is a heading, not a destination.
      if (!item.view) return;
      pages.push({
        key: item.view,
        label: item.label,
        ...(group ? { group } : {}),
        assistantAvailable: this.chatAllowedOn(item.view),
      });
    };
    for (const item of this.navItems) {
      if (item.children) {
        for (const child of item.children) add(child, item.label);
        continue;
      }
      add(item);
    }
    return pages;
  }

  toggleChat(): void {
    // Never open the chat where it isn't allowed (Dashboard). Always permit closing.
    if (!this.chatAllowed) {
      this.chatOpen = false;
      return;
    }
    this.chatOpen = !this.chatOpen;
    // The panel is always mounted now (so background sessions survive a close), so
    // its ngOnInit no longer re-runs per open — refresh the session list on open so
    // history reflects sessions that finished/started while the dock was closed.
    if (this.chatOpen) void this.assistant?.refreshSessions();
  }

  /** Panel header actions delegate to the embedded assistant. */
  newChat(): void {
    this.assistant?.newSession();
  }
  toggleChatHistory(): void {
    this.assistant?.toggleHistory();
  }

  /** Drag-to-resize the docked panel from its left edge. */
  startResize(event: PointerEvent): void {
    this.resizing = true;
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.chatWidth;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  onResizeMove(event: PointerEvent): void {
    if (!this.resizing) return;
    // A manual drag pins the width — stop auto-adjusting it on window resize.
    this.userSizedChat = true;
    // Dragging left (smaller clientX) widens the right-docked panel. The max is
    // viewport-relative so the dock can't be dragged to swamp the workbench.
    const delta = this.resizeStartX - event.clientX;
    const next = this.resizeStartWidth + delta;
    this.chatWidth = Math.min(maxChatWidth(window.innerWidth), Math.max(CHAT_MIN_WIDTH, next));
  }

  /**
   * Keep the dock proportional to the window until the user manually resizes it.
   * After a manual drag we only re-clamp (so a shrinking window can't push the
   * dock past its viewport-relative max), never override the chosen width.
   */
  @HostListener('window:resize')
  onWindowResize(): void {
    const vw = window.innerWidth;
    if (this.userSizedChat) {
      this.chatWidth = Math.min(maxChatWidth(vw), Math.max(CHAT_MIN_WIDTH, this.chatWidth));
    } else {
      this.chatWidth = defaultChatWidth(vw);
    }
  }
  endResize(event: PointerEvent): void {
    if (!this.resizing) return;
    this.resizing = false;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  // ── Draggable assistant button (FAB) ─────────────────────────────
  /**
   * Begin dragging the floating assistant button. We track movement and only
   * treat it as a drag once it passes a small threshold — so a plain click still
   * opens the chat (fabClick checks `fabMoved`). Positions are kept as right/
   * bottom offsets so the button stays anchored relative to the viewport edges.
   */
  startFabDrag(event: PointerEvent): void {
    this.fabDragging = true;
    this.fabMoved = false;
    this.fabStartX = event.clientX;
    this.fabStartY = event.clientY;
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    this.fabStartRight = window.innerWidth - rect.right;
    this.fabStartBottom = window.innerHeight - rect.bottom;
    el.setPointerCapture?.(event.pointerId);
  }
  onFabDrag(event: PointerEvent): void {
    if (!this.fabDragging) return;
    const dx = event.clientX - this.fabStartX;
    const dy = event.clientY - this.fabStartY;
    if (!this.fabMoved && Math.hypot(dx, dy) < WorkbenchComponent.FAB_DRAG_THRESHOLD) return;
    this.fabMoved = true;
    // Dragging right/down shrinks the right/bottom offsets; clamp on-screen.
    const maxRight = window.innerWidth - WorkbenchComponent.FAB_SIZE - WorkbenchComponent.FAB_MARGIN;
    const maxBottom = window.innerHeight - WorkbenchComponent.FAB_SIZE - WorkbenchComponent.FAB_MARGIN;
    const clamp = (v: number, max: number) => Math.min(Math.max(v, WorkbenchComponent.FAB_MARGIN), max);
    this.fabPos = {
      right: clamp(this.fabStartRight - dx, maxRight),
      bottom: clamp(this.fabStartBottom - dy, maxBottom),
    };
  }
  endFabDrag(event: PointerEvent): void {
    if (!this.fabDragging) return;
    this.fabDragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }
  /** Open the chat only when the press was a click, not the end of a drag. */
  onFabClick(): void {
    if (this.fabMoved) {
      this.fabMoved = false;
      return;
    }
    this.toggleChat();
  }

  setActiveNav(item: NavItem): void {
    // A group header is a label, not a page — and its children are always on show,
    // so there is nothing for a click on it to do.
    if (item.children) return;
    this.selectView((item.view ?? 'introduction') as FeatureKey);
  }

  /**
   * Point the sidebar highlight at `view`, wherever it sits in the hierarchy. A
   * group header never takes the highlight itself: its children are always visible,
   * so the one that IS the current page shows it.
   *
   * Returns whether `view` matched a nav entry at all; a view that matches nothing
   * (e.g. a hand-typed `?view=`) leaves the highlight untouched rather than
   * clearing it, so the sidebar can't end up pointing at no page while one is open.
   */
  private markActiveNav(view: string): boolean {
    const owns = (item: NavItem) =>
      item.view === view || !!item.children?.some((c) => c.view === view);
    if (!this.navItems.some(owns)) return false;

    let matched = false;
    for (const item of this.navItems) {
      if (!item.children) {
        item.active = item.view === view;
        if (item.active) matched = true;
        continue;
      }
      item.active = false;
      for (const child of item.children) {
        child.active = child.view === view;
        if (child.active) matched = true;
      }
    }
    return matched;
  }

  /**
   * Switch the active feature view, update the sidebar highlight, mirror it to
   * the `?view=` query param, and keep the shared bridge in sync (so the
   * assistant's UI-context reflects the current page). Used by the sidebar and
   * by Guided-mode navigate directives.
   *
   * Before switching, ask the mounted feature whether it's safe to leave. If it
   * has unsaved edits it BLOCKS the switch and shows its own "Save draft / Leave
   * / Keep editing" dialog; the actual switch runs from the deferred `proceed`
   * callback only if the user chooses to leave (or save-then-leave). A no-op
   * switch to the same view skips the guard.
   */
  selectView(view: FeatureKey): void {
    if (view === this.activeView) return;
    const proceed = () => this.doSelectView(view);
    if (this.bridge.canLeaveActive(proceed)) proceed();
  }

  private doSelectView(view: FeatureKey): void {
    this.markActiveNav(view);
    this.activeView = view;
    this.bridge.activeView.set(view);
    // The Assistant is unavailable on the Dashboard (SC-2685) — close the dock if
    // the user navigates there while it's open, so it can't linger on that page.
    if (!this.chatAllowed) this.chatOpen = false;
    // A page switch abandons any restore still waiting on the page we just left,
    // so the mirror is free to write the new page's (empty) item straight away.
    this.restoringItem = false;
    // Write `?view=` now rather than waiting for the render hook, so the URL is
    // right even if nothing re-renders; syncUrl is idempotent, so the hook that
    // follows this switch is a no-op.
    this.syncUrl();
  }

  /**
   * Mirror the page on screen — and the item that page has open — into the query
   * string, so a refresh (or a copied URL) comes back to the same place. Runs after
   * every render and exits immediately unless something changed, because the item
   * is READ from the mounted feature rather than pushed by it (see
   * WorkbenchBridgeService.currentItemToken).
   *
   * `replaceUrl` keeps selections out of the browser history: Back should leave the
   * workbench the way it always has, not walk back through every item the user
   * clicked.
   */
  private syncUrl(): void {
    // Mid-restore the page hasn't re-opened the item yet and so reports none;
    // writing that would erase the very token we're restoring.
    if (this.restoringItem) return;
    const item = this.bridge.currentItemToken();
    if (this.activeView === this.urlView && item === this.urlItem) return;
    this.urlView = this.activeView;
    this.urlItem = item;
    this.router.navigate([], {
      queryParams: { view: this.activeView, ...(item ? { item } : {}) },
      replaceUrl: true,
    });
  }

  /**
   * Re-open the item named by `?item=` on the restored page. Best-effort by design:
   * the page may have finished loading its list before or after this runs, and the
   * item may be gone (deleted, or a stale bookmark) — either way the page is left on
   * its overview and the mirror drops the token from the URL. Nothing is reported to
   * the user; a URL that no longer resolves is not an error they caused.
   */
  private restoreItemFromUrl(token: string): void {
    this.restoringItem = true;
    this.urlView = this.activeView;
    this.urlItem = token; // what the URL already says, so a hit re-writes nothing
    void this.bridge.restoreItem(this.activeView, token).then(() => {
      this.restoringItem = false;
      // Zoneless: this resolves outside any template event, so ask for a CD pass —
      // it both paints the restored item and runs the render hook that reconciles
      // the URL (dropping the token when the restore found nothing).
      this.cdr.markForCheck();
    });
  }
}
