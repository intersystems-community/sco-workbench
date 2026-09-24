import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../core/api';

/** A cube's lifecycle state. */
export type CubeState = 'draft' | 'compiled' | 'built';

/** A cube as returned by the backend list endpoint. */
export interface CubeSummary {
  cubeName: string;
  className: string;
  sourceClass?: string;
  /** True only for Workbench-created cubes (SC.Workbench.Cube.*); SCO built-ins are read-only. */
  editable: boolean;
  /** Lifecycle state; SCO built-ins are always 'built'. */
  state?: CubeState;
}

/** A measure in a cube's structure (from the D2CLIENT Info API). */
export interface CubeMeasureInfo {
  name: string;
  caption?: string;
  type?: string;
  hidden?: boolean;
  factName?: string;
}

export interface CubeLevelInfo {
  name: string;
  caption?: string;
  type?: string;
  spec: string;
  sourceProperty?: string;
  sourceExpression?: string;
}
export interface CubeHierarchyInfo {
  name: string;
  levels: CubeLevelInfo[];
}
export interface CubeDimensionInfo {
  name: string;
  hierarchies: CubeHierarchyInfo[];
}
export interface CubeListingInfo {
  name: string;
  fields?: string;
  order?: string;
  type?: string;
}

/**
 * A cube's detail (source/fact class + build state), plus its full structure
 * (measures, dimensions→hierarchies→levels, listings) assembled by the backend
 * from the read-only D2CLIENT Info API. Structure fields are present only for a
 * built cube.
 */
export interface CubeDetail extends CubeSummary {
  exists: boolean;
  factClass?: string;
  factCount?: number;
  measures?: CubeMeasureInfo[];
  dimensions?: CubeDimensionInfo[];
  listings?: CubeListingInfo[];
}

/** Result of a save / compile / build action. */
export interface CubeMutationResult {
  ok: boolean;
  cubeName: string;
  className?: string;
  state?: CubeState;
  factCount?: number;
  message?: string;
}

/**
 * Cube CRUD against our backend's /api/cubes routes. SCO has no cube-management
 * API, so the backend talks to IRIS BI directly (generate .cls → compile →
 * build; delete = %KillCube + delete class). These are our own endpoints, NOT
 * the SCO reverse-proxy, but still resolved through apiUrl() for a split deploy.
 */
@Injectable({ providedIn: 'root' })
export class CubeService {
  constructor(private http: HttpClient) {}

  private base(): string {
    return apiUrl('/api/cubes');
  }

  list(): Observable<{ cubes: CubeSummary[] }> {
    return this.http.get<{ cubes: CubeSummary[] }>(this.base());
  }

  /**
   * List the real properties of ANY compiled source class (a custom scmodel
   * object OR an SCO built-in like SC.Data.SalesOrder), resolving a short or full
   * name. Feeds the cube form's Source Property dropdowns so the value is picked
   * from the authoritative list rather than guessed.
   */
  sourceProperties(className: string): Observable<{ className: string; properties: Array<{ name: string; type?: string }> }> {
    return this.http.get<{ className: string; properties: Array<{ name: string; type?: string }> }>(
      `${this.base()}/source-properties`,
      { params: { class: className } },
    );
  }

  get(cubeName: string): Observable<{ cube: CubeDetail }> {
    return this.http.get<{ cube: CubeDetail }>(`${this.base()}/${encodeURIComponent(cubeName)}`);
  }

  /**
   * Fetch the editable CubeDefinition for a Workbench cube (parsed from its class
   * XData). 403 for SCO built-ins (not editable here). The `definition` matches
   * the backend CubeDefinition shape the create/edit form produces.
   */
  getDefinition(cubeName: string): Observable<{ definition: any; editable: boolean }> {
    return this.http.get<{ definition: any; editable: boolean }>(
      `${this.base()}/${encodeURIComponent(cubeName)}/definition`,
    );
  }

  /**
   * Save the definition as a draft (may be incomplete; does not touch IRIS).
   * `originalName` (when editing) lets the backend clean up the old cube if the
   * name changed, so a rename doesn't leave a duplicate.
   */
  save(definition: unknown, originalName?: string): Observable<CubeMutationResult> {
    return this.http.post<CubeMutationResult>(`${this.base()}/save`, { definition, originalName });
  }

  /** Save + generate + compile the cube class into IRIS (no build). */
  compile(definition: unknown, originalName?: string): Observable<CubeMutationResult> {
    return this.http.post<CubeMutationResult>(`${this.base()}/compile`, { definition, originalName });
  }

  /** Save + compile + build (populate) the cube. */
  build(definition: unknown, originalName?: string): Observable<CubeMutationResult> {
    return this.http.post<CubeMutationResult>(`${this.base()}/build`, { definition, originalName });
  }

  delete(cubeName: string): Observable<{ ok: boolean; message: string }> {
    return this.http.delete<{ ok: boolean; message: string }>(
      `${this.base()}/${encodeURIComponent(cubeName)}`,
    );
  }
}
