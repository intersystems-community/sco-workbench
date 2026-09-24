/**
 * The backend TWIN of the wizard's Deploy payload + prompt
 * (frontend/src/app/data-integration/deploy-prompt.ts).
 *
 * The live-source suites drive Deploy through a real agent turn, so they must send
 * the byte-identical prompt the button sends — otherwise the tier proves a prompt no
 * user ever produces. This is a twin rather than an import because the two
 * workspaces build under separate tsconfigs (the same reason humanizeLabel is a twin
 * of humanizeField). The shared CONTRACT is `ci/deploy-prompt-lockstep.json`:
 * backend/test/unit/deploy-prompt-lockstep.test.ts and
 * frontend/src/app/data-integration/deploy-prompt.spec.ts assert the same fixture,
 * so if either side drifts, one of the two suites goes red.
 *
 * The types below are the wizard fields the prompt READS — a subset of the
 * component's SourceConfig/IntegrationJob, which also carry UI-only state.
 */

/** The Step-1 source config, as the wizard holds it. */
export interface WizardSourceConfig {
  type: 'database' | 'rest-api' | 'ftp' | 'cloud' | 'file';
  adapterType: 'SQL' | 'FTP' | 'SFTP' | 'Cloud' | 'File' | 'REST';

  // database → SQL
  dbType?: string;
  dbDsn?: string;
  dbQuery?: string;
  dbCredentialName?: string;
  dbKeyField?: string;
  dbDriverClasspath?: string;

  // ftp / sftp
  ftpSftp?: boolean;
  ftpHost?: string;
  ftpPort?: string;
  ftpPath?: string;
  ftpFileSpec?: string;
  ftpCredentialName?: string;
  sftpPublicKeyFile?: string;
  sftpPrivateKeyFile?: string;

  // cloud → AWS S3
  cloudBucket?: string;
  cloudRegion?: string;
  cloudCredentialsFile?: string;
  cloudBlobPrefix?: string;
  cloudBlobPattern?: string;

  // file
  filePath?: string;
  fileSpec?: string;
}

/** One mapped source column (a row of the wizard's Field Mapping table). */
export interface WizardColumn {
  name: string;
  type: string;
  targetProperty?: string;
  transform?: string;
  transformArgs?: Record<string, string>;
}

/** A saved pipeline, as the wizard holds it. */
export interface WizardJob {
  id: string;
  name: string;
  source: WizardSourceConfig;
  /** Short objectName; resolved to the IRIS FQN via `classNameByObject`. */
  targetClass: string;
  hasHeader: boolean;
  columns: WizardColumn[];
  /** Step-2 selection — the source table a database pipeline polls. */
  dataEntity?: { nameLabel: string; name: string; sourceLabel: string; source: string };
}

/** UI source-column type label → the data-integration skill's canonical type token. */
export const SOURCE_TYPE_TOKENS: Record<string, string> = {
  String: 'string',
  Integer: 'integer',
  Decimal: 'decimal',
  Boolean: 'boolean',
  Date: 'date',
  DateTime: 'datetime',
  Time: 'time',
};

/** Database Type → JDBC driver class the deployed GenericService loads. */
export const DB_DRIVER_CLASS: Record<string, string> = {
  IRIS: 'com.intersystems.jdbc.IRISDriver',
  PostgreSQL: 'org.postgresql.Driver',
};

/** Column types that are CAST to VARCHAR for a PostgreSQL source (see buildSqlQuery). */
const STRING_COLUMN_TYPES = new Set(['String']);

/** The polled SELECT for a database source: the mapped columns (plus the source key
 *  column when it isn't already mapped) against the Step-2 table. PostgreSQL string
 *  columns are CAST so IRIS reads them as strings, not LOBs. */
export function buildSqlQuery(job: WizardJob): string {
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
  const key = job.source.dbKeyField?.trim();
  if (key && !cols.some((c) => c.toLowerCase() === key.toLowerCase())) cols.push(key);
  return `SELECT ${cols.join(', ')} FROM ${table}`;
}

/** The FTP/SFTP control port: what the user typed, or the protocol default. */
export function ftpPortOrDefault(c: WizardSourceConfig): string {
  return c.ftpPort?.trim() || (c.ftpSftp ? '22' : '21');
}

/** Only the Step-1 fields relevant to the job's adapter. */
export function buildSourcePayload(c: WizardSourceConfig): Record<string, unknown> {
  switch (c.type) {
    case 'database':
      return {
        dsn: c.dbDsn?.trim(),
        credentials: c.dbCredentialName,
        query: c.dbQuery?.trim(),
        keyField: c.dbKeyField?.trim() || undefined,
        dbType: c.dbType,
        driverClass: DB_DRIVER_CLASS[c.dbType ?? ''] ?? '',
        ...(c.dbDriverClasspath ? { driverClasspath: c.dbDriverClasspath } : {}),
      };
    case 'ftp':
      return {
        protocol: c.ftpSftp ? 'SFTP' : 'FTP',
        host: c.ftpHost,
        port: ftpPortOrDefault(c),
        path: c.ftpPath,
        fileSpec: c.ftpFileSpec,
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

/** The full deploy payload (Step 1 + Step 2), as the agent receives it. */
export function buildDeployPayload(job: WizardJob, classNameByObject: Record<string, string>) {
  const adapter =
    job.source.type === 'ftp' ? (job.source.ftpSftp ? 'SFTP' : 'FTP') : job.source.adapterType;
  return {
    id: job.id,
    name: job.name,
    adapter,
    service: {
      ...buildSourcePayload(job.source),
      ...(job.source.type === 'database' ? { query: buildSqlQuery(job) } : {}),
    },
    process: {
      hasHeader: job.hasHeader,
      targetClass: classNameByObject[job.targetClass] ?? job.targetClass,
      mappings: job.columns
        .filter((c) => c.targetProperty?.trim())
        .map((c) => ({
          sourceField: c.name,
          sourceType: SOURCE_TYPE_TOKENS[c.type] ?? c.type.toLowerCase(),
          transform: c.transform || null,
          transformArgs: c.transformArgs ?? {},
          targetProperty: c.targetProperty!.trim(),
        })),
    },
  };
}

/** JSON description of a pipeline, embedded in the agent prompt. */
export function jobSpecJson(job: WizardJob, classNameByObject: Record<string, string>): string {
  return JSON.stringify(buildDeployPayload(job, classNameByObject), null, 2);
}

/** The friendly one-liner the chat shows for a Deploy. */
export function deployDisplayText(job: WizardJob): string {
  return `Start to run the data integration process: ${job.name}`;
}

/** The prompt the Deploy button hands to the agent. */
export function buildDeployPrompt(job: WizardJob, classNameByObject: Record<string, string>): string {
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
