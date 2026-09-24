/**
 * The Deploy button's payload and agent prompt, as pure functions.
 *
 * Extracted from the wizard component so the live-source test tier can build the
 * SAME prompt the button builds and hand it to a real agent turn — those tests then
 * exercise the path a user actually takes (Deploy → agent → IRIS), not the class
 * generator directly.
 *
 * The backend keeps a TWIN of this file (backend/test/live-source/helpers/deploy-prompt.ts)
 * instead of importing it, because the two workspaces build under separate tsconfigs
 * — the same reason humanizeLabel is a twin of humanizeField. The shared CONTRACT is
 * `ci/deploy-prompt-lockstep.json`: deploy-prompt.spec.ts and
 * backend/test/unit/deploy-prompt-lockstep.test.ts assert the same fixture, so if
 * either side's prompt drifts, one of the two suites goes red.
 */
import type { IntegrationJob, SourceConfig } from './data-integration.model';

/** UI source-column type label → the data-integration skill's canonical type
 *  token (see references/message.md's type table), used in the deploy payload so
 *  the agent maps each request-message property without relying on case-folding.
 *  `Time` maps to the `time` token (%Time), added to message.md alongside this. */
export const SOURCE_TYPE_TOKENS: Record<string, string> = {
  String: 'string',
  Integer: 'integer',
  Decimal: 'decimal',
  Boolean: 'boolean',
  Date: 'date',
  DateTime: 'datetime',
  Time: 'time',
};

/** Database Type → JDBC driver class the backend's Java helper loads. The
 *  matching driver JAR must be on the helper's classpath (backend/jdbc-lib). */
export const DB_DRIVER_CLASS: Record<string, string> = {
  IRIS: 'com.intersystems.jdbc.IRISDriver',
  PostgreSQL: 'org.postgresql.Driver',
};

/** Normalized column types that map to a variable-length string in the source DB.
 *  Only these are CAST to VARCHAR for PostgreSQL — see buildSqlQuery(). Raw DB
 *  types like `text`/`varchar` never appear here; mapToColumnType() already
 *  normalizes every text-like type to `String`. */
const STRING_COLUMN_TYPES = new Set(['String']);

/**
 * The polled SELECT for a database source: the mapped columns (plus the source key
 * column when it isn't already mapped) against the Step-2 table, or the user's own
 * stored query when the table/columns aren't known.
 *
 * PostgreSQL string columns are CAST to VARCHAR(32700): a PostgreSQL `text`
 * (or unbounded `varchar`) column reports a length of ~2.1 billion, so IRIS's
 * SQL adapter reads it as a LOB via `getClob()` — but the PostgreSQL JDBC
 * driver has no CLOB, so it treats the value as a large-object OID and fails
 * with `Bad value for type long`. Casting reports a small length, so IRIS
 * reads it as a plain string. 32700 stays under IRIS's default
 * MaxVarCharLengthAsString (32767), so it's read as a string without touching
 * that setting; values longer than 32700 chars are truncated.
 */
export function buildSqlQuery(job: IntegrationJob): string {
  const isPostgres = job.source.type === 'database' && job.source.dbType === 'PostgreSQL';
  const mapped = job.columns.filter((c) => c.targetProperty?.trim() && c.name.trim());
  const cols = mapped.map((c) => {
    const name = c.name.trim();
    return isPostgres && STRING_COLUMN_TYPES.has(c.type) ? `CAST(${name} AS VARCHAR(32700)) AS ${name}` : name;
  });
  const table = job.dataEntity?.name
    ? (job.dataEntity.source && job.dataEntity.source !== '—' ? `${job.dataEntity.source}.${job.dataEntity.name}` : job.dataEntity.name)
    : '';
  if (!cols.length || !table) return (job.source.dbQuery ?? '').trim();
  // The source key column (KeyFieldName) must be IN the polled result set for the
  // adapter to track rows by it — even when the user didn't map it to a target
  // property (the target auto-generates its own key). Add it to the SELECT if
  // it's not already a mapped column, so `SELECT …mapped…, <keyField> FROM t`.
  const key = job.source.dbKeyField?.trim();
  if (key && !cols.some((c) => c.toLowerCase() === key.toLowerCase())) cols.push(key);
  return `SELECT ${cols.join(', ')} FROM ${table}`;
}

/** The FTP/SFTP control port to send downstream: what the user typed, or the
 *  protocol default when they left it blank (as the field's placeholder
 *  promises). Blank must never reach the agent — the generated business service
 *  emits `Set ..Adapter.FTPPort = {port}`, which is a COMPILE ERROR with no
 *  value on the right-hand side, not a fallback to 21/22. */
export function ftpPortOrDefault(c: SourceConfig): string {
  return c.ftpPort?.trim() || (c.ftpSftp ? '22' : '21');
}

/** Extract only the Step-1 fields relevant to the job's adapter, so the deploy
 *  payload carries clean source config (not the cross-adapter defaults that
 *  emptySource seeds). */
export function buildSourcePayload(c: SourceConfig): Record<string, unknown> {
  switch (c.type) {
    case 'database':
      return {
        // Trim: a trailing space in the JDBC URL breaks the namespace parse.
        dsn: c.dbDsn?.trim(),
        // The backend created this IRIS Credentials entry (from the generated
        // name + the user's username/password) before the agent ran, so the
        // agent only needs the NAME to set as the adapter's Credentials setting.
        // The raw username/password are NOT sent to the agent.
        credentials: c.dbCredentialName,
        // Raw stored query; buildDeployPayload replaces it with an explicit
        // mapped-column SELECT so the message properties match the columns 1:1.
        query: c.dbQuery?.trim(),
        // The source table's key column (auto-detected). The generator sets it as
        // the GenericService KeyFieldName so each source row is processed once.
        // Empty/omitted → no source key → the generator disables row-tracking.
        keyField: c.dbKeyField?.trim() || undefined,
        // The chosen Database Type + its JDBC driver class, so the deployed
        // GenericService targets the right database (IRIS, PostgreSQL, …) rather
        // than always assuming IRIS.
        dbType: c.dbType,
        driverClass: DB_DRIVER_CLASS[c.dbType ?? ''] ?? '',
        // For a non-IRIS source, the in-container path of the driver JAR staged
        // into IRIS at Deploy — set as the GenericService's JDBCClasspath. Absent
        // for IRIS (its driver is always on the Java Gateway's default classpath).
        ...(c.dbDriverClasspath ? { driverClasspath: c.dbDriverClasspath } : {}),
      };
    case 'ftp':
      return {
        protocol: c.ftpSftp ? 'SFTP' : 'FTP',
        host: c.ftpHost,
        port: ftpPortOrDefault(c),
        path: c.ftpPath,
        fileSpec: c.ftpFileSpec,
        // The backend created this Credentials entry from the user's
        // username/password before the agent ran; the agent gets only the name.
        credentials: c.ftpCredentialName,
        ...(c.ftpSftp
          ? { sftpPublicKeyFile: c.sftpPublicKeyFile, sftpPrivateKeyFile: c.sftpPrivateKeyFile }
          : {}),
      };
    case 'cloud':
      return {
        bucket: c.cloudBucket,
        region: c.cloudRegion,
        credentialsFile: c.cloudCredentialsFile,
        blobPrefix: c.cloudBlobPrefix,
        blobPattern: c.cloudBlobPattern,
      };
    case 'file':
      return {
        filePath: c.filePath,
        fileSpec: c.fileSpec,
      };
    default:
      return {};
  }
}

/** Assemble the full deploy payload for a job (sent to the backend). Includes
 *  Step 1 (data source) AND Step 2 (mapping) so the backend has everything.
 *  `classNameByObject` maps the wizard's short objectName to the IRIS FQN. */
export function buildDeployPayload(job: IntegrationJob, classNameByObject: Record<string, string>) {
  // The FTP card covers two skill adapters — report the real one (SFTP vs FTP).
  const adapter =
    job.source.type === 'ftp' ? (job.source.ftpSftp ? 'SFTP' : 'FTP') : job.source.adapterType;
  return {
    // The integration id namespaces every generated class as
    // SC.Workbench.Integration{id}.* — the skill keys idempotency on it, so it
    // travels in the structured payload, not just the prompt prose.
    id: job.id,
    name: job.name,
    adapter,
    // service = the data source (Step 1). For SQL, replace the stored query
    // with an explicit mapped-column SELECT so the typed message's properties
    // match the polled columns 1:1 (never a SELECT * that returns extra columns).
    service: {
      ...buildSourcePayload(job.source),
      ...(job.source.type === 'database' ? { query: buildSqlQuery(job) } : {}),
    },
    // process = everything else (Step 2 mapping).
    process: {
      hasHeader: job.hasHeader,
      // The skill wants the fully-qualified IRIS class (e.g. SC.Data.BOM). The
      // dropdown/property-fetch use the short objectName (e.g. BOM), so resolve
      // to the FQN here; fall back to the stored value if the map isn't loaded.
      targetClass: classNameByObject[job.targetClass] ?? job.targetClass,
      // Skip source fields the user left unmapped — a column whose Target
      // Property is "—" (empty) produces nothing in the DTL, so it's dropped
      // from the payload entirely.
      mappings: job.columns
        .filter((c) => c.targetProperty?.trim())
        .map((c) => ({
          sourceField: c.name,
          // Emit the skill's canonical type token (message.md's table), not the UI
          // display label — so the agent maps it without relying on case-folding.
          sourceType: SOURCE_TYPE_TOKENS[c.type] ?? c.type.toLowerCase(),
          transform: c.transform || null,
          transformArgs: c.transformArgs ?? {},
          targetProperty: c.targetProperty!.trim(),
        })),
    },
  };
}

/** JSON description of a pipeline, embedded in the agent prompts. */
export function jobSpecJson(job: IntegrationJob, classNameByObject: Record<string, string>): string {
  return JSON.stringify(buildDeployPayload(job, classNameByObject), null, 2);
}

/** The friendly one-liner shown in the chat for a Deploy (the full prompt with
 *  the pipeline JSON is system detail and stays out of the UI). */
export function deployDisplayText(job: IntegrationJob): string {
  return `Start to run the data integration process: ${job.name}`;
}

/**
 * The prompt the Deploy button hands to the agent. Deploy is a single automatic
 * action: in ONE turn the agent generates + compiles the classes, registers the
 * hosts on the production, AND enables them (starts the pipeline) — no separate
 * "Create" step and no "start now?" question. It reports one `deployed` status,
 * so the badge advances draft → deployed. The uploaded file was already
 * transferred into IRIS at Save, so the payload's filePath/fileSpec already
 * points at a real file.
 */
export function buildDeployPrompt(job: IntegrationJob, classNameByObject: Record<string, string>): string {
  return [
    `Deploy the data-integration pipeline "${job.name}" (integration id: ${job.id}) — do the whole thing automatically in THIS single turn, without asking me to confirm or whether to start it.`,
    `Use the data-integration skill. In order:`,
    ``,
    `1. Generate and compile the request message, Business Service, DTL, and BPL classes in SCO.`,
    `   Follow the skill's naming and existence-check rules — all classes live under the package`,
    `   SC.Workbench.Integration${job.id}.* (BS/BP/DTL/Message sub-packages), one set per integration`,
    `   id (re-running updates the existing classes, not duplicates them). If any compile fails, STOP`,
    `   and report ok:false.`,
    `2. Register ALL of this pipeline's hosts on the active production FIRST, all left disabled`,
    `   (Business Process and Business Service — for a SQL adapter add/reuse the shared JavaGateway and`,
    `   add the per-pipeline GenericService). THEN, as a separate phase, ENABLE them in order (Business`,
    `   Process first, then Business Service) so the pipeline starts ingesting. Do not enable a host`,
    `   until every host has been added.`,
    `3. Report the single outcome by calling ui_report_status`,
    `   { target: "${job.id}", phase: "deployed", ok: <true only if every class compiled AND the hosts`,
    `   were registered and enabled, else false>, detail: <short note> }. Do NOT ask whether to start.`,
    ``,
    `Pipeline definition:`,
    '```json',
    jobSpecJson(job, classNameByObject),
    '```',
  ].join('\n');
}
