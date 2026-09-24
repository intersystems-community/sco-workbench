import { Injectable } from '@angular/core';

/**
 * User-defined KPI grouping, persisted locally.
 *
 * KPI definitions live in IRIS (the SCO scbi API) and the Workbench installs no
 * classes there, so a KPI's *group* is a Workbench-only organizational concept:
 * the user categorizes KPIs into groups of their own naming, and that mapping is
 * stored in the browser (localStorage), keyed by KPI name — not sent to IRIS.
 *
 * State shape (one JSON blob under `STORAGE_KEY`):
 *   - `groups`: the ordered list of group names the user has created.
 *   - `assign`: kpiName → groupName. A KPI with no entry is "Ungrouped".
 */

const STORAGE_KEY = 'sco-workbench.kpi-groups.v1';

/** The bucket for KPIs the user hasn't assigned to a custom group. */
export const UNGROUPED = 'Ungrouped';

interface GroupState {
  groups: string[];
  assign: Record<string, string>;
}

@Injectable({ providedIn: 'root' })
export class KpiGroupService {
  private state: GroupState = this.load();

  private load(): GroupState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { groups: [], assign: {} };
      const parsed = JSON.parse(raw) as Partial<GroupState>;
      return {
        groups: Array.isArray(parsed.groups) ? parsed.groups.filter((g) => typeof g === 'string') : [],
        assign: parsed.assign && typeof parsed.assign === 'object' ? { ...parsed.assign } : {},
      };
    } catch {
      // Corrupt/unavailable storage must never break the KPI page.
      return { groups: [], assign: {} };
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* storage full/unavailable — grouping is best-effort, not critical */
    }
  }

  /** The custom group names the user has created, in creation order. */
  groupNames(): string[] {
    return [...this.state.groups];
  }

  /** The group a KPI belongs to, or `UNGROUPED` if unassigned. */
  groupOf(kpiName: string): string {
    return this.state.assign[kpiName] || UNGROUPED;
  }

  /**
   * Create a group (no-op if it already exists or the name is blank). Returns the
   * normalized (trimmed) name, or '' if the input was blank.
   */
  createGroup(name: string): string {
    const g = name.trim();
    if (!g) return '';
    if (!this.state.groups.includes(g)) {
      this.state.groups = [...this.state.groups, g];
      this.persist();
    }
    return g;
  }

  /**
   * Assign a KPI to a group. A blank/`UNGROUPED` group clears the assignment.
   * Creates the group if it's new, so "type a new name" both makes and assigns it.
   */
  assign(kpiName: string, group: string): void {
    const g = group.trim();
    if (!g || g === UNGROUPED) {
      delete this.state.assign[kpiName];
    } else {
      this.createGroup(g);
      this.state.assign = { ...this.state.assign, [kpiName]: g };
    }
    this.persist();
  }

  /** Rename a KPI (e.g. after an edit renames it) so its group carries over. */
  renameKpi(oldName: string, newName: string): void {
    if (oldName === newName) return;
    const g = this.state.assign[oldName];
    if (g === undefined) return;
    const next = { ...this.state.assign };
    delete next[oldName];
    next[newName] = g;
    this.state.assign = next;
    this.persist();
  }

  /** Forget a deleted KPI's assignment. */
  forget(kpiName: string): void {
    if (this.state.assign[kpiName] === undefined) return;
    const next = { ...this.state.assign };
    delete next[kpiName];
    this.state.assign = next;
    this.persist();
  }

  /** The KPI names currently assigned to a group. */
  kpisInGroup(group: string): string[] {
    return Object.entries(this.state.assign)
      .filter(([, g]) => g === group)
      .map(([kpiName]) => kpiName);
  }

  /**
   * Delete a group: drop it from the group list AND clear every KPI's assignment
   * to it. (Deleting the KPIs themselves is the caller's responsibility — this
   * only owns the Workbench-local grouping.)
   */
  deleteGroup(group: string): void {
    this.state.groups = this.state.groups.filter((g) => g !== group);
    const next: Record<string, string> = {};
    for (const [kpiName, g] of Object.entries(this.state.assign)) {
      if (g !== group) next[kpiName] = g;
    }
    this.state.assign = next;
    this.persist();
  }
}
