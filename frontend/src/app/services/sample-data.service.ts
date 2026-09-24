import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { apiUrl } from '../core/api';

// Resolved per call (not at module load) so the runtime-configured API base is used.
const BASE = (): string => apiUrl('/api/sample-data');

/**
 * The outcome of listing the sample data sets. A discriminated union rather than
 * `string[] | null` for the same reason as `CountResult` in data-browser.service:
 * the dropdown has to tell "there are none" apart from "we could not ask", and only
 * the failure branch can explain itself.
 */
export type SampleFoldersResult =
  | { ok: true; folders: string[] }
  | { ok: false; error: string };

interface FoldersBody {
  folders?: string[];
}

/** One CSV in the preview of a set: the table its rows would go into. */
export interface SamplePreviewTable {
  file: string;
  /** The `SC_Data` table the rows would land in, or the file's own name when none takes it. */
  table: string;
  /** False when no installed table takes this file, so a Load would skip it. */
  willLoad: boolean;
}

/** What a Load of one set WOULD populate, asked before pressing Load. */
export interface SamplePreview {
  folder: string;
  /** SQL schema the rows would go into (`SC_Data`). */
  schema: string;
  /**
   * What the set says about itself, from its own `intro.txt`. Absent when it has none —
   * a description, not a requirement, so the page shows the tables either way.
   */
  intro?: string;
  /** One entry per CSV, in the order a Load would go through them. */
  tables: SamplePreviewTable[];
  /**
   * True when the server checked the set against the tables the namespace actually has.
   * False means the names come from the file names alone (IRIS could not be asked), so
   * the page must present them as what the set is FOR, not as what is installed.
   */
  verified: boolean;
  /** Why it could not be checked, when `verified` is false. */
  reason?: string;
}

export type SamplePreviewResult =
  | { ok: true; preview: SamplePreview }
  | { ok: false; error: string };

/**
 * One CSV's outcome inside a load. A three-way union, mirroring the backend's, so
 * each outcome is unmistakable: a file that was SKIPPED (no such table in the
 * namespace, or nothing in `SC_Data` takes it) carries a reason and no counts, and a
 * file that FAILED has no row count at all — neither can be read as "loaded 0 rows".
 */
export type SampleTableLoad =
  | {
      file: string;
      table: string;
      ok: true;
      skipped?: false;
      columns: number;
      /** Rows added to the table. */
      rows: number;
      /** Rows the file had that were already in the table (or keyless), so not added. */
      skippedRows: number;
      /**
       * Rows left out because something they reference is missing from the namespace.
       * Kept apart from `skippedRows` because it means the opposite: a skipped row is
       * already loaded, an orphan row is data that did NOT load.
       */
      orphanRows?: number;
      /** Which references were missing, when `orphanRows` is non-zero. */
      orphanReason?: string;
      /**
       * Columns the file had that the table does not, so their values did not load.
       * Absent when every header found a column — which is the normal case, and is why
       * an empty array is not sent.
       */
      ignoredHeaders?: string[];
    }
  | { file: string; table: string; ok: true; skipped: true; reason: string }
  | { file: string; table: string; ok: false; error: string };

/** What the server did: one entry per CSV, plus the totals. */
export interface SampleLoadReport {
  folder: string;
  /** SQL schema the rows went into (`SC_Data`, the SCO data model's own tables). */
  schema: string;
  tables: SampleTableLoad[];
  /** Rows added across every table. */
  totalRows: number;
  /** Rows whose `uid` was already there (or blank), skipped across every table. */
  totalSkippedRows: number;
  /** Rows left out across every table because what they reference is not there. */
  totalOrphanRows?: number;
  /** CSV columns across the set that no table column took, so they did not load. */
  totalIgnoredHeaders?: number;
  /** Set when the load stopped part way (IRIS stopped answering); says where. */
  aborted?: string;
  /** True only when there was at least one CSV and none of them failed. */
  ok: boolean;
}

/**
 * The outcome of ASKING for a load. Note the two levels, which mean different
 * things: the outer `ok` is "the server answered", `report.ok` is "everything in the
 * set loaded". A set where two files failed is `{ ok: true }` with a report the page
 * renders per table — that partial result is exactly what the user needs to see.
 */
export type SampleLoadResult =
  | { ok: true; report: SampleLoadReport }
  | { ok: false; error: string };

/**
 * Client for the workbench's own `/api/sample-data` route — the folder names under
 * the server's SampleData directory, one per ready-made sample data set.
 */
@Injectable({ providedIn: 'root' })
export class SampleDataService {
  private readonly http = inject(HttpClient);

  /**
   * The sample data set names, in the order the backend sorted them. Never
   * errors: a transport/server failure resolves to `{ ok: false, error }` so the
   * page can show why the dropdown is empty instead of hanging on a spinner.
   */
  listFolders(): Observable<SampleFoldersResult> {
    return this.http.get<FoldersBody>(`${BASE()}/folders`).pipe(
      // A body without `folders` (an older backend, a proxy that swallowed it) is
      // "no data sets", not a crash.
      map((body): SampleFoldersResult => ({ ok: true, folders: Array.isArray(body?.folders) ? body.folders : [] })),
      catchError((err: unknown) => of<SampleFoldersResult>({ ok: false, error: toMessage(err) })),
    );
  }

  /**
   * What one set says about itself (its `intro.txt`) and which `SC_Data` tables loading it
   * would put rows in — asked when the set is PICKED, so the user reads the description
   * and sees what is about to be written to before pressing Load. Loads nothing. Never
   * errors: a failure resolves to `{ ok: false, error }` so the page can say the list is
   * unavailable and still offer the Load button.
   */
  previewFolder(folder: string): Observable<SamplePreviewResult> {
    return this.http.get<Partial<SamplePreview>>(`${BASE()}/tables`, { params: { folder } }).pipe(
      map((body): SamplePreviewResult => ({ ok: true, preview: normalizePreview(folder, body) })),
      catchError((err: unknown) => of<SamplePreviewResult>({ ok: false, error: toPreviewMessage(err) })),
    );
  }

  /**
   * Load one data set's CSVs into IRIS — each file's rows are added to the `SC_Data`
   * table that takes them. Never errors: a transport/server failure resolves to
   * `{ ok: false, error }` so the page can say what went wrong and let the user try
   * again.
   *
   * Slow by nature (the shipped set is ~15,500 rows, ~17 s), so the caller must show
   * a busy state for the whole round-trip. No client timeout is set: cutting the
   * request off would abandon a load that IRIS is still applying.
   */
  loadFolder(folder: string): Observable<SampleLoadResult> {
    return this.http.post<Partial<SampleLoadReport>>(`${BASE()}/load`, { folder }).pipe(
      map((body): SampleLoadResult => ({ ok: true, report: normalizeReport(folder, body) })),
      catchError((err: unknown) => of<SampleLoadResult>({ ok: false, error: toLoadMessage(err) })),
    );
  }
}

/**
 * Trust the server's numbers but not its shape: a body that lost `tables` (an older
 * backend, a proxy that rewrote it) becomes an empty, NOT-ok report rather than a
 * template crash on `.tables.length`.
 */
function normalizeReport(folder: string, body: Partial<SampleLoadReport> | null): SampleLoadReport {
  const tables = Array.isArray(body?.tables) ? body!.tables : [];
  return {
    folder: typeof body?.folder === 'string' ? body.folder : folder,
    schema: typeof body?.schema === 'string' ? body.schema : '',
    tables,
    totalRows: Number(body?.totalRows) || 0,
    totalSkippedRows: Number(body?.totalSkippedRows) || 0,
    totalOrphanRows: Number(body?.totalOrphanRows) || 0,
    totalIgnoredHeaders: Number(body?.totalIgnoredHeaders) || 0,
    ...(typeof body?.aborted === 'string' && body.aborted ? { aborted: body.aborted } : {}),
    ok: body?.ok === true && tables.length > 0,
  };
}

/**
 * Same distrust of the shape as `normalizeReport`. A body without a usable `tables`
 * array is an EMPTY preview rather than a template crash, and anything but an explicit
 * `verified: true` is treated as unverified — the caveat has to be the default, or a
 * body that lost the flag would show guessed table names as checked ones.
 */
function normalizePreview(folder: string, body: Partial<SamplePreview> | null): SamplePreview {
  const tables = Array.isArray(body?.tables) ? body!.tables : [];
  // A blank or non-string intro is NO intro: an empty paragraph above the list would
  // read as a set that had something to say and lost it.
  const intro = typeof body?.intro === 'string' ? body.intro.trim() : '';
  return {
    folder: typeof body?.folder === 'string' ? body.folder : folder,
    schema: typeof body?.schema === 'string' ? body.schema : '',
    ...(intro ? { intro } : {}),
    tables: tables.map((t) => ({
      file: String(t?.file ?? ''),
      table: String(t?.table ?? ''),
      // Same reasoning the other way round: only an explicit `false` means "skipped".
      willLoad: t?.willLoad !== false,
    })),
    verified: body?.verified === true,
    ...(typeof body?.reason === 'string' && body.reason ? { reason: body.reason } : {}),
  };
}

/** The server's own message when it sent one, else a plain statement of the failure. */
function toMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: string } | string | null;
    if (typeof body === 'object' && body !== null && typeof body.error === 'string') return body.error;
    return `Could not load the sample data sets (HTTP ${err.status}).`;
  }
  return 'Could not load the sample data sets.';
}

/**
 * Same idea for the load call, with its own wording — "could not load the data
 * sets" (the listing) and "loading the sample data failed" (the ingest) are
 * different failures and must not read alike. The backend's envelope is flat
 * (`{ error, code }`, see error-middleware.ts), so the server's own sentence —
 * "Sample data set "X" was not found.", the IRIS message on a 502 — is preferred
 * over anything invented here.
 */
function toLoadMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: string } | string | null;
    if (typeof body === 'object' && body !== null && typeof body.error === 'string' && body.error) {
      return body.error;
    }
    return `Loading the sample data failed (HTTP ${err.status}).`;
  }
  return 'Loading the sample data failed.';
}

/**
 * The preview's own wording: nothing was attempted and nothing is broken for the user
 * yet, so this must not read like a failed load — the Load button stays available.
 */
function toPreviewMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: string } | string | null;
    if (typeof body === 'object' && body !== null && typeof body.error === 'string' && body.error) {
      return body.error;
    }
    return `Could not list the tables this set would load (HTTP ${err.status}).`;
  }
  return 'Could not list the tables this set would load.';
}
