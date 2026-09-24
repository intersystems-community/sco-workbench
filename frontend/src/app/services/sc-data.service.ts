import { Injectable } from '@angular/core';
import { HttpClient, HttpParams, type HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ScBaseService } from './sc-base.service';
import { apiUrl } from '../core/api';
// The resource list and the objectName→resource map moved to their own tested
// module; re-exported here so existing importers keep working.
export { SC_DATA_RESOURCES } from './sc-data-resources';
import type { ScDataResource } from './sc-data-resources';

// Resolved per call (not at module load) so the runtime-configured API base is used.
const BASE = (): string => apiUrl('/api/scdata/v1');

/** One page of scdata rows plus the paging headers the product returns. */
export interface ScDataPage {
  /** The response body is a bare JSON array of row objects. */
  rows: Array<Record<string, unknown>>;
  pageIndex: number;
  pageSize: number;
  /** scdata's RETURNCOUNT. `returnCount < pageSize` means this is the last page. */
  returnCount: number;
  /** scdata's ORDERBY, e.g. `name ASC`. Empty string when absent. */
  orderBy: string;
}

@Injectable({ providedIn: 'root' })
export class ScDataService {
  constructor(private base: ScBaseService, private http: HttpClient) {}

  /**
   * One page of rows, using scdata's own paging contract.
   *
   * The param names are exact and case-sensitive: they are read from
   * `%request.Data`, so `pagesize` or `_size` are silently ignored (that is what
   * made the old `getCount()` download 100 rows). `sortBy` takes a `-` prefix
   * for DESC and is whitelisted server-side — an unknown column returns HTTP
   * 500, so only columns scmodel reports should be offered as sortable.
   */
  getPage(
    resource: string,
    opts: { pageSize: number; pageIndex: number; sortBy?: string | null },
  ): Observable<ScDataPage> {
    let params = new HttpParams()
      .set('pageSize', String(opts.pageSize))
      .set('pageIndex', String(opts.pageIndex));
    if (opts.sortBy) params = params.set('sortBy', opts.sortBy);

    return this.http
      .get<Array<Record<string, unknown>>>(`${BASE()}/${resource}`, { params, observe: 'response' })
      .pipe(map((res) => decodePage(res, opts)));
  }

  getAll<T>(resource: ScDataResource, params?: Record<string, string>): Observable<T[]> {
    return this.base.getAll<T>(BASE(), resource, params);
  }

  getById<T>(resource: ScDataResource, id: string): Observable<T> {
    return this.base.getById<T>(BASE(), resource, id);
  }

  // create<T>(resource: ScDataResource, body: Partial<T>): Observable<T> {
  //   return this.base.create<T>(BASE(), resource, body);
  // }

  // patch<T>(resource: ScDataResource, id: string, body: Partial<T>): Observable<T> {
  //   return this.base.patch<T>(BASE(), resource, id, body);
  // }

  // put<T>(resource: ScDataResource, id: string, body: T): Observable<T> {
  //   return this.base.put<T>(BASE(), resource, id, body);
  // }

  // delete(resource: ScDataResource, id: string): Observable<void> {
  //   return this.base.delete(BASE(), resource, id);
  // }

  // Bulk upload — custom endpoints
  getBulkUploadContents(uploadId: string): Observable<string> {
    return this.base.getById<string>(BASE(), 'bulkupload/contents', uploadId);
  }

  // getBulkUploadIds(): Observable<string[]> {
  //   return this.base.post<string[]>(BASE(), 'bulkupload/details/uploadIds');
  // }

  // getBulkUploadErrors(body: unknown): Observable<any> {
  //   return this.base.post<any>(BASE(), 'bulkupload/error', body);
  // }

  getBackendVersion(): Observable<any> {
    return this.base.getAll<any>(BASE(), 'backend-version');
  }
}

/**
 * Header names are matched case-insensitively by HttpHeaders, so the lowercase
 * lookups here read the product's uppercase ORDERBY/PAGEINDEX/... correctly.
 * Missing or unparseable headers fall back to what was requested.
 */
function decodePage(
  res: HttpResponse<Array<Record<string, unknown>>>,
  opts: { pageSize: number; pageIndex: number },
): ScDataPage {
  const rows = res.body ?? [];
  const num = (name: string, fallback: number): number => {
    const raw = res.headers.get(name);
    const parsed = raw !== null && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    rows,
    pageIndex: num('pageindex', opts.pageIndex),
    pageSize: num('pagesize', opts.pageSize),
    returnCount: num('returncount', rows.length),
    orderBy: res.headers.get('orderby') ?? '',
  };
}
