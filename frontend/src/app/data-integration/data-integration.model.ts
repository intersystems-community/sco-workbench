/**
 * The Data Integration data model — the shapes a pipeline ("case") is made of.
 *
 * Extracted from the component so the pure logic that reasons about a SAVED job
 * (see job-readiness.ts) can import the types without pulling in the Angular
 * component, and so both sides share one definition of what a pipeline is.
 */

// ── Source types ──────────────────────────────────────────────
export type SourceType = 'database' | 'rest-api' | 'ftp' | 'cloud' | 'file';

// The create-business-service skill's adapter short names. Each source config
// carries one so the backend knows which IRIS inbound adapter to generate.
export type AdapterType = 'SQL' | 'FTP' | 'SFTP' | 'Cloud' | 'File' | 'REST';

// Field names mirror the IRIS adapter properties the create-business-service
// skill emits (verified against the IRIS docs), so the collected config maps
// straight onto `Set ..Adapter.<Prop>` lines.
export interface SourceConfig {
  type: SourceType;
  /**
   * IRIS adapter short name (the skill's Step-1 adapterType). Immutable routing
   * key: the backend reads it to invoke the matching skill/adapter section. Set
   * once per source type; the FTP↔SFTP protocol choice rides on `ftpSftp`, not here.
   */
  readonly adapterType: AdapterType;

  // ── database → SQL (EnsLib.SQL.Service.GenericService) ──
  dbType?: string;                    // Database Type — IRIS or PostgreSQL
  dbDataSourceName?: string;          // Data Source Name — free-text name for the data source
  dbDsn?: string;                     // DSN — JDBC URL, e.g. jdbc:IRIS://host:1972/ns
  dbUsername?: string;                // Username
  dbPassword?: string;                // Password
  dbQuery?: string;                   // Query — SELECT / query-proc call
  dbCredentialName?: string;          // Generated IRIS Credentials entry name (Data Source Name + uuid), created at Deploy
  dbKeyField?: string;                // Source table's primary/unique key column (auto-detected via JDBC); becomes the GenericService KeyFieldName so each source row is processed once. Empty = no source key → row-tracking disabled.
  dbDriverClasspath?: string;         // In-container path of the driver JAR staged at Save (non-IRIS only) → the GenericService's JDBCClasspath

  // ── rest-api (disabled — kept for existing jobs) ──
  apiUrl?: string;
  apiAuth?: string;
  apiKey?: string;
  apiBearer?: string;
  apiUser?: string;
  apiPassword?: string;

  // ── ftp / sftp (EnsLib.FTP.InboundAdapter) ──
  ftpSftp?: boolean;                  // Protocol = "SFTP" when true
  ftpHost?: string;                   // FTPServer
  ftpPort?: string;                   // FTPPort (21 FTP / 22 SFTP recommended)
  ftpPath?: string;                   // FilePath
  ftpDataSourceName?: string;         // Data Source Name — display label; also seeds the generated IRIS credential name
  ftpUsername?: string;               // Username
  ftpPassword?: string;               // Password
  ftpFileSpec?: string;               // FileSpec (required for SFTP)
  ftpCredentialName?: string;         // Generated IRIS Credentials entry name (host + uuid), created at Deploy
  // SFTP key-file auth (shown in the main SFTP grid)
  sftpPublicKeyFile?: string;         // SFTPPublicKeyFile
  sftpPrivateKeyFile?: string;        // SFTPPrivateKeyFile

  // ── cloud → AWS S3 (EnsLib.AmazonS3.InboundAdapter) ──
  cloudBucket?: string;               // BucketName
  cloudRegion?: string;               // StorageRegion
  cloudCredentialsFile?: string;      // ProviderCredentialsFile — the server-side path the credentials-file upload returns (blank = default AWS chain)
  cloudBlobPrefix?: string;           // BlobNamePrefix — SERVER-side "folder" filter: the key prefix the picked object lives under (relative, trailing slash; '' at bucket root)
  cloudBlobPattern?: string;          // BlobNamePattern — CLIENT-side wildcard filter matched against the FULL blob key (not the leaf name), so for an exact single file this is the whole relative path, e.g. "Test/locations.csv"

  // ── file (EnsLib.File.InboundAdapter — polls a directory on the IRIS host) ──
  filePath?: string;                  // FilePath — directory to poll
  fileSpec?: string;                  // FileSpec — filename filter, e.g. *.csv
}

/** A user-entered source data column: property/column name + its value type.
 *  `targetProperty` / `transform` are the Section-3 mapping onto the target class.
 *  `transformArgs` holds the selected transform function's extra arguments,
 *  keyed by parameter name (e.g. { start: '1', end: '8' } for SubString). */
export interface SourceColumn {
  name: string;
  type: string;
  targetProperty?: string;
  transform?: string;
  transformArgs?: Record<string, string>;
}

export interface ScAttribute { name: string; dataType: string; required: boolean; }

/**
 * Pipeline lifecycle:
 *  - `draft`     — saved locally only; no IRIS classes exist yet (a template).
 *  - `created`   — legacy phase (classes compiled but not yet deployed); the
 *                  current Deploy is a single automatic action, so pipelines go
 *                  straight from `draft` to `deployed`. Kept for older records.
 *  - `deployed`  — the agent compiled the classes, registered the hosts, AND
 *                  started (enabled) the pipeline on the production, in one step.
 *
 * "Ready" is deliberately NOT here: it is not a stored state but a DERIVED one
 * (a draft whose three wizard steps are all complete — see job-readiness.ts), so
 * it needs no backend round trip and can never drift from the saved config.
 */
export type IntegrationStatus = 'draft' | 'created' | 'deployed';

export interface IntegrationJob {
  id: string;
  name: string;
  status: IntegrationStatus;
  sourceType: SourceType;
  sourceName: string;
  source: SourceConfig;
  // New mapping model: target class + user-defined source columns mapped to it.
  targetClass: string;
  hasHeader: boolean;
  columns: SourceColumn[];
  // Summary snapshot (captured at save) so the detail page can surface what was
  // configured without re-opening the wizard.
  connectionTested?: boolean;  // true only if the SAVED connection config was successfully tested
  dataEntity?: { nameLabel: string; name: string; sourceLabel: string; source: string }; // Step-2 selection
  // Signature of the target class + its properties captured at Save. On restore we
  // re-fetch the class and compare: if it no longer exists or ANY property changed,
  // the saved field mappings are stale, so Step 3 resets to "no target class".
  targetClassSignature?: string;
  /**
   * True once this pipeline has been deployed at least once, i.e. its generated
   * classes and production hosts exist in SCO. SERVER-owned (stamped by the backend
   * when a deploy reports success) and never cleared, which is what distinguishes it
   * from `status`: editing a deployed pipeline sends its `status` back to `draft`
   * (the saved config is no longer what is live), while this stays true — so Deploy
   * still reads "Redeploy" and the case still can't be deleted out from under the
   * live SCO artifacts.
   */
  everDeployed?: boolean;
  /** Names of the target class's REQUIRED properties as of the last Save. Stored so
   *  the readiness check (and therefore the Deploy gate and the Ready badge) can
   *  judge a saved job's mapping completeness WITHOUT re-fetching the class —
   *  every job in the list is judged, not just the one open in the wizard.
   *  Absent on cases saved before this field existed; see job-readiness.ts for how
   *  those degrade. */
  requiredTargetProperties?: string[];
  // Backend ids for files uploaded in this wizard, keyed by slot. Used at Deploy
  // to materialize them into IRIS and at Delete to clean them up. Keyed (not a
  // flat list) so editing one slot without re-picking the others preserves each
  // slot's id. These reference in-memory-only bytes on the backend, so after a
  // backend restart they go stale and Deploy reports "re-upload" — the intended
  // behavior (nothing is retained across a restart).
  uploadedFiles?: UploadSlots;
}

/** Backend upload ids per file slot (only slots used by the adapter are set). */
export interface UploadSlots {
  publicKey?: string;
  privateKey?: string;
  cloudCred?: string;
  localFile?: string;
}

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  'database':  'Database',
  'rest-api':  'REST API',
  'ftp':       'FTP / SFTP',
  'cloud':     'Cloud Storage',
  'file':      'Local File',
};
