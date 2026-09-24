/**
 * Deterministic generator for a data-integration pipeline's ObjectScript
 * classes. Given an IntegrationDefinition (the deploy payload + the discovered
 * key index), it produces the request message, DTL, BPL process, and (for
 * file-family adapters) the Business Service — all as ready-to-compile `.cls`
 * text, WITHOUT any LLM authoring.
 *
 * Every template here was compile-verified against IRIS 2025.3 and a real
 * SC.Data.* target class. The whole point of this module is that the assistant
 * never hand-writes the class structure — so the recurring failures (a stray
 * Storage block, %CSV.Reader, a <call> to the DTL, an undeclared context
 * property, create="new") cannot happen.
 */

import type {
  IntegrationDefinition,
  IntegrationService,
  FieldMapping,
  SourceTypeToken,
  TransformFn,
} from './integration-definition.model.js';

/** Package every generated class lives under, keyed by the integration id. */
export function integrationPackage(id: string): string {
  return `SC.Workbench.Integration${id}`;
}

/** The four fully-qualified class names for an integration. */
export interface IntegrationClassNames {
  requestClass: string;
  dtlClass: string;
  bpConfigName: string;
  bsConfigName: string;
}

/**
 * Derive the class names from id + a sanitized IntegrationName. `bpConfigName`
 * and `bsConfigName` double as the production config-item names.
 */
export function integrationClassNames(id: string, integrationName: string): IntegrationClassNames {
  const pkg = integrationPackage(id);
  const nm = integrationName;
  return {
    requestClass: `${pkg}.Message.${nm}Request`,
    dtlClass: `${pkg}.DTL.${nm}Transformation`,
    bpConfigName: `${pkg}.BP.${nm}Process`,
    bsConfigName: `${pkg}.BS.${nm}Service`,
  };
}

/**
 * Sanitize a user integration name into a legal ObjectScript class-name segment:
 * keep letters/digits, drop everything else, ensure it starts with a letter.
 * "ERP Orders" → "ERPOrders"; "3-way" → "P3way". Empty → "Integration".
 */
export function sanitizeIntegrationName(name: string): string {
  const cleaned = (name || '').replace(/[^A-Za-z0-9]/g, '');
  if (!cleaned) return 'Integration';
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `P${cleaned}`;
}

/** A legal ObjectScript identifier (for property names, class segments). */
function isIdentifier(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(s);
}

/** Source-type token → IRIS property type. */
const TYPE_MAP: Record<SourceTypeToken, string> = {
  string: '%String',
  integer: '%Integer',
  decimal: '%Decimal',
  boolean: '%Boolean',
  date: '%Date',
  datetime: '%TimeStamp',
  time: '%Time',
  stream: '%Stream.GlobalCharacter',
};

/** The transform functions we can emit, and how many positional args each takes. */
const TRANSFORM_ARITY: Record<Exclude<TransformFn, ''>, string[]> = {
  ToUpper: [],
  ToLower: [],
  Length: [],
  SubString: ['start', 'end'],
  ReplaceStr: ['old', 'new'],
  Strip: ['mask', 'chars'],
  Pad: ['length', 'char'],
  ConvertDateTime: ['inFmt', 'outFmt'],
  Piece: ['delim', 'from', 'to'],
  Lookup: ['table', 'key'],
};

/**
 * Validate the definition before generating. Returns human-readable problems
 * (empty = valid). Fails fast on the things that would otherwise produce a
 * broken class or a silently-wrong pipeline.
 */
export function validateIntegrationDefinition(def: IntegrationDefinition): string[] {
  const problems: string[] = [];

  if (!def.id?.toString().trim()) problems.push('id is required.');
  else if (!/^[A-Za-z0-9]+$/.test(String(def.id))) {
    problems.push(`id "${def.id}" must be alphanumeric (it becomes part of the class package).`);
  }
  if (!def.name?.trim()) problems.push('name is required.');
  if (!def.process?.targetClass?.trim()) problems.push('process.targetClass is required.');
  else if (!def.process.targetClass.includes('.')) {
    problems.push(`process.targetClass "${def.process.targetClass}" must be a fully-qualified class name.`);
  }

  const mappings = def.process?.mappings ?? [];
  if (!mappings.length) problems.push('process.mappings must have at least one mapped field.');

  const seenProps = new Set<string>();
  for (const [i, m] of mappings.entries()) {
    const where = `mappings[${i}]`;
    if (!m.sourceField?.trim()) problems.push(`${where}: sourceField is required.`);
    else if (!isIdentifier(m.sourceField.trim())) {
      // The source field becomes a request-message property name.
      problems.push(
        `${where}: sourceField "${m.sourceField}" is not a legal property name (letters/digits, start with a letter).`,
      );
    } else if (seenProps.has(m.sourceField.trim())) {
      problems.push(`${where}: duplicate sourceField "${m.sourceField}".`);
    } else {
      seenProps.add(m.sourceField.trim());
    }
    if (!m.targetProperty?.trim()) problems.push(`${where}: targetProperty is required.`);
    if (m.sourceType && !(m.sourceType in TYPE_MAP)) {
      problems.push(`${where}: unknown sourceType "${m.sourceType}".`);
    }
    if (m.transform && !(m.transform in TRANSFORM_ARITY)) {
      problems.push(`${where}: unknown transform "${m.transform}".`);
    }
  }

  // If a key index is claimed, its request property must be one of the mapped fields.
  if (def.keyIndex && def.keyRequestProp) {
    if (!seenProps.has(def.keyRequestProp.trim())) {
      problems.push(
        `keyRequestProp "${def.keyRequestProp}" is not one of the mapped sourceFields — it must carry the key value.`,
      );
    }
  }

  const adapter = def.adapter;
  const svc = def.service ?? {};
  if (adapter === 'File') {
    if (!svc.filePath?.trim()) problems.push('service.filePath is required for a File adapter.');
    if (!svc.fileSpec?.trim()) problems.push('service.fileSpec is required for a File adapter.');
  } else if (adapter === 'FTP' || adapter === 'SFTP') {
    if (!svc.host?.trim()) problems.push(`service.host is required for an ${adapter} adapter.`);
    if (!svc.path?.trim()) problems.push(`service.path is required for an ${adapter} adapter.`);
    if (adapter === 'SFTP' && !svc.credentials?.trim()) {
      problems.push('service.credentials (an SCO credential entry name) is required for SFTP.');
    }
  } else if (adapter === 'Cloud') {
    if (!svc.bucket?.trim()) problems.push('service.bucket is required for a Cloud adapter.');
  } else if (adapter !== 'SQL') {
    problems.push(`Unsupported adapter "${adapter}".`);
  }

  return problems;
}

/** Split a fully-qualified class name into package + short name. */
function splitClass(fqn: string): { pkg: string; short: string } {
  const i = fqn.lastIndexOf('.');
  return { pkg: fqn.slice(0, i), short: fqn.slice(i + 1) };
}

/** Escape a string for a single-quoted DTL/BPL XML attribute value. */
function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Quote an ObjectScript string literal. */
function osStr(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

// ── Request message ────────────────────────────────────────────────

/**
 * Generate the Ens.Request message class: one property per mapped source field,
 * PLUS (for a SQL source) an extra property for the row-tracking key column when
 * it isn't already mapped. The SQL GenericService populates the typed message by
 * matching result-set columns to message properties, so a `KeyFieldName` column
 * that has no matching property would be a column↔property mismatch — this adds
 * the property so the polled key column always has a home (the DTL just never
 * assigns it to the target).
 */
export function generateMessageClass(def: IntegrationDefinition, names: IntegrationClassNames): string {
  const { pkg, short } = splitClass(names.requestClass);
  const propLines = def.process.mappings.map(
    (m) => `Property ${m.sourceField.trim()} As ${TYPE_MAP[m.sourceType ?? 'string']};`,
  );
  const trackingKey = sqlTrackingKeyProperty(def);
  if (trackingKey) {
    // Present so the typed message can carry the polled key; %String is fine — it's
    // never assigned to the target, only used by the adapter for row-tracking.
    propLines.push(`Property ${trackingKey} As %String;`);
  }
  return `Class ${pkg}.${short} Extends Ens.Request
{

${propLines.join('\n\n')}

}
`;
}

// ── DTL ────────────────────────────────────────────────────────────

/** Build the DTL `value` expression for one mapping (applying its transform). */
function dtlValueExpr(m: FieldMapping): string {
  const src = `source.${m.sourceField.trim()}`;
  const fn = m.transform ?? '';
  if (!fn) return src;
  const argNames = TRANSFORM_ARITY[fn];
  const args = argNames.map((k) => {
    const raw = m.transformArgs?.[k] ?? '';
    // Numeric args (positions, lengths) pass bare; everything else is a string literal.
    return /^-?\d+$/.test(raw) ? raw : osStr(raw);
  });
  if (fn === 'Lookup') {
    // Lookup(table, key) — table + key are the two args, source value not implicit.
    return `..Lookup(${args.join(', ')})`;
  }
  return `..${fn}(${[src, ...args].join(', ')})`;
}

/**
 * Generate the DTL. Always `create='existing'` (upsert — the BP hands it the
 * opened-or-new target). One `<assign>` per mapping.
 */
export function generateDtlClass(def: IntegrationDefinition, names: IntegrationClassNames): string {
  const { pkg, short } = splitClass(names.dtlClass);
  const assigns = def.process.mappings
    .map(
      (m) =>
        `<assign value='${xmlAttr(dtlValueExpr(m))}' property='target.${xmlAttr(
          m.targetProperty.trim(),
        )}' action='set' />`,
    )
    .join('\n');
  return `Class ${pkg}.${short} Extends Ens.DataTransformDTL
{

Parameter IGNOREMISSINGSOURCE = 1;

Parameter REPORTERRORS = 1;

XData DTL [ XMLNamespace = "http://www.intersystems.com/dtl" ]
{
<transform sourceClass='${names.requestClass}' targetClass='${def.process.targetClass}' create='existing' language='objectscript' >
${assigns}
</transform>
}

}
`;
}

// ── BPL process ────────────────────────────────────────────────────

/**
 * Generate the BPL process: one `<code>` block that opens-or-news the target by
 * its key index (upsert), runs the DTL classmethod, and %Save()s — with a
 * `<catchall>` that logs and skips a bad record. Never a `<call>`, never a
 * context property, never a Storage block.
 */
export function generateBplClass(def: IntegrationDefinition, names: IntegrationClassNames): string {
  const { pkg, short } = splitClass(names.bpConfigName);
  const targetShort = splitClass(def.process.targetClass).short;

  // Upsert when we have a verified key index + its request property; else insert-only.
  const openLine =
    def.keyIndex && def.keyRequestProp
      ? ` Set tTarget = ##class(${def.process.targetClass}).${def.keyIndex}Open(request.${def.keyRequestProp.trim()})
 If '$IsObject(tTarget) { Set tTarget = ##class(${def.process.targetClass}).%New() }`
      : ` Set tTarget = ##class(${def.process.targetClass}).%New()`;

  return `Class ${pkg}.${short} Extends Ens.BusinessProcessBPL [ ClassType = persistent ]
{

XData BPL [ XMLNamespace = "http://www.intersystems.com/bpl" ]
{
<process language='objectscript' request='${names.requestClass}' height='2000' width='2000' >
<sequence xend='200' yend='400' >
<scope name='Transform and save ${xmlAttr(targetShort)}' xpos='200' ypos='250' >
<code name='Transform and save' xpos='200' ypos='350' >
<![CDATA[
${openLine}
 Set status = ##class(${names.dtlClass}).Transform(request, .tTarget)
 If $$$ISOK(status) { Set status = tTarget.%Save() }
 If $$$ISERR(status) { Throw ##class(%Exception.StatusException).CreateFromStatus(status) }
]]>
</code>
<faulthandlers>
<catchall xpos='200' ypos='450' >
<code name='Log skipped request' xpos='200' ypos='550' >
<![CDATA[
${bplCatchallBody(def)}
]]>
</code>
</catchall>
</faulthandlers>
</scope>
</sequence>
</process>
}

}
`;
}

/**
 * The ObjectScript body of the BPL's `<catchall>` — logs a skipped record. When
 * the target has foreign keys this pipeline writes, and the failure is a `#5829`
 * referential-integrity error, it appends the exact FK column(s) and the request
 * value(s) that had no matching parent row — so the Event Log says WHICH
 * reference is missing (e.g. "primaryLocationId='LOC-99' not found in
 * SC.Data.Location"), not just a generic "Skipped request". Falls back to the
 * plain message for any other error.
 */
function bplCatchallBody(def: IntegrationDefinition): string {
  const fks = def.foreignKeys ?? [];
  if (!fks.length) {
    return ` Do ##class(Ens.Util.Log).LogError($classname(), "OnFailure", "Skipped request - "_$System.Status.GetErrorText(..%Context.%LastError))`;
  }
  // Build the "which field, what value" detail as a SIMPLE ObjectScript concat:
  // `"field="_request.field` fragments joined by `_", "_`. Deliberately NO `[`,
  // `]`, `'`, or `(` `)` literals inside the strings — an earlier version used
  // `[...: 'value']` and the bracket/quote nesting broke OS paren-matching
  // (#1010 "Missing right parenthesis"). Referenced class names are interpolated
  // at generate-time as plain text (dotted alphanumerics — safe in a string).
  const fields = fks.flatMap((fk) => fk.sourceFields.map((f) => f.trim())).filter(Boolean);
  const fieldsExpr = fields.map((f) => `"${f}="_request.${f}`).join('_" "_');
  const refClasses = [...new Set(fks.map((fk) => fk.referencedClass).filter(Boolean))].join(', ');
  return ` Set tErrText = $System.Status.GetErrorText(..%Context.%LastError)
 If tErrText [ "5829" {
   Set tMsg = "Skipped request - FK constraint failed (${refClasses}): "_${fieldsExpr}_" - referenced row must exist first. Original: "_tErrText
   Do ##class(Ens.Util.Log).LogError($classname(), "OnFailure", tMsg)
 } Else {
   Do ##class(Ens.Util.Log).LogError($classname(), "OnFailure", "Skipped request - "_tErrText)
 }`;
}

// ── Business Service (File / FTP / SFTP / Cloud) ────────────────────

const ADAPTER_CLASS: Record<string, string> = {
  File: 'EnsLib.File.InboundAdapter',
  FTP: 'EnsLib.FTP.InboundAdapter',
  SFTP: 'EnsLib.FTP.InboundAdapter',
  Cloud: 'EnsLib.AmazonS3.InboundAdapter',
};

/** The `pInput` stream type for each file-family adapter's OnProcessInput. */
const INPUT_TYPE: Record<string, string> = {
  File: '%FileCharacterStream',
  FTP: '%CharacterStream',
  SFTP: '%CharacterStream',
  Cloud: 'EnsLib.CloudStorage.InboundInput',
};

/** Emit the `OnInit()` adapter-setting lines for a file-family adapter. */
function adapterInitLines(def: IntegrationDefinition): string {
  const s: IntegrationService = def.service ?? {};
  const set = (prop: string, value: string, quote = true) =>
    `    Set ..Adapter.${prop} = ${quote ? osStr(value) : value}`;
  const lines: string[] = [];
  // Two IRIS defaults on the file-family inbound adapters are wrong for a workbench
  // ingest pipeline, so we override them explicitly:
  //
  // 1. DeleteFromServer defaults to 1 (EnsLib.File.InboundAdapter, inherited by
  //    FTP/SFTP): the adapter DELETES the source file after reading it. That
  //    destroys the user's source, and on FTP the next poll re-lists the now-missing
  //    file and logs <Ens>ErrFTPListFailed (550 "No such file"); SFTP deletes
  //    silently. We ingest NON-destructively → DeleteFromServer=0 (mirrors Cloud's
  //    DeleteAfterDownload=0). The adapter's own "done" table (keyed by
  //    filename+modified-timestamp) still suppresses re-processing of an unchanged
  //    file, so leaving it in place is cheap — the next poll just skips it.
  //
  // 2. ConfirmComplete defaults to 1 ("Size" — re-query the file's size and wait for
  //    it to stop growing, to avoid reading a half-written upload). Verified live
  //    that this re-issues a directory LIST via getSize(); on a stock FTP server
  //    (e.g. pyftpdlib) that response comes back as "226 Transfer complete" instead
  //    of a size line, so getSize fails (<Ens>ErrFTPGetSizeFailed) AND the file is
  //    never marked done → the BPL is re-invoked on EVERY poll (repeated upserts).
  //    We drop the size check → ConfirmComplete=0. The BPL upsert is idempotent, so
  //    the rare case of reading a still-uploading file self-heals on the next full
  //    read — far better than re-processing every poll.
  //
  // 3. We do NOT set MLSD (FTP only), and must not. An earlier version set MLSD=1 to
  //    get a machine-readable listing (stable size + timestamp) instead of parsing
  //    `ls -l` text for the dedup key. Verified live against vsftpd 3.0.2 that this
  //    breaks FTP ingestion two ways, so the IRIS default of 0 is the only safe value:
  //      a) `EnsLib.FTP.Common.MLSD` is documented "Not supported by all servers", and
  //         its OnInit hard-fails when the server's FEAT reply has no MLST —
  //         "ERROR #5001: MLSD set but not supported by FTP server." vsftpd, the most
  //         common Linux FTP server, advertises no MLST.
  //      b) The same doc comment: "using this setting will change the File Spec format
  //         to Regex". FileList then filters with `$match(name, wildcards)`, so a
  //         wildcard FileSpec like `*.csv` — which is what the wizard collects and
  //         what every other adapter here takes — is an invalid regex:
  //         "<Ens>ErrFTPRegex: Regex Error: ERROR #8311: Syntax error in regexp
  //         pattern --- With File Spec: '*.csv'".
  //    With MLSD off, FileSpec is passed to the server's own LIST and the dedup key
  //    comes from the listing line. That key is coarser (minute precision, no year),
  //    but ConfirmComplete=0 already marks files done and the BPL upsert is
  //    idempotent, so a re-read costs nothing. SFTP lists via getFileInfo (OnInit
  //    forces unix style, %isSFTP), so MLSD never applied there.
  //
  // 4. We do NOT set RenameFilename. The requirement is to leave the user's source
  //    file EXACTLY as-is (same name, same place) after ingesting it once. An earlier
  //    version renamed the source to "<name>.archive" as a belt-and-suspenders
  //    process-once guard, but that mutates the source (the original filename
  //    disappears), which contradicts the non-destructive requirement — and it is
  //    unreliable anyway: many SFTP/FTP accounts lack rename permission, so the rename
  //    just fails and logs a Warning every poll (observed live: "Failed to rename file
  //    'customers.csv' to 'customers.csv.archive' … SFTP Error '4'"). Crucially, that
  //    same live run PROVED the done-table is sufficient on its own — the very next
  //    poll logged "Skipping previously processed file" even though the rename had
  //    failed. So the once-only guard is DeleteFromServer=0 + a stable dedup key
  //    (ConfirmComplete=0 so the file is marked done, plus MLSD=1 on FTP for a
  //    machine-readable timestamp); no rename needed. Re-uploading a file with the
  //    same name and a newer timestamp is correctly reprocessed, and even if a poll
  //    ever did re-read an unchanged file, the BPL upsert is idempotent (no dup data).
  switch (def.adapter) {
    case 'File':
      lines.push(set('FilePath', s.filePath ?? ''));
      lines.push(set('FileSpec', s.fileSpec ?? ''));
      lines.push(set('DeleteFromServer', '0', false));
      break;
    case 'SFTP':
      lines.push(set('Protocol', 'SFTP'));
      lines.push(set('FTPServer', s.host ?? ''));
      if (s.port) lines.push(set('FTPPort', String(s.port), false));
      lines.push(set('FilePath', s.path ?? ''));
      if (s.credentials) lines.push(set('Credentials', s.credentials));
      if (s.fileSpec) lines.push(set('FileSpec', s.fileSpec));
      if (s.sftpPublicKeyFile) lines.push(set('SFTPPublicKeyFile', s.sftpPublicKeyFile));
      if (s.sftpPrivateKeyFile) lines.push(set('SFTPPrivateKeyFile', s.sftpPrivateKeyFile));
      lines.push(set('DeleteFromServer', '0', false));
      lines.push(set('ConfirmComplete', '0', false));
      break;
    case 'FTP':
      lines.push(set('FTPServer', s.host ?? ''));
      if (s.port) lines.push(set('FTPPort', String(s.port), false));
      lines.push(set('FilePath', s.path ?? ''));
      if (s.credentials) lines.push(set('Credentials', s.credentials));
      if (s.fileSpec) lines.push(set('FileSpec', s.fileSpec));
      lines.push(set('DeleteFromServer', '0', false));
      lines.push(set('ConfirmComplete', '0', false));
      break;
    case 'Cloud':
      lines.push(set('BucketName', s.bucket ?? ''));
      if (s.credentialsFile) lines.push(set('ProviderCredentialsFile', s.credentialsFile));
      if (s.region) lines.push(set('StorageRegion', s.region));
      // BlobNamePrefix filters SERVER-side (an S3 ListObjects key prefix — a
      // "folder", e.g. "Test/"). BlobNamePattern filters CLIENT-side with */?
      // wildcards, and the adapter matches it against the FULL blob key
      // (blobInfo.name, e.g. "Test/locations.csv"), NOT the leaf filename. So to
      // pull exactly one nested object the pattern must be the WHOLE relative key
      // ("Test/locations.csv"), not just "locations.csv" — the frontend builds it
      // that way (see selectCloudCsvFile). We emit these verbatim.
      if (s.blobPrefix) lines.push(set('BlobNamePrefix', s.blobPrefix));
      if (s.blobPattern) lines.push(set('BlobNamePattern', s.blobPattern));
      lines.push(set('DeleteAfterDownload', '0', false));
      break;
  }
  return lines.join('\n');
}

/**
 * Emit the CSV-parse body of OnProcessInput. For Cloud the lines are read from
 * `tContent` (the blob stream); for File/FTP/SFTP straight from `pInput`.
 */
function parseBody(def: IntegrationDefinition, names: IntegrationClassNames): string {
  const mappings = def.process.mappings;
  const readerVar = def.adapter === 'Cloud' ? 'tContent' : 'pInput';
  const cloudPrelude = def.adapter === 'Cloud' ? '        Set tContent = pInput.Content\n' : '';
  // A character stream's default LineTerminator is CR ($C(13)) — so `ReadLine()`
  // on a UNIX (LF-only) CSV never splits and reads the whole file as one "line",
  // gluing the last header cell to the first data row (→ "column X not found in
  // header"). Force LF; the per-line/per-field $ZStrip(...,"<>WC") below then also
  // trims the stray CR from a Windows CRLF file, so this handles LF and CRLF both.
  const lineTermPrelude = `        Set ${readerVar}.LineTerminator = $Char(10)\n`;

  const send = `            Set tSC = ..SendRequestSync(${osStr(names.bpConfigName)}, tRequest, .tResponse)
            Quit:$$$ISERR(tSC)`;

  if (def.process.hasHeader) {
    // Header-lookup variant: build a name→position map from the first line, then
    // read each mapped column by its resolved index (tolerates reordering).
    const headerChecks = mappings
      .map(
        (m) =>
          `                If '$Data(tHeaderMap(${osStr(m.sourceField.trim())})) { Set tSC = $$$ERROR($$$GeneralError, ${osStr(
            `column '${m.sourceField.trim()}' not found in header`,
          )})  Quit }`,
      )
      .join('\n');
    const assigns = mappings
      .map(
        (m) =>
          `            Set tRequest.${m.sourceField.trim()} = $ZStrip($Piece(tLine, ",", tHeaderMap(${osStr(
            m.sourceField.trim(),
          )})), "<>WC")`,
      )
      .join('\n');
    return `${cloudPrelude}${lineTermPrelude}        While '${readerVar}.AtEnd {
            Set tLine = $ZStrip(${readerVar}.ReadLine(), "<>WC")
            Continue:tLine=""
            If '$Data(tHeaderMap) {
                For i=1:1:$Length(tLine, ",") {
                    Set tCol = $ZStrip($Piece(tLine, ",", i), "<>WC")
                    Set:tCol'="" tHeaderMap(tCol) = i
                }
${headerChecks}
                Continue
            }
            Set tRequest = ##class(${names.requestClass}).%New()
${assigns}
${send}
        }`;
  }

  // No-header variant: read each mapped column by its 1-based position.
  const assigns = mappings
    .map(
      (m, idx) =>
        `            Set tRequest.${m.sourceField.trim()} = $ZStrip($Piece(tLine, ",", ${idx + 1}), "<>WC")`,
    )
    .join('\n');
  return `${cloudPrelude}${lineTermPrelude}        While '${readerVar}.AtEnd {
            Set tLine = $ZStrip(${readerVar}.ReadLine(), "<>WC")
            Continue:tLine=""
            Set tRequest = ##class(${names.requestClass}).%New()
${assigns}
${send}
        }`;
}

/**
 * Generate the Business Service class for a file-family adapter. Returns null for
 * SQL (which has no generated class — it's configured via production settings).
 */
export function generateBusinessServiceClass(
  def: IntegrationDefinition,
  names: IntegrationClassNames,
): string | null {
  if (def.adapter === 'SQL') return null;
  const { pkg, short } = splitClass(names.bsConfigName);
  const adapterClass = ADAPTER_CLASS[def.adapter];
  const inputType = INPUT_TYPE[def.adapter];
  const init = adapterInitLines(def);
  const body = parseBody(def, names);

  return `Class ${pkg}.${short} Extends Ens.BusinessService
{

Parameter ADAPTER = "${adapterClass}";

Method OnInit() As %Status
{
${init}
    Quit $$$OK
}

Method OnProcessInput(pInput As ${inputType}, Output pOutput As %RegisteredObject) As %Status
{
    Set tSC = $$$OK
    Set tResponse = ""
    Try {
${body}
        Set:($IsObject(tResponse)) pOutput = tResponse
    } Catch ex {
        Set tSC = ex.AsStatus()
    }
    Quit tSC
}

}
`;
}

/** One generated class: its name and source (source null only for the SQL BS). */
export interface GeneratedClass {
  role: 'message' | 'dtl' | 'bpl' | 'businessService';
  className: string;
  source: string | null;
}

// ── Production config items (what to register, with exact settings) ─────
//
// The registration half is as error-prone as the class source — the invalid
// `TargetConfigName` setting that broke a deploy came from GUESSING a setting
// name. So the generator emits the EXACT `sco_add_config_item` args too; the
// agent just calls the tool with them, never inventing a setting.

/** One production config item to register, matching sco_add_config_item args. */
export interface ConfigItemSpec {
  /** Fully-qualified host class (or pre-built IRIS service class for SQL). */
  className: string;
  /** Config-item name (= className for our hosts; a fixed name for JavaGateway). */
  name: string;
  /** Dedicated pool; always 1 here (a SQL pool > 1 processes rows repeatedly). */
  poolSize: number;
  /** Adapter/host settings to upsert (empty for file-family — baked into OnInit). */
  settings: { name: string; target: 'Adapter' | 'Host'; value: string }[];
  /**
   * Only present for the shared JavaGateway: register it ONLY if a config item of
   * this name isn't already on the production (check with sco_list_config_items).
   */
  reuseIfExists?: boolean;
  /** Human note for the agent's report (what this item is). */
  note: string;
}

/**
 * Decide the SQL GenericService `KeyFieldName` for a definition. Returns the
 * SOURCE table's key column to track rows by, or "" to disable tracking:
 *   - Use `service.keyField` — the source table's primary/unique key, auto-detected
 *     from the source schema. This is INDEPENDENT of the target mapping (the source
 *     key need not map to any target property). Use it only if the polled query
 *     actually selects it (the adapter reads it out of the result set); the query
 *     builder adds the key column to the SELECT precisely so this holds.
 *   - Otherwise return "" (disable row-tracking). NEVER return "ID" implicitly —
 *     the adapter defaults KeyFieldName to "ID", which fails every poll when the
 *     query has no ID column, so we always set it explicitly.
 * A `SELECT *` (no explicit column list) is treated as selecting the key.
 */
function resolveSqlKeyField(def: IntegrationDefinition): string {
  const key = def.service?.keyField?.trim();
  if (!key) return '';
  const query = def.service?.query ?? '';
  return querySelectsColumn(query, key) ? key : '';
}

/**
 * The source key column that the request message must carry a property for, so
 * the SQL GenericService's typed message can hold the polled key value even when
 * it isn't mapped to a target property. Returns "" when there's no usable key or
 * it's already one of the mapped source fields (then it's a property already).
 */
function sqlTrackingKeyProperty(def: IntegrationDefinition): string {
  if (def.adapter !== 'SQL') return '';
  const key = resolveSqlKeyField(def);
  if (!key) return '';
  const mapped = def.process.mappings.some((m) => m.sourceField?.trim().toLowerCase() === key.toLowerCase());
  return mapped ? '' : key;
}

/**
 * Best-effort: does a SELECT query's projection include `column` (case-insensitive)?
 * A `SELECT *` (or a query we can't parse) is treated as including it. Only the
 * text between SELECT and FROM is inspected, split on commas, each piece reduced
 * to its output name (last dotted segment, alias-aware isn't needed for our
 * generated queries which are a plain column list).
 */
function querySelectsColumn(query: string, column: string): boolean {
  const m = /\bselect\b(.*?)\bfrom\b/is.exec(query);
  if (!m) return false;
  const projection = m[1]!.trim();
  if (projection === '*' || projection.includes('*')) return true;
  const cols = projection.split(',').map((c) => {
    const name = c.trim().split(/\s+/)[0]!; // drop any alias
    return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  });
  return cols.includes(column.toLowerCase());
}

/**
 * The ordered plan for registering the pipeline's hosts on the production. ALL
 * are added DISABLED first (the deploy enables them afterward, BP before BS).
 * The order here is the add order.
 *
 * - File/FTP/SFTP/Cloud → [ BP, BS ]. The BS carries NO settings (host/path/
 *   credentials are compiled into its OnInit).
 * - SQL → [ BP, JavaGateway (shared, reuse-if-exists), GenericService (per-pipeline,
 *   full settings) ]. There is no BS class for SQL.
 */
export function generateConfigItems(def: IntegrationDefinition): ConfigItemSpec[] {
  const integrationName = sanitizeIntegrationName(def.name);
  const names = integrationClassNames(String(def.id), integrationName);
  const bp: ConfigItemSpec = {
    className: names.bpConfigName,
    name: names.bpConfigName,
    poolSize: 1,
    settings: [],
    note: 'Business Process (runs the DTL, %Save()s the target). Enable this FIRST.',
  };

  if (def.adapter !== 'SQL') {
    const bs: ConfigItemSpec = {
      className: names.bsConfigName,
      name: names.bsConfigName,
      poolSize: 1,
      // No settings: every connection value is compiled into the BS class OnInit().
      settings: [],
      note: 'Business Service (inbound adapter). Enable this LAST — it starts polling on enable.',
    };
    return [bp, bs];
  }

  // SQL: no BS class — a shared JavaGateway + a per-pipeline GenericService.
  const s = def.service ?? {};
  const gateway: ConfigItemSpec = {
    className: 'EnsLib.JavaGateway.Service',
    name: 'JavaGateway',
    poolSize: 1,
    settings: [{ name: '%gatewayName', target: 'Host', value: '%JDBC Server' }],
    reuseIfExists: true,
    note: 'Shared Java Gateway (one per production). Reuse the existing one if present.',
  };
  // KeyFieldName: the GenericService's inbound adapter uses this column as a
  // high-water mark so it processes each SOURCE row only once. It DEFAULTS TO "ID"
  // — and if the polled query doesn't select an "ID" column, EVERY poll fails with
  // "Key value not found in field 'ID'" (a real deploy hit this after the user
  // removed the ID field from the mapping). So we set it EXPLICITLY:
  //   - to the SOURCE table's key column (`service.keyField`, auto-detected from
  //     the source schema — independent of the target mapping), when the query
  //     selects it (the query builder adds it to the SELECT); else
  //   - to "" (empty) to DISABLE row-tracking. Every poll then re-reads all rows,
  //     which is safe because our BPL upserts by the target's key — re-processing
  //     just re-upserts the same rows, no duplicates. Never leave it defaulting to
  //     "ID" when "ID" isn't a selected column.
  const keyFieldName = resolveSqlKeyField(def);
  // The JDBC driver class follows the SOURCE database (IRIS, PostgreSQL, …). The
  // payload carries it as `service.driverClass`; default to the IRIS driver when
  // absent so an older IRIS-only payload still works.
  const driverClass = s.driverClass?.trim() || 'com.intersystems.jdbc.IRISDriver';
  // For a NON-IRIS source, the workbench stages the driver JAR into IRIS and passes
  // its in-container path as `service.driverClasspath`; it becomes JDBCClasspath so
  // the shared Java Gateway can load the driver. For IRIS the payload omits it (the
  // IRIS driver is always on the gateway's default classpath) → don't set it.
  const driverClasspath = s.driverClasspath?.trim();
  const generic: ConfigItemSpec = {
    className: 'EnsLib.SQL.Service.GenericService',
    name: names.bsConfigName,
    poolSize: 1,
    settings: [
      ...(s.dsn ? [{ name: 'DSN', target: 'Adapter' as const, value: s.dsn }] : []),
      ...(s.query ? [{ name: 'Query', target: 'Adapter' as const, value: s.query }] : []),
      ...(s.credentials ? [{ name: 'Credentials', target: 'Adapter' as const, value: s.credentials }] : []),
      { name: 'JGService', target: 'Adapter', value: 'JavaGateway' },
      // JDBCDriver follows the source DB — never hardcode IRIS (a PostgreSQL source
      // needs org.postgresql.Driver).
      { name: 'JDBCDriver', target: 'Adapter', value: driverClass },
      // JDBCClasspath only when the payload staged a non-IRIS driver JAR.
      ...(driverClasspath ? [{ name: 'JDBCClasspath', target: 'Adapter' as const, value: driverClasspath }] : []),
      // Always set KeyFieldName explicitly (real column or "") — never let it default to "ID".
      { name: 'KeyFieldName', target: 'Adapter', value: keyFieldName },
      { name: 'MessageClass', target: 'Host', value: names.requestClass },
      { name: 'TargetConfigNames', target: 'Host', value: names.bpConfigName },
    ],
    note:
      'Per-pipeline SQL GenericService (polls the query, sends the typed message to the BP). Enable LAST.' +
      (keyFieldName
        ? ` Row-tracking on KeyFieldName="${keyFieldName}".`
        : ' Row-tracking DISABLED (no key column in the query) — the BPL upsert keeps re-polls idempotent.'),
  };
  return [bp, gateway, generic];
}

/**
 * Generate every class for the pipeline, in COMPILE ORDER (message → DTL → BPL →
 * BS). For SQL the businessService entry has `source: null` (no class to
 * compile). The caller compiles each non-null source with sco_compile_class.
 */
export function generateIntegrationClasses(def: IntegrationDefinition): GeneratedClass[] {
  const integrationName = sanitizeIntegrationName(def.name);
  const names = integrationClassNames(String(def.id), integrationName);
  return [
    { role: 'message', className: names.requestClass, source: generateMessageClass(def, names) },
    { role: 'dtl', className: names.dtlClass, source: generateDtlClass(def, names) },
    { role: 'bpl', className: names.bpConfigName, source: generateBplClass(def, names) },
    { role: 'businessService', className: names.bsConfigName, source: generateBusinessServiceClass(def, names) },
  ];
}
