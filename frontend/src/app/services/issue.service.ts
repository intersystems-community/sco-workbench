import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiUrl } from '../core/api';

/** Severity and urgency are open integers in SCO; the page shows three bands. */
export type IssueBand = 'High' | 'Medium' | 'Low';

/** The nav dimensions the issue list can be sliced by. */
export type IssueCategoryGroup = 'kpi' | 'severity' | 'workqueue';

/** One row of the issue table. `null` means SCO holds no value for the field. */
export interface IssueRow {
  uid: string;
  description: string;
  kpi: string | null;
  severity: IssueBand | null;
  urgency: IssueBand | null;
  status: string;
  created: string | null;
  impactedObjectType: string | null;
  impactedObjectId: string | null;
}

/** An issue row plus the fields only the detail pane shows. */
export interface IssueDetail extends IssueRow {
  triggerType: string | null;
  issueData: string | null;
  resolutionNote: string | null;
  latestAnalysis: Record<string, unknown> | null;
}

/** Nav badge counts. The dimensions overlap — only `total` sums the issues. */
export interface IssueCounts {
  total: number;
  byKpi: Record<string, number>;
  bySeverity: Record<IssueBand, number>;
  workQueue: number;
}

export interface IssueListPage {
  issues: IssueRow[];
  /** Issues matching the category, which may exceed the returned rows. */
  totalCount: number;
  truncated: boolean;
  cap: number;
}

/**
 * Reads the Issue Management data from our backend (`/api/issues`), which queries
 * SCO server-side. Filtering and counting are NOT done here: SCO's issue API is
 * paged and an instance holds tens of thousands of issues, so the browser never
 * sees the full set.
 */
@Injectable({ providedIn: 'root' })
export class IssueService {
  constructor(private http: HttpClient) {}

  /** Resolved per call — the API base is only set during app bootstrap. */
  private get baseURL(): string {
    return apiUrl('/api/issues');
  }

  /** Every nav badge, in one request. */
  counts(): Observable<{ counts: IssueCounts }> {
    return this.http.get<{ counts: IssueCounts }>(`${this.baseURL}/counts`);
  }

  /** The issues in one nav category, newest first. */
  list(group: IssueCategoryGroup, value: string): Observable<IssueListPage> {
    const params = new HttpParams().set('group', group).set('value', value);
    return this.http.get<IssueListPage>(this.baseURL, { params });
  }

  /** One issue, with its latest analysis when one has run. */
  get(uid: string): Observable<{ issue: IssueDetail }> {
    return this.http.get<{ issue: IssueDetail }>(`${this.baseURL}/${encodeURIComponent(uid)}`);
  }
}
