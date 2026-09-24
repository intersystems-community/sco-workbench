# Reference: Business Service (inbound ingestion)

> **In the normal deploy flow you do NOT hand-write this class — `sco_generate_integration_classes` produces it** (the right adapter, `OnInit` settings, and the CSV parse), and it returns the SQL config-item settings too. This reference documents what the tool generates and why. Author by hand only in a rare chat-only exception.


Generate an SCO Business Service (`Ens.BusinessService`) that receives inbound data via an inbound adapter and forwards a typed `requestClass` message to the Business Process (`targetHost = bpConfigName`).

You are generating source only — the pipeline compiles it in Step 7. Do not write files to disk here.

> **All paths below (`FilePath`, `ArchivePath`, `ProviderCredentialsFile`, SFTP key files, etc.) point into the user’s SCO container/host, which you cannot reach.** Take each value exactly as the user gave it and drop it verbatim into the adapter setting — do not try to open, list, `find`, or verify any of these paths locally, and don't hunt for a sample data file to infer columns. If a required value is missing, ask the user; never substitute a guessed or "discovered" path.

## Supported adapters

Only these are covered. If the user needs another (HTTP, REST, TCP, JMS, MQ, MQTT, Email, SOAP), tell them it's not yet supported in the pipeline and stop.

**File, SFTP, FTP, and Cloud ingest a single CSV file only** — CSV is the only supported data format for these adapters, and the flow is built around one CSV source (for Cloud/S3, exactly one CSV object). If the user needs another format (JSON/XML/fixed-width/Excel) or a multi-file batch, say it's not supported yet and stop. (SQL reads a query result set, not a file.)

| Adapter | Adapter class | Notes |
|---|---|---|
| `File` | `EnsLib.File.InboundAdapter` | poll a local directory for one CSV |
| `SFTP` | `EnsLib.FTP.InboundAdapter` | `Protocol="SFTP"`; needs `Credentials` |
| `FTP` | `EnsLib.FTP.InboundAdapter` | credentials optional (anonymous ok) |
| `SQL` | pre-built service class | **no `.cls`** — see the SQL section |
| `Cloud` | `EnsLib.AmazonS3.InboundAdapter` | AWS S3 only |
| `None` | (none) | adapterless push mode; triggered externally |

## Class template (all adapters except SQL)

```objectscript
/// {description}
Class {packageName}.{className} Extends Ens.BusinessService
{

Parameter ADAPTER = "{adapterClass}";

Method OnInit() As %Status
{
{adapterSettingsLines}
    Quit $$$OK
}

Method OnProcessInput(pInput As {pInputType}, Output pOutput As %RegisteredObject) As %Status
{
    Set tSC = $$$OK
    Set tResponse = ""
    Try {
        {onProcessInputBody}
        Set:($IsObject(tResponse)) pOutput = tResponse
    } Catch ex {
        Set tSC = ex.AsStatus()
    }
    Quit tSC
}

}
```

- Omit the `/// ...` line if no description.
- Omit `Parameter ADAPTER` **and** `OnInit()` entirely for `None`.
- `{pInputType}` and the adapter class come from the per-adapter section below.

### Generate the template EXACTLY — do not improvise the BS structure
Use the template above verbatim (fill only the `{…}` placeholders). Do NOT add members it doesn't show. Real deviations that have broken pipelines — avoid every one:
- **No `Parameter INVOCATION`.** Don't add `Parameter INVOCATION = "Queue"` (or `"InProc"`). The default invocation is correct; a wrong one changes threading semantics and isn't needed.
- **No `Property Adapter`.** `Parameter ADAPTER` already gives the service its `..Adapter`. Re-declaring `Property Adapter As …` shadows it and is wrong.
- **No `Storage` block / `XData`.** A Business Service is not persistent; never hand-write a `Storage Default { ... }` block (it causes `#5559`/`#5478` compile errors).
- **No `TargetConfigName`/`TargetConfigNames` — not on the class, not as a production config-item setting.** A file/FTP/SFTP/cloud Business Service routes by the **hardcoded `bpConfigName` string** you pass to `SendRequestSync/Async(...)` in `OnProcessInput` (below) — NOT via a `TargetConfigName(s)` setting. `Ens.BusinessService` has no such setting, so registering it makes the production log `ERROR <Ens>ErrProductionSettingInvalid: Production setting 'TargetConfigName' … is invalid`. (Only the SQL GenericService uses `TargetConfigNames`, and only because it's a pre-built host with no `OnProcessInput` — see the SQL section.)
- **Parse the CSV with `$ZStrip` + `$Piece` as shown in `{onProcessInputBody}` below.** Do NOT invent or use a CSV helper class: **`%CSV.Reader` does NOT exist in this SCO instance** — referencing it compiles but then fails at RUNTIME with `<CLASS DOES NOT EXIST> … *%CSV.Reader`, so the service errors on the first file and never ingests. Also do not substitute `$ListFromString(tLine, ",")` (it doesn't trim fields and mishandles quoting/trailing CR). Read the stream line-by-line with `pInput.ReadLine()` and split with `$Piece`, exactly as the parse blocks below show.
- Keep `OnProcessInput`'s signature and Try/Catch/`Quit tSC` exactly as templated; put only the parse+send logic in `{onProcessInputBody}`.

### A complete, compile-tested File Business Service (copy this shape)
This exact shape (header-row CSV → typed request → BP) was compiled and run against a real target class on a live SCO instance. Match it — only the class name, message class, `bpConfigName`, adapter path/spec, and the per-column `$Piece` assigns change.

```objectscript
Class SC.Workbench.Integration{id}.BS.{IntegrationName}Service Extends Ens.BusinessService
{

Parameter ADAPTER = "EnsLib.File.InboundAdapter";

Method OnInit() As %Status
{
    Set ..Adapter.FilePath = "{filePath}"
    Set ..Adapter.FileSpec = "{fileSpec}"
    Set ..Adapter.DeleteFromServer = 0
    Quit $$$OK
}

Method OnProcessInput(pInput As %FileCharacterStream, Output pOutput As %RegisteredObject) As %Status
{
    Set tSC = $$$OK
    Set tResponse = ""
    Try {
        Set tHeaderDone = 0
        While 'pInput.AtEnd {
            Set tLine = $ZStrip(pInput.ReadLine(), "<>WC")
            Continue:tLine=""
            // Skip exactly one header line (hasHeader=true). For hasHeader=false, delete these two lines.
            If 'tHeaderDone { Set tHeaderDone = 1  Continue }
            Set tRequest = ##class(SC.Workbench.Integration{id}.Message.{IntegrationName}Request).%New()
            Set tRequest.{prop1} = $ZStrip($Piece(tLine, ",", 1), "<>WC")
            Set tRequest.{prop2} = $ZStrip($Piece(tLine, ",", 2), "<>WC")
            // … one assign per MAPPED column, at its 1-based position …
            Set tSC = ..SendRequestSync("SC.Workbench.Integration{id}.BP.{IntegrationName}Process", tRequest, .tResponse)
            Quit:$$$ISERR(tSC)
        }
        Set:($IsObject(tResponse)) pOutput = tResponse
    } Catch ex {
        Set tSC = ex.AsStatus()
    }
    Quit tSC
}

}
```
The message-property names are the SOURCE field names from `process.mappings[]` (the DTL maps them onto the target). Map only the mapped columns; a `$Piece` position that isn't mapped is simply never read. For a header file where columns may be reordered, use the header-lookup variant below instead of fixed positions.

## `{adapterSettingsLines}` — the `OnInit()` body

**Connection settings belong HERE, in the generated class's `OnInit()` — never as ad-hoc `settings` on the production config item (Step 8).** The config item for a non-SQL adapter is registered with `{ className, name }` only. Setting names must be the adapter's **exact property names**: a wrong name FAILS COMPILATION (so you catch it here), whereas the same wrong name pushed onto a config item is silently dropped at runtime and the adapter falls back to a default (e.g. plain FTP on port 21) with a misleading connect error. (SQL is the sole exception — it has no generated class, so its settings live on the config item; see Step 8.)

Emit `Set ..Adapter.X = Y` only for values the user confirmed. String values quoted; numbers/booleans unquoted. For a missing **[REQUIRED]** value, don't fabricate a default — either re-prompt or emit a `// TODO:` line and warn the user the adapter won't work without it. For a missing **[OPTIONAL]** value, emit nothing.

### Process once, keep the source (the retention default for this pipeline)

This pipeline **ingests each source file/blob exactly once and leaves the original in place** — it never deletes or moves the user's source. Every non-SQL adapter must therefore turn OFF the adapter's delete-after-processing behavior, whose **adapter class default is ON (delete)**. Always emit the retention line for the adapter (`DeleteFromServer = 0` for File/FTP/SFTP, `DeleteAfterDownload = 0` for Cloud) — do not rely on the default, and do not omit it.

**How "process once" still works when the file stays.** Deletion is not what prevents reprocessing — a persistent dedup table does, independently of the delete flag:
- **File / FTP / SFTP** record each processed file in a persistent "done" table (`^Ens.AppData` via `EnsStaticAppData`), keyed by **filename + last-modified timestamp**. On every poll the adapter skips a file whose stored timestamp still matches, logging `Skipping previously processed file`.
- **Cloud / S3** record each blob in a state global keyed by **bucket + blob name + updateTime**, marked `SUCCEEDED`; matching entries are skipped on later polls.

So with the delete flag off, the source stays and is read once, not on a loop.

**Re-uploading a file with the same name DOES reprocess it — this is intended.** The dedup key includes the modified timestamp (File/FTP) or `updateTime` (Cloud). If the user deletes the original and drops in a new file with the same name, it has a new timestamp, so it no longer matches the done-table entry and the adapter processes it as fresh content. That is the desired "pick up the updated file" behavior — same name + same timestamp is skipped; same name + newer timestamp is reprocessed. (The done-table entry for a name is also cleared once that name disappears from a listing, so a later same-named file is unambiguously treated as new.)

**Never emit a path/rename setting that moves the source out of place.** For the keep-in-place flow, do NOT set `WorkPath`, `ArchivePath` (File/FTP/SFTP), `ArchiveBucket`, or `RenameFilename` unless the user explicitly asks to move or archive the source — `WorkPath` and archiving/renaming relocate or rename the original (and `WorkPath` even overrides `DeleteFromServer`), which defeats "leave the source in place."

> **One residual case for File/FTP/SFTP (not Cloud):** with `DeleteFromServer = 0`, SCO may still delete the source file **when the corresponding interoperability message is purged** (per the adapter's own property doc). If the user needs the source to be *truly* never removed, the source directory/credentials must lack delete permission for the SCO/FTP account — there is no adapter setting that suppresses the purge-time delete. Cloud/S3 has no such behavior: `DeleteAfterDownload = 0` keeps the blob unconditionally.

**File** (`EnsLib.File.InboundAdapter`, `pInput As %FileCharacterStream`; `%FileBinaryStream` when `Charset=Binary`)
```objectscript
    Set ..Adapter.FilePath = "{path}"           // [REQUIRED] e.g. /data/inbox/
    Set ..Adapter.FileSpec = "{fileSpec}"        // [REQUIRED] e.g. *.csv — adapter won't poll if empty
    Set ..Adapter.DeleteFromServer = 0           // [REQUIRED] 0 = keep the source file, process once (see "Process once, keep the source" below). Adapter default is 1 (delete) — always emit this line.
    Set ..Adapter.CallInterval = {interval}      // optional, seconds (default 5)
    // Do NOT emit WorkPath or ArchivePath for the keep-in-place flow — either one MOVES the file out of FilePath (WorkPath also overrides DeleteFromServer). Omit both unless the user explicitly asks to move/archive the file.
```

**SFTP** (`EnsLib.FTP.InboundAdapter`, `pInput As %CharacterStream`; `%BinaryStream` when `Charset=Binary`)
```objectscript
    Set ..Adapter.Protocol = "SFTP"              // always first — enables SFTP mode
    Set ..Adapter.FTPServer = "{server}"         // [REQUIRED]
    Set ..Adapter.FTPPort = {port}               // [REQUIRED] default 22
    Set ..Adapter.FilePath = "{path}"            // [REQUIRED]
    Set ..Adapter.Credentials = "{credentials}"  // [REQUIRED] SCO credential ENTRY name — holds the SSH username (+ passphrase). Must already exist in SCO.
    Set ..Adapter.FileSpec = "{fileSpec}"        // [REQUIRED] e.g. *.csv
    Set ..Adapter.DeleteFromServer = 0           // [REQUIRED] 0 = keep the file on the server, process once (see "Process once, keep the source" below). Adapter default is 1 (delete) — always emit this line.
    Set ..Adapter.SFTPPublicKeyFile = "{publicKeyFile}"    // for key-pair auth, if the user gave a public key file
    Set ..Adapter.SFTPPrivateKeyFile = "{privateKeyFile}"  // for key-pair auth, if the user gave a private key file
    Set ..Adapter.CallInterval = {interval}      // optional, seconds
    // Do NOT emit ArchivePath for the keep-in-place flow (it writes a local SCO copy). Omit unless the user asks to archive.
    // NOTE: there is NO ..Adapter.Username setting — the SSH username is part of the Credentials ENTRY,
    //       not an adapter property. Never emit ..Adapter.Username (SCO rejects it as an invalid setting).
    //       The property names above (SFTPPublicKeyFile / SFTPPrivateKeyFile) are exact — NOT PublicKeyFile / PrivateKeyFile / Port.
```

**FTP** (`EnsLib.FTP.InboundAdapter`, same `pInput` as SFTP)
```objectscript
    Set ..Adapter.FTPServer = "{server}"         // [REQUIRED]
    Set ..Adapter.FTPPort = {port}               // [REQUIRED] default 21
    Set ..Adapter.FilePath = "{path}"            // [REQUIRED]
    Set ..Adapter.Credentials = "{credentials}"  // optional (anonymous FTP needs none)
    Set ..Adapter.FileSpec = "{fileSpec}"        // optional
    Set ..Adapter.DeleteFromServer = 0           // [REQUIRED] 0 = keep the file on the server, process once (see "Process once, keep the source" below). Adapter default is 1 (delete) — always emit this line.
    Set ..Adapter.CallInterval = {interval}      // optional, seconds
    // FTP has NO WorkPath. Do NOT emit ArchivePath (local SCO copy) or RenameFilename for the keep-in-place flow.
```

**Cloud / AWS S3** (`EnsLib.AmazonS3.InboundAdapter`, `pInput As EnsLib.CloudStorage.InboundInput`; content in `pInput.Content`)
```objectscript
    Set ..Adapter.BucketName = "{bucketName}"                            // [REQUIRED], must exist & be READABLE (writable only if you delete — see below)
    Set ..Adapter.ProviderCredentialsFile = "{providerCredentialsFile}" // [REQUIRED]
    Set ..Adapter.StorageRegion = "{storageRegion}"                     // [REQUIRED], e.g. us-east-1
    Set ..Adapter.BlobNamePrefix = "{blobNamePrefix}"                   // server-side key-prefix filter (a "folder", e.g. "Test/"); "" = whole bucket. See below.
    Set ..Adapter.BlobNamePattern = "{blobNamePattern}"                 // [REQUIRED] client-side */? wildcard filter matched against the FULL blob key. See below.
    Set ..Adapter.DeleteAfterDownload = 0                               // [REQUIRED] 0 = keep the blob in the bucket, process once (see "Process once, keep the source" below). Adapter default is 1 (delete) — always emit 0 for the keep-in-place flow.
    Set ..Adapter.CallInterval = {interval}                             // optional, seconds (default 60)
```
> Only AWS S3 is supported. If the user says GCP/Azure, say it's not yet available and stop.
> **`BlobNamePrefix` vs `BlobNamePattern` — they are NOT "folder path" + "file name".** They work together to select blobs, and the pattern matches the **full blob key**, not the leaf name:
> - `BlobNamePrefix` filters **server-side** — an S3 `ListObjects` key prefix, exactly like a directory. `"Test/"` returns every blob whose key starts with `Test/`; `""` (empty) lists the whole bucket. `SubdirectoryLevels` defaults to `-1` (search all depths), so a prefix alone can still return nested blobs.
> - `BlobNamePattern` then filters that list **client-side** with `*` and `?` wildcards, and the adapter matches it against the blob's **FULL key** (`blobInfo.name`, e.g. `Test/locations.csv`) — NOT the filename under the prefix. So a bare `locations.csv` pattern will NOT match the blob `Test/locations.csv`.
> - **To pull exactly ONE file, set `BlobNamePattern` to the whole relative key** (no wildcards), and `BlobNamePrefix` to its folder:
>   - blob `customers.csv` at the bucket root → `BlobNamePrefix=""` (omit), `BlobNamePattern="customers.csv"`.
>   - blob `Test/locations.csv` → `BlobNamePrefix="Test/"`, `BlobNamePattern="Test/locations.csv"` (NOT `"locations.csv"` — that matches nothing).
> - The Workbench wizard builds `blobPattern` as the full relative key for the object the user picks, so the generated `OnInit` is correct; when hand-writing one, follow the same rule.
> **`DeleteAfterDownload`: the adapter class default is `1` (delete each blob after download) — always emit `0`** to keep the blob and let the state global (below) prevent reprocessing. With `0`, the bucket only needs to be **readable**: `OnInit` skips its is-writable check when the flag is off, so a read-only bucket is fine (with `1` the bucket must be writable or the service fails at startup).

**None** — omit `OnInit()`; `pInput As %RegisteredObject`; the service is driven by an external `ProcessInput()` call.

**Credentials check (SFTP, or FTP when credentials given):** after the user names a `Credentials` entry, ask if it already exists in SCO. If not, it must be created in the Management Portal (Production Credentials) before the service can connect — note this in the final report rather than assuming it exists.

## `{onProcessInputBody}` — parse input, send the typed request

Read the inbound data, populate a `requestClass` message (its properties come from the field mappings — see message.md), and forward it to the BP. Use `requestClass` as an existing class name (the pipeline generated it in Step 3) — do not generate a differently-named message here. Every field you read must be a real property on `pInput`; if the user didn't give explicit parse mappings, emit `// TODO:` lines showing the correct access pattern rather than inventing fields.

**File / SFTP / FTP** — stream input, CSV read line-by-line. Which variant you generate depends on whether the source file has a header row (Step 1's `headerRow` / the payload's `process.hasHeader`). Both use the same `$ZStrip(...,"<>WC")` cleaning (see the warning below) and pick columns individually, so **non-contiguous / ignored columns need no special handling** — a column you don't map is simply never read.

**Partial field mapping is expected — map only the fields the user chose.** The payload's `process.mappings[]` already contains **only the source fields the user mapped** (the wizard's ✕ button removes a row, and any row left without a target property is dropped from the payload). Do not try to map every column in the CSV — generate a request-message property, a parse/read line, and a DTL assign **only** for each entry in `mappings[]`. Unmapped source columns are simply never read (the parse logic picks fields individually, so gaps and reordering are fine). Never invent a mapping for a column the payload didn't include, and never require the user to map all columns.

**No header row — map by position.** The request properties are `Column{n}` (one-based, per message.md); read each with `$Piece` at that same position (index maps 1:1 since both are one-based):
```objectscript
    While 'pInput.AtEnd {
        // $ZStrip(...,"<>WC") strips leading/trailing Whitespace AND Control
        // characters — a trailing CR (Windows CRLF), stray LF, tab, NBSP, null,
        // etc. ReadLine() leaves any such junk on the LAST field, and it silently
        // breaks exact-match logic downstream (see the warning below). Clean the
        // whole line first, then clean EACH field before you use it.
        Set tLine = $ZStrip(pInput.ReadLine(), "<>WC")
        Continue:tLine=""
        Set tRequest = ##class({requestClass}).%New()
        // Map columns per the field mappings, trimming each field the same way so
        // no stray whitespace/control char rides along (e.g. "Best Buy " → "Best Buy"):
        //   Set tRequest.Column1 = $ZStrip($Piece(tLine, ",", 1), "<>WC")
        //   Set tRequest.Column3 = $ZStrip($Piece(tLine, ",", 3), "<>WC")
        Set tSC = ..SendRequestSync("{bpConfigName}", tRequest, .tResponse)
        Quit:$$$ISERR(tSC)
    }
```

**Has header row — map by column name.** The request properties are the header names verbatim (per message.md), but the file is still read positionally — so resolve each mapped property name to its column position **from the actual header line** before reading any data. This keeps the mapping correct even if columns are reordered, and consumes the header so it's never sent as a data row. Build a name→position lookup from the first non-blank line, **error loud** if any mapped column is absent from the header, then for every data row fetch each property by its stored index. The `a`/`c` lines below are an **example** — at generation time, replace them with the user's mapped columns:
```objectscript
    While 'pInput.AtEnd {
        Set tLine = $ZStrip(pInput.ReadLine(), "<>WC")
        Continue:tLine=""

        // tHeaderMap is a local array used as a lookup table: header column name -> its
        // 1-based position in the row (e.g. tHeaderMap("a")=1 means column "a" is field 1).
        // It's empty until we've read the header, so the FIRST non-blank line fills it
        // and is then skipped (Continue) — the header must never become a data record.
        If '$Data(tHeaderMap) {
            For i = 1:1:$Length(tLine, ",") {
                Set tColName = $ZStrip($Piece(tLine, ",", i), "<>WC")
                Set:tColName'="" tHeaderMap(tColName) = i
            }
            // Fail loud if a mapped column name isn't present in the header, rather than
            // silently reading the wrong/empty field. Emit ONE check per mapped column
            // (below is the example for columns "a" and "c"):
            If '$Data(tHeaderMap("a")) { Set tSC = $$$ERROR($$$GeneralError, "column 'a' not found in header")  Quit }
            If '$Data(tHeaderMap("c")) { Set tSC = $$$ERROR($$$GeneralError, "column 'c' not found in header")  Quit }
            Continue
        }

        // Data row: for each mapped property, look up its column index in tHeaderMap,
        // read the field at that index with $Piece, trim it, and assign it.
        Set tRequest = ##class({requestClass}).%New()
        Set tRequest.a = $ZStrip($Piece(tLine, ",", tHeaderMap("a")), "<>WC")
        Set tRequest.c = $ZStrip($Piece(tLine, ",", tHeaderMap("c")), "<>WC")

        Set tSC = ..SendRequestSync("{bpConfigName}", tRequest, .tResponse)
        Quit:$$$ISERR(tSC)
    }
```
(For a whole-file read instead of per-line, use `pInput.Read()`. `pInput.Attributes("Filename")` has the source filename.)

> **Always strip trailing junk and trim fields when parsing delimited text.** A CRLF-terminated file
> leaves a carriage return on the final column of every row; files can also carry stray tabs, a BOM,
> non-breaking spaces, or leading/trailing spaces on any field. These invisible characters don't just
> look wrong — they break exact-match operations. The worst case is a value bound for a **foreign-key**
> property (a location/customer id): `"LOC-1"_$Char(13)` won't match the `"LOC-1"` key in the referenced
> index, so `%Save()` fails with `#5829 Foreign Key constraint ... failed referential integrity check`
> even though the referenced row clearly exists — and the record is silently skipped. `$ZStrip` with the
> `"<>WC"` mask (trim both ends, Whitespace + Control chars) on the line AND on every field used as a
> key, id, or FK removes the whole class of problem in one call — don't hand-strip only `$Char(13)`.

**Cloud** — blob name in `pInput.Name`, content stream in `pInput.Content`:
```objectscript
    Set tContent = pInput.Content
    Set tRequest = ##class({requestClass}).%New()
    // read tContent and populate tRequest per the field mappings
    Set tSC = ..SendRequestSync("{bpConfigName}", tRequest, .tResponse)
```
> The blob is a single CSV object. Parse `tContent` line-by-line using the same header/index logic as File/SFTP/FTP above (build `tHeaderMap` when there's a header, or read `Column{n}` positionally when there isn't) — the only difference is you read lines from `tContent` instead of `pInput`. Map only the fields in `process.mappings[]` (partial mapping), same as the other file adapters.

**None** — the caller passes the object into `ProcessInput()`:
```objectscript
    Set tRequest = ##class({requestClass}).%New()
    // cast/copy pInput into tRequest per the field mappings
    Set tSC = ..SendRequestSync("{bpConfigName}", tRequest, .tResponse)
```

Use `Try/Catch` with `ex.AsStatus()` (already in the template) — never `$ZT`.

## SQL adapter (no `.cls` generated)

The SQL path uses a **pre-built SCO service class** configured entirely through production config-item settings — there is no custom class to generate or compile, and no `OnProcessInput` to write. Two production hosts are involved: a **shared Java Gateway** (one per production, reused by every SQL pipeline) and a **per-pipeline GenericService** (one for each SQL pipeline). Both are configured with the `sco_add_config_item` tool over the Native SDK — **not** the docker-exec / `irissession` approach from the original reference, which does not apply here.

We support only the **SELECT-query / query-type** style (`EnsLib.SQL.Service.GenericService`). We do NOT support function-type stored procedures / `EnsLib.SQL.Service.ProcService` — if the user needs that, say it's not supported yet and stop.

Only a **subset of the reference's settings** matters for us; ignore the rest:

### The shared Java Gateway (one per production)
`EnsLib.JavaGateway.Service` provides the JDBC bridge every SQL GenericService needs. **Exactly one** is needed across all SQL pipelines — reuse it, don't add a second.
- Config item name: **`JavaGateway`** (fixed — so every pipeline finds the same one).
- Class: `EnsLib.JavaGateway.Service`; one setting `%gatewayName` (target `Host`) = `%JDBC Server`; `PoolSize` = 1.
- **Before adding it, check whether it already exists** with `sco_list_config_items` — if an item named `JavaGateway` (class `EnsLib.JavaGateway.Service`) is already on the production, reuse it and skip the add. `sco_add_config_item` upserts by name, so a redundant add is harmless, but the point is you only ever need one.

### The per-pipeline GenericService (one per SQL pipeline)
- Config item name = `bsConfigName` (the pipeline's own Business Service name, e.g. `SC.Workbench.Integration{id}.BS.CustomerService`) — this is what makes it per-pipeline and unique. Class: `EnsLib.SQL.Service.GenericService`.
- **`PoolSize` = 1** — a larger pool processes rows multiple times.
- Settings (only these; all target `Adapter` except the two host settings noted):
  - `DSN` — JDBC URL. Its shape follows the source database, e.g. `jdbc:IRIS://host:1972/namespace` for IRIS or `jdbc:postgresql://host:5432/database` for PostgreSQL. Use the DSN from the payload verbatim. **[required]**
  - `Query` — the SELECT statement to poll. Its selected **columns must be exactly the mapped source fields** (the typed message's properties), in the same names — use the explicit column list from the payload, e.g. `SELECT city, country, uid FROM orders`. **Never poll with `SELECT *`**: it returns unmapped columns (e.g. an `ID` key) that break the MessageClass column↔property match. If the payload's query is a `SELECT *`, rewrite it to the explicit mapped-column list; if a mapped column isn't a real table column, tell the user and stop. **PostgreSQL text / unbounded-`varchar` columns must be `CAST(col AS VARCHAR(32700)) AS col`** — such a column reports a length of ~2.1 billion, so SCO reads it as a LOB via `getClob()`, but the PostgreSQL driver has no CLOB and fails with `Bad value for type long`; the CAST reports a small length so it's read as a plain string (32700 stays under SCO’s default `MaxVarCharLengthAsString` of 32767, so no adapter reconfiguration is needed). The workbench UI already emits this cast in the payload query for PostgreSQL sources — keep it; don't strip it back to the bare column. **[required]**
  - `Credentials` — SCO credential entry name. The workbench creates this entry (from a generated name + the user's username/password) BEFORE the agent runs, and passes only the NAME in the payload's `service.credentials`; set it verbatim. Do not expect a username/password in the payload, and do not try to create the credential yourself. **[required]**
  - `JGService` = `JavaGateway` (the shared gateway's config name).
  - `JDBCDriver` = the payload's `service.driverClass` — the JDBC driver class for the source database (e.g. `com.intersystems.jdbc.IRISDriver` for IRIS, `org.postgresql.Driver` for PostgreSQL). Set it from the payload; **do NOT hardcode the IRIS driver**. (Absent → defaults to the IRIS driver for back-compat.) **[required]**
  - `JDBCClasspath` = the payload's `service.driverClasspath`, **only when the payload provides it**. It's the in-container path of the driver JAR the workbench staged into SCO before this run so the Java Gateway can load a non-IRIS driver (e.g. PostgreSQL). For an IRIS source the payload omits it (the IRIS driver is always on the gateway's default classpath) — in that case do NOT set `JDBCClasspath` at all.
  - `MessageClass` (target `Host`) = `requestClass` — sends the typed message instead of the untyped `Ens.StreamContainer` JSON. `requestClass` property names must exactly match the query's selected **columns**; if they can't, tell the user and stop rather than silently falling back to untyped.
  - `TargetConfigNames` (target `Host`) = `bpConfigName` — the BP that receives each row. SQL wires via `TargetConfigNames`, **not** `targetHost`.
  - `KeyFieldName` (target `Adapter`) — **ALWAYS set this explicitly; never leave it unset.** The inbound adapter uses it as a high-water mark to process each **source** row only once, and it **defaults to `"ID"`**. If the polled query doesn't select an `ID` column, EVERY poll fails with `Key value not found in field 'ID'` and nothing ingests (a real deploy hit this after the user dropped the `ID` field). The value is the **source table's own primary/unique key column**, auto-detected from the source schema (`service.keyField` in the payload) — it is INDEPENDENT of the target mapping (the source key need not map to any target property; the target generates its own key). The query builder adds that key column to the SELECT so it's in the result set, and the request message carries a property for it (even if unmapped) so the typed message can hold it. If no single source key is detected, `KeyFieldName` is set to an **empty string** to disable row-tracking — safe because the BPL upserts by the target's key, so re-reading rows each poll just re-upserts them (no duplicates). The generator computes all of this for you.
  - `CallInterval` (target `Adapter`) — optional poll interval in seconds.
- Ignore all other reference settings (DeleteQuery, Parameters, StayConnected, ConnectTimeout, etc.) — we don't collect or set them.

For SQL, Step 7 (compile) skips the BS (nothing to compile — it's a pre-built class). Registration happens in Step 8 with `sco_add_config_item`: add/reuse the shared `JavaGateway`, then add the GenericService (named `bsConfigName`) with the settings above. Return the fully-qualified `bsConfigName` + its settings to the pipeline.
