import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import {
  SampleDataService,
  type SampleLoadReport,
  type SamplePreview,
  type SamplePreviewTable,
} from '../services/sample-data.service';
import { PageHeaderComponent } from '../shared/page-header';

/**
 * "Load sample data" — lists the ready-made sample data sets kept on the server
 * (one folder per set under its SampleData directory) in a dropdown, and loads the
 * chosen one into the user's IRIS: each CSV's rows are ADDED to the `SC_Data` table
 * that takes them (the SCO data model's own tables, installed with the product).
 * Nothing is created or replaced, and a row whose `uid` is already in the table is
 * skipped — so a second Load neither doubles the data nor fails.
 *
 * The Load button is enabled ONLY once a set is chosen, and disabled again for the
 * whole round-trip: the load is genuinely slow (the shipped set is ~15,500 rows,
 * ~17 s), so the button both reports progress ("Loading…") and refuses a second
 * click that would restart the same work mid-flight.
 *
 * Three listing states are distinguished deliberately: still asking, could not ask
 * (the backend's own message, with a retry), and asked-but-there-are-none — an
 * empty dropdown with no explanation is the bug this avoids, since SampleData/ is
 * not in git and a fresh install genuinely has no sets.
 *
 * Picking a set also asks the server what that set SAYS ABOUT ITSELF and WHICH TABLES it
 * would populate, and shows both before anything is loaded — the point being that Load
 * writes into the user's own `SC_Data` tables, so neither what this data is nor which
 * tables it will write to should be a surprise. The description is the set's own
 * `intro.txt` and comes first, above everything a load produces, since it describes the
 * set rather than any outcome. The list below it is the load's own plan (same name
 * matching, same order) and marks the files no table takes, the ones a Load would skip —
 * and it gives way to the report once a load has run, so the tables are never listed twice
 * with one of the lists silently out of date.
 *
 * The load's outcome is reported PER FILE rather than as one verdict, because a
 * partial load is a real outcome: a malformed CSV fails on its own while every other
 * table lands, and a CSV no `SC_Data` table takes is skipped rather than failed. The
 * user has to see which is which, so all three are distinguished here. A file can also
 * land with a column MISSING — a header the data model has no column for — which reads
 * as a clean success unless it is said out loud, so it is said, per file and in the
 * headline.
 *
 * Zoneless: every piece of state is a signal write.
 */
@Component({
  selector: 'app-load-sample-data',
  standalone: true,
  imports: [PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './load-sample-data.html',
  styleUrl: './load-sample-data.css',
})
export class LoadSampleDataComponent implements OnInit {
  private readonly sampleData = inject(SampleDataService);

  /** The data-set folder names, in the order the backend sorted them. */
  readonly folders = signal<string[]>([]);
  /** The listing request is in flight (true on first paint — nothing is known yet). */
  readonly loading = signal(true);
  /** Why the list could not be fetched; null when the last attempt succeeded. */
  readonly error = signal<string | null>(null);
  /** The chosen data set, or null while the placeholder option is selected. */
  readonly selected = signal<string | null>(null);

  /** What the selected set would populate, or null before one is picked / while asking. */
  readonly preview = signal<SamplePreview | null>(null);
  /** The preview request is in flight. */
  readonly previewing = signal(false);
  /** Why the preview could not be fetched. Never blocks Load — it is information only. */
  readonly previewError = signal<string | null>(null);

  /** A load is in flight; the set it is loading (also the busy flag's evidence). */
  readonly loadingSet = signal<string | null>(null);
  /** What the last completed load did, per table. Null until one completes. */
  readonly report = signal<SampleLoadReport | null>(null);
  /** Why the last load could not run at all (IRIS down, unknown set, …). */
  readonly loadError = signal<string | null>(null);

  /** Is a load in flight? Drives the button label and blocks a second click. */
  readonly busy = computed(() => this.loadingSet() !== null);
  /** Is there something to load right now? Drives the Load button's disabled state. */
  readonly canLoad = computed(() => this.selected() !== null && !this.busy());

  ngOnInit(): void {
    this.reload();
  }

  /** (Re)fetch the folder list. Also the error state's Retry action. */
  reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.clearOutcome();
    this.sampleData.listFolders().subscribe((result) => {
      this.loading.set(false);
      if (result.ok) {
        this.folders.set(result.folders);
        // A set that vanished from the server must not stay selected — nor keep its
        // preview on screen under no selection at all.
        if (this.selected() && !result.folders.includes(this.selected() as string)) {
          this.selected.set(null);
          this.clearPreview();
        }
        return;
      }
      this.folders.set([]);
      this.selected.set(null);
      this.clearPreview();
      this.error.set(result.error);
    });
  }

  /** Native select change — the placeholder's empty value means "nothing chosen". */
  onSelect(value: string): void {
    const folder = value || null;
    this.selected.set(folder);
    // Picking a different set retires the previous outcome: a report headed by
    // another set's name, sitting under this one's selection, reads as this one's.
    this.clearOutcome();
    this.showTablesFor(folder);
  }

  /**
   * Ask which tables the chosen set would populate. Answers that arrive after the user
   * has moved on are DROPPED: two quick picks race, and the slower first answer landing
   * last would list the wrong set's tables under the current selection.
   */
  private showTablesFor(folder: string | null): void {
    this.clearPreview();
    if (!folder) return;
    this.previewing.set(true);
    this.sampleData.previewFolder(folder).subscribe((result) => {
      if (this.selected() !== folder) return;
      this.previewing.set(false);
      if (result.ok) {
        this.preview.set(result.preview);
        return;
      }
      this.previewError.set(result.error);
    });
  }

  /**
   * Load the selected data set into IRIS.
   *
   * Guarded twice over: the button is disabled with nothing selected AND while a
   * load runs, and both conditions are re-checked here for a programmatic caller
   * (and for anyone who re-enables the button later without re-checking).
   */
  load(): void {
    const folder = this.selected();
    if (!folder || this.busy()) return;
    this.clearOutcome();
    this.loadingSet.set(folder);
    this.sampleData.loadFolder(folder).subscribe((result) => {
      this.loadingSet.set(null);
      if (result.ok) {
        this.report.set(result.report);
        return;
      }
      this.loadError.set(result.error);
    });
  }

  /**
   * What the selected set says about itself, or `''` when it says nothing. Read out of the
   * preview but rendered as its own paragraph at the top of the "About this data set" block,
   * directly under the picker: it describes the data the user chose, so it must stay put
   * while what follows it inside that block — the plan, then the load's report — changes.
   */
  readonly previewIntro = computed(() => this.preview()?.intro ?? '');

  /**
   * Should the plan (which tables a Load would fill) be on screen? Only until a load has
   * reported: the report then says which tables actually took rows, and keeping the plan
   * beside it shows the same tables twice, one list of them describing something that has
   * already happened. Picking another set retires the report, so the plan comes back.
   */
  readonly showPlan = computed(() => this.selected() !== null && this.report() === null);

  /** The tables a Load would put rows in, in the order it would go through them. */
  readonly previewTables = computed<SamplePreviewTable[]>(
    () => this.preview()?.tables.filter((t) => t.willLoad) ?? [],
  );
  /** Files in the set that no `SC_Data` table takes, so a Load would skip them. */
  readonly previewSkipped = computed<SamplePreviewTable[]>(
    () => this.preview()?.tables.filter((t) => !t.willLoad) ?? [],
  );

  /**
   * The line above the table list. Says how many tables and names the schema, and — when
   * the server could not check the set against the namespace — says that the names come
   * from the files rather than from tables known to be there.
   */
  readonly previewSummary = computed<string | null>(() => {
    const preview = this.preview();
    if (!preview) return null;
    const count = this.previewTables().length;
    const where = preview.schema ? ` ${preview.schema}` : '';
    if (!preview.verified) {
      return count
        ? `"${preview.folder}" has ${count} CSV file${count === 1 ? '' : 's'}, for these${where} ` +
          'tables. Which of them this namespace has could not be checked:'
        : `"${preview.folder}" has no CSV files, so a Load would add nothing.`;
    }
    if (!count) {
      return `Nothing in "${preview.folder}" matches a table in the${where} schema, so a Load ` +
        'would add no rows.';
    }
    // The order is part of the answer: the tables fill in the order they reference each
    // other, and someone watching the load will see them come back in exactly this order.
    return `Load will add rows to ${count}${where} table${count === 1 ? '' : 's'}, in this order:`;
  });

  /** The skipped files, named — the list above would otherwise silently omit them. */
  readonly previewSkippedNote = computed<string | null>(() => {
    const skipped = this.previewSkipped();
    if (!skipped.length) return null;
    const schema = this.preview()?.schema || 'SC_Data';
    return (
      `${skipped.length} file${skipped.length === 1 ? '' : 's'} in this set ` +
      `${skipped.length === 1 ? 'is' : 'are'} not named after any ${schema} table in this ` +
      `namespace, so ${skipped.length === 1 ? 'it' : 'they'} will be skipped: ` +
      `${nameList(skipped.map((t) => t.file))}.`
    );
  });

  /** Tables the rows actually went into (a skipped file is not one of them). */
  readonly loadedCount = computed(
    () => this.report()?.tables.filter((t) => t.ok && !t.skipped).length ?? 0,
  );
  /** Files skipped because no installed SC_Data table takes them. */
  readonly skippedCount = computed(
    () => this.report()?.tables.filter((t) => t.ok && t.skipped).length ?? 0,
  );
  /** Files that did not load — the count the summary has to lead with when non-zero. */
  readonly failedCount = computed(() => this.report()?.tables.filter((t) => !t.ok).length ?? 0);

  /**
   * One flat row per file for the results list. Flattening the server's three-way
   * union here (rather than narrowing it in the template) keeps the markup a plain
   * list and puts the wording — "1,445 rows added", the skip reason, the error — in
   * one testable place.
   */
  readonly tableRows = computed<ExampleTableRow[]>(() =>
    (this.report()?.tables ?? []).map((t) => {
      if (!t.ok) return { file: t.file, table: t.table, ok: false, skipped: false, detail: t.error };
      if (t.skipped) return { file: t.file, table: t.table, ok: true, skipped: true, detail: t.reason };
      // "added" rather than a bare count: the rows join whatever the table already
      // holds, and the skipped count says what was already there.
      const detail =
        `${rowCount(t.rows)} added, ${t.columns} column${t.columns === 1 ? '' : 's'}` +
        (t.skippedRows ? ` — ${rowCount(t.skippedRows)} already there` : '') +
        // An orphan count is a PROBLEM, not a tidy-up, so it says what is missing
        // rather than just how many rows went nowhere.
        (t.orphanRows
          ? ` — ${rowCount(t.orphanRows)} left out: ${t.orphanReason ?? 'a row they reference is missing'}`
          : '') +
        // A column that landed nowhere is named, not counted: the name is the only thing
        // that tells whoever assembled the set WHICH column to look at.
        (t.ignoredHeaders?.length
          ? ` — ${t.ignoredHeaders.length} column${t.ignoredHeaders.length === 1 ? '' : 's'} ` +
            `${t.table} does not have: ${nameList(t.ignoredHeaders)}`
          : '');
      return { file: t.file, table: t.table, ok: true, skipped: false, detail };
    }),
  );

  /**
   * The report's headline. Leads with the failures when there are any — a user who
   * reads only the first sentence must not walk away thinking the set loaded whole —
   * and never says "added 0 rows" when the truth is that everything was already
   * there, which is the normal result of pressing Load a second time.
   */
  readonly summary = computed<string | null>(() => {
    const report = this.report();
    if (!report) return null;
    if (!report.tables.length) {
      return `"${report.folder}" has no CSV files, so nothing was loaded.`;
    }

    const failed = this.failedCount();
    // The abort comes first when there is one: it means the tables listed below are
    // not the whole set, which changes how everything after it should be read.
    // Ends with IRIS's own words ("…timed out after 30000ms"), which carry no full
    // stop, so one is added: without it the next sentence runs straight into it.
    const stopped = report.aborted ? `${sentence(report.aborted)} ` : '';
    const lead = failed ? `${failed} file${failed === 1 ? '' : 's'} could not be loaded. ` : '';

    const where = report.schema ? ` in the ${report.schema} schema` : '';
    const already = report.totalSkippedRows;
    let main: string;
    if (report.totalRows > 0) {
      main =
        `Added ${rowCount(report.totalRows)} to ${this.loadedCount()} table` +
        `${this.loadedCount() === 1 ? '' : 's'}${where}.` +
        (already ? ` Skipped ${rowCount(already)} that ${already === 1 ? 'was' : 'were'} already there.` : '');
    } else if (already > 0) {
      main =
        `Nothing new to add: all ${rowCount(already)} in this set ${already === 1 ? 'is' : 'are'} ` +
        `already in the${where ? ` ${report.schema}` : ''} tables.`;
    } else {
      main = 'No rows were added.';
    }

    const skippedFiles = this.skippedCount();
    const tail = skippedFiles
      ? ` ${skippedFiles} file${skippedFiles === 1 ? '' : 's'} ${skippedFiles === 1 ? 'was' : 'were'} skipped.`
      : '';
    // Orphans are headlined, not left to the per-file list: they are the difference
    // between "the set loaded" and "the set is missing the data these rows point at".
    const orphans = report.totalOrphanRows ?? 0;
    const missing = orphans
      ? ` Left out ${rowCount(orphans)} that reference something this namespace does not have — see the files below.`
      : '';
    // Same reasoning for columns: a file whose header the data model has no column for
    // loaded its rows WITHOUT those values, and that is invisible unless it is said here.
    const ignored = report.totalIgnoredHeaders ?? 0;
    const dropped = ignored
      ? ` ${ignored} column${ignored === 1 ? '' : 's'} in this set ${ignored === 1 ? 'is' : 'are'} ` +
        `not in the${where ? ` ${report.schema}` : ''} tables, so ${ignored === 1 ? 'its' : 'their'} ` +
        'values were not loaded — see the files below.'
      : '';
    return `${stopped}${lead}${main}${tail}${missing}${dropped}`;
  });

  /** Forget the last load's outcome (a new selection or a new attempt supersedes it). */
  private clearOutcome(): void {
    this.report.set(null);
    this.loadError.set(null);
  }

  /** Forget the previous selection's table list, so none of it outlives its set. */
  private clearPreview(): void {
    this.preview.set(null);
    this.previewError.set(null);
    this.previewing.set(false);
  }
}

/** A results-list row: what happened to one CSV, already worded for display. */
interface ExampleTableRow {
  file: string;
  table: string;
  ok: boolean;
  /** True for a file no installed SC_Data table takes: not loaded, but not a failure. */
  skipped: boolean;
  /** Row/column counts for a loaded table, the reason for a skip, or the error. */
  detail: string;
}

/** A server message ended as a sentence, so the summary's next clause reads apart. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/**
 * Column (or file) names for one line of a list. Every one is named up to a point — a
 * file exported from another system can carry dozens, and a detail line that long stops
 * being readable at all, so the rest is counted instead.
 */
function nameList(names: readonly string[], limit = 6): string {
  const shown = names.slice(0, limit).join(', ');
  return names.length > limit ? `${shown} and ${names.length - limit} more` : shown;
}

/** "1 row" / "1,445 rows", grouped so a big count stays readable. */
function rowCount(rows: number): string {
  return `${rows.toLocaleString()} row${rows === 1 ? '' : 's'}`;
}
