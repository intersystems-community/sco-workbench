// frontend/src/app/dashboard/services/kpi-health.service.ts
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { shareReplay } from 'rxjs/operators';
import { apiUrl } from '../../core/api';

const BASE = (): string => apiUrl('/api/dashboard');

/** Mirror of the backend `KpiHealth` envelope (backend/src/dashboard/kpi-health.ts).
 *  Kept in lockstep like `ChartData` — the FE renders resolved values, never re-derives.
 *  A band's terminal `to` arrives as `null` on the wire (JSON has no Infinity). */
export interface KpiHealth {
  name: string;
  label: string;
  value: number | null;
  valueUnavailable?: boolean;
  threshold: {
    target: number;
    bands: { to: number | null; kind: 'ok' | 'watching' | 'warning'; color: string }[];
    status: 'ok' | 'watching' | 'warning' | null;
    statusColor: string | null;
  } | null;
  issues:
    | { baseObject: string; total: number; bySeverity: { severity: number; count: number }[] }
    | { baseObject: string; unavailable: true }
    | null;
}

@Injectable({ providedIn: 'root' })
export class KpiHealthService {
  private readonly http = inject(HttpClient);
  /** A single warmed fetch, keyed by KPI name. Replaced by a later prefetch; consumed single-use. */
  private slot: { name: string; obs: Observable<KpiHealth> } | null = null;

  /** Fetch a KPI's health envelope. Name-encoded like getKpiData (kpi.service.ts). */
  getKpiHealth(name: string): Observable<KpiHealth> {
    return this.http.get<KpiHealth>(`${BASE()}/kpi-health/${encodeURIComponent(name)}`);
  }

  /** Warm a KPI's health fetch so it starts at the expand CLICK, not a mount cycle later. Eagerly
   *  SUBSCRIBES (shareReplay alone is cold — it would not fire the GET until the panel subscribed), so
   *  the request is in flight before the overlay mounts; the buffered result is replayed to the panel. */
  prefetch(name: string): void {
    const obs = this.getKpiHealth(name).pipe(shareReplay(1));
    obs.subscribe({ error: () => {} }); // ignition + swallow errors (the panel re-reads and degrades)
    this.slot = { name, obs };
  }

  /** The prefetched observable when the slot matches `name` — consumed single-use so a re-open always
   *  starts a fresh fetch and no stale envelope can be replayed — else a fresh fetch. */
  getKpiHealthShared(name: string): Observable<KpiHealth> {
    const slot = this.slot;
    if (slot && slot.name === name) {
      this.slot = null; // single-use
      return slot.obs;
    }
    return this.getKpiHealth(name);
  }
}
