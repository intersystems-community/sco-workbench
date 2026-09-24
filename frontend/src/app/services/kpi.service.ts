import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { apiUrl } from '../core/api';

/** A KPI's lifecycle state in the Workbench. */
export type KpiState = 'draft' | 'created';

/** A KPI drill-down / breakdown dimension (MDX-encoded cube dimension). */
export interface KpiDimension {
  name: string;
  label?: string;
  cubeDimension?: string;
}

/** The DeepSee-cube-backed spec of a KPI (mirrors SC.Core.Analytics.KPI.DeepseeKpiSpec). */
export interface DeepseeKpiSpec {
  namespace?: string;
  cube?: string;
  kpiMeasure?: string;
  valueType?: 'raw' | 'percentage';
  kpiConditions?: string[];
  baseConditions?: string[];
  kpiDimensions?: KpiDimension[];
}

/** A full KPI definition (mirrors SC.Core.Analytics.KPI.KpiDefinition). */
export interface KpiDefinition {
  name: string;
  label?: string;
  description?: string;
  type?: string;
  baseObject?: string;
  status?: string;
  watchingThreshold?: number;
  warningThreshold?: number;
  issueKpi?: boolean;
  defaultIssueSeverity?: number;
  analysisService?: string;
  deepseeKpiSpec?: DeepseeKpiSpec;
}

/** A locally-saved KPI draft as returned by the draft store. */
export interface KpiDraft {
  kpiName: string;
  definition: KpiDefinition;
  state: KpiState;
  updatedAt: string;
}

@Injectable({
  providedIn: 'root'
})
export class KpiApiService {
  private readonly kpiDefinitionsURL = apiUrl('/api/scbi/v1/kpi/definitions');
  private readonly kpiDataURL = apiUrl('/api/scbi/v1/kpi/values');
  private readonly kpiListingURL = apiUrl('/api/scbi/v1/kpi/listings');
  // Local draft store on our backend (NOT the SCO proxy). Persists unsubmitted
  // edits so the Save-draft / Submit lifecycle survives navigation.
  private readonly kpiDraftsURL = apiUrl('/api/kpi-drafts');

  constructor(private http: HttpClient) {}

  getKpiDefinitions(): Observable<any[]> {
    return this.http.get<any[]>(this.kpiDefinitionsURL);
  }

  // ── Local draft store ────────────────────────────────────────
  /** List all locally-saved KPI drafts. */
  listKpiDrafts(): Observable<{ drafts: KpiDraft[] }> {
    return this.http.get<{ drafts: KpiDraft[] }>(this.kpiDraftsURL);
  }

  /**
   * List the valid KPI base objects — the `{name}` from the
   * `SC.Core.API.Data.{name}ApiImpl` classes that back the drill-through listing.
   */
  listKpiBaseObjects(): Observable<{ baseObjects: string[] }> {
    return this.http.get<{ baseObjects: string[] }>(`${this.kpiDraftsURL}/base-objects`);
  }

  /**
   * Save (upsert) a KPI draft locally — no IRIS write. `originalName` (when the
   * name changed during editing) lets the backend drop the stale draft so the
   * list has no duplicate.
   */
  saveKpiDraft(definition: unknown, originalName?: string): Observable<{ ok: boolean; kpiName: string; state: string }> {
    return this.http.post<{ ok: boolean; kpiName: string; state: string }>(
      `${this.kpiDraftsURL}/save`,
      { definition, originalName },
    );
  }

  /** Delete a local draft (after a successful Submit, or on discard). */
  deleteKpiDraft(kpiName: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`${this.kpiDraftsURL}/${encodeURIComponent(kpiName)}`);
  }

  createKpiDefinition(body: unknown): Observable<any> {
    return this.http.post<any>(this.kpiDefinitionsURL, body);
  }

  updateKpiDefinition(kpiName: string, body: unknown): Observable<any> {
    return this.http.put<any>(`${this.kpiDefinitionsURL}/${encodeURIComponent(kpiName)}`, body);
  }

  deleteKpiDefinition(kpiName: string): Observable<any> {
    return this.http.delete<any>(`${this.kpiDefinitionsURL}/${encodeURIComponent(kpiName)}`);
  }

  getKpiData(kpiName: string, expandDimension?: string | null, kpiFilter?: string[] | null): Observable<any> {
    if (!kpiName || kpiName.trim() === '') {
      return throwError(() => new Error('kpiName is required and cannot be empty.'));
    }
    const url = `${this.kpiDataURL}/${encodeURIComponent(kpiName)}`;
    let params = new HttpParams();

    if (expandDimension) {
      params = params.set('expandDimension', expandDimension);
    }
    if (kpiFilter && kpiFilter.length > 0) {
      params = params.set('kpiFilter', kpiFilter.join(','));
    }
    return this.http.get<any>(url, { params });
  }

getKpiListing(
    kpiName: string,
    kpiFilter?: string[] | null,
    pageSize?: number,
    pageIndex?: number,
    sortBy?: string,
  ): Observable<any> {
    if (!kpiName || kpiName.trim() === '') {
      return throwError(() => new Error('kpiName is required and cannot be empty.'));
    }
    const url = `${this.kpiListingURL}/${encodeURIComponent(kpiName)}`;
    let params = new HttpParams();

    if (kpiFilter && kpiFilter.length > 0) {
      params = params.set('kpiFilter', kpiFilter.join(','));
    }
    if (pageSize)  params = params.set('pageSize',  pageSize.toString());
    if (pageIndex) params = params.set('pageIndex', pageIndex.toString());
    if (sortBy)    params = params.set('sortBy',    sortBy);

    return this.http.get<any>(url, { params });
  }
}
