import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { apiUrl } from '../core/api';

// Resolved per call (not at module load) so the runtime-configured API base is used.
const BASE = (): string => apiUrl('/api/data-browser');

/**
 * The outcome of a count request. Deliberately a discriminated union rather
 * than `number | null`: the route goes to the trouble of computing a reason
 * (a not-found class with nearest candidates, or an upstream message), and the
 * "count unavailable" tooltip cannot explain itself without it. A null-returning
 * count method is exactly the shape of the bug this replaces.
 */
export type CountResult =
  | { ok: true; total: number; className: string; sqlTableName: string }
  | { ok: false; error: string; candidates: string[] };

interface CountBody {
  className: string;
  sqlTableName: string;
  total: number;
}

/** The backend per-item shape (className is the map key, so it is not repeated). */
interface CountsBody {
  counts: Record<string, { ok: true; total: number; sqlTableName: string } | { ok: false; error: string }>;
}

/**
 * Client for the workbench's own `/api/data-browser` route — separate from
 * `ScDataService` because it targets a local route, not the scdata proxy
 * surface. See `backend/src/iris/row-count-ops.ts` for why the count needs SQL
 * at all (scdata sends no total-count header).
 */
@Injectable({ providedIn: 'root' })
export class DataBrowserService {
  private readonly http = inject(HttpClient);

  /** Exact row total for an scmodel `className`, e.g. `SC.Data.BOM`. Never errors. */
  getCount(className: string): Observable<CountResult> {
    return this.http.get<CountBody>(`${BASE()}/${encodeURIComponent(className)}/count`).pipe(
      map((body): CountResult => ({
        ok: true,
        total: body.total,
        className: body.className,
        sqlTableName: body.sqlTableName,
      })),
      catchError((err: unknown) => of(toFailure(err))),
    );
  }

  /**
   * Bulk counts for the Table dropdown — one round trip for every table. Never
   * errors: a transport failure resolves to an empty map so the dropdown still
   * lists every table by name. Each success entry backfills `className` from the
   * map key (the backend omits it) so both count surfaces share the CountResult
   * shape; each failure entry carries `candidates: []` (the batch path computes
   * no nearest-match suggestions).
   */
  getCounts(classNames: string[]): Observable<Record<string, CountResult>> {
    return this.http.post<CountsBody>(`${BASE()}/counts`, { classNames }).pipe(
      map((body): Record<string, CountResult> => {
        const out: Record<string, CountResult> = {};
        for (const [className, entry] of Object.entries(body.counts ?? {})) {
          out[className] = entry.ok
            ? { ok: true, total: entry.total, className, sqlTableName: entry.sqlTableName }
            : { ok: false, error: entry.error, candidates: [] };
        }
        return out;
      }),
      catchError(() => of<Record<string, CountResult>>({})),
    );
  }
}

function toFailure(err: unknown): CountResult {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: string; candidates?: string[] } | string | null;
    const error =
      typeof body === 'object' && body !== null && typeof body.error === 'string'
        ? body.error
        : `Count request failed (HTTP ${err.status}).`;
    const candidates =
      typeof body === 'object' && body !== null && Array.isArray(body.candidates)
        ? body.candidates
        : [];
    return { ok: false, error, candidates };
  }
  return { ok: false, error: 'Count request failed.', candidates: [] };
}
