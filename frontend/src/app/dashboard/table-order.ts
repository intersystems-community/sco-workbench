// frontend/src/app/dashboard/table-order.ts
//
// Populated-first ordering for the Table picker (Change 6 / M2), the D1-side sibling
// of Change 1's chartable-first cube ordering. Empty tables stay SELECTABLE (an empty
// table still usefully shows its columns/schema) — only the ORDER changes, so the two
// panels feel like one system. Pure; the backend's within-group order is preserved.
import type { ScObjectSummary } from '../services/sc-model.types';
import type { CountResult } from '../services/data-browser.service';

/**
 * Objects reordered: populated first, then known-empty. A table is "empty" only when
 * its count is known AND zero (`ok && total === 0`). Unknown counts — still loading
 * (no map entry) or failed (`!ok`) — sort with the populated group, since we do not
 * yet know they are empty (M4 surfaces the unknown-count case separately). Array order
 * within each group is preserved (a stable partition).
 */
export function orderPopulatedFirst(
  objects: readonly ScObjectSummary[],
  counts: Record<string, CountResult>,
): ScObjectSummary[] {
  const isEmpty = (o: ScObjectSummary): boolean => {
    const c = counts[o.className];
    return !!c && c.ok && c.total === 0;
  };
  const populated = objects.filter((o) => !isEmpty(o));
  const empty = objects.filter(isEmpty);
  return [...populated, ...empty];
}
