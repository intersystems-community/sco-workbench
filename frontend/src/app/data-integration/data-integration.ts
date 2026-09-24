import { Component, OnInit, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy, ViewChild, ElementRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ScModelService } from '../services/sc-model.service';
import { DataSourceService, type SqlColumn, type FtpEntry, type CsvPreview, type FtpConnection, type CloudEntry, type CloudConnection, type Mapping } from '../services/data-source.service';
import type { SqlConnection } from '../services/data-source.service';
import { UploadService, type UploadKind, type UploadResult } from '../services/upload.service';
import { DataIntegrationService, type SavedCase, type SavedFileMeta } from '../services/data-integration.service';
import { SqlConnectionTestService, type SqlConnectionConfig } from '../services/sql-connection-test.service';
import { FtpConnectionTestService, type FtpConnectionConfig } from '../services/ftp-connection-test.service';
import { SftpConnectionTestService, type SftpConnectionConfig } from '../services/sftp-connection-test.service';
import { CloudConnectionTestService, type CloudConnectionConfig } from '../services/cloud-connection-test.service';
import { WorkbenchBridgeService, type GuidedFormController, type SetFieldResult, type StatusReport } from '../core/workbench-bridge.service';
import { GuideHighlightDirective } from '../core/guide-highlight.directive';
import { ConfirmDialogComponent } from '../shared/confirm-dialog';
import { ToastService } from '../core/toast.service';
import { isAiEnabled, AI_KEY_MISSING_MESSAGE, AI_KEY_MISSING_SHORT } from '../core/ai-status';
import {
  SOURCE_TYPE_LABELS,
  type AdapterType,
  type IntegrationJob,
  type ScAttribute,
  type SourceColumn,
  type SourceConfig,
  type SourceType,
  type UploadSlots,
} from './data-integration.model';
import {
  hasPolledEntity,
  isJobReady,
  jobReadinessGaps,
  missingStep1Field,
  missingStep1Fields,
  readinessWarningMessage,
  unmappedRequiredProperties,
  type ReadinessGap,
} from './job-readiness';
import {
  DB_DRIVER_CLASS,
  buildDeployPayload,
  buildDeployPrompt,
  buildSourcePayload,
  buildSqlQuery,
  deployDisplayText,
  ftpPortOrDefault,
} from './deploy-prompt';

// The data model lives in data-integration.model.ts; re-exported here so existing
// importers of these types keep working.
export type { AdapterType, IntegrationJob, SourceType } from './data-integration.model';

/** A DTL transform function: its name, signature label, and extra parameters
 *  (beyond the implicit source value). */
interface TransformFn {
  value: string;
  label: string;
  params: { key: string; label: string }[];
}

/** Local-file preview bounds: a header row + first five data rows, read from at
 *  most this many bytes so we never load a large file into memory. */
const LOCAL_PREVIEW_ROWS = 6;
const LOCAL_PREVIEW_MAX_BYTES = 64 * 1024;

@Component({
  selector: 'app-data-integration',
  standalone: true,
  imports: [CommonModule, FormsModule, GuideHighlightDirective, ConfirmDialogComponent],
  templateUrl: './data-integration.html',
  styleUrl: './data-integration.css',
  changeDetection: ChangeDetectionStrategy.Default,
})
export class DataIntegrationComponent implements OnInit, OnDestroy {
  // ── List panel ────────────────────────────────────────────────
  // Loaded from the backend (SQLite) in ngOnInit — DI cases persist server-side,
  // NOT in the browser, so they survive refresh/restart across machines.
  jobs: IntegrationJob[] = [];
  selectedJob: IntegrationJob | null = null;
  wizardOpen = false;

  /** Whether the left list panel is collapsed away, giving the detail/wizard the
   *  full width (the Cube/KPI/Resources list panels behave the same way). */
  listCollapsed = false;
  toggleList(): void {
    this.listCollapsed = !this.listCollapsed;
    this.cdr.markForCheck();
  }

  // ── Unsaved-changes guard ─────────────────────────────────────
  /** True while the leave-confirmation dialog ("Unsaved information will be
   *  lost.") is showing. Mirrors the KPI/Cube form pattern. */
  showLeaveConfirm = false;
  /** The action to run if the user confirms leaving (close/select/new/navigate). */
  private pendingLeave: (() => void) | null = null;
  /** Signature of the form as last SAVED (or as first opened) — the wizard is
   *  "dirty" when the live form no longer matches it. Avoids peppering every input
   *  with a markDirty() call. */
  private savedFormSignature = '';
  /** A per-step Save (persistCase) is in flight — disables the Save buttons. */
  savingCase = false;
  /** Slots uploaded THIS wizard session whose bytes aren't yet persisted to
   *  SQLite. Persisted (and cleared) on the next Save; restored slots aren't here
   *  because their bytes already live in SQLite. */
  private freshUploadSlots = new Set<keyof UploadSlots>();

  // ── Wizard state ──────────────────────────────────────────────
  currentStep = 1;
  editingJobId: string | null = null;

  // Step 1
  sourceType: SourceType = 'database';
  jobName = '';
  sourceConfig: SourceConfig = this.emptySource('database');
  /** Set once the user tries to advance from Step 1 with a required field empty.
   *  The "<field> is required" banner shows only after this, so a fresh/blank form
   *  isn't nagging by default. Reset when the wizard (re)opens. */
  step1Attempted = false;
  @ViewChild('step1ErrorEl') private step1ErrorEl?: ElementRef<HTMLDivElement>;

  /** The prominent inline error banner text for Step 1 — matches the cube/KPI
   *  form's `.form-error` treatment. Shown only AFTER a blocked Next (so a fresh
   *  form doesn't nag), and derived from the CURRENT missing field so fixing it
   *  updates/clears the banner live. */
  get step1Error(): string | null {
    if (!this.step1Attempted) return null;
    const field = this.missingStep1Field;
    return field ? `${field} is required.` : null;
  }

  // Step 2 — Data (adapter-specific data selection).
  /** The data-source identity (see dataSourceIdentity) the data currently on Step 2
   *  was loaded for. Empty until the step has loaded once — on a first entry there
   *  is nothing stale to drop. */
  private loadedDataSource = '';
  /** Set once the user tries to advance from Step 2 without having selected the
   *  data entity (schema+table / a CSV file / an object). Same "don't nag until
   *  they try" contract as `step1Attempted`; reset with the data step. */
  step2Attempted = false;
  @ViewChild('step2ErrorEl') private step2ErrorEl?: ElementRef<HTMLDivElement>;

  /** The prominent inline error banner text for Step 2 — the Step-1 treatment,
   *  applied to the data-entity selection. Derived from the CURRENT selection, so
   *  picking the missing table/file clears it live. */
  get step2Error(): string | null {
    return this.step2Attempted ? this.missingStep2Selection : null;
  }

  // SQL adapter: schema → table → columns, each fetched via DataSourceService.
  sqlSchemas: string[] = [];
  loadingSchemas = false;
  /** Error message from the last schema fetch (bad connection/credentials); null = none. */
  schemaError: string | null = null;
  selectedSchema = '';
  sqlTables: string[] = [];
  loadingTables = false;
  /** Error message from the last table fetch; null = none. */
  tableError: string | null = null;
  selectedTable = '';
  sqlColumns: SqlColumn[] = [];
  loadingColumns = false;
  /** Error message from the last column fetch; null = none. */
  columnError: string | null = null;

  // FTP/SFTP adapter: remote file browser + CSV preview (independent from SQL).
  ftpPathSegments: string[] = [];   // current directory, e.g. ['a','b'] → /a/b
  ftpEntries: FtpEntry[] = [];
  loadingFtpDir = false;
  /** Error message from the last directory listing; null = none. */
  ftpError: string | null = null;
  selectedCsvPath = '';             // absolute path of the previewed CSV
  csvPreview: CsvPreview | null = null;
  loadingCsvPreview = false;
  /** Error message from the last CSV preview; null = none. */
  csvPreviewError: string | null = null;
  /** RAW preview rows for the selected CSV (header-agnostic), as returned by the
   *  backend. The displayed `csvPreview` is derived from these + the header option,
   *  so toggling the header checkbox needs no re-fetch. */
  private ftpCsvRaw: string[][] = [];

  // Cloud adapter: object-storage browser + CSV preview (independent from FTP/SQL).
  cloudPathSegments: string[] = []; // current key prefix, e.g. ['raw','sales'] → /raw/sales
  cloudEntries: CloudEntry[] = [];
  loadingCloudDir = false;
  /** Error message from the last bucket listing; null = none. */
  cloudError: string | null = null;
  selectedCloudCsvPath = '';        // absolute object key of the previewed CSV
  cloudCsvPreview: CsvPreview | null = null;
  loadingCloudCsvPreview = false;
  /** Error message from the last cloud object preview; null = none. */
  cloudCsvPreviewError: string | null = null;
  /** RAW preview rows for the selected object (header-agnostic), as returned by
   *  the backend — `cloudCsvPreview` is derived from these + the header option,
   *  so toggling the header checkbox needs no re-fetch. */
  private cloudCsvRaw: string[][] = [];

  // Local File adapter: preview of the file uploaded in Step 1 (independent).
  localCsvPreview: CsvPreview | null = null;
  loadingLocalPreview = false;
  /** Error message from the local file preview (e.g. not a CSV); null = none. */
  localPreviewError: string | null = null;
  /** The picked File object, held in memory so Step 2 can read it directly in the
   *  browser (no upload round-trip — the bytes are already here). */
  private localFile: File | null = null;
  /** RAW preview rows for the uploaded file (header-agnostic); the displayed
   *  preview is derived from these + the header option, so toggling needs no re-read. */
  private localCsvRaw: string[][] = [];

  /** Signature of the Step-2 column structure that last seeded Step-3's working
   *  set — so we rebuild only when the structure actually changes, preserving
   *  the user's Step-3 removals/refinements otherwise. */
  private lastDataSignature = '';

  /** Per-source-entity snapshot of the Step-3 mapping (sourceColumns), keyed by
   *  currentEntityKey() (schema.table for SQL, the file path otherwise). Lets a
   *  brief detour in the Step-2 selector — pick another table, then re-pick the
   *  original — restore the mappings that belonged to a table instead of blanking
   *  them. Seeded from a reopened case's saved mapping. */
  private mappingByEntity = new Map<string, SourceColumn[]>();
  /** The entity key the current `sourceColumns` belong to, so a rebuild can stash
   *  them under the right key before switching entities. */
  private mappingEntityKey: string | null = null;

  /** A reopened case's saved target class + its per-source-column mapping (column
   *  name → target property). A mapping is only meaningful within its class, so
   *  switching the target class blanks every row; switching BACK to this saved
   *  class restores these values (matched by column name, dropping any property the
   *  class no longer has). Empty for a brand-new case, which has nothing to restore. */
  private savedTargetClass = '';
  private savedMappingByColumn = new Map<string, string>();

  // Section 1: user-entered source data columns + whether the source has a header row.
  sourceColumns: SourceColumn[] = [];
  sourceHasHeader = true;
  /** Value types a user can pick for a source column. */
  readonly SOURCE_COLUMN_TYPES = ['String', 'Integer', 'Decimal', 'Boolean', 'Date', 'DateTime', 'Time'];
  /** DTL transform functions supported by the create-dtl skill. `params` are the
   *  extra arguments beyond the implicit source value; the backend assembles
   *  ..Fn(sourceField, ...params). Empty value = no transform. */
  readonly TRANSFORM_FUNCTIONS: TransformFn[] = [
    { value: '',                label: '— (none)',                             params: [] },
    { value: 'ToUpper',         label: 'ToUpper(val)',                         params: [] },
    { value: 'ToLower',         label: 'ToLower(val)',                         params: [] },
    { value: 'Length',          label: 'Length(val)',                          params: [] },
    { value: 'SubString',       label: 'SubString(val, start, end)',           params: [{ key: 'start', label: 'start' }, { key: 'end', label: 'end' }] },
    { value: 'ReplaceStr',      label: 'ReplaceStr(val, old, new)',            params: [{ key: 'old', label: 'old' }, { key: 'new', label: 'new' }] },
    { value: 'Strip',           label: 'Strip(val, mask, chars)',              params: [{ key: 'mask', label: 'mask' }, { key: 'chars', label: 'chars' }] },
    { value: 'Pad',             label: 'Pad(val, length, char)',               params: [{ key: 'length', label: 'length' }, { key: 'char', label: 'char' }] },
    { value: 'ConvertDateTime', label: 'ConvertDateTime(val, inFmt, outFmt)',  params: [{ key: 'inFmt', label: 'in format' }, { key: 'outFmt', label: 'out format' }] },
    { value: 'Piece',           label: 'Piece(val, delim, from, to)',          params: [{ key: 'delim', label: 'delim' }, { key: 'from', label: 'from' }, { key: 'to', label: 'to' }] },
    { value: 'Lookup',          label: 'Lookup(table, key)',                   params: [{ key: 'table', label: 'table' }, { key: 'key', label: 'key' }] },
  ];

  /** Database Type options for the Database adapter. */
  readonly DB_TYPES = ['IRIS', 'PostgreSQL'];
  /** Database Type → JDBC driver class the backend's Java helper loads. The
   *  matching driver JAR must be on the helper's classpath (backend/jdbc-lib). */
  readonly DB_DRIVER_CLASS = DB_DRIVER_CLASS;

  // Section 2: target class fetched from the backend (mock for now).
  targetClasses: string[] = [];
  selectedTargetClass = '';
  loadingTargetClasses = false;
  /** Set once the user tries to save without having picked a target class. Same
   *  "don't nag until they try" contract as `step1Attempted`/`step2Attempted`. */
  step3Attempted = false;
  @ViewChild('step3ErrorEl') private step3ErrorEl?: ElementRef<HTMLDivElement>;

  /**
   * Why the draft can't be saved yet, as a ready-to-show sentence, or null when
   * Step 3 is settled. The target class is what every mapping row points AT: with
   * none chosen the mapping grid never renders, so a saved draft would carry a
   * data source and columns that map to nothing, and Deploy would have no class to
   * generate a DTL against.
   */
  get missingStep3Selection(): string | null {
    if (!this.selectedTargetClass.trim()) {
      return this.loadingTargetClasses
        ? 'Wait for the target classes to finish loading, then select one.'
        : 'Select a target class before saving.';
    }
    // Every required target property must be the mapping target of some source
    // column: a deployed pipeline that leaves one unmapped can't populate that
    // property, so block the save and name the offenders.
    const unmapped = this.unmappedRequiredProperties();
    if (unmapped.length) {
      return `Map every required target property before saving. Unmapped: ${unmapped.join(', ')}.`;
    }
    return null;
  }

  /** Names of the selected class's REQUIRED properties that no source column maps
   *  to. Empty when the mapping is complete (or nothing is required). */
  unmappedRequiredProperties(): string[] {
    return unmappedRequiredProperties(this.requiredProperties.map((p) => p.name), this.sourceColumns);
  }

  get canSaveJob(): boolean { return !this.missingStep3Selection; }

  /** The prominent inline error banner text for Step 3 — the Step-1/2 treatment,
   *  applied to the target class. Derived from the CURRENT selection, so choosing
   *  a class clears it live. */
  get step3Error(): string | null {
    return this.step3Attempted ? this.missingStep3Selection : null;
  }
  /** Short objectName (dropdown value) → fully-qualified className (e.g.
   *  BOM → SC.Data.BOM), from GET /objects, used to send the FQN in the payload. */
  private classNameByObject: Record<string, string> = {};
  // Properties of the selected target class (name + type).
  targetProperties: ScAttribute[] = [];
  loadingTargetProperties = false;
  /** The required / non-required subsets of the selected class's properties — the
   *  "Required" and "Optional" optgroups in the Target Property dropdown. Splitting
   *  them groups the two visually without ever touching a property's name (the
   *  option [value] stays the clean name). The `required` flag is populated by
   *  onTargetClassChange(). */
  get requiredProperties(): ScAttribute[] {
    return this.targetProperties.filter((p) => p.required);
  }
  get optionalProperties(): ScAttribute[] {
    return this.targetProperties.filter((p) => !p.required);
  }
  // Section 3: LLM auto-mapping in flight.
  autoMapping = false;

  // ── AI availability ───────────────────────────────────────────
  /** Shows the "Claude key not provided" acknowledgement modal — raised when
   *  Deploy is pressed on an install with no Bedrock credentials. */
  showAiKeyDialog = false;
  /** The modal's body text (also used by the Auto-map toast). */
  readonly aiKeyMissingMessage = AI_KEY_MISSING_MESSAGE;

  // ── Delete confirmation ───────────────────────────────────────
  /** The pipeline awaiting a delete confirmation, or null when no prompt is up. Holds
   *  the job itself (not just an id) so the dialog can name it. */
  pendingDeleteJob: IntegrationJob | null = null;

  // ── Deploy readiness ──────────────────────────────────────────
  /** Shows the "this integration isn't finished" acknowledgement modal, raised when
   *  Deploy is pressed on a pipeline that still has incomplete wizard steps. */
  showNotReadyDialog = false;
  /** What that modal lists — the gaps found by the Deploy that was refused. */
  notReadyGaps: ReadinessGap[] = [];

  /** The refused Deploy's body text: every incomplete step, one per line. */
  get notReadyMessage(): string {
    return readinessWarningMessage(this.notReadyGaps);
  }

  /**
   * True when every wizard step of a SAVED pipeline is complete, so Deploy can run.
   * Judged from the stored job (not the live wizard) because this also drives the
   * list badge, where no wizard state exists.
   */
  isJobReady(job: IntegrationJob): boolean {
    return isJobReady(job);
  }

  /** Chip text for a draft that is complete. Spelled out rather than a bare "Ready"
   *  so the chip says what the state affords — the pipeline is finished and the
   *  Deploy button will work — instead of leaving "ready for what?" to be guessed. */
  static readonly READY_LABEL = 'Ready to Deploy';

  /**
   * The lifecycle chip's text: Deployed / Ready to Deploy / Draft.
   *
   * "Ready to Deploy" is derived, not stored — a draft whose three steps are all
   * complete. That keeps the backend's status enum (draft | created | deployed)
   * authoritative about what exists in IRIS, while the chip still tells the user
   * whether the thing they configured can actually be deployed.
   */
  statusLabel(job: IntegrationJob): string {
    if (job.status === 'deployed') return 'Deployed';
    if (job.status === 'created') return 'Created';
    return this.isJobReady(job) ? DataIntegrationComponent.READY_LABEL : 'Draft';
  }

  /**
   * "Deploy" or "Redeploy" — the same action either way, but a pipeline already
   * deployed is being UPDATED (the skill keys idempotency on the integration id, so
   * a re-run rewrites its existing classes rather than creating a second set), and
   * "Deploy" on something already deployed reads like it would do nothing.
   *
   * Only `deployed` earns the "Re-": a `created` pipeline had its classes compiled but
   * was never deployed, so deploying it is still the first time.
   */
  deployLabel(job: IntegrationJob): string {
    return this.wasDeployed(job) ? 'Redeploy' : 'Deploy';
  }

  /**
   * Has this pipeline ever been deployed — i.e. do its classes and hosts exist in SCO?
   *
   * Not the same question as "is its status deployed": editing a deployed pipeline
   * sends the status back to draft (the saved config is no longer what is live), while
   * the classes it already generated remain. So the next run is still a RE-deploy, and
   * the case still must not be deleted out from under those artifacts.
   */
  private wasDeployed(job: IntegrationJob): boolean {
    return job.status === 'deployed' || job.everDeployed === true;
  }

  /** May this pipeline be deleted? Only one that was never deployed — anything live in
   *  SCO would leave orphaned classes and production hosts behind. Drives whether the
   *  Delete button is offered at all. */
  canDeleteIntegration(job: IntegrationJob): boolean {
    return !this.wasDeployed(job);
  }

  /**
   * A SHORT descriptor of where a pipeline reads from, for the list row's hover hint.
   *
   * Short is the whole point. `sourceName` is the full connection string for a database
   * (`jdbc:postgresql://host:5432/db`), and a hint that long wraps onto a second line —
   * which does not fit in the ~38px above a row and gets clipped by the list's scroll
   * container, cutting off the FIRST line (the name). So each adapter contributes the
   * one token that identifies it: the host, the bucket, or the uploaded file's name.
   * The full connection details are on the detail panel, one click away.
   */
  sourceHint(job: IntegrationJob): string {
    const c = job.source;
    switch (job.sourceType) {
      case 'file':
        // The uploaded file's own name — `sourceName` here is the poll DIRECTORY, which
        // is identical for every local-file pipeline and so distinguishes nothing.
        return job.dataEntity?.name?.trim() || job.sourceName;
      case 'database':
        return jdbcHost(c.dbDsn) || job.sourceName;
      case 'ftp':
        return c.ftpHost?.trim() || job.sourceName;
      case 'cloud':
        return c.cloudBucket?.trim() || job.sourceName;
      default:
        return job.sourceName;
    }
  }

  /**
   * Roughly the most characters that stay on ONE line in a tooltip bubble (its cap is
   * 220px at 11px). A two-line bubble is taller than the space above a list row, so the
   * scroll container clips it — and it clips the TOP, losing the name.
   */
  private static readonly ROW_HINT_BUDGET = 40;

  /**
   * The list row's hover hint: the pipeline's name, plus its source when both fit on one
   * line. When they don't, the SOURCE is dropped rather than the name — the name is what
   * the hint is for (it's the value the row truncates), and letting the bubble wrap is
   * what made the name disappear.
   */
  rowTooltip(job: IntegrationJob): string {
    const source = this.sourceHint(job)?.trim();
    if (!source) return job.name;
    const both = `${job.name} · ${source}`;
    return both.length <= DataIntegrationComponent.ROW_HINT_BUDGET ? both : job.name;
  }

  /** The Deploy/Redeploy button's tooltip — describes updating rather than creating
   *  once the pipeline is live in SCO. */
  deployTooltip(job: IntegrationJob): string {
    return this.wasDeployed(job)
      ? 'Regenerate + recompile the classes from the current configuration and restart the pipeline in SCO'
      : 'Generate + compile the classes, register the hosts, and start the pipeline in SCO';
  }

  /** Modifier class for the chip, matching the Cube/KPI list tag palette. */
  statusTagClass(job: IntegrationJob): string {
    switch (this.statusLabel(job)) {
      case 'Deployed': return 'di-status-tag--deployed';
      case 'Created':  return 'di-status-tag--ready';
      case DataIntegrationComponent.READY_LABEL: return 'di-status-tag--ready';
      default:         return 'di-status-tag--draft';
    }
  }

  // ── SFTP key-file uploads ─────────────────────────────────────
  /** Which SFTP key files are currently uploading (button shows a spinner and
   *  is disabled while its upload is in flight). */
  uploadingKeyFile: { public: boolean; private: boolean } = { public: false, private: false };
  /** Original file name the user picked per key slot, shown next to the button
   *  (the config field itself holds the server-side path the upload returns). */
  keyFileName: { public: string; private: string } = { public: '', private: '' };
  /** The private key's file CONTENTS, held only in memory for the connection
   *  test (sent in the test request body). Deliberately NOT part of SourceConfig
   *  so key material is never persisted in a saved draft. */
  private sftpPrivateKeyContent = '';

  // ── Cloud credentials-file upload (independent from SFTP) ──────
  /** The AWS S3 credentials file is uploading (button spinner + disabled). */
  uploadingCloudCredFile = false;
  /** File name the user picked for the cloud credentials file, shown next to the
   *  button (cloudCredentialsFile holds the server-side path the upload returns). */
  cloudCredFileName = '';
  /** The AWS credentials file's CONTENTS, held only in memory for the connection
   *  test and the bucket browser (sent in those request bodies, where the backend
   *  parses the keys out). Deliberately NOT part of SourceConfig, so key material
   *  is never persisted in a saved draft — same rule as sftpPrivateKeyContent. */
  private cloudCredentialsContent = '';

  // ── Local File upload (independent) ───────────────────────────
  /** The local data file is uploading (button spinner + disabled). */
  uploadingLocalFile = false;
  /** File name the user picked, shown next to the button (filePath holds the
   *  server-side path the upload returns). */
  localFileName = '';

  // ── Uploaded-file ids (backend holds the bytes in memory) ──────
  /** The backend fileId for each uploaded slot, so Deploy can materialize them
   *  into IRIS and Delete can clean them up. Keyed by slot; only the slots that
   *  apply to the current adapter are populated. Seeded from the edited job so a
   *  slot not re-picked in an edit keeps its id. */
  private uploadFileIds: UploadSlots = {};

  // ── Test Connection (SQL / SFTP / Cloud) ──────────────────────
  /** A remote-connection test is in flight (button disabled + spinner). */
  testingConnection = false;
  /** Result of the last connection test for the current source; null = not run. */
  connectionTestResult: { ok: boolean; message: string } | null = null;
  /** Signature of the connection config the last test ran against — whatever its
   *  outcome. Compared against the live config so that the moment any connection
   *  field changes (host, port, credentials, the FTP↔SFTP flip, …) both
   *  `connectionTested` and the rendered message go stale: a pass no longer
   *  licenses the edited config, and "SFTP connection to … succeeded" is a lie
   *  about a form that now says FTP. */
  private resultSignature = '';

  /** The last test's outcome, but ONLY while it still describes what's in the form.
   *  This is what the template renders, so an edited connection can't keep showing
   *  the previous one's verdict (e.g. "SFTP connection … succeeded" surviving a flip
   *  of the Protocol radio back to FTP). Null while a test is in flight — the
   *  spinner speaks for that. */
  get currentConnectionResult(): { ok: boolean; message: string } | null {
    if (this.testingConnection || !this.connectionTestResult || !this.canTestConnection()) return null;
    return this.resultSignature === this.connectionSignature() ? this.connectionTestResult : null;
  }
  /** The in-flight test was started by Next, not by the Test Connection button —
   *  so Next reads "Verifying connection…" while the two buttons both disable. */
  verifyingForNext = false;
  @ViewChild('connectionResultEl') private connectionResultEl?: ElementRef<HTMLElement>;

  readonly SOURCE_TYPES: SourceType[] = ['database', 'ftp', 'cloud', 'file', 'rest-api'];
  /** Source types not yet supported — shown grayed out and unclickable. */
  readonly DISABLED_SOURCE_TYPES: ReadonlySet<SourceType> = new Set(['rest-api']);
  readonly SOURCE_TYPE_LABELS = SOURCE_TYPE_LABELS;
  readonly API_AUTHS = ['None', 'API Key', 'Bearer Token', 'Basic Auth'];
  /** ConfirmComplete strategies for detecting fully-written files (File/FTP). */
  readonly CONFIRM_COMPLETE_OPTIONS = ['', 'None', 'Size', 'Rename', 'Size & Rename'];
  /** Charset options; Binary makes the adapter deliver a binary stream. */
  readonly CHARSET_OPTIONS = ['', 'Binary', 'UTF-8', 'Latin1', 'ASCII'];

  /** Advanced-settings disclosure per source type sub-page. */
  advancedOpen = false;
  readonly VALIDATION_RULES = ['', 'required', 'regex', 'range', 'enum'];
  readonly ON_ERROR_OPTIONS = ['skip', 'use default', 'reject all'];

  /** Field path currently highlighted by Guided mode (bound in the template). */
  highlightPath: string | null = null;

  // Pending (in-flight deploy) state lives on the ROOT bridge, not here, so it
  // survives this component being destroyed/recreated when the user navigates to
  // another page and back while a deploy is still running. `isPending` reads it.

  /** Subscription to the agent's status reports (create/deploy/delete outcomes). */
  private statusSub?: Subscription;
  /** Subscription to agent turn-ended events, to clear a stuck Deploy spinner when
   *  the run was stopped/errored before it could report status. */
  private turnEndedSub?: Subscription;

  constructor(
    private scModel: ScModelService,
    private dataSource: DataSourceService,
    private uploads: UploadService,
    private casesApi: DataIntegrationService,
    private sqlConnectionTest: SqlConnectionTestService,
    private ftpConnectionTest: FtpConnectionTestService,
    private sftpConnectionTest: SftpConnectionTestService,
    private cloudConnectionTest: CloudConnectionTestService,
    private cdr: ChangeDetectorRef,
    private bridge: WorkbenchBridgeService,
    private toast: ToastService,
  ) {}

  /** Controller the assistant (Guided mode) uses to drive this wizard. */
  private readonly guidedController: GuidedFormController = {
    feature: 'data-integration',
    openNewForm: () => this.openNewWizard(),
    setField: (path, value) => this.guidedSetField(path, value),
    highlight: (target) => {
      this.highlightPath = target;
      this.cdr.markForCheck();
    },
    snapshot: () => this.formSnapshot(),
    // Block a navigation away from an open wizard with unsaved edits, surfacing
    // the same "Unsaved information will be lost." dialog as the Cancel button.
    canLeave: (proceed) => this.guardLeave(proceed),
    // Deep link: which pipeline is on screen, and how to get back to it on reload.
    currentItem: () => this.openItemId(),
    restoreItem: (id) => this.restoreJobById(id),
  };

  /**
   * The pipeline this page has open, as the shell's `?item=` token (the case id —
   * stable, and unique where names need not be). Mirrors `isRowActive`, so the URL
   * names whichever row is highlighted: the selected pipeline, or the one the wizard
   * is editing. A brand-new pipeline has no id until its first save, so the URL
   * carries nothing for it.
   */
  private openItemId(): string | null {
    if (this.wizardOpen) return this.editingJobId;
    return this.selectedJob?.id ?? null;
  }

  /**
   * Re-select the pipeline `?item=` names after a page reload, once the saved-case
   * list has arrived. Lands on its DETAIL view — never the wizard — so a refresh
   * mid-edit returns to the pipeline rather than a half-filled form whose unsaved
   * steps the browser already warned about. False if the case is gone (deleted, or
   * a stale bookmark), which leaves the feature intro on screen.
   */
  private async restoreJobById(id: string): Promise<boolean> {
    await this.casesReady;
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    this.selectedJob = job;
    this.wizardOpen = false;
    this.cdr.markForCheck();
    return true;
  }

  /** Resolves once the saved-case list has settled (loaded or failed), so a deep-link
   *  restore waits for the list instead of racing the initial fetch. */
  private resolveCasesReady!: () => void;
  private readonly casesReady = new Promise<void>((res) => { this.resolveCasesReady = res; });

  /** Warn the browser before a refresh/close discards unsaved wizard edits. The
   *  text is the browser's own generic prompt (modern browsers ignore a custom
   *  message); we only need to trigger it. */
  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.wizardOpen && this.formDirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  ngOnDestroy(): void {
    this.bridge.unregister(this.guidedController);
    this.statusSub?.unsubscribe();
    this.turnEndedSub?.unsubscribe();
  }

  ngOnInit(): void {
    // Load saved cases from the backend (SQLite) — the list survives refresh.
    this.reloadCases();
    // Load the target-class map now (not just when the wizard opens) so a case
    // restored after a refresh can still resolve its short objectName to the FQN
    // (SC.Data.BOM) the deploy payload needs — keeping the agent prompt identical.
    this.loadTargetClasses();
    // Expose this wizard to the assistant's Guided mode.
    this.bridge.register(this.guidedController);
    // Listen for the agent's real create/deploy/delete outcomes so a pipeline's
    // status reflects what actually happened (not the optimistic click-time guess).
    this.statusSub = this.bridge.statusReports$.subscribe((r) => this.onStatusReport(r));
    // A deploy run that ENDS without reporting status (Stop/error) has already had
    // its pending state cleared on the bridge (notifyAgentTurnEnded) — just refresh
    // this view so the spinner/disabled-Deploy update while we're on this page.
    this.turnEndedSub = this.bridge.agentTurnEnded$.subscribe(() => this.cdr.markForCheck());
  }

  // ── List panel ────────────────────────────────────────────────
  /**
   * Is this row the one the user is working on — the selected pipeline, or, while the
   * wizard is open, the one being EDITED?
   *
   * The list used to go blank the moment the wizard opened, which left nothing on screen
   * saying which pipeline the form belonged to. A brand-new pipeline has no row to
   * highlight until its first save creates one.
   */
  isRowActive(job: IntegrationJob): boolean {
    return this.wizardOpen ? this.editingJobId === job.id : this.selectedJob?.id === job.id;
  }

  selectJob(job: IntegrationJob): void {
    this.guardLeave(() => {
      this.selectedJob = job;
      this.wizardOpen = false;
      this.cdr.markForCheck();
    });
  }

  /** Load (or reload) the saved cases from the backend into the list. */
  private reloadCases(): void {
    this.casesApi.list().subscribe({
      next: ({ cases }) => {
        this.jobs = cases.map((c) => this.caseToJob(c));
        // Keep the current selection pointed at the refreshed object, if it's still there.
        if (this.selectedJob) this.selectedJob = this.jobs.find((j) => j.id === this.selectedJob!.id) ?? null;
        this.resolveCasesReady(); // the list is populated (idempotent after the first call)
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.toast.error(`Could not load saved integrations: ${err?.error?.error || err?.message || 'unknown error'}`);
        this.resolveCasesReady(); // settle even on error so a deep-link restore can't hang
        this.cdr.markForCheck();
      },
    });
  }

  /** Reconstruct an IntegrationJob from a saved case. The full job shape lives in
   *  `definition` (passwords redacted to the sentinel); id/name/status come from
   *  the case row. */
  private caseToJob(c: SavedCase): IntegrationJob {
    const def = (c.definition ?? {}) as Partial<IntegrationJob>;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      sourceType: def.sourceType ?? 'database',
      sourceName: def.sourceName ?? '',
      source: (def.source as SourceConfig) ?? this.emptySource(def.sourceType ?? 'database'),
      targetClass: def.targetClass ?? '',
      hasHeader: def.hasHeader ?? true,
      columns: (def.columns ?? []).map((col) => ({ ...col })),
      connectionTested: def.connectionTested,
      // Server-owned: "this pipeline's classes/hosts exist in SCO", which outlives a
      // status that fell back to draft when the config was edited.
      everDeployed: def.everDeployed === true,
      dataEntity: def.dataEntity,
      targetClassSignature: def.targetClassSignature,
      requiredTargetProperties: def.requiredTargetProperties ? [...def.requiredTargetProperties] : undefined,
      uploadedFiles: { ...(def.uploadedFiles ?? {}) },
    };
  }

  // ── Unsaved-changes guard (open wizard with edits) ────────────
  /** A JSON fingerprint of everything the wizard would persist. `formDirty`
   *  compares it against the last-saved snapshot, so no per-field markDirty is
   *  needed. */
  private formSignatureForDirty(): string {
    return JSON.stringify({
      name: this.jobName,
      type: this.sourceType,
      source: this.sourceConfig,
      hasHeader: this.sourceHasHeader,
      columns: this.sourceColumns,
      targetClass: this.selectedTargetClass,
      schema: this.selectedSchema,
      table: this.selectedTable,
      csv: this.selectedCsvPath,
      cloudCsv: this.selectedCloudCsvPath,
      files: this.uploadFileIds,
    });
  }

  /** True when the wizard is open and its form differs from the last save. */
  get formDirty(): boolean {
    return this.wizardOpen && this.formSignatureForDirty() !== this.savedFormSignature;
  }

  /**
   * Run `proceed` unless the open wizard has unsaved edits — in which case defer it
   * behind the "Unsaved information will be lost." confirmation. Returns whether it
   * ran synchronously (the GuidedFormController.canLeave contract).
   */
  guardLeave(proceed: () => void): boolean {
    if (this.wizardOpen && this.formDirty) {
      this.pendingLeave = proceed;
      this.showLeaveConfirm = true;
      this.cdr.markForCheck();
      return false;
    }
    proceed();
    return true;
  }

  /** Confirm leaving: discard the unsaved edits and run the deferred action. */
  leaveWithoutSaving(): void {
    this.showLeaveConfirm = false;
    const proceed = this.pendingLeave;
    this.pendingLeave = null;
    proceed?.();
    this.cdr.markForCheck();
  }

  /** Dismiss the confirmation and stay in the wizard. */
  leaveKeepEditing(): void {
    this.showLeaveConfirm = false;
    this.pendingLeave = null;
    this.cdr.markForCheck();
  }

  /**
   * Generate (once) the IRIS Credentials entry name the adapter will reference —
   * `<source label>_<uuid>` sanitized to a valid credential SystemName. Frozen on
   * the config after the first Save so re-deploys upsert the same entry rather
   * than orphaning a new one. Only SQL and FTP/SFTP use a Credentials entry.
   */
  private ensureCredentialName(): void {
    const c = this.sourceConfig;
    // Regenerate a name that is missing OR overflows the SystemName MAXLEN (a draft
    // saved before the cap froze a 51+ char name that IRIS rejects at Deploy). A
    // valid (≤ MAXLEN) name is kept: it may already back a deployed credential, and
    // an over-long one provably never deployed (creation always failed), so remaking
    // only the over-long one orphans nothing.
    if (c.type === 'database' && this.credentialNameNeedsGen(c.dbCredentialName)) {
      c.dbCredentialName = this.makeCredentialName(c.dbDataSourceName || c.dbDsn || 'sql');
    } else if (c.type === 'ftp' && this.credentialNameNeedsGen(c.ftpCredentialName)) {
      c.ftpCredentialName = this.makeCredentialName(c.ftpDataSourceName || c.ftpHost || 'ftp');
    }
  }

  /** Ens.Config.Credentials:SystemName MAXLEN — a longer value fails datatype
   *  validation (#7201/#5802) when the credential is created at Deploy. */
  private static readonly CRED_NAME_MAXLEN = 50;

  /** A stored credential name must be (re)generated when absent or over the MAXLEN. */
  private credentialNameNeedsGen(name: string | undefined): boolean {
    return !name || name.length > DataIntegrationComponent.CRED_NAME_MAXLEN;
  }

  /** Build a valid IRIS credential SystemName from a label + a uuid suffix, capped at
   *  the SystemName MAXLEN. The suffix (8 hex from a uuid) keeps the name unique per
   *  pipeline; only the LABEL is truncated so the whole suffix survives and
   *  `label_suffix` always fits — otherwise a long Data Source Name overflows MAXLEN
   *  and Deploy fails creating the entry. */
  private makeCredentialName(label: string): string {
    const base = (label || 'cred').replace(/[^A-Za-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'cred';
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const room = DataIntegrationComponent.CRED_NAME_MAXLEN - suffix.length - 1; // 1 for the "_"
    return `${base.slice(0, room).replace(/_$/, '')}_${suffix}`;
  }

  /** The polled SELECT for a database source — see buildSqlQuery in deploy-prompt.ts,
   *  which owns it because the deploy payload carries the query. */
  private buildSqlQuery(job: IntegrationJob): string {
    return buildSqlQuery(job);
  }

  /** The FTP/SFTP control port to send downstream — see ftpPortOrDefault in
   *  deploy-prompt.ts. */
  private ftpPortOrDefault(c: SourceConfig): string {
    return ftpPortOrDefault(c);
  }

  /** Only the Step-1 fields relevant to the job's adapter — see buildSourcePayload
   *  in deploy-prompt.ts. */
  private buildSourcePayload(c: SourceConfig): Record<string, unknown> {
    return buildSourcePayload(c);
  }

  /** The full deploy payload (Step 1 + Step 2) — see buildDeployPayload in
   *  deploy-prompt.ts. */
  private buildDeployPayload(job: IntegrationJob) {
    return buildDeployPayload(job, this.classNameByObject);
  }

  /** Template entry point for "+ New": guard any unsaved edits first. */
  attemptNewWizard(): void {
    this.guardLeave(() => this.openNewWizard());
  }

  /** Template entry point for "Edit": guard any unsaved edits first. */
  attemptEditJob(job: IntegrationJob): void {
    this.guardLeave(() => this.editJob(job));
  }

  openNewWizard(): void {
    this.editingJobId = null;
    this.currentStep = 1;
    this.step1Attempted = false;
    this.step3Attempted = false;
    this.jobName = '';
    this.sourceType = 'database';
    this.uploadFileIds = {};
    this.freshUploadSlots.clear();
    this.sourceConfig = this.emptySource('database');
    this.sourceColumns = [];
    this.sourceHasHeader = true;
    this.selectedTargetClass = '';
    this.targetProperties = [];
    this.connectionTestResult = null;
    this.testingConnection = false;
    this.verifyingForNext = false;
    this.resetDataStep();
    this.loadTargetClasses();
    this.selectedJob = null;
    this.wizardOpen = true;
    this.savedFormSignature = this.formSignatureForDirty(); // a fresh form starts clean
    this.cdr.markForCheck();
  }

  editJob(job: IntegrationJob): void {
    this.editingJobId = job.id;
    this.step1Attempted = false;
    this.step2Attempted = false;
    this.step3Attempted = false;
    this.jobName = job.name;
    this.sourceType = job.source.type;
    // Wipe the Step-2 whiteboard BEFORE seeding the saved selection, exactly as
    // openNewWizard() does. The wizard lives in one long-lived component (no route
    // per feature), so without this a reopened case inherits the PREVIOUS session's
    // transient browse state — `loadedDataSource` and the ftp/cloud/sql listings —
    // which makes enterDataStep() either spuriously reset the just-seeded selection
    // (different identity) or skip the restore preview (stale list still present).
    // Every value it clears is re-seeded below from the saved job.
    this.resetDataStep();
    // Seed the slot map from the saved job so a slot the user does NOT re-pick
    // keeps its original id (its bytes already live in SQLite). Only slots
    // re-picked THIS session are "fresh" and re-persisted on the next Save.
    this.uploadFileIds = { ...(job.uploadedFiles ?? {}) };
    this.freshUploadSlots.clear();
    this.sourceConfig = { ...job.source };
    // Self-heal drafts saved before the query was auto-derived: rebuild it from
    // the stored table selection (dataEntity.source = schema, .name = table).
    if (this.sourceType === 'database' && !this.sourceConfig.dbQuery?.trim() && job.dataEntity?.name) {
      const schema = job.dataEntity.source && job.dataEntity.source !== '—' ? job.dataEntity.source : '';
      const qualified = schema ? `${schema}.${job.dataEntity.name}` : job.dataEntity.name;
      this.sourceConfig.dbQuery = `SELECT * FROM ${qualified}`;
    }
    // Restore the new mapping model (Sections 1–3).
    this.sourceColumns = job.columns.map(c => ({ ...c }));
    this.sourceHasHeader = job.hasHeader;
    // Seed the Step-2 selection labels so the restored entity shows without a
    // re-introspection round trip (the plaintext password isn't in the browser,
    // so re-browsing a password-protected source needs the user to re-enter it).
    this.seedDataStepFromEntity(job);
    // Remember the saved mapping keyed to its source entity, so a Step-2 detour that
    // returns to the SAME table restores these mappings rather than blanking them.
    this.mappingByEntity.clear();
    this.mappingEntityKey = this.currentEntityKey();
    this.mappingByEntity.set(this.mappingEntityKey, this.sourceColumns.map((c) => ({ ...c })));
    // Remember the mapping keyed to its target CLASS too, so switching the target
    // class away and back restores these rows (see onTargetClassChange).
    this.savedTargetClass = job.targetClass ?? '';
    this.savedMappingByColumn = new Map(
      this.sourceColumns
        .filter((c) => c.targetProperty)
        .map((c) => [c.name, c.targetProperty as string]),
    );
    // A previously-tested connection stays "tested" so Step 1 → 2 doesn't force a
    // re-test the redacted password would fail. Any edit to a connection field
    // drifts the signature and re-arms the gate (see connectionTested).
    if (job.connectionTested) {
      this.connectionTestResult = { ok: true, message: 'Connection previously verified.' };
      this.resultSignature = this.connectionSignature();
    } else {
      this.connectionTestResult = null;
    }
    this.testingConnection = false;
    this.verifyingForNext = false;
    this.loadTargetClasses();
    // Restore + re-validate the target class against its CURRENT definition; a
    // changed/removed class resets Step 3 (see restoreTargetClass).
    this.restoreTargetClass(job);
    this.currentStep = 1;
    this.wizardOpen = true;
    this.selectedJob = null;
    this.savedFormSignature = this.formSignatureForDirty(); // a just-restored form is clean
    this.cdr.markForCheck();
  }

  /** Seed the Step-2 selection state (schema/table, CSV path, object key) from a
   *  restored job's saved data entity, so the choice is visible without re-listing
   *  the source. `carriedOverDataEntity` then lets Step 2 pass its gate on the
   *  saved columns rather than forcing a re-pick. */
  private seedDataStepFromEntity(job: IntegrationJob): void {
    const e = job.dataEntity;
    if (!e) return;
    switch (job.sourceType) {
      case 'database':
        this.selectedSchema = e.source && e.source !== '—' ? e.source : '';
        this.selectedTable = e.name;
        break;
      case 'ftp':
        this.selectedCsvPath = e.source;
        // Point the browser at the saved file's directory so the breadcrumb + listing
        // restore there (not the root) when Step 2 re-lists it.
        this.ftpPathSegments = (this.sourceConfig.ftpPath ?? '').split('/').filter(Boolean);
        break;
      case 'cloud':
        this.selectedCloudCsvPath = e.source;
        // The saved object's key prefix ("folder"); restore the browser there.
        this.cloudPathSegments = (this.sourceConfig.cloudBlobPrefix ?? '').split('/').filter(Boolean);
        break;
      case 'file':
        this.localFileName = e.name;
        break;
    }
  }

  /**
   * Restore the saved target class, re-fetch its properties, and compare them to
   * the signature captured at Save. If the class no longer exists or ANY property
   * changed, the saved mappings point at a class that isn't there anymore, so drop
   * the target selection and clear every row's Target Property (Step 3 default).
   */
  private restoreTargetClass(job: IntegrationJob): void {
    if (!job.targetClass) { this.selectedTargetClass = ''; this.targetProperties = []; return; }
    this.selectedTargetClass = job.targetClass;
    this.loadingTargetProperties = true;
    this.cdr.markForCheck();
    this.scModel.getObjectDetail(job.targetClass).subscribe({
      next: (detail) => {
        const props: ScAttribute[] = (detail?.attributes ?? []).map((a: any) => ({
          name: a.name, dataType: a.dataType, required: !!a.required,
        }));
        this.loadingTargetProperties = false;
        if (this.targetClassSignatureOf(job.targetClass, props) !== (job.targetClassSignature ?? '')) {
          this.resetStaleTargetClass();
        } else {
          this.targetProperties = props;
        }
        this.savedFormSignature = this.formSignatureForDirty(); // resets keep the form "clean"
        this.cdr.markForCheck();
      },
      error: () => {
        // The class could not be read (most likely it no longer exists) — treat it
        // as stale and reset the target selection.
        this.loadingTargetProperties = false;
        this.resetStaleTargetClass();
        this.savedFormSignature = this.formSignatureForDirty();
        this.cdr.markForCheck();
      },
    });
  }

  /** Drop a stale target class: no class selected, no properties, and every
   *  mapping row's Target Property cleared. */
  private resetStaleTargetClass(): void {
    this.selectedTargetClass = '';
    this.targetProperties = [];
    this.sourceColumns = this.sourceColumns.map((c) => ({ ...c, targetProperty: '' }));
    this.toast.info('The saved target class changed or no longer exists; please re-select it.');
  }

  /** Stable fingerprint of a target class + its properties (name/type/required),
   *  so a restore can detect any drift since the case was saved. */
  private targetClassSignatureOf(cls: string, props: ScAttribute[]): string {
    return JSON.stringify({
      cls,
      props: props.map((p) => [p.name, p.dataType, p.required]).sort(),
    });
  }

  cancelWizard(): void {
    this.guardLeave(() => {
      this.wizardOpen = false;
      // Land back on the pipeline that was being edited — its detail view, with its row
      // highlighted. editJob() clears the selection when it opens the wizard, so without
      // this a Cancel dropped the user on the feature intro and they had to find their
      // pipeline in the list again. A never-saved new pipeline has nothing to go back to.
      this.selectedJob = this.editingJobId
        ? this.jobs.find((j) => j.id === this.editingJobId) ?? null
        : null;
      this.cdr.markForCheck();
    });
  }

  // ── Step 1 ────────────────────────────────────────────────────
  onSourceTypeChange(): void {
    this.sourceConfig = this.emptySource(this.sourceType);
    this.advancedOpen = false;
    // A prior result belongs to the previous source's config — clear it.
    this.connectionTestResult = null;
    this.testingConnection = false;
    this.verifyingForNext = false;
    // The Data step is adapter-specific — a new adapter invalidates its selections.
    this.resetDataStep();
  }

  // ── Step 2: Data (adapter-specific) ───────────────────────────
  /** Clear all Data-step selections/results (on new wizard or adapter change). */
  private resetDataStep(): void {
    this.step2Attempted = false;
    // SQL
    this.sqlSchemas = [];
    this.schemaError = null;
    this.selectedSchema = '';
    this.sqlTables = [];
    this.tableError = null;
    this.selectedTable = '';
    this.sqlColumns = [];
    this.columnError = null;
    this.loadingSchemas = false;
    this.loadingTables = false;
    this.loadingColumns = false;
    // FTP/SFTP
    this.ftpPathSegments = [];
    this.ftpEntries = [];
    this.loadingFtpDir = false;
    this.ftpError = null;
    this.selectedCsvPath = '';
    this.csvPreview = null;
    this.loadingCsvPreview = false;
    this.csvPreviewError = null;
    this.ftpCsvRaw = [];
    // Cloud
    this.cloudPathSegments = [];
    this.cloudEntries = [];
    this.loadingCloudDir = false;
    this.cloudError = null;
    this.selectedCloudCsvPath = '';
    this.cloudCsvPreview = null;
    this.loadingCloudCsvPreview = false;
    this.cloudCsvPreviewError = null;
    this.cloudCsvRaw = [];
    this.sourceConfig.cloudBlobPrefix = '';
    this.sourceConfig.cloudBlobPattern = '';
    // Local File
    this.localCsvPreview = null;
    this.loadingLocalPreview = false;
    this.localPreviewError = null;
    this.localFile = null;
    this.localCsvRaw = [];
    // The recorded data entity names a table/file on the server being left, so it
    // goes too — otherwise Step 2's gate would wave the user through to Mapping on
    // an entity that no longer exists (see carriedOverDataEntity).
    this.sourceConfig.dbQuery = '';
    this.sourceConfig.ftpPath = '';
    this.sourceConfig.ftpFileSpec = '';
    // Step-2 → Step-3 seeding
    this.lastDataSignature = '';
    this.loadedDataSource = '';
    // The per-entity mapping cache belongs to the previous adapter/wizard session.
    this.mappingByEntity.clear();
    this.mappingEntityKey = null;
    // Likewise the saved-by-class baseline (a brand-new case has none to restore).
    this.savedTargetClass = '';
    this.savedMappingByColumn.clear();
  }

  /** Advance to the Data step, but only over a connection that actually works.
   *
   *  Two gates, in order:
   *    1. Required fields — a blocked Next surfaces a prominent "<field> is
   *       required" banner (same red treatment as the cube/KPI forms), scrolled
   *       into view. The button stays clickable precisely so this can fire; the
   *       form doesn't nag until the user tries.
   *    2. A live connection test — Step 2 immediately introspects the source
   *       (list schemas / list a directory / list the bucket), so advancing on an
   *       unverified connection only moves the same failure one page to the right,
   *       where it reads as a broken Data step instead of bad credentials. Already
   *       verified configs skip the round trip: `connectionTested` is true only
   *       while the tested config still matches what's in the form.
   */
  goDataStep(): void {
    // Both gates report themselves inside Step 1's body, so they only apply when
    // Step 1 is what we're leaving. The Step-2 breadcrumb also lands here from
    // Step 3, and gating that would strand its message on an invisible step —
    // moving BACK through the wizard is not a fresh attempt to advance.
    if (this.currentStep !== 1) {
      this.enterDataStep();
      return;
    }

    if (!this.canProceedStep1) {
      // Turning this on makes the `step1Error` getter surface the missing field;
      // scroll the banner into view so it can't be missed.
      this.step1Attempted = true;
      this.cdr.markForCheck();
      setTimeout(
        () => this.step1ErrorEl?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        0,
      );
      return;
    }

    if (this.canTestConnection() && !this.connectionTested) {
      if (this.testingConnection) return;   // a test is already in flight
      this.verifyingForNext = true;
      this.testConnection((result) => {
        this.verifyingForNext = false;
        if (result.ok) {
          this.persistThenEnterDataStep();
        } else {
          // The failure renders in the existing test-result slot under the
          // buttons; scroll it into view for the same reason as the banner.
          this.cdr.markForCheck();
          setTimeout(
            () => this.connectionResultEl?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' }),
            0,
          );
        }
      });
      return;
    }

    this.persistThenEnterDataStep();
  }

  /** Save the case (Step-1 data), then advance to Step 2 only if the save stuck. */
  private persistThenEnterDataStep(): void {
    this.persistCase((ok) => { if (ok) this.enterDataStep(); });
  }

  /**
   * Which SERVER/BUCKET the Step-2 browser is pointed at — the identity of the
   * data source, not the credentials used to reach it. Everything Step 2 shows
   * (schema list, directory listing, previews, the picked entity) belongs to this
   * identity, so a change to it invalidates all of them.
   *
   * Authentication material is deliberately EXCLUDED (password, SFTP private key,
   * AWS credentials file): those decide whether you get in, not which machine you
   * are looking at, and a wrong one can't leave a stale listing on screen because
   * the Next gate refuses to advance on a failed test. Including them would throw
   * away the user's schema/file selection every time they retyped a password.
   */
  private dataSourceIdentity(): string {
    const c = this.sourceConfig;
    switch (this.sourceType) {
      case 'database': return `sql|${c.dbType ?? ''}|${c.dbDsn ?? ''}|${c.dbUsername ?? ''}`;
      // The protocol is part of the identity in its own right: FTP and SFTP on the
      // same host and port are different servers with different file trees.
      case 'ftp':      return `${c.ftpSftp ? 'sftp' : 'ftp'}|${c.ftpHost ?? ''}|${this.ftpPortOrDefault(c)}|${c.ftpUsername ?? ''}`;
      case 'cloud':    return `s3|${c.cloudBucket ?? ''}|${c.cloudRegion ?? ''}`;
      default:         return this.sourceType;   // file / rest-api: nothing remote to browse
    }
  }

  /** Enter the Data step. Loads the adapter's initial data-selection view once:
   *  SQL → schema list; FTP/SFTP → root directory listing. */
  private enterDataStep(): void {
    this.currentStep = 2;
    // Re-entering after Step 1 was pointed at a DIFFERENT server (another host or
    // bucket, a different DSN, or the FTP→SFTP flip): every listing, preview and
    // selection on this step came from the old one. The load branches below only
    // fetch when their list is EMPTY, so without this the previous server's file
    // tree stays on screen and the picked entity still names one of its files.
    const identity = this.dataSourceIdentity();
    if (this.loadedDataSource && identity !== this.loadedDataSource) this.resetDataStep();
    this.loadedDataSource = identity;
    // A reopened case seeds its saved selection labels but not the browse lists or
    // the file preview, so each shows blank until re-fetched. Every adapter has a
    // dedicated restore that re-lists/previews from the server — the backend recovers
    // the case's persisted secret by id (password / SFTP key / cloud creds file), and
    // the local file previews from its stored SQLite copy — to DISPLAY the saved
    // schema/table or directory + file content, exactly as the SQL restore does. The
    // restores are DISPLAY-ONLY: they never rebuild the Step-3 mapping columns, so the
    // target properties/transforms the user already saved survive. Each is guarded to
    // run once (its list/preview still empty); a later re-entry just shows what's there.
    if (this.editingJobId && this.carriedOverDataEntity) {
      switch (this.sourceType) {
        case 'database':
          if (!this.sqlSchemas.length && !this.loadingSchemas) this.restoreSqlDataStep();
          else this.cdr.markForCheck();
          return;
        case 'ftp':
          if (!this.ftpEntries.length && !this.loadingFtpDir) this.restoreFtpDataStep();
          else this.cdr.markForCheck();
          return;
        case 'cloud':
          if (!this.cloudEntries.length && !this.loadingCloudDir) this.restoreCloudDataStep();
          else this.cdr.markForCheck();
          return;
        case 'file':
          this.enterLocalFileStep();
          return;
      }
    }
    // A carried-over entity from THIS session (not a reopen) already has its browse
    // lists in memory from live browsing, so it's shown as-is; `carriedOverDataEntity`
    // waves the Step-2 gate through, and editing a connection field (identity change,
    // above) resets this and re-enables live browsing.
    if (this.carriedOverDataEntity) { this.cdr.markForCheck(); return; }
    if (this.sourceType === 'database' && !this.sqlSchemas.length && !this.loadingSchemas) {
      this.loadSchemas();
    } else if (this.sourceType === 'ftp' && !this.ftpEntries.length && !this.loadingFtpDir) {
      this.loadFtpDir();
    } else if (this.sourceType === 'cloud' && !this.cloudEntries.length && !this.loadingCloudDir) {
      this.loadCloudDir();
    } else if (this.sourceType === 'file') {
      this.enterLocalFileStep();
    }
    this.cdr.markForCheck();
  }

  /**
   * Show the local file's preview, from wherever its bytes are.
   *
   * The Local File adapter is the one adapter whose entity is picked in STEP 1, so
   * Step 2 has no control the user can re-pick to trigger a load — if this step
   * doesn't resolve the preview itself, the user is left staring at a "Preview —
   * orders.csv" heading with no table under it and nothing to click.
   *
   * Two sources of bytes, in order:
   *   • the picked `File`, still in memory this session → read it client-side;
   *   • otherwise a REOPENED case → the copy the backend persisted to SQLite at Save.
   * Reached from both enterDataStep() branches, because a reopened case that was
   * saved from Step 1 only (the common "upload, Save, come back later" flow) has no
   * saved mapping columns and so is not a `carriedOverDataEntity`.
   */
  private enterLocalFileStep(): void {
    // Already resolved (a preview, an inline error, or a read in flight) — a
    // re-entry just shows what's there, exactly as the other adapters' guards do.
    if (this.localCsvPreview || this.localPreviewError || this.loadingLocalPreview) {
      this.cdr.markForCheck();
      return;
    }
    if (this.localFile) { this.loadLocalPreview(); return; }
    if (this.editingJobId && this.sourceConfig.filePath?.trim()) { this.restoreLocalDataStep(); return; }
    this.cdr.markForCheck();
  }

  /**
   * Re-introspect a REOPENED SQL case to restore its saved schema/table for display.
   * Chains schema → table → column just like a manual drill-down, but preserves the
   * saved selection at each level instead of resetting downstream (which the normal
   * onSchemaChange/onTableChange handlers do). When the saved schema or table no
   * longer exists on the server, it falls back to the fresh-pick state — same as a
   * case that was never saved — so the user selects a schema, then a table, anew.
   *
   * The Step-3 mapping columns (sourceColumns) are NEVER rebuilt here: this only
   * repopulates the Step-2 display lists (sqlSchemas/sqlTables/sqlColumns), so the
   * target-property mappings and transforms the user already saved survive intact.
   */
  private restoreSqlDataStep(): void {
    const savedSchema = this.selectedSchema;
    const savedTable = this.selectedTable;
    this.loadingSchemas = true;
    this.schemaError = null;
    this.cdr.markForCheck();
    this.dataSource.getSchemas(this.sqlConnection()).subscribe({
      next: (res) => {
        this.loadingSchemas = false;
        if (!res.ok || !res.schemas) {
          this.schemaError = res.message || 'Could not load schemas from the database.';
          this.cdr.markForCheck();
          return;
        }
        this.sqlSchemas = res.schemas;
        if (savedSchema && res.schemas.includes(savedSchema)) {
          this.selectedSchema = savedSchema;
          this.restoreSqlTables(savedSchema, savedTable);
        } else {
          // The saved schema is gone — drop the stale selection so the user picks anew.
          this.fallBackToFreshSqlPick();
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingSchemas = false;
        this.schemaError = err?.error?.error || err?.message || 'Could not load schemas from the database.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Restore step of restoreSqlDataStep: list the saved schema's tables, then keep
   *  the saved table (loading its columns) if it still exists, else fall back. */
  private restoreSqlTables(schema: string, savedTable: string): void {
    this.loadingTables = true;
    this.tableError = null;
    this.cdr.markForCheck();
    this.dataSource.getTables(this.sqlConnection(), schema).subscribe({
      next: (res) => {
        this.loadingTables = false;
        if (!res.ok || !res.tables) {
          this.tableError = res.message || 'Could not load tables for this schema.';
          this.cdr.markForCheck();
          return;
        }
        this.sqlTables = res.tables;
        if (savedTable && res.tables.includes(savedTable)) {
          this.selectedTable = savedTable;
          this.restoreSqlColumns(schema, savedTable);
        } else {
          // The saved table is gone — clear it so the user picks from the live list.
          this.selectedTable = '';
          this.sqlColumns = [];
          this.sourceConfig.dbQuery = '';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingTables = false;
        this.tableError = err?.error?.error || err?.message || 'Could not load tables for this schema.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Restore step of restoreSqlDataStep: load the saved table's columns for DISPLAY
   *  only. Deliberately does not touch sourceColumns, so the saved mappings survive. */
  private restoreSqlColumns(schema: string, table: string): void {
    this.loadingColumns = true;
    this.columnError = null;
    this.cdr.markForCheck();
    this.dataSource.getColumns(this.sqlConnection(), schema, table).subscribe({
      next: (res) => {
        this.loadingColumns = false;
        if (res.ok && res.columns) this.sqlColumns = res.columns;
        else this.columnError = res.message || 'Could not load columns for this table.';
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingColumns = false;
        this.columnError = err?.error?.error || err?.message || 'Could not load columns for this table.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Drop a reopened SQL case's stale schema/table selection so Step 2 behaves like
   *  a never-saved case: clearing `dbQuery` also drops `carriedOverDataEntity`, so
   *  the Step-2 gate again requires a real selection instead of waving the saved one
   *  through. The dropdown of live schemas stays populated for the fresh pick. */
  private fallBackToFreshSqlPick(): void {
    this.selectedSchema = '';
    this.selectedTable = '';
    this.sqlTables = [];
    this.sqlColumns = [];
    this.sourceConfig.dbQuery = '';
  }

  /**
   * Re-introspect a REOPENED FTP/SFTP case to restore its saved directory listing
   * and CSV preview for DISPLAY. The FTP/SFTP analogue of restoreSqlDataStep: the
   * backend recovers the persisted password/private key by case id, so the listing
   * and preview succeed without the user re-entering credentials. The Step-3 mapping
   * columns are NEVER rebuilt here (display only), so the saved mappings survive. If
   * the saved file no longer lists/reads, the inline error shows and the user can
   * browse to another file, same as a fresh pick.
   */
  private restoreFtpDataStep(): void {
    const savedCsvPath = this.selectedCsvPath;
    const blocked = this.ftpBrowseBlocker;
    if (blocked) { this.ftpError = blocked; this.cdr.markForCheck(); return; }
    this.loadingFtpDir = true;
    this.ftpError = null;
    this.cdr.markForCheck();
    this.dataSource.listFtpDir(this.ftpConnection(), this.ftpCurrentPath).subscribe({
      next: (res) => {
        this.loadingFtpDir = false;
        if (res.ok && res.entries) {
          this.ftpEntries = res.entries;
          if (savedCsvPath) this.restoreRemoteCsvPreview(savedCsvPath);
        } else {
          this.ftpError = res.message || 'Could not list this directory.';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingFtpDir = false;
        this.ftpError = err?.error?.error || err?.message || 'Could not list this directory.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Re-preview a reopened FTP/SFTP case's saved CSV for DISPLAY only — rebuilds
   *  csvPreview from the raw rows but deliberately does not touch sourceColumns, so
   *  the saved Step-3 mappings survive (mirrors restoreSqlColumns). */
  private restoreRemoteCsvPreview(path: string): void {
    this.loadingCsvPreview = true;
    this.csvPreviewError = null;
    this.cdr.markForCheck();
    this.dataSource.previewRemoteCsv(this.ftpConnection(), path).subscribe({
      next: (res) => {
        this.loadingCsvPreview = false;
        if (res.ok && res.rows) {
          this.ftpCsvRaw = res.rows;
          this.csvPreview = this.buildCsvPreviewFromRaw(this.ftpCsvRaw);
        } else {
          this.csvPreviewError = res.message || 'Could not read this file.';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingCsvPreview = false;
        this.csvPreviewError = err?.error?.error || err?.message || 'Could not read this file.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Re-list a REOPENED cloud case's saved prefix and re-preview its object for
   *  DISPLAY. Cloud analogue of restoreFtpDataStep: the backend recovers the
   *  persisted credentials file by case id. Display only — the saved mappings survive. */
  private restoreCloudDataStep(): void {
    const savedPath = this.selectedCloudCsvPath;
    const blocked = this.cloudBrowseBlocker;
    if (blocked) { this.cloudError = blocked; this.cdr.markForCheck(); return; }
    this.loadingCloudDir = true;
    this.cloudError = null;
    this.cdr.markForCheck();
    this.dataSource.listCloudDir(this.cloudConnection(), this.cloudCurrentPath).subscribe({
      next: (res) => {
        this.loadingCloudDir = false;
        if (res.ok && res.entries) {
          this.cloudEntries = res.entries;
          if (savedPath) this.restoreCloudCsvPreview(savedPath);
        } else {
          this.cloudError = res.message || 'Could not list this bucket prefix.';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingCloudDir = false;
        this.cloudError = err?.error?.error || err?.message || 'Could not list this bucket prefix.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Re-preview a reopened cloud case's saved object for DISPLAY only (does not
   *  touch sourceColumns, so the saved mappings survive). */
  private restoreCloudCsvPreview(path: string): void {
    this.loadingCloudCsvPreview = true;
    this.cloudCsvPreviewError = null;
    this.cdr.markForCheck();
    this.dataSource.previewCloudCsv(this.cloudConnection(), path).subscribe({
      next: (res) => {
        this.loadingCloudCsvPreview = false;
        if (res.ok && res.rows) {
          this.cloudCsvRaw = res.rows;
          this.cloudCsvPreview = this.buildCsvPreviewFromRaw(this.cloudCsvRaw);
        } else {
          this.cloudCsvPreviewError = res.message || 'Could not read this object.';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingCloudCsvPreview = false;
        this.cloudCsvPreviewError = err?.error?.error || err?.message || 'Could not read this object.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Preview a REOPENED local-file case from the copy the backend stored in SQLite —
   *  the browser no longer holds the picked File after a refresh, so there are no
   *  bytes to read client-side. Display only; the saved mappings survive. */
  private restoreLocalDataStep(): void {
    if (!this.editingJobId) return;
    this.loadingLocalPreview = true;
    this.localPreviewError = null;
    this.cdr.markForCheck();
    this.dataSource.previewStoredLocalCsv(this.editingJobId).subscribe({
      next: (res) => {
        this.loadingLocalPreview = false;
        if (res.ok && res.rows) {
          this.localCsvRaw = res.rows;
          this.localCsvPreview = this.buildCsvPreviewFromRaw(this.localCsvRaw);
          if (!this.localCsvPreview) this.localPreviewError = 'The file appears to be empty.';
          // A case saved from Step 1 only carries NO mapping columns, and this adapter
          // has no Step-2 control whose change would seed them — so seed Step 3 from
          // the restored preview here. Guarded on "nothing saved to protect": a case
          // WITH a saved mapping must survive this restore untouched (display only),
          // which is what keeps its target properties and transforms intact.
          if (!this.sourceColumns.length) this.syncSourceColumnsFromData();
        } else {
          this.localPreviewError = res.message || 'Re-upload the file in the Data Source step to preview it.';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingLocalPreview = false;
        this.localPreviewError = err?.error?.error || err?.message || 'Could not read the file.';
        this.cdr.markForCheck();
      },
    });
  }

  /** Advance to the Mapping step, but only once a data entity is actually
   *  selected — Step 3 maps the retrieved columns, so with nothing selected it
   *  opens empty and the real problem (no table/file picked) is left behind on an
   *  invisible step. A blocked Next surfaces `step2Error` and scrolls it in, the
   *  same contract Step 1 uses. */
  goMappingStep(): void {
    // The banner lives in Step 2's body, so the gate only applies when Step 2 is
    // what we're leaving — the Mapping breadcrumb is clickable from Step 3 too,
    // and re-entering Step 3 is not a fresh attempt to advance.
    if (this.currentStep === 2 && !this.canProceedStep2) {
      this.step2Attempted = true;
      this.cdr.markForCheck();
      setTimeout(
        () => this.step2ErrorEl?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        0,
      );
      return;
    }
    // Leaving Step 2 forward: save the entity selection before showing Mapping.
    // Moving BACK into Step 3 from elsewhere doesn't re-save (nothing changed).
    if (this.currentStep === 2) {
      this.persistCase((ok) => { if (ok) { this.currentStep = 3; this.cdr.markForCheck(); } });
      return;
    }
    this.currentStep = 3;
    this.cdr.markForCheck();
  }

  /** Build the SQL connection config (from Step 1) that introspection calls
   *  authenticate with. Mirrors the Test Connection payload — same DSN, username,
   *  password, and the driver class derived from the chosen Database Type. */
  private sqlConnection(): SqlConnection {
    const c = this.sourceConfig;
    return {
      dsn: c.dbDsn ?? '',
      username: c.dbUsername ?? '',
      password: c.dbPassword ?? '',
      driverClass: this.DB_DRIVER_CLASS[c.dbType ?? ''] ?? '',
      // A reopened case holds the password only as the `__saved__` sentinel; the id
      // lets the backend swap in the decrypted password so browse works unchanged.
      caseId: this.editingJobId ?? undefined,
    };
  }

  /** SQL: fetch the connected database's schemas via the backend (real JDBC).
   *  On failure (unreachable host / bad credentials) surfaces the message inline
   *  in the Schema section rather than leaving an empty dropdown. */
  loadSchemas(): void {
    this.loadingSchemas = true;
    this.schemaError = null;
    this.sqlSchemas = [];
    this.cdr.markForCheck();
    this.dataSource.getSchemas(this.sqlConnection()).subscribe({
      next: (res) => {
        if (res.ok && res.schemas) {
          this.sqlSchemas = res.schemas;
        } else {
          this.schemaError = res.message || 'Could not load schemas from the database.';
        }
        this.loadingSchemas = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.schemaError = err?.error?.error || err?.message || 'Could not load schemas from the database.';
        this.loadingSchemas = false;
        this.cdr.markForCheck();
      },
    });
  }

  /** SQL: when a schema is picked, load its tables and reset the downstream
   *  table/column selections. Surfaces a fetch error inline in the Table section. */
  onSchemaChange(): void {
    this.selectedTable = '';
    this.sqlTables = [];
    this.sqlColumns = [];
    this.tableError = null;
    this.columnError = null;
    if (!this.selectedSchema) { this.cdr.markForCheck(); return; }
    this.loadingTables = true;
    this.cdr.markForCheck();
    this.dataSource.getTables(this.sqlConnection(), this.selectedSchema).subscribe({
      next: (res) => {
        if (res.ok && res.tables) this.sqlTables = res.tables;
        else this.tableError = res.message || 'Could not load tables for this schema.';
        this.loadingTables = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.tableError = err?.error?.error || err?.message || 'Could not load tables for this schema.';
        this.loadingTables = false;
        this.cdr.markForCheck();
      },
    });
  }

  /** SQL: when a table is picked, load its columns (name + data type). Surfaces a
   *  fetch error inline in the Columns section. */
  onTableChange(): void {
    this.sqlColumns = [];
    this.columnError = null;
    if (!this.selectedTable) { this.sourceConfig.dbQuery = ''; this.cdr.markForCheck(); return; }
    // The SQL adapter polls a SELECT; derive it from the picked schema.table so the
    // user never types it. Qualify with the schema when present (e.g.
    // "SELECT * FROM SC_Data.Carrier").
    const qualified = this.selectedSchema ? `${this.selectedSchema}.${this.selectedTable}` : this.selectedTable;
    this.sourceConfig.dbQuery = `SELECT * FROM ${qualified}`;
    this.loadingColumns = true;
    this.cdr.markForCheck();
    this.dataSource.getColumns(this.sqlConnection(), this.selectedSchema, this.selectedTable).subscribe({
      next: (res) => {
        if (res.ok && res.columns) {
          this.sqlColumns = res.columns;
          // Record the source table's key column (a single primary/unique key) as
          // the pipeline's row-tracking KeyFieldName — auto-set for the user, not
          // hand-picked. Only a SINGLE key column is usable (the adapter tracks by
          // one column); a composite/absent key leaves it empty → row-tracking off.
          const keyCols = res.columns.filter((c) => c.primaryKey).map((c) => c.name);
          this.sourceConfig.dbKeyField = keyCols.length === 1 ? keyCols[0] : '';
          this.syncSourceColumnsFromData();
        } else {
          this.columnError = res.message || 'Could not load columns for this table.';
        }
        this.loadingColumns = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.columnError = err?.error?.error || err?.message || 'Could not load columns for this table.';
        this.loadingColumns = false;
        this.cdr.markForCheck();
      },
    });
  }

  // ── Step 2: FTP/SFTP remote file browser (independent from SQL) ───
  /** Connection info (from Step 1) the browse/read services authenticate with. */
  private ftpConnection(): FtpConnection {
    const c = this.sourceConfig;
    return {
      protocol: c.ftpSftp ? 'SFTP' : 'FTP',
      host: c.ftpHost,
      port: this.ftpPortOrDefault(c),
      credentials: c.ftpCredentialName,
      username: c.ftpUsername,
      password: c.ftpPassword,
      // SFTP browse/preview authenticate with the uploaded private key (in-memory,
      // never persisted). Empty for plain FTP.
      privateKey: c.ftpSftp ? this.sftpPrivateKeyContent : '',
      // A reopened case no longer holds the key/password in memory; the id lets the
      // backend recover the persisted secret so browse works without re-uploading.
      caseId: this.editingJobId ?? undefined,
    };
  }

  /** The current browser directory as an absolute path, e.g. '/a/b' (root '/'). */
  get ftpCurrentPath(): string {
    return '/' + this.ftpPathSegments.join('/');
  }

  /** True when SFTP is selected but no private key has been uploaded yet — the
   *  real browse/preview need it, so we prompt for it instead of calling out. */
  get sftpKeyMissing(): boolean {
    // A reopened case has a persisted key (uploadFileIds.privateKey) the backend can
    // recover, even though its contents are no longer in memory — so it's not missing.
    return !!this.sourceConfig.ftpSftp
      && !this.sftpPrivateKeyContent.trim()
      && !this.uploadFileIds.privateKey;
  }

  /**
   * Why the remote browser can't call out yet, or null when it can. Both protocols
   * now hit a real server, so the Step-1 fields they authenticate with must be
   * filled before we try: host + username for either, plus the private key for
   * SFTP. (Plain FTP needs no password check — a blank one is legal for anonymous
   * FTP, and the server is the authority on whether it's accepted.)
   */
  private get ftpBrowseBlocker(): string | null {
    const c = this.sourceConfig;
    const protocol = c.ftpSftp ? 'SFTP' : 'FTP';
    if (!c.ftpHost?.trim()) return `Enter the ${protocol} Host in Step 1 to browse the server.`;
    if (!c.ftpUsername?.trim()) return `Enter the ${protocol} Username in Step 1 to browse the server.`;
    if (this.sftpKeyMissing) return 'Upload a private key file in Step 1 to browse the SFTP server.';
    return null;
  }

  /** List the current directory on the remote server — a REAL listing for both
   *  protocols (ssh2 for SFTP, basic-ftp for plain FTP). Surfaces errors inline. */
  loadFtpDir(): void {
    this.ftpError = null;
    // Changing directory (Up / enter folder / breadcrumb) invalidates any preview
    // — the previously-selected CSV isn't in the new listing, so clear it.
    this.clearCsvPreview();
    const blocked = this.ftpBrowseBlocker;
    if (blocked) {
      this.ftpEntries = [];
      this.ftpError = blocked;
      this.cdr.markForCheck();
      return;
    }
    this.loadingFtpDir = true;
    this.ftpEntries = [];
    this.cdr.markForCheck();
    this.dataSource.listFtpDir(this.ftpConnection(), this.ftpCurrentPath).subscribe({
      next: (res) => {
        if (res.ok && res.entries) this.ftpEntries = res.entries;
        else this.ftpError = res.message || 'Could not list this directory.';
        this.loadingFtpDir = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.ftpError = err?.error?.error || err?.message || 'Could not list this directory.';
        this.loadingFtpDir = false;
        this.cdr.markForCheck();
      },
    });
  }

  /** Enter a folder: descend into it and list its contents. */
  enterFtpFolder(name: string): void {
    this.ftpPathSegments = [...this.ftpPathSegments, name];
    this.loadFtpDir();
  }

  /** Navigate up to the parent directory (no-op at the root). */
  ftpGoUp(): void {
    if (!this.ftpPathSegments.length) return;
    this.ftpPathSegments = this.ftpPathSegments.slice(0, -1);
    this.loadFtpDir();
  }

  /** Jump to a breadcrumb segment: `depth` 0 = root, 1 = first segment, etc.
   *  No-op if it's already the current directory. */
  ftpGoToDepth(depth: number): void {
    if (depth >= this.ftpPathSegments.length) return;
    this.ftpPathSegments = this.ftpPathSegments.slice(0, depth);
    this.loadFtpDir();
  }

  /** Clear the CSV preview (hides the panel, which is gated on selectedCsvPath).
   *  Used when navigating directories, so a stale preview doesn't linger — and the
   *  derived adapter path/spec are cleared too, so the payload never references a
   *  file the user navigated away from. */
  private clearCsvPreview(): void {
    this.selectedCsvPath = '';
    this.csvPreview = null;
    this.csvPreviewError = null;
    this.ftpCsvRaw = [];
    this.loadingCsvPreview = false;
    this.sourceConfig.ftpPath = '';
    this.sourceConfig.ftpFileSpec = '';
  }

  /** Split an absolute file path into the adapter's poll DIRECTORY and file name.
   *  The File/FTP/SFTP adapters poll a directory + FileSpec, not a single file, so
   *  a picked CSV maps to { dir → FilePath, file → FileSpec }.
   *  '/incoming/vendors/orders.csv' → { dir: '/incoming/vendors', file: 'orders.csv' };
   *  a file at the root → { dir: '/', file }. */
  private splitPollPath(fullPath: string): { dir: string; file: string } {
    const segs = fullPath.split('/').filter(Boolean);
    const file = segs.pop() ?? '';
    return { dir: '/' + segs.join('/'), file };
  }

  /** Select a CSV in the current directory (via its radio) and load its preview.
   *  Both protocols read the real file as RAW rows and have the header option
   *  applied client-side, so there is no protocol branch here. */
  selectCsvFile(name: string): void {
    const path = (this.ftpCurrentPath === '/' ? '' : this.ftpCurrentPath) + '/' + name;
    this.selectedCsvPath = path;
    // Feed the adapter: poll the file's directory, matching just this file.
    const { dir, file } = this.splitPollPath(path);
    this.sourceConfig.ftpPath = dir;
    this.sourceConfig.ftpFileSpec = file;
    this.csvPreview = null;
    this.csvPreviewError = null;
    this.ftpCsvRaw = [];
    const blocked = this.ftpBrowseBlocker;
    if (blocked) {
      this.csvPreviewError = blocked;
      this.loadingCsvPreview = false;
      this.cdr.markForCheck();
      return;
    }
    this.loadingCsvPreview = true;
    this.cdr.markForCheck();

    this.dataSource.previewRemoteCsv(this.ftpConnection(), path).subscribe({
      next: (res) => {
        if (res.ok && res.rows) {
          this.ftpCsvRaw = res.rows;
          this.csvPreview = this.buildCsvPreviewFromRaw(this.ftpCsvRaw);
          this.syncSourceColumnsFromData();
        } else {
          this.csvPreviewError = res.message || 'Could not read this file.';
        }
        this.loadingCsvPreview = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.csvPreviewError = err?.error?.error || err?.message || 'Could not read this file.';
        this.loadingCsvPreview = false;
        this.cdr.markForCheck();
      },
    });
  }

  /**
   * Build a displayed CSV preview from raw rows + the header-row option. Header on
   * → row 0 is the column names, rows 1‥5 are data. Header off → columns are
   * Column1‥ColumnN, rows 0‥4 are data. Column types are inferred from the data
   * cells. Returns null when there are no raw rows. Shared by the remote
   * (FTP/SFTP) and local-file previews (each holds its own raw grid).
   *
   * The headerless names use the data-integration skill's convention — one-based
   * `Column{n}` (see message.md) — so the source-field names sent in the deploy
   * payload match the request-message properties the agent generates. Do NOT
   * change this to a zero-based/`col{i}` scheme: the names must agree or the DTL
   * reads a property that doesn't exist and the pipeline routes nothing.
   */
  private buildCsvPreviewFromRaw(raw: string[][]): CsvPreview | null {
    if (!raw.length) return null;
    const width = Math.max(...raw.map((r) => r.length));
    const header = this.sourceHasHeader;
    const names = header
      ? Array.from({ length: width }, (_, i) => (raw[0][i] ?? `Column${i + 1}`))
      : Array.from({ length: width }, (_, i) => `Column${i + 1}`);
    const dataRows = (header ? raw.slice(1) : raw).slice(0, 5);
    const columns = names.map((name, i) => ({
      name,
      dataType: this.inferCsvType(dataRows.map((r) => r[i] ?? '')),
    }));
    return { columns, rows: dataRows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')) };
  }

  /** Infer a display data type for a CSV column from its sample cell values. */
  private inferCsvType(cells: string[]): string {
    const vals = cells.map((c) => (c ?? '').trim()).filter((c) => c.length);
    if (!vals.length) return 'String';
    if (vals.every((v) => /^-?\d+$/.test(v))) return 'Integer';
    if (vals.every((v) => /^-?\d*\.\d+$/.test(v))) return 'Decimal';
    if (vals.every((v) => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v))) {
      return vals.some((v) => /[ T]\d{2}:/.test(v)) ? 'DateTime' : 'Date';
    }
    if (vals.every((v) => /^(true|false)$/i.test(v))) return 'Boolean';
    return 'String';
  }

  /**
   * Parse up to `maxRows` rows from CSV text (client-side, for the local-file
   * preview). Quote-aware: handles commas and newlines inside double-quoted fields
   * and escaped quotes (`""`). Mirrors the backend's SFTP parseCsv so both previews
   * behave identically. Adequate for a small trusted preview, not a full RFC-4180
   * library.
   */
  private parseCsv(text: string, maxRows: number): string[][] {
    const rows: string[][] = [];
    let field = '';
    let row: string[] = [];
    let inQuotes = false;
    let sawAny = false;

    for (let i = 0; i < text.length && rows.length < maxRows; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
          else inQuotes = false;
        } else {
          field += c;
        }
        continue;
      }
      if (c === '"') { inQuotes = true; sawAny = true; continue; }
      if (c === ',') { row.push(field); field = ''; sawAny = true; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++; // CRLF
        row.push(field);
        rows.push(row);
        field = '';
        row = [];
        sawAny = false;
        continue;
      }
      field += c;
      sawAny = true;
    }
    if (rows.length < maxRows && (sawAny || field.length)) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /** File name of the currently-selected CSV (for the preview heading). */
  get selectedCsvName(): string {
    return this.selectedCsvPath.split('/').filter(Boolean).pop() ?? '';
  }

  // ── Step 2: Cloud object-storage browser (independent from FTP/SQL) ───
  /** Connection info (from Step 1) the cloud browse/read services authenticate with. */
  private cloudConnection(): CloudConnection {
    const c = this.sourceConfig;
    return {
      bucket: c.cloudBucket,
      region: c.cloudRegion,
      credentialsFile: c.cloudCredentialsFile,
      // The browse/preview calls authenticate with the credentials file's CONTENTS
      // (in-memory, never persisted); `credentialsFile` above is the IRIS-side path
      // the adapter itself will read, which the backend cannot open.
      credentialsFileContent: this.cloudCredentialsContent,
      // A reopened case no longer holds the file contents in memory; the id lets the
      // backend recover the persisted credentials so browse works without re-picking.
      caseId: this.editingJobId ?? undefined,
    };
  }

  /**
   * Why the bucket browser can't call out yet, or null when it can. The listing is
   * a real AWS call, so the Step-1 fields it authenticates with must be filled
   * first: bucket, region, and the uploaded credentials file (whose contents are
   * what the backend signs the request with).
   */
  private get cloudBrowseBlocker(): string | null {
    const c = this.sourceConfig;
    if (!c.cloudBucket?.trim()) return 'Enter the Bucket Name in Step 1 to browse the bucket.';
    if (!c.cloudRegion?.trim()) return 'Enter the Storage Region in Step 1 to browse the bucket.';
    // A reopened case has a persisted credentials file (uploadFileIds.cloudCred) the
    // backend can recover, even though its contents are no longer in memory.
    if (!this.cloudCredentialsContent.trim() && !this.uploadFileIds.cloudCred) {
      return 'Upload an AWS-S3 credentials file in Step 1 to browse the bucket.';
    }
    return null;
  }

  /** The current browser prefix as an absolute key, e.g. '/raw/sales' (root '/'). */
  get cloudCurrentPath(): string {
    return '/' + this.cloudPathSegments.join('/');
  }

  /** List the current prefix in the bucket — a REAL AWS listing of that one prefix
   *  level (common prefixes as folders, objects as csv/other). Errors show inline. */
  loadCloudDir(): void {
    this.cloudError = null;
    // Changing prefix (Up / enter folder / breadcrumb) invalidates any preview —
    // the previously-selected object isn't in the new listing, so clear it.
    this.clearCloudCsvPreview();
    const blocked = this.cloudBrowseBlocker;
    if (blocked) {
      this.cloudEntries = [];
      this.cloudError = blocked;
      this.cdr.markForCheck();
      return;
    }
    this.loadingCloudDir = true;
    this.cloudEntries = [];
    this.cdr.markForCheck();
    this.dataSource.listCloudDir(this.cloudConnection(), this.cloudCurrentPath).subscribe({
      next: (res) => {
        if (res.ok && res.entries) this.cloudEntries = res.entries;
        else this.cloudError = res.message || 'Could not list this bucket prefix.';
        this.loadingCloudDir = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.cloudError = err?.error?.error || err?.message || 'Could not list this bucket prefix.';
        this.loadingCloudDir = false;
        this.cdr.markForCheck();
      },
    });
  }

  /** Clear the cloud preview (the panel is gated on selectedCloudCsvPath) and the
   *  adapter fields derived from it, so the payload never references an object the
   *  user navigated away from. */
  private clearCloudCsvPreview(): void {
    this.selectedCloudCsvPath = '';
    this.cloudCsvPreview = null;
    this.cloudCsvPreviewError = null;
    this.cloudCsvRaw = [];
    this.loadingCloudCsvPreview = false;
    this.sourceConfig.cloudBlobPrefix = '';
    this.sourceConfig.cloudBlobPattern = '';
  }

  /** Enter a prefix: descend into it and list its contents. */
  enterCloudFolder(name: string): void {
    this.cloudPathSegments = [...this.cloudPathSegments, name];
    this.loadCloudDir();
  }

  /** Navigate up to the parent prefix (no-op at the root). */
  cloudGoUp(): void {
    if (!this.cloudPathSegments.length) return;
    this.cloudPathSegments = this.cloudPathSegments.slice(0, -1);
    this.loadCloudDir();
  }

  /** Jump to a breadcrumb segment: `depth` 0 = root, 1 = first segment, etc. */
  cloudGoToDepth(depth: number): void {
    if (depth >= this.cloudPathSegments.length) return;
    this.cloudPathSegments = this.cloudPathSegments.slice(0, depth);
    this.loadCloudDir();
  }

  /** Select a CSV object in the current prefix (via its radio) and load its preview. */
  selectCloudCsvFile(name: string): void {
    const path = (this.cloudCurrentPath === '/' ? '' : this.cloudCurrentPath) + '/' + name;
    this.selectedCloudCsvPath = path;
    // Feed the S3 adapter (EnsLib.CloudStorage.InboundAdapter):
    //  - BlobNamePrefix is the SERVER-side "folder" filter: the key prefix (relative,
    //    no leading slash, trailing slash so it matches only that prefix — '' at root).
    //  - BlobNamePattern is a CLIENT-side wildcard filter that the adapter matches
    //    against the FULL blob key (blobInfo.name, e.g. "Test/locations.csv"), NOT the
    //    leaf name. So for an exact single file the pattern must be the WHOLE relative
    //    key (prefix + name), not just `name` — otherwise a nested object like
    //    "Test/locations.csv" never matches a bare "locations.csv" and nothing is
    //    retrieved (it only worked at the bucket root by coincidence, where the full
    //    key equals the leaf name).
    const prefix = this.cloudPathSegments.join('/');
    this.sourceConfig.cloudBlobPrefix = prefix ? `${prefix}/` : '';
    this.sourceConfig.cloudBlobPattern = prefix ? `${prefix}/${name}` : name;
    this.cloudCsvPreview = null;
    this.cloudCsvPreviewError = null;
    this.cloudCsvRaw = [];
    const blocked = this.cloudBrowseBlocker;
    if (blocked) {
      this.cloudCsvPreviewError = blocked;
      this.loadingCloudCsvPreview = false;
      this.cdr.markForCheck();
      return;
    }
    this.loadingCloudCsvPreview = true;
    this.cdr.markForCheck();
    // A bounded ranged read of the object → RAW rows; the header-row option is
    // applied client-side (same as the FTP/SFTP and local previews).
    this.dataSource.previewCloudCsv(this.cloudConnection(), path).subscribe({
      next: (res) => {
        if (res.ok && res.rows) {
          this.cloudCsvRaw = res.rows;
          this.cloudCsvPreview = this.buildCsvPreviewFromRaw(this.cloudCsvRaw);
          this.syncSourceColumnsFromData();
        } else {
          this.cloudCsvPreviewError = res.message || 'Could not read this object.';
        }
        this.loadingCloudCsvPreview = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.cloudCsvPreviewError = err?.error?.error || err?.message || 'Could not read this object.';
        this.loadingCloudCsvPreview = false;
        this.cdr.markForCheck();
      },
    });
  }

  /** Object name of the currently-selected cloud CSV (for the preview heading). */
  get selectedCloudCsvName(): string {
    return this.selectedCloudCsvPath.split('/').filter(Boolean).pop() ?? '';
  }

  // ── Step 2: Local File preview (uploaded in Step 1) ───────────
  /**
   * Preview the file picked in Step 1. The bytes are already in the browser (a
   * File object), so we read + parse them directly — no upload/backend round-trip
   * (the mock `filePath` only describes where IRIS would later read it). Non-CSV
   * files show an error in the Preview instead of a table.
   */
  loadLocalPreview(): void {
    this.localPreviewError = null;
    this.localCsvPreview = null;
    this.localCsvRaw = [];
    if (!this.localFile) {
      // A path but no in-memory File and no case to restore from — nothing to read.
      // (A reopened case never lands here: enterLocalFileStep() routes it to the
      // stored SQLite copy instead.)
      if (this.sourceConfig.filePath) {
        this.localPreviewError = 'Re-upload the file in the Data Source step to preview it.';
      }
      this.cdr.markForCheck();
      return;
    }
    if (!this.isCsvFile(this.localFile)) {
      this.localPreviewError = `"${this.localFile.name}" is not a CSV file. Please upload a .csv file.`;
      this.cdr.markForCheck();
      return;
    }

    this.loadingLocalPreview = true;
    this.cdr.markForCheck();
    // Read only a bounded slice — enough for the preview, never the whole file.
    this.localFile.slice(0, LOCAL_PREVIEW_MAX_BYTES).text().then(
      (text) => {
        this.localCsvRaw = this.parseCsv(text, LOCAL_PREVIEW_ROWS);
        this.localCsvPreview = this.buildCsvPreviewFromRaw(this.localCsvRaw);
        if (!this.localCsvPreview) this.localPreviewError = 'The file appears to be empty.';
        this.loadingLocalPreview = false;
        this.syncSourceColumnsFromData();
        this.cdr.markForCheck();
      },
      (err) => {
        this.localPreviewError = err?.message || 'Could not read the file.';
        this.loadingLocalPreview = false;
        this.cdr.markForCheck();
      },
    );
  }

  // ── Step 2 → Step 3 bridge (retrieved columns seed the mapping) ───
  /** The columns retrieved in the Data step for the active adapter — the source
   *  of truth Step 3 is seeded from. Empty until data has been retrieved. */
  private retrievedColumns(): SqlColumn[] {
    switch (this.sourceType) {
      case 'database': return this.sqlColumns;
      case 'ftp':      return this.csvPreview?.columns ?? [];
      case 'cloud':    return this.cloudCsvPreview?.columns ?? [];
      case 'file':     return this.localCsvPreview?.columns ?? [];
      default:         return [];
    }
  }

  /** A stable identifier for the Step-2 source selection, so re-selecting the same
   *  entity can be recognized (schema.table for SQL, the file path otherwise). Used
   *  to key the saved Step-3 mapping so a detour + return restores it. */
  private currentEntityKey(): string {
    switch (this.sourceType) {
      case 'database': return this.selectedSchema ? `${this.selectedSchema}.${this.selectedTable}` : this.selectedTable;
      case 'ftp':      return this.selectedCsvPath;
      case 'cloud':    return this.selectedCloudCsvPath;
      case 'file':     return this.localFileName;
      default:         return '';
    }
  }

  /**
   * Seed Step 3's source columns (Property/Column Name + Data Type) from the
   * columns retrieved in Step 2. Step-2 data stays the source of truth; this only
   * (re)builds the Step-3 working set when the retrieved structure CHANGES, so a
   * user's manual removals/refinements survive re-entry to the step. The retrieved
   * column name is used verbatim — for a headerless CSV that name is already the
   * skill's `Column{n}` convention (set in buildCsvPreviewFromRaw), so the deploy
   * payload's source-field names match the request-message properties the agent
   * generates from message.md.
   */
  private syncSourceColumnsFromData(): void {
    const cols = this.retrievedColumns();
    if (!cols.length) return; // nothing retrieved yet — leave Step 3 as-is

    const signature = JSON.stringify({
      t: this.sourceType,
      h: this.sourceHasHeader,
      cols: cols.map((c) => [c.name, c.dataType]),
    });
    if (signature === this.lastDataSignature) return; // structure unchanged

    this.lastDataSignature = signature;

    // Preserve the mapping across a Step-2 detour: stash the columns we're leaving
    // under their own entity key, then, if the newly selected entity has a stashed
    // mapping (e.g. re-selecting the originally saved table), carry each column's
    // target-property/transform back by name. Re-selecting the same source entity
    // must not lose the mappings the user saved for it.
    const newKey = this.currentEntityKey();
    if (this.mappingEntityKey && this.mappingEntityKey !== newKey && this.sourceColumns.length) {
      this.mappingByEntity.set(this.mappingEntityKey, this.sourceColumns.map((c) => ({ ...c })));
    }
    const prior = this.mappingByEntity.get(newKey);
    const priorByName = prior ? new Map(prior.map((c) => [c.name, c])) : null;
    this.mappingEntityKey = newKey;
    this.sourceColumns = cols.map((c) => {
      const p = priorByName?.get(c.name);
      return {
        name: c.name,
        type: p?.type ?? this.mapToColumnType(c.dataType),
        targetProperty: p?.targetProperty ?? '',
        transform: p?.transform ?? '',
        transformArgs: p?.transformArgs ? { ...p.transformArgs } : {},
      };
    });
  }

  /** The header-row option changes how CSV columns are named (header names vs.
   *  Column1‥N indices), so rebuild the affected preview from its stored raw rows
   *  (no re-fetch/re-read) and re-seed Step 3 from the retrieved data when it toggles. */
  onHeaderRowChange(): void {
    if (this.ftpCsvRaw.length) this.csvPreview = this.buildCsvPreviewFromRaw(this.ftpCsvRaw);
    if (this.cloudCsvRaw.length) this.cloudCsvPreview = this.buildCsvPreviewFromRaw(this.cloudCsvRaw);
    if (this.localCsvRaw.length) this.localCsvPreview = this.buildCsvPreviewFromRaw(this.localCsvRaw);
    this.syncSourceColumnsFromData();
    this.cdr.markForCheck();
  }

  /** Map a retrieved source data type onto one of SOURCE_COLUMN_TYPES. */
  private mapToColumnType(dataType: string): string {
    const d = (dataType || '').toLowerCase();
    if (/int|serial/.test(d))                         return 'Integer';
    if (/dec|numeric|float|double|real|money/.test(d)) return 'Decimal';
    if (/bool/.test(d))                               return 'Boolean';
    if (/datetime|timestamp/.test(d))                 return 'DateTime';
    if (/date/.test(d))                               return 'Date';
    if (/time/.test(d))                               return 'Time';
    return 'String';
  }

  /** Protocol dropdown (FTP | SFTP) → the `ftpSftp` flag the rest of the wizard
   *  reads (the SFTP key-file uploads show only when true). SFTP authenticates
   *  with the uploaded private key, so clear any password when switching to it
   *  (the field is also disabled in the template). */
  onProtocolChange(value: string): void {
    this.sourceConfig.ftpSftp = value === 'SFTP';
    if (this.sourceConfig.ftpSftp) this.sourceConfig.ftpPassword = '';
  }

  /**
   * Shared upload flow for all three pickers: flip the spinner, upload the file
   * (held in backend memory), and on success hand the result to `onSuccess` for
   * the slot-specific field writes; on failure clear the spinner and toast. This
   * is the single place the subscribe/spinner/error/CD ceremony lives, so the
   * pickers can't drift. `setBusy` toggles that picker's uploading flag.
   */
  private runUpload(
    file: File,
    kind: UploadKind,
    setBusy: (busy: boolean) => void,
    onSuccess: (res: UploadResult) => void,
  ): void {
    setBusy(true);
    this.cdr.markForCheck();
    this.uploads.uploadFile(file, kind).subscribe({
      next: (res) => {
        onSuccess(res);
        setBusy(false);
        this.cdr.markForCheck();
      },
      error: (err) => {
        setBusy(false);
        this.toast.error(this.uploadErrorMessage(file.name, err));
        this.cdr.markForCheck();
      },
    });
  }

  /** Read the picked file from an <input type=file>, resetting it so the same
   *  file can be re-picked (change doesn't fire otherwise). Null if none. */
  private pickedFile(event: Event): File | null {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    return file;
  }

  /**
   * Upload a picked SFTP key file and store the returned IRIS path on the matching
   * config field (`sftpPublicKeyFile` / `sftpPrivateKeyFile`) — that server-side
   * path is what the adapter needs; the bytes are pushed to it at Deploy.
   */
  onKeyFileSelected(slot: 'public' | 'private', event: Event): void {
    const file = this.pickedFile(event);
    if (!file) return;

    // For the private key, keep its CONTENTS in memory — the connection test
    // sends them in the request body (the backend authenticates with the key).
    if (slot === 'private') {
      file.text().then((text) => { this.sftpPrivateKeyContent = text; });
    }

    this.runUpload(file, 'ssh-key', (busy) => (this.uploadingKeyFile[slot] = busy), (res) => {
      if (slot === 'public') {
        this.sourceConfig.sftpPublicKeyFile = res.irisPath;
        this.uploadFileIds.publicKey = res.fileId;
        this.freshUploadSlots.add('publicKey');
      } else {
        this.sourceConfig.sftpPrivateKeyFile = res.irisPath;
        this.uploadFileIds.privateKey = res.fileId;
        this.freshUploadSlots.add('privateKey');
      }
      this.keyFileName[slot] = file.name;
    });
  }

  /**
   * Upload the picked AWS S3 credentials file and store the returned IRIS path on
   * `cloudCredentialsFile`. Uploaded as kind 'aws-cred' (materialized 0600): the
   * backend normalizes it to a `[default]` profile — the only one the IRIS Cloud
   * adapter reads — whereas SFTP keys ('ssh-key') are staged verbatim.
   */
  onCloudCredFileSelected(event: Event): void {
    const file = this.pickedFile(event);
    if (!file) return;

    // Keep the CONTENTS in memory: the connection test and the bucket browser send
    // them in the request body (the backend parses the access key + secret out of
    // the file — it cannot read the IRIS-side path the upload returns).
    file.text().then((text) => {
      this.cloudCredentialsContent = text;
      // A newly-supplied credentials file unblocks the browser; if the user is
      // already on Step 2 looking at the blocker message, this refreshes it.
      this.cdr.markForCheck();
    });

    this.runUpload(file, 'aws-cred', (busy) => (this.uploadingCloudCredFile = busy), (res) => {
      this.sourceConfig.cloudCredentialsFile = res.irisPath;
      this.uploadFileIds.cloudCred = res.fileId;
      this.freshUploadSlots.add('cloudCred');
      this.cloudCredFileName = file.name;
    });
  }

  /**
   * Handle the picked local data file. The bytes stay in the browser (we keep the
   * File object so Step 2 can preview it directly) AND are uploaded to the backend
   * so the File adapter can read them from the IRIS host. A non-CSV is accepted
   * here and reported in the Preview (Step 2), not blocked at pick time.
   */
  onLocalFileSelected(event: Event): void {
    const file = this.pickedFile(event);
    if (!file) return;

    // Keep the File so Step 2 reads its real bytes; drop any prior preview.
    this.localFile = file;
    this.localCsvPreview = null;
    this.localPreviewError = null;
    this.localCsvRaw = [];

    // The File adapter polls a DIRECTORY + FileSpec, not a single file, so split
    // the returned IRIS path into its directory (filePath) and stored basename
    // (fileSpec) — the stored name carries a unique id prefix so the spec targets
    // exactly this file.
    this.runUpload(file, 'csv', (busy) => (this.uploadingLocalFile = busy), (res) => {
      const slash = res.irisPath.lastIndexOf('/');
      this.sourceConfig.filePath = slash >= 0 ? res.irisPath.slice(0, slash) : res.irisPath;
      this.sourceConfig.fileSpec = slash >= 0 ? res.irisPath.slice(slash + 1) : res.irisPath;
      this.uploadFileIds.localFile = res.fileId;
      this.freshUploadSlots.add('localFile');
      this.localFileName = file.name;
    });
  }

  /** Human-readable message for a failed upload (surfaces the backend's reason). */
  private uploadErrorMessage(fileName: string, err: unknown): string {
    const detail = (err as { error?: { error?: string } })?.error?.error;
    return `Upload of "${fileName}" failed${detail ? `: ${detail}` : '.'}`;
  }

  /** Flatten a slot map to the list of ids to materialize / clean up. */
  private fileIdsOf(slots: UploadSlots | undefined): string[] {
    return Object.values(slots ?? {}).filter((id): id is string => !!id);
  }

  /** True while any picker's upload is still in flight. Guards Save so a config
   *  isn't snapshotted before the upload callback has set its path + fileId. */
  uploadInProgress(): boolean {
    return this.uploadingKeyFile.public || this.uploadingKeyFile.private
      || this.uploadingCloudCredFile || this.uploadingLocalFile;
  }

  /** True if the picked file is a CSV — by extension, or by the MIME type the
   *  browser reports (some browsers use text/csv or application/vnd.ms-excel). */
  private isCsvFile(file: File): boolean {
    return /\.csv$/i.test(file.name)
      || file.type === 'text/csv'
      || file.type === 'application/csv';
  }

  trackByIndex(index: number): number { return index; }

  /** Extra parameters for the transform function selected on a mapping row. */
  transformParams(col: SourceColumn): { key: string; label: string }[] {
    return this.TRANSFORM_FUNCTIONS.find((f) => f.value === col.transform)?.params ?? [];
  }

  /** Data type of the target property a row is mapped to (from the loaded
   *  target-class properties), or '' when the row isn't mapped yet. */
  targetPropertyType(col: SourceColumn): string {
    if (!col.targetProperty) return '';
    return this.targetProperties.find((p) => p.name === col.targetProperty)?.dataType ?? '';
  }

  /** Whether a target property is already mapped by a DIFFERENT row, so the given
   *  row's dropdown should offer it as disabled (each property maps to one field).
   *  The row's own current selection is never disabled, so it stays valid. */
  isTargetPropertyTaken(name: string, col: SourceColumn): boolean {
    return this.sourceColumns.some((c) => c !== col && c.targetProperty === name);
  }

  /** Reset a row's transform args when its function changes. */
  onTransformChange(col: SourceColumn): void {
    col.transformArgs = {};
  }

  // ── Section 1: source columns ─────────────────────────────────
  addSourceColumn(): void {
    this.sourceColumns.push({ name: '', type: this.SOURCE_COLUMN_TYPES[0] });
  }


  // ── Section 2: target class ───────────────────────────────────
  /** Fetch the supported target class names from the backend — the SC data
   *  objects from GET /api/scmodel/v1/objects (e.g. BOM, Carrier). */
  loadTargetClasses(): void {
    this.loadingTargetClasses = true;
    this.cdr.markForCheck();
    this.scModel.getObjects().subscribe({
      next: (objs) => {
        const list = (Array.isArray(objs) ? objs : []).filter((o: any) => o.objectName);
        this.classNameByObject = {};
        for (const o of list) this.classNameByObject[o.objectName] = o.className ?? o.objectName;
        this.targetClasses = list
          .map((o: any) => o.objectName)
          .sort((a: string, b: string) => a.localeCompare(b));
        this.loadingTargetClasses = false;
        this.cdr.markForCheck();
      },
      error: () => { this.loadingTargetClasses = false; this.cdr.markForCheck(); },
    });
  }

  /** When the user picks a target class, fetch its properties (name + type)
   *  from GET /api/scmodel/v1/objects/{objectName}. The Target Property Type
   *  shown in each mapping row is derived from these via targetPropertyType(). */
  onTargetClassChange(): void {
    this.targetProperties = [];
    // A mapping only means something within its class, so switching the target class
    // blanks every row's Target Property now (the "-" default). If this is the case's
    // saved class, its saved mappings are restored once the new class's properties
    // load (applyMappingsForTargetClass), so the user need not re-map by hand.
    this.sourceColumns = this.sourceColumns.map((c) => ({ ...c, targetProperty: '' }));
    if (!this.selectedTargetClass) { this.cdr.markForCheck(); return; }
    this.loadingTargetProperties = true;
    this.cdr.markForCheck();
    this.scModel.getObjectDetail(this.selectedTargetClass).subscribe({
      next: (detail) => {
        this.targetProperties = (detail?.attributes ?? []).map((a: any) => ({
          name: a.name,
          dataType: a.dataType,
          required: !!a.required,
        }));
        this.applyMappingsForTargetClass();
        this.loadingTargetProperties = false;
        this.cdr.markForCheck();
      },
      error: () => { this.loadingTargetProperties = false; this.cdr.markForCheck(); },
    });
  }

  /** Restore the case's saved mappings when the selected target class IS the one
   *  saved with the case — matching each source column by name and keeping only
   *  properties the class still has. For any other class the rows stay blank (their
   *  default). Called after the class's properties load, so validity is checkable.
   *  A brand-new case (empty baseline) is a no-op. */
  private applyMappingsForTargetClass(): void {
    if (this.selectedTargetClass !== this.savedTargetClass || !this.savedMappingByColumn.size) return;
    const valid = new Set(this.targetProperties.map((p) => p.name));
    this.sourceColumns = this.sourceColumns.map((c) => {
      const saved = this.savedMappingByColumn.get(c.name);
      return saved && valid.has(saved) ? { ...c, targetProperty: saved } : c;
    });
  }

  // ── Section 3: AI auto-mapping ────────────────────────────────
  /**
   * Ask the backend AI for a source→target field mapping, then fill each row's
   * Target Property (the source column's own Type is left untouched). The mapping
   * is one-to-one and meaning-based; unmatched fields stay empty. If the AI call
   * fails, fall back to a local heuristic so the button still does something.
   *
   * The fallback used to be SILENT, which was the wrong trade: the rows filled in
   * either way, so a user could not tell an AI mapping from a name-match one and
   * had no idea a key was missing or rejected. Every degraded outcome now
   * says so in a toast — and still applies the local mapping, because a name match
   * is more useful than an empty grid.
   */
  autoMap(): void {
    // Nothing configured: don't even call — the backend would only answer
    // `ok: false` with this same message.
    if (!isAiEnabled()) {
      this.fallbackAutoMap(AI_KEY_MISSING_SHORT);
      return;
    }
    this.autoMapping = true;
    this.cdr.markForCheck();
    this.dataSource
      .autoMapFields({
        sourceFields: this.sourceColumns.map((c) => ({ name: c.name, type: c.type })),
        targetClass: this.selectedTargetClass,
        targetProperties: this.targetProperties.map((p) => ({ name: p.name, dataType: p.dataType, required: p.required })),
      })
      .subscribe({
        next: (res) => {
          this.autoMapping = false;
          if (res.ok && res.mappings) {
            this.applyMappings(res.mappings);
            this.cdr.markForCheck();
            return;
          }
          // A completed call that could not produce a mapping — invalid credentials,
          // an unparseable reply, a throttle. The backend's message
          // says which; pass it through rather than inventing one.
          this.fallbackAutoMap(res.message || 'The AI could not suggest a mapping.');
        },
        error: (err) => {
          this.autoMapping = false;
          this.fallbackAutoMap(this.autoMapErrorMessage(err));
        },
      });
  }

  /** Report why the AI mapping didn't happen, then map locally anyway. */
  private fallbackAutoMap(reason: string): void {
    this.toast.error(`${reason} Auto-map used a local name match instead.`);
    this.applyMappings(this.localAutoMap());
    this.cdr.markForCheck();
  }

  /** Readable reason for a FAILED auto-map request (transport/HTTP, not `ok:false`). */
  private autoMapErrorMessage(err: unknown): string {
    const detail = (err as { error?: { error?: string } } | null)?.error?.error;
    return detail ? `Auto-map failed: ${detail}` : 'Auto-map could not reach the AI service.';
  }

  /** Set each source column's targetProperty from the mappings (only real fields;
   *  bijective, so a duplicated target is ignored). Unmapped fields are cleared. */
  private applyMappings(mappings: Mapping[]): void {
    const byField = new Map<string, string>();
    const usedTargets = new Set<string>();
    for (const m of mappings) {
      if (usedTargets.has(m.targetProperty)) continue;
      if (!this.targetProperties.some((p) => p.name === m.targetProperty)) continue;
      byField.set(m.sourceField, m.targetProperty);
      usedTargets.add(m.targetProperty);
    }
    this.sourceColumns = this.sourceColumns.map((c) => ({ ...c, targetProperty: byField.get(c.name) ?? '' }));
  }

  /**
   * Local fallback mapping when the AI call is unavailable. Greedy one-to-one:
   * for each source field, pick the best unused target by normalized-name overlap,
   * breaking ties toward a compatible data type. No positional fallback — a field
   * with no name overlap is left unmapped.
   */
  private localAutoMap(): Mapping[] {
    const norm = (s: string) => s.toLowerCase().replace(/[_\s]/g, '');
    const usedTargets = new Set<string>();
    const mappings: Mapping[] = [];
    for (const col of this.sourceColumns) {
      const src = norm(col.name);
      if (!src) continue;
      let best: ScAttribute | undefined;
      let bestScore = 0;
      for (const p of this.targetProperties) {
        if (usedTargets.has(p.name)) continue;
        const tgt = norm(p.name);
        let score = 0;
        if (tgt === src) score = 3;
        else if (tgt.includes(src) || src.includes(tgt)) score = 2;
        if (!score) continue;
        if (this.typesCompatible(col.type, p.dataType)) score += 0.5; // tie-break toward matching type
        if (score > bestScore) { best = p; bestScore = score; }
      }
      if (best) {
        usedTargets.add(best.name);
        mappings.push({ sourceField: col.name, targetProperty: best.name, confidence: 1, reason: 'name match' });
      }
    }
    return mappings;
  }

  /** Whether a source column type and an IRIS target data type are compatible. */
  private typesCompatible(sourceType: string, targetType: string): boolean {
    const t = (targetType || '').toLowerCase().replace(/^%/, '');
    const group: Record<string, string> = {
      String: 'text', Integer: 'number', Decimal: 'number', Boolean: 'bool',
      Date: 'date', DateTime: 'date', Time: 'date',
    };
    const targetGroup =
      /int/.test(t) ? 'number' :
      /numeric|decimal|double|float|money/.test(t) ? 'number' :
      /boolean/.test(t) ? 'bool' :
      /date|time|timestamp/.test(t) ? 'date' :
      'text';
    return group[sourceType] === targetGroup;
  }

  // ── Test Connection (SQL / SFTP / Cloud) ──────────────────────
  /** Source types that reach a remote server and so support a connection test.
   *  (`file` polls a local IRIS directory; `rest-api` is disabled.) */
  canTestConnection(): boolean {
    return this.sourceType === 'database' || this.sourceType === 'ftp' || this.sourceType === 'cloud';
  }

  // The exact config each adapter's test authenticates with. These four builders
  // are the SINGLE source of both the request body and the signature below, so a
  // field can never be sent to the test endpoint without also invalidating an
  // earlier pass. (They used to diverge: the signature was taken from
  // buildSourcePayload, the DEPLOY payload, which carries an IRIS Credentials NAME
  // instead of a username/password — so editing either credential after a green
  // test left the signature unchanged and Next waved the stale pass through.)
  private sqlTestConfig(): SqlConnectionConfig {
    const c = this.sourceConfig;
    return {
      dsn: c.dbDsn ?? '',
      username: c.dbUsername ?? '',
      password: c.dbPassword ?? '',
      driverClass: this.DB_DRIVER_CLASS[c.dbType ?? ''] ?? '',
    };
  }

  private ftpTestConfig(): FtpConnectionConfig {
    const c = this.sourceConfig;
    return {
      host: c.ftpHost ?? '',
      port: c.ftpPort ?? '',
      username: c.ftpUsername ?? '',
      // May be blank — an anonymous login is a valid FTP configuration.
      password: c.ftpPassword ?? '',
    };
  }

  private sftpTestConfig(): SftpConnectionConfig {
    const c = this.sourceConfig;
    return {
      host: c.ftpHost ?? '',
      port: c.ftpPort ?? '',
      username: c.ftpUsername ?? '',
      // The picked key's CONTENTS, so re-picking a different key drifts the
      // signature even when the file name happens to match.
      privateKey: this.sftpPrivateKeyContent,
    };
  }

  private cloudTestConfig(): CloudConnectionConfig {
    const c = this.sourceConfig;
    return {
      bucket: c.cloudBucket ?? '',
      region: c.cloudRegion ?? '',
      credentialsFileContent: this.cloudCredentialsContent,
    };
  }

  /** Signature of everything the current source's connection test depends on —
   *  nothing more, nothing less. Fields that cannot change a test's outcome (the
   *  SQL query, the FTP path, the S3 blob pattern) are deliberately absent, so
   *  editing them doesn't force a pointless re-test. */
  private connectionSignature(): string {
    const t = this.sourceType;
    const config =
      t === 'database' ? this.sqlTestConfig()
      : t === 'ftp' ? (this.sourceConfig.ftpSftp ? this.sftpTestConfig() : this.ftpTestConfig())
      : t === 'cloud' ? this.cloudTestConfig()
      : null;
    // `sftp` is part of the key in its own right: FTP and SFTP on the same host,
    // port and username are different servers to authenticate against.
    return JSON.stringify({ t, sftp: !!this.sourceConfig.ftpSftp, c: config });
  }

  /** True only when the CURRENT connection config was successfully tested. Flips
   *  to false automatically once any connection field changes (signature drift). */
  get connectionTested(): boolean {
    return !!this.connectionTestResult?.ok
      && this.resultSignature === this.connectionSignature();
  }

  /** Verify the remote server is reachable with the entered config. Database
   *  (JDBC), plain FTP, SFTP and cloud (AWS S3) each hit their own real backend
   *  test endpoint — there is no mock left on this path.
   *
   *  `onSettled` fires once with the outcome, however the test finished (validation
   *  short-circuit, backend result, or HTTP error), so Next can gate on it. */
  testConnection(onSettled?: (result: { ok: boolean; message: string }) => void): void {
    if (this.testingConnection) return;
    this.testingConnection = true;
    this.connectionTestResult = null;
    this.cdr.markForCheck();

    // Pin the tested config only on success; connectionTested compares against it.
    const settle = (result: { ok: boolean; message: string }) => {
      this.connectionTestResult = result;
      this.resultSignature = this.connectionSignature();
      this.testingConnection = false;
      this.cdr.markForCheck();
      onSettled?.(result);
    };

    const httpError = (err: { error?: { error?: string }; message?: string }) =>
      settle({ ok: false, message: err?.error?.error || err?.message || 'Connection test failed.' });

    if (this.sourceType === 'database') {
      const c = this.sourceConfig;
      const driverClass = this.DB_DRIVER_CLASS[c.dbType ?? ''] ?? '';
      if (!driverClass) {
        settle({ ok: false, message: 'Select a database type to test the connection.' });
        return;
      }
      // Required in the UI only: the backend accepts a blank password (trust-auth
      // targets), but every JDBC source the wizard configures authenticates with one.
      if (!c.dbPassword) {
        settle({ ok: false, message: 'Connection failed: Password is required.' });
        return;
      }
      this.sqlConnectionTest
        .testConnection({ adapter: 'SQL', config: this.sqlTestConfig(), caseId: this.editingJobId ?? undefined })
        .subscribe({ next: (result) => settle(result), error: httpError });
      return;
    }

    // SFTP (not plain FTP): real backend test, key-based via the uploaded .pem.
    if (this.sourceType === 'ftp' && this.sourceConfig.ftpSftp) {
      // A reopened case has a persisted key the backend recovers by caseId, so its
      // in-memory contents may legitimately be empty — only block a brand-new source.
      if (!this.sftpPrivateKeyContent.trim() && !this.uploadFileIds.privateKey) {
        settle({ ok: false, message: 'Upload a private key file to test the connection.' });
        return;
      }
      this.sftpConnectionTest
        .testConnection({ adapter: 'SFTP', config: this.sftpTestConfig(), caseId: this.editingJobId ?? undefined })
        .subscribe({ next: (result) => settle(result), error: httpError });
      return;
    }

    // Plain FTP: real backend test — connect, log in with username/password, PWD.
    if (this.sourceType === 'ftp') {
      const c = this.sourceConfig;
      if (!c.ftpHost?.trim()) {
        settle({ ok: false, message: 'Connection failed: Host is required.' });
        return;
      }
      if (!c.ftpUsername?.trim()) {
        settle({ ok: false, message: 'Connection failed: Username is required.' });
        return;
      }
      this.ftpConnectionTest
        .testConnection({ adapter: 'FTP', config: this.ftpTestConfig(), caseId: this.editingJobId ?? undefined })
        .subscribe({ next: (result) => settle(result), error: httpError });
      return;
    }

    // Cloud (AWS S3): real backend test — list the bucket root with the keys parsed
    // from the uploaded credentials file, which is exactly what the Data Entity
    // browser then does, so a green test means the browser will work.
    const c = this.sourceConfig;
    if (!c.cloudBucket?.trim()) {
      settle({ ok: false, message: 'Connection failed: Bucket Name is required.' });
      return;
    }
    if (!c.cloudRegion?.trim()) {
      settle({ ok: false, message: 'Connection failed: Storage Region is required.' });
      return;
    }
    // Required in the UI: the adapter would otherwise fall back to the default AWS
    // credential chain, which a containerised IRIS does not have — and the backend
    // needs the keys to sign this very request.
    // A reopened case has a persisted credentials file the backend recovers by
    // caseId, so its in-memory contents may be empty — only block a brand-new source.
    if (!this.cloudCredentialsContent.trim() && !this.uploadFileIds.cloudCred) {
      settle({ ok: false, message: 'Upload an AWS-S3 credentials file to test the connection.' });
      return;
    }
    this.cloudConnectionTest
      .testConnection({ adapter: 'Cloud', config: this.cloudTestConfig(), caseId: this.editingJobId ?? undefined })
      .subscribe({ next: (result) => settle(result), error: httpError });
  }

  /**
   * Save — persist the CURRENT wizard state to SQLite (backend), including the
   * uploaded file bytes for any slot picked this session. This is the single
   * persistence path used by every step's Save button. It is deliberately free of
   * IRIS side-effects (no driver-JAR staging, no file materialize, no credential
   * creation) — all of those moved to Deploy, so a Save never touches the running
   * IRIS. `onDone(true)` fires only after the case row (and its fresh files) are
   * durably written.
   */
  private persistCase(onDone: (ok: boolean) => void): void {
    // Don't snapshot the config while a file upload is still resolving — the path
    // fields and the slot's fileId are only set in the upload's async callback.
    if (this.uploadInProgress()) {
      this.toast.info('A file is still uploading — please wait for it to finish before saving.');
      onDone(false);
      return;
    }
    const id = this.ensureCaseId();
    const existing = this.jobs.find((j) => j.id === id);
    // Freeze the generated IRIS credential-entry name on first save so re-deploys
    // reuse (upsert) the same entry instead of orphaning a new one each time.
    this.ensureCredentialName();
    const job: IntegrationJob = {
      id,
      name: this.jobName || `${SOURCE_TYPE_LABELS[this.sourceType]} Integration`,
      // Keep a deployed case deployed; anything else is a draft. The backend is
      // authoritative and echoes the real status back.
      status: existing?.status ?? 'draft',
      sourceType: this.sourceType,
      sourceName: this.sourceLabel,
      source: { ...this.sourceConfig },
      targetClass: this.selectedTargetClass,
      hasHeader: this.sourceHasHeader,
      columns: this.sourceColumns.map((c) => ({ ...c })),
      connectionTested: this.connectionTested,
      dataEntity: this.dataEntitySummary(),
      targetClassSignature: this.selectedTargetClass
        ? this.targetClassSignatureOf(this.selectedTargetClass, this.targetProperties)
        : '',
      // Which target properties were REQUIRED when this mapping was made, so the
      // readiness check can judge the saved mapping later without re-fetching the
      // class (see job-readiness.ts). A drifted class is caught separately, by
      // targetClassSignature on reopen.
      requiredTargetProperties: this.requiredProperties.map((p) => p.name),
      uploadedFiles: { ...this.uploadFileIds },
    };

    this.savingCase = true;
    this.cdr.markForCheck();
    this.casesApi.save(this.casePayload(job)).subscribe({
      next: ({ status }) => {
        job.status = status;
        this.upsertJob(job);
        this.selectedJob = job;
        // Persist bytes for slots uploaded this session (restored slots already
        // live in SQLite), then settle.
        this.persistFreshFiles(id, () => {
          this.savingCase = false;
          this.savedFormSignature = this.formSignatureForDirty(); // the form is now clean
          this.cdr.markForCheck();
          onDone(true);
        });
      },
      error: (err) => {
        this.savingCase = false;
        this.toast.error(`Could not save the integration: ${err?.error?.error || err?.message || 'unknown error'}`);
        this.cdr.markForCheck();
        onDone(false);
      },
    });
  }

  /** The id for the case being edited, generating one on first save. It becomes
   *  part of the per-integration IRIS package name (SC.Workbench.Integration{id}.*),
   *  so it must be a valid ObjectScript identifier segment — hence the hyphens are
   *  stripped from the UUID, leaving 32 hex chars after the "Integration" prefix. */
  private ensureCaseId(): string {
    if (!this.editingJobId) this.editingJobId = crypto.randomUUID().replace(/-/g, '');
    return this.editingJobId;
  }

  /** The case object POSTed to the backend: the full job (the backend stores it as
   *  `definition` and encrypts the source passwords at rest). */
  private casePayload(job: IntegrationJob): { id: string; name: string; source?: unknown; [k: string]: unknown } {
    return { ...job };
  }

  /** Insert or replace a job in the local list. */
  private upsertJob(job: IntegrationJob): void {
    const idx = this.jobs.findIndex((j) => j.id === job.id);
    if (idx !== -1) this.jobs[idx] = job; else this.jobs.push(job);
    this.jobs = [...this.jobs];
  }

  /** Persist the bytes of slots uploaded this session into SQLite (durable),
   *  sequentially; a failure toasts but doesn't abort the save (the case row is
   *  already written). Calls `done` once every fresh slot is handled. */
  private persistFreshFiles(id: string, done: () => void): void {
    const slots = [...this.freshUploadSlots];
    const step = (i: number): void => {
      if (i >= slots.length) { done(); return; }
      const slot = slots[i]!;
      const fileId = this.uploadFileIds[slot];
      if (!fileId) { this.freshUploadSlots.delete(slot); step(i + 1); return; }
      this.casesApi.putFile(id, slot, fileId).subscribe({
        next: () => { this.freshUploadSlots.delete(slot); step(i + 1); },
        error: (err) => {
          this.toast.error(`Could not save the uploaded "${slot}" file: ${err?.error?.error || err?.message || 'unknown error'}`);
          step(i + 1);
        },
      });
    };
    step(0);
  }

  /**
   * Step-3 Save — validate the mapping, persist, and close the wizard. Blocks (and
   * surfaces `step3Error`) when no target class is chosen or a required target
   * property is left unmapped: a deployed pipeline that skips a required property
   * would fail to populate its target object.
   */
  saveJob(): void {
    if (!this.canSaveJob) {
      this.step3Attempted = true;
      this.cdr.markForCheck();
      setTimeout(
        () => this.step3ErrorEl?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        0,
      );
      return;
    }
    this.persistCase((ok) => {
      if (!ok) return;
      this.wizardOpen = false;
      this.cdr.markForCheck();
    });
  }

  /**
   * Deploy — perform ALL the IRIS-side setup that a Save deliberately skips, then
   * hand the pipeline to the agent to generate + compile its classes AND register
   * its hosts on the running production. In order, each step fail-loud (a failure
   * clears the pending state and toasts; the agent is never reached):
   *   1. stage the non-IRIS SQL driver JAR into the container (sets dbDriverClasspath)
   *   2. materialize the saved upload bytes (from SQLite) into IRIS at their path
   *   3. create/upsert the IRIS Credentials entry from the case's DECRYPTED password
   *      (server-side — the plaintext never re-enters the browser or the prompt)
   * Only after all three succeed do we build the prompt (unchanged in content and
   * structure) and run the agent in a fresh chat session. Marks the pipeline
   * pending until the agent reports the deploy outcome.
   */
  deployIntegration(job: IntegrationJob): void {
    // Deploy is the agent's job, so with no Claude key there is nothing to hand it
    // to. The button STAYS enabled — a greyed-out control with a tooltip
    // teaches nobody why the feature is missing — and explains itself in a modal
    // instead. Checked before anything else so no pending state is set and no
    // credential is created for a deploy that cannot start.
    if (!isAiEnabled()) {
      this.showAiKeyDialog = true;
      this.cdr.markForCheck();
      return;
    }
    // An unfinished pipeline cannot deploy: the agent generates IRIS classes from
    // this config, so a missing connection field / unpicked data entity / unmapped
    // required property fails deep inside the agent turn as a compile error, where
    // the user can neither see which field they skipped nor fix it. Check every step
    // up front and name what is missing. Before any pending state is set, so a
    // refused deploy leaves nothing behind (and never holds the single-deploy lock).
    const gaps = jobReadinessGaps(job);
    if (gaps.length) {
      this.notReadyGaps = gaps;
      this.showNotReadyDialog = true;
      this.cdr.markForCheck();
      return;
    }
    // Only one Data Integration deploy may run at a time (SC-2677). A deploy hands
    // a long-running turn to the agent, so a second concurrent deploy risks racing
    // IRIS deployment state. Block ANY deploy while one is in flight — not just a
    // repeat of this same pipeline — and tell the user why.
    if (this.anyDeployPending()) {
      if (!this.isPending(job.id)) {
        this.toast.error('A deploy is already running. Please wait for it to finish before starting another.');
      }
      return;
    }
    this.markPending(job.id);
    this.stageDriverJar(job, () =>
      this.materializeFiles(job, () =>
        this.createCredentialThenDeploy(job),
      ),
    );
  }

  /** Step 1: stage the non-IRIS SQL driver JAR into the container and capture its
   *  in-container path as the GenericService's JDBCClasspath, so the prompt built
   *  below carries the same driverClasspath the old Save-time staging produced.
   *  No-op (proceeds straight on) for IRIS/non-database sources. */
  private stageDriverJar(job: IntegrationJob, next: () => void): void {
    if (job.source.type !== 'database' || !job.source.dbType) { next(); return; }
    this.uploads.ensureDriverJar(job.source.dbType).subscribe({
      next: ({ irisPath }) => {
        job.source.dbDriverClasspath = irisPath || undefined;
        next();
      },
      error: (err) => {
        this.clearPending(job.id);
        this.toast.error(this.uploadErrorMessage('the database driver', err));
        this.cdr.markForCheck();
      },
    });
  }

  /** Step 2: materialize the case's uploaded file bytes into IRIS at their fixed
   *  path (the backend reads them from SQLite for a restored case). No-op when the
   *  pipeline has no uploads. */
  private materializeFiles(job: IntegrationJob, next: () => void): void {
    const fileIds = this.fileIdsOf(job.uploadedFiles);
    if (fileIds.length === 0) { next(); return; }
    this.uploads.materialize(fileIds).subscribe({
      next: ({ results }) => {
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          const detail = failed.map((f) => f.error).find(Boolean) ?? 'file transfer failed';
          this.clearPending(job.id);
          this.toast.error(`Could not transfer the uploaded file(s) into SCO: ${detail}`);
          this.cdr.markForCheck();
          return;
        }
        next();
      },
      error: (err) => {
        this.clearPending(job.id);
        this.toast.error(this.uploadErrorMessage('the uploaded file(s)', err));
        this.cdr.markForCheck();
      },
    });
  }

  /** Step 3: create/upsert the pipeline's IRIS Credentials entry (if any) from the
   *  case's DECRYPTED password held server-side, then hand off to the agent. The
   *  password never enters the browser or the prompt — only the frozen credential
   *  NAME travels in the payload. */
  private createCredentialThenDeploy(job: IntegrationJob): void {
    this.casesApi.createCredentialFromCase(job.id).subscribe({
      next: () => this.bridge.runAgentPrompt(this.buildDeployPrompt(job), this.deployDisplayText(job), true),
      error: (err) => {
        this.clearPending(job.id);
        this.toast.error(this.uploadErrorMessage('the connection credential', err));
        this.cdr.markForCheck();
      },
    });
  }

  /**
   * Delete, step 1 — ASK first. Deleting a pipeline drops a whole configuration
   * (connection, data entity, every field mapping) with no undo, so it goes through
   * the same confirmation the Cube and KPI deletes use rather than firing on the
   * click. `confirmDeleteIntegration()` is what actually deletes.
   */
  requestDeleteIntegration(job: IntegrationJob, event: Event): void {
    event.stopPropagation();
    // A pipeline that has been deployed has live SCO classes + production hosts behind
    // it, so deleting its case would orphan them — block it (the backend enforces this
    // too, returning 409). Refused before the prompt: a dialog offering an impossible
    // delete would only be dismissed.
    //
    // `wasDeployed`, not the status alone: editing a deployed pipeline puts it back to
    // draft, but its SCO artifacts are still there, so it stays undeletable.
    if (this.wasDeployed(job)) {
      this.toast.error('A deployed integration cannot be deleted.');
      return;
    }
    this.pendingDeleteJob = job;
    this.cdr.markForCheck();
  }

  /** Dismiss the delete confirmation without deleting anything. */
  cancelDeleteIntegration(): void {
    this.pendingDeleteJob = null;
    this.cdr.markForCheck();
  }

  /**
   * Delete, step 2 — the user confirmed. Drops the pipeline from the app's saved
   * list. Nothing in the IRIS container is touched: the generated classes, any
   * registered production hosts, and any materialized upload files are left in
   * place. (There is also no MCP tool to delete a compiled class, so an
   * agent-driven cleanup could not remove them anyway — see the removal steps a
   * user can run manually in the Management Portal.)
   */
  confirmDeleteIntegration(): void {
    const job = this.pendingDeleteJob;
    this.pendingDeleteJob = null;
    if (!job) return;
    this.casesApi.delete(job.id).subscribe({
      next: () => this.removeJob(job.id),
      error: (err) => {
        this.toast.error(`Could not delete the integration: ${err?.error?.error || err?.message || 'unknown error'}`);
        this.cdr.markForCheck();
      },
    });
  }

  /** Is a lifecycle step (create/deploy/delete) in flight for this pipeline?
   *  Reads the ROOT bridge so the pending spinner/disabled-Deploy survives this
   *  component being destroyed/recreated on navigation. */
  isPending(id: string): boolean {
    return this.bridge.pendingDeploys().has(id);
  }

  /** True when ANY pipeline has an in-flight deploy — used to enforce a single
   *  concurrent deploy (SC-2677): every pipeline's Deploy is disabled while one runs. */
  anyDeployPending(): boolean {
    return this.bridge.pendingDeploys().size > 0;
  }

  /** Mark a pipeline as having an in-flight agent step (spinner + disabled button). */
  private markPending(id: string): void {
    this.bridge.markDeployPending(id);
    this.cdr.markForCheck();
  }
  private clearPending(id: string): void {
    this.bridge.clearDeployPending(id);
    this.cdr.markForCheck();
  }

  /**
   * Apply an agent status report to the matching pipeline. This is the ONLY path
   * that advances a pipeline to `created`/`deployed` — driven by the agent's real
   * outcome, never optimistically. A failure clears the pending state (leaving
   * the prior status) and toasts why. (Delete is local-only and never reports.)
   */
  private onStatusReport(r: StatusReport): void {
    this.clearPending(r.id);
    const job = this.jobs.find((j) => j.id === r.id);
    if (!job) { this.cdr.markForCheck(); return; }

    if (!r.ok) {
      this.toast.error(`${this.phaseVerb(r.phase)} "${job.name}" failed${r.detail ? `: ${r.detail}` : '.'}`);
      this.cdr.markForCheck();
      return;
    }

    // Deploy is a single automatic action that emits one `deployed` report. We
    // still accept a `created` phase for compatibility (older flows), but the
    // current agent only reports `deployed`. Delete is local-only and never
    // reports, so ignore a stray phase.
    if (r.phase !== 'created' && r.phase !== 'deployed') { this.cdr.markForCheck(); return; }
    job.status = r.phase;
    this.jobs = [...this.jobs];
    if (this.selectedJob?.id === r.id) this.selectedJob = job;
    this.toast.success(`${this.phaseVerb(r.phase)} "${job.name}".`);
    this.cdr.markForCheck();
    // Persist the advance to SQLite (the one place draft → deployed is recorded).
    // Best-effort: the in-UI badge already updated; a failure only toasts.
    if (r.phase === 'deployed') {
      this.casesApi.setStatus(job.id, 'deployed').subscribe({
        error: (err) => this.toast.error(`Deployed, but could not save the status: ${err?.error?.error || err?.message || 'unknown error'}`),
      });
    }
  }

  /** Remove a pipeline from the list (and clear selection if it was selected).
   *  Local only: this drops the pipeline from the app's persisted list and does
   *  NOT touch the IRIS container — the generated classes, any registered hosts,
   *  and any materialized upload files are intentionally left in place. */
  private removeJob(id: string): void {
    this.clearPending(id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.selectedJob?.id === id) {
      this.selectedJob = null;
      this.wizardOpen = false;
    }
    this.cdr.markForCheck();
  }

  /** Past-tense verb for a phase, for status toasts. */
  private phaseVerb(phase: StatusReport['phase']): string {
    return phase === 'created' ? 'Created' : phase === 'deployed' ? 'Deployed' : 'Deleted';
  }

  /** The friendly one-liner shown in the chat for a Deploy — see deployDisplayText
   *  in deploy-prompt.ts. */
  private deployDisplayText(job: IntegrationJob): string {
    return deployDisplayText(job);
  }

  /** The prompt the Deploy button hands to the agent — see buildDeployPrompt in
   *  deploy-prompt.ts, which owns it so the live-source tests can send the exact
   *  same prompt through a real agent turn. */
  private buildDeployPrompt(job: IntegrationJob): string {
    return buildDeployPrompt(job, this.classNameByObject);
  }


  // ── Guided-mode co-pilot (assistant drives the wizard) ────────────
  /**
   * Set one wizard field by dotted path on behalf of Guided mode, opening the
   * wizard and switching to the right step as needed so the assistant can walk a
   * user through both steps. Returns whether the value actually LANDED —
   * dropdown/enum-backed fields (sourceType, a column's type, transform,
   * targetProperty, and the targetClass) only accept a valid option; anything
   * else is rejected with a detail message so the assistant is told the truth.
   *
   * Supported paths (examples):
   *   Step 1: name · sourceType · dbType|dbDataSourceName|dbDsn|dbUsername|dbPassword|dbQuery ·
   *           ftpSftp|ftpHost|ftpPort|ftpPath|ftpFileSpec|ftpDataSourceName|ftpUsername|ftpPassword|sftpPublicKeyFile|sftpPrivateKeyFile ·
   *           cloudBucket|cloudRegion|cloudCredentialsFile · filePath|fileSpec
   *   Step 2: sourceHasHeader · targetClass ·
   *           columns.0.name|type|transform|targetProperty
   */
  private guidedSetField(path: string, value: unknown): SetFieldResult {
    if (!this.wizardOpen) this.openNewWizard();
    const parts = path.split('.');
    const head = parts[0]!;
    let result: SetFieldResult;
    try {
      if (head === 'columns') {
        this.currentStep = 3;
        result = this.setColumnField(Number(parts[1]), parts[2]!, value);
      } else if (head === 'sourceType') {
        result = this.setSourceType(value);
      } else if (head === 'targetClass') {
        this.currentStep = 3;
        result = this.setTargetClass(value);
      } else if (head === 'sourceHasHeader') {
        this.currentStep = 2;
        this.sourceHasHeader = value === true || String(value).toLowerCase() === 'true';
        result = { applied: true };
      } else if (head === 'name') {
        this.currentStep = 1;
        this.jobName = String(value);
        result = { applied: true };
      } else {
        // Adapter-specific Step-1 scalar (dbDsn, ftpHost, filePath, …). Only
        // accept keys that belong to the current source type's config.
        this.currentStep = 1;
        result = this.setSourceConfigField(head, value);
      }
      this.cdr.markForCheck();
      return result;
    } catch {
      return { applied: false, detail: `Unknown or unsupported field path "${path}".` };
    }
  }

  /** Switch the source type; must match one of the selectable (non-disabled) types. */
  private setSourceType(value: unknown): SetFieldResult {
    const v = String(value).trim().toLowerCase();
    const match = this.SOURCE_TYPES.find((t) => t.toLowerCase() === v);
    if (!match) {
      return { applied: false, detail: `"${value}" is not a source type. Choose one of: ${this.SOURCE_TYPES.join(', ')}.` };
    }
    if (this.isSourceDisabled(match)) {
      return { applied: false, detail: `Source type "${match}" is not supported yet.` };
    }
    this.currentStep = 1;
    this.sourceType = match;
    this.onSourceTypeChange();
    return { applied: true };
  }

  /**
   * Fields whose value is produced by an UPLOAD, not typed. The assistant must never
   * set these: the value is a server-side path the upload returns, so anything written
   * here would point at a file that does not exist — the pipeline would then fail at
   * Deploy (or read nothing) with no sign of why. The user has to click Upload File.
   */
  private static readonly UPLOAD_BACKED_FIELDS: ReadonlySet<string> = new Set([
    'sftpPublicKeyFile',
    'sftpPrivateKeyFile',
    'cloudCredentialsFile',
    'filePath',
    'fileSpec',
  ]);

  /**
   * Config fields the wizard DERIVES from the Step-2 data-entity selection — they are
   * not inputs and appear nowhere on the form. `dbQuery` is built from the picked
   * schema + table, the FTP path/spec from the picked CSV, the cloud prefix/pattern
   * from the picked object.
   *
   * The assistant must not set them, and more importantly must not TELL THE USER to
   * fill them in: they'd go looking for a "Query" field that hasn't existed since the
   * query became derived, and anything written here is overwritten by Step 2 anyway.
   */
  private static readonly DERIVED_FIELDS: ReadonlySet<string> = new Set([
    'dbQuery',
    'ftpPath',
    'ftpFileSpec',
    'cloudBlobPrefix',
    'cloudBlobPattern',
  ]);

  /**
   * The `ui_set_field` paths Guided mode may fill on this wizard: the integration name,
   * the source type, and the current adapter's TYPED connection fields. Derived from the
   * same two constants the setter enforces, so what is advertised and what is accepted
   * cannot drift apart.
   */
  private guidedFillablePaths(): string[] {
    const config = (SOURCE_CONFIG_FIELDS[this.sourceType] ?? []).filter(
      (f) =>
        !DataIntegrationComponent.UPLOAD_BACKED_FIELDS.has(f) &&
        !DataIntegrationComponent.DERIVED_FIELDS.has(f),
    );
    return ['name', 'sourceType', ...config];
  }

  /** The current adapter's upload-backed fields, so the assistant can name the ones it
   *  must ask the USER to upload rather than silently skipping them. */
  private guidedUploadOnlyPaths(): string[] {
    return (SOURCE_CONFIG_FIELDS[this.sourceType] ?? []).filter((f) =>
      DataIntegrationComponent.UPLOAD_BACKED_FIELDS.has(f),
    );
  }

  /**
   * What still stands between the user and leaving the CURRENT step — required field
   * labels on Step 1, or the one blocking reason on Steps 2/3. Empty means the step is
   * genuinely done.
   *
   * Reported in the UI context because the assistant was announcing a step complete
   * from its own reading of the conversation while the form still had an empty required
   * field. The form is the authority; this is it speaking.
   */
  private guidedStepBlockers(): string[] {
    if (this.currentStep === 1) return this.missingStep1Fields;
    const blocker = this.currentStep === 2 ? this.missingStep2Selection : this.missingStep3Selection;
    return blocker ? [blocker] : [];
  }

  /** The real label + effect of the button that leaves this step. The assistant told the
   *  user to "click Next"; there is no Next button — Steps 1 and 2 read "Continue". */
  private guidedAdvanceButton(): { label: string; does: string } {
    if (this.currentStep === 3) {
      return { label: 'Save', does: 'saves the pipeline and closes the wizard' };
    }
    return {
      label: 'Continue',
      does: `saves this step and advances to Step ${this.currentStep + 1}`,
    };
  }

  /**
   * What the NEXT step actually asks for, per adapter — the answer the assistant got
   * wrong ("Step 2, where you'll write the SQL query"). For a database source nobody
   * types SQL: the query is derived from the schema + table picked from dropdowns.
   */
  private guidedNextStepHint(): string {
    if (this.currentStep === 3) return 'Nothing — Step 3 is the last step. Save finishes the wizard.';
    if (this.currentStep === 2) {
      return 'Step 3 (Mapping): choose the Target Class, then map each source column to a target property. There is an Auto-map button. Every REQUIRED target property must be mapped before Save.';
    }
    switch (this.sourceType) {
      case 'database':
        return 'Step 2 (Data Entity): choose a Schema, then a Table, from dropdowns the wizard loads over this connection. NO SQL is written by hand — the SELECT is derived from that choice, and the table\'s columns become the source fields.';
      case 'ftp':
        return 'Step 2 (Data Entity): browse the remote server and pick ONE CSV file; its header row (or Column1..N) becomes the source fields.';
      case 'cloud':
        return 'Step 2 (Data Entity): browse the bucket and pick ONE CSV object; its header row becomes the source fields.';
      case 'file':
        return 'Step 2 (Data Entity): the CSV uploaded in Step 1 is previewed there — nothing to pick, just confirm the header-row option.';
      default:
        return 'Step 2 (Data Entity).';
    }
  }

  /** The current adapter's Step-2-derived fields. Reported so the assistant knows they
   *  exist in the saved config but are NOT inputs — it must not send the user looking
   *  for a "Query" box that isn't there. */
  private guidedDerivedPaths(): string[] {
    return (SOURCE_CONFIG_FIELDS[this.sourceType] ?? []).filter((f) =>
      DataIntegrationComponent.DERIVED_FIELDS.has(f),
    );
  }

  /** Set a Step-1 adapter config field, only if it belongs to the current source type. */
  private setSourceConfigField(key: string, value: unknown): SetFieldResult {
    const allowed = SOURCE_CONFIG_FIELDS[this.sourceType] ?? [];
    if (!allowed.includes(key)) {
      return {
        applied: false,
        detail: `"${key}" is not a field of the ${this.sourceType} source. Available: ${allowed.join(', ') || '(none)'}.`,
      };
    }
    if (DataIntegrationComponent.UPLOAD_BACKED_FIELDS.has(key)) {
      return {
        applied: false,
        detail:
          `"${key}" is set by uploading a file, not by typing a value — its content is stored server-side and the ` +
          `field holds the path the upload returns. Ask the user to click "Upload File" for it in Step 1 and pick ` +
          `the file themselves; you cannot supply this one.`,
      };
    }
    if (DataIntegrationComponent.DERIVED_FIELDS.has(key)) {
      return {
        applied: false,
        detail:
          `"${key}" is not a field on this form — the wizard derives it in Step 2 from the data entity the user ` +
          `picks there (the schema + table, or the CSV file / object). Do NOT ask the user to fill it in; there is ` +
          `no such input on screen. Move on to Step 2 and have them select the entity instead.`,
      };
    }
    if (key === 'ftpSftp') {
      this.sourceConfig.ftpSftp = value === true || String(value).toLowerCase() === 'true';
    } else {
      (this.sourceConfig as unknown as Record<string, unknown>)[key] = String(value);
    }
    return { applied: true };
  }

  /** Set the target class; must be one the backend offers, then load its properties. */
  private setTargetClass(value: unknown): SetFieldResult {
    const v = String(value).trim();
    const match = this.targetClasses.find((c) => c.toLowerCase() === v.toLowerCase());
    if (this.targetClasses.length && !match) {
      return { applied: false, detail: `"${v}" is not an available target class. Choose one of: ${this.targetClasses.join(', ')}.` };
    }
    this.selectedTargetClass = match ?? v;
    this.onTargetClassChange();
    return { applied: true };
  }

  /** Set a source column field (creating column rows as needed). */
  private setColumnField(i: number, field: string, value: unknown): SetFieldResult {
    while (this.sourceColumns.length <= i) this.addSourceColumn();
    const col = this.sourceColumns[i]!;
    if (field === 'type') {
      const match = this.SOURCE_COLUMN_TYPES.find((t) => t.toLowerCase() === String(value).trim().toLowerCase());
      if (!match) return { applied: false, detail: `"${value}" is not a column type. Choose one of: ${this.SOURCE_COLUMN_TYPES.join(', ')}.` };
      col.type = match;
      return { applied: true };
    }
    if (field === 'transform') {
      const match = this.TRANSFORM_FUNCTIONS.find((f) => f.value.toLowerCase() === String(value).trim().toLowerCase());
      if (!match) return { applied: false, detail: `"${value}" is not a transform. Choose one of: ${this.TRANSFORM_FUNCTIONS.map((f) => f.value || '(none)').join(', ')}.` };
      col.transform = match.value;
      col.transformArgs = {};
      return { applied: true };
    }
    if (field === 'targetProperty') {
      const raw = String(value).trim();
      // Empty / "—" / "none" clears the mapping: the row stays but is unmapped
      // (and so is dropped from the deploy payload). Mirrors picking "—" in the UI.
      if (raw === '' || raw === '—' || raw.toLowerCase() === 'none') {
        col.targetProperty = '';
        return { applied: true };
      }
      if (this.targetProperties.length) {
        const match = this.targetProperties.find((p) => p.name.toLowerCase() === raw.toLowerCase());
        if (!match) return { applied: false, detail: `"${value}" is not a property of ${this.selectedTargetClass || 'the target class'}. Available: ${this.targetProperties.map((p) => p.name).join(', ')}.` };
        col.targetProperty = match.name;
        return { applied: true };
      }
      col.targetProperty = raw;
      return { applied: true };
    }
    // name (free text)
    (col as unknown as Record<string, unknown>)[field] = String(value);
    return { applied: true };
  }

  /** Compact snapshot for the assistant's UI-context block. Reflects the wizard
   *  when open, otherwise the selected integration's detail. */
  private formSnapshot(): Record<string, unknown> {
    if (this.wizardOpen) {
      return {
        mode: this.editingJobId ? 'editing integration' : 'creating new integration',
        step: this.currentStep === 1 ? '1 (Data Source)' : this.currentStep === 2 ? '2 (Data Entity / source selection)' : '3 (Mapping)',
        // Exactly what Guided mode may fill here — Step 1's TYPED connection fields.
        // Deliberately narrower than what guidedSetField technically accepts: the
        // upload-backed paths are left out because only a real upload can produce their
        // value (the form refuses them), and Steps 2–3 are chosen by browsing/picking in
        // the UI. The assistant is told to fill only what this lists.
        validFieldPaths: this.guidedFillablePaths(),
        uploadOnlyFields: this.guidedUploadOnlyPaths(),
        // Derived in Step 2 — present in the saved config, but NOT inputs. Listed so the
        // assistant describes them as automatic instead of telling the user to type them.
        derivedInStep2Fields: this.guidedDerivedPaths(),
        // ── What the FORM says about this step, so the assistant can't contradict it ──
        // It announced "Step 1 is now complete" with a required Data Source Name still
        // blank, and invented a "Next" button and a SQL-query step. These three answer
        // "is it done?", "what do I click?" and "what comes next?" from the real UI.
        requiredFieldsRemaining: this.guidedStepBlockers(),
        stepComplete: this.guidedStepBlockers().length === 0,
        advanceButton: this.guidedAdvanceButton(),
        nextStepIs: this.guidedNextStepHint(),
        name: this.jobName,
        sourceType: this.sourceType,
        source: this.buildSourcePayload(this.sourceConfig),
        sourceHasHeader: this.sourceHasHeader,
        targetClass: this.selectedTargetClass,
        availableTargetClasses: this.targetClasses,
        targetProperties: this.targetProperties.map((p) => p.name),
        columns: this.sourceColumns.map((c) => ({
          name: c.name,
          type: c.type,
          transform: c.transform || null,
          targetProperty: c.targetProperty || null,
        })),
      };
    }
    if (this.selectedJob) {
      const j = this.selectedJob;
      return {
        mode: 'viewing integration detail',
        selectedIntegration: j.name,
        status: j.status,
        sourceType: j.sourceType,
        sourceName: j.sourceName,
        targetClass: j.targetClass,
        columns: j.columns.map((c) => ({ name: c.name, type: c.type, transform: c.transform || null, targetProperty: c.targetProperty || null })),
      };
    }
    return { mode: 'integration list (none selected)' };
  }

  get sourceLabel(): string {
    const c = this.sourceConfig;
    if (this.sourceType === 'database') return c.dbDsn || 'Database (JDBC)';
    if (this.sourceType === 'rest-api') return c.apiUrl ?? 'REST API';
    if (this.sourceType === 'ftp')      return c.ftpHost ? `${c.ftpSftp ? 'SFTP' : 'FTP'} @ ${c.ftpHost}` : (c.ftpSftp ? 'SFTP' : 'FTP');
    if (this.sourceType === 'cloud')    return c.cloudBucket ? `S3 / ${c.cloudBucket}` : 'AWS S3';
    if (this.sourceType === 'file')     return c.filePath || 'Local File';
    return '';
  }

  /** Basic connection details from Step 1, as label/value rows, for the summary.
   *  Reads from a saved job's source config so the detail page can show them. */
  connectionDetails(job: IntegrationJob): { label: string; value: string }[] {
    const c = job.source;
    const row = (label: string, value?: string) => ({ label, value: value?.trim() ? value : '—' });
    // Password row: shown as dots when set (the real value is never rendered),
    // '—' when empty. The actual value reaches the backend via buildSourcePayload.
    const secretRow = (label: string, value?: string) => ({ label, value: value ? '••••••' : '—' });
    switch (job.sourceType) {
      case 'database':
        return [
          row('Database Type', c.dbType),
          row('Data Source Name', c.dbDataSourceName),
          row('DSN (JDBC URL)', c.dbDsn),
          row('Username', c.dbUsername),
          secretRow('Password', c.dbPassword),
        ];
      case 'ftp':
        return [
          row('Data Source Name', c.ftpDataSourceName),
          row('Protocol', c.ftpSftp ? 'SFTP' : 'FTP'),
          row('Host', c.ftpHost),
          // The EFFECTIVE port, so the review shows what will actually be
          // deployed rather than a blank the payload silently fills in.
          row('Port', this.ftpPortOrDefault(c)),
          row('Username', c.ftpUsername),
          row('Poll Directory', c.ftpPath),
          row('File Spec', c.ftpFileSpec),
          ...(c.ftpSftp
            ? [row('SFTP Public Key', c.sftpPublicKeyFile), row('SFTP Private Key', c.sftpPrivateKeyFile)]
            : [secretRow('Password', c.ftpPassword)]),
        ];
      case 'cloud':
        return [
          row('Bucket Name', c.cloudBucket),
          row('Storage Region', c.cloudRegion),
          row('AWS-S3 Credentials File', c.cloudCredentialsFile),
          row('Blob Prefix', c.cloudBlobPrefix),
          row('Blob Pattern', c.cloudBlobPattern),
        ];
      case 'file':
        return [row('Poll Directory', c.filePath), row('File Spec', c.fileSpec)];
      default:
        return [];
    }
  }

  /** Describe the Step-2 data selection (file name + its source location) for the
   *  summary, per adapter. Returns null when nothing has been selected yet. */
  private dataEntitySummary(): IntegrationJob['dataEntity'] | undefined {
    switch (this.sourceType) {
      case 'database':
        if (!this.selectedTable) return undefined;
        return { nameLabel: 'Table', name: this.selectedTable, sourceLabel: 'Schema', source: this.selectedSchema || '—' };
      case 'ftp':
        if (!this.selectedCsvPath) return undefined;
        return { nameLabel: 'File', name: this.selectedCsvName, sourceLabel: 'Path', source: this.selectedCsvPath };
      case 'cloud':
        if (!this.selectedCloudCsvPath) return undefined;
        return { nameLabel: 'Object', name: this.selectedCloudCsvName, sourceLabel: 'Key', source: this.selectedCloudCsvPath };
      case 'file':
        if (!this.sourceConfig.filePath) return undefined;
        return { nameLabel: 'File', name: this.localFileName || this.sourceConfig.filePath, sourceLabel: 'Path', source: this.sourceConfig.filePath };
      default:
        return undefined;
    }
  }

  /** The first required Step-1 field still empty, by its on-screen label (exactly
   *  the fields carrying a `*`), or null when Step 1 is complete. Drives both the
   *  Next button's disabled state and its tooltip, so the two can never disagree
   *  about what is missing. Step 2 immediately introspects the source (schema
   *  list / directory listing), which cannot work with a half-filled connection —
   *  hence the gate lives here rather than surfacing as a load error later.
   *
   *  The rules themselves live in job-readiness.ts, so this gate and the Deploy
   *  gate (which judges a SAVED job, with no wizard state to read) apply exactly
   *  the same definition of "required". */
  get missingStep1Field(): string | null {
    return missingStep1Field(this.jobName, this.sourceType, this.sourceConfig);
  }

  /** Every required Step-1 field still empty, for the assistant's UI context — it must
   *  not be able to call the step complete while the form disagrees. */
  get missingStep1Fields(): string[] {
    return missingStep1Fields(this.jobName, this.sourceType, this.sourceConfig);
  }

  get canProceedStep1(): boolean { return !this.missingStep1Field; }

  /**
   * Why Step 2 can't be left yet, as a ready-to-show sentence, or null when the
   * data entity is settled. Step 3 maps the selected entity's columns onto a
   * target class, so with nothing selected it opens with an empty mapping table
   * and no way to explain why — the reason belongs here, next to the browser the
   * user is meant to pick in.
   *
   * A selection that HAS been made is then judged on what it retrieved: still
   * loading, unreadable, and column-less all block too, for the same reason.
   *
   * `carriedOverDataEntity` is the one escape, for re-entry: an edited job arrives
   * with its saved mapping columns and no Step-2 selection state, and forcing a
   * re-pick would rebuild Step 3 from scratch (see syncSourceColumnsFromData) and
   * discard the target properties and transforms the user already chose.
   */
  get missingStep2Selection(): string | null {
    switch (this.sourceType) {
      case 'database':
        if (!this.selectedTable) {
          if (this.carriedOverDataEntity) return null;
          return this.selectedSchema
            ? 'Select a table before continuing.'
            : 'Select a schema, then a table, before continuing.';
        }
        if (this.loadingColumns) return 'Wait for the selected table’s columns to finish loading.';
        if (this.sqlColumns.length) return null;
        return this.columnError
          ? 'The selected table’s columns could not be read, so there is nothing to map.'
          : 'The selected table has no columns to map.';

      case 'ftp':
        if (!this.selectedCsvPath) {
          return this.carriedOverDataEntity ? null : 'Select a CSV file before continuing.';
        }
        if (this.loadingCsvPreview) return 'Wait for the selected file’s preview to finish loading.';
        if (this.csvPreview?.columns.length) return null;
        return this.csvPreviewError
          ? 'The selected file could not be read, so there is nothing to map.'
          : 'The selected file has no columns to map.';

      case 'cloud':
        if (!this.selectedCloudCsvPath) {
          return this.carriedOverDataEntity ? null : 'Select a CSV object before continuing.';
        }
        if (this.loadingCloudCsvPreview) return 'Wait for the selected object’s preview to finish loading.';
        if (this.cloudCsvPreview?.columns.length) return null;
        return this.cloudCsvPreviewError
          ? 'The selected object could not be read, so there is nothing to map.'
          : 'The selected object has no columns to map.';

      case 'file':
        // The file itself is chosen in Step 1; Step 2 only previews it.
        if (!this.sourceConfig.filePath?.trim()) {
          return 'Upload a file in the Data Source step before continuing.';
        }
        if (this.loadingLocalPreview) return 'Wait for the file preview to finish loading.';
        if (this.localCsvPreview?.columns.length) return null;
        if (this.carriedOverDataEntity) return null;
        return this.localPreviewError
          ? 'The uploaded file could not be read, so there is nothing to map.'
          : 'The uploaded file has no columns to map.';

      default:
        // rest-api has no data-selection step ("No data selection is required for
        // this source type"), so there is nothing to require.
        return null;
    }
  }

  get canProceedStep2(): boolean { return !this.missingStep2Selection; }

  /**
   * True when the wizard already carries a COMPLETE data entity from a previous
   * session — i.e. a saved job restored by editJob(), which brings its columns and
   * its adapter config but no Step-2 selection state.
   *
   * Both halves must hold: the columns Step 3 maps AND the adapter fields the
   * deployed pipeline actually polls with. Leftover `sourceColumns` alone are not
   * enough, because browsing to another folder clears the selection and those
   * adapter fields (clearCsvPreview / clearCloudCsvPreview / onTableChange) while
   * the previous file's columns stay in Step 3 — so a folder with nothing picked
   * would sail through on stale columns and deploy a pipeline pointing at nothing.
   */
  private get carriedOverDataEntity(): boolean {
    return this.sourceColumns.length > 0 && hasPolledEntity(this.sourceType, this.sourceConfig);
  }

  isSourceDisabled(t: SourceType): boolean {
    return this.DISABLED_SOURCE_TYPES.has(t);
  }

  sourceTypeIcon(t: SourceType): string {
    const icons: Record<SourceType, string> = {
      'database': '🗄', 'rest-api': '🌐', 'ftp': '📂', 'cloud': '☁', 'file': '📄',
    };
    return icons[t];
  }

  /**
   * The Step-1 "Load sample data" tile: leave the wizard for the Getting Started page
   * that loads a ready-made SC_Data set. Routed through the bridge, like Issue
   * Management's business-process tile, so the shell's unsaved-edits handshake still
   * runs — a half-built integration is not discarded behind the user's back.
   */
  openLoadSampleData(): void {
    this.bridge.setActiveView('load-sample-data');
  }

  /** Default IRIS adapter short name for each UI source type. */
  private static readonly ADAPTER_TYPE_BY_SOURCE: Record<SourceType, AdapterType> = {
    'database': 'SQL',
    'ftp': 'FTP',   // immutable; the FTP-vs-SFTP protocol rides on ftpSftp
    'cloud': 'Cloud',
    'file': 'File',
    'rest-api': 'REST',
  };

  private emptySource(type: SourceType): SourceConfig {
    return {
      type,
      adapterType: DataIntegrationComponent.ADAPTER_TYPE_BY_SOURCE[type],
      // ftp / sftp — leave port empty so the gray "Default port is 21/22" hint shows
      ftpSftp: false,
      // rest-api (disabled)
      apiAuth: 'None',
    };
  }
}

/**
 * The host out of a JDBC URL: `jdbc:postgresql://54.226.72.249:5432/db` → `54.226.72.249`.
 * Returns '' when the string isn't shaped like one, so the caller falls back rather than
 * showing a mangled fragment.
 */
function jdbcHost(dsn: string | undefined): string {
  const m = /\/\/([^/:?]+)/.exec(dsn ?? '');
  return m?.[1]?.trim() ?? '';
}

/**
 * Which SourceConfig fields Guided mode may set per source type — so `ui_set_field`
 * only accepts a config key that actually belongs to the chosen source (rejecting
 * e.g. `ftpHost` on a `file` source with a clear message).
 */
const SOURCE_CONFIG_FIELDS: Record<SourceType, string[]> = {
  database: ['dbType', 'dbDataSourceName', 'dbDsn', 'dbUsername', 'dbPassword', 'dbQuery'],
  ftp: ['ftpSftp', 'ftpHost', 'ftpPort', 'ftpPath', 'ftpFileSpec', 'ftpDataSourceName', 'ftpUsername', 'ftpPassword', 'sftpPublicKeyFile', 'sftpPrivateKeyFile'],
  cloud: ['cloudBucket', 'cloudRegion', 'cloudCredentialsFile', 'cloudBlobPrefix', 'cloudBlobPattern'],
  file: ['filePath', 'fileSpec'],
  'rest-api': ['apiUrl', 'apiAuth', 'apiKey', 'apiBearer', 'apiUser', 'apiPassword'],
};
