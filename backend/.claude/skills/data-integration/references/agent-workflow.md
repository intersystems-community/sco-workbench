# Agent-mode data-integration workflow (build the pipeline in SCO)

You are in **Agent mode** — the worker. You automate the end-to-end creation of an SCO Interoperability flow that ingests external data and maps it onto an **existing** SCO persistent class. Generating the flow means generating four components that must agree on a set of shared names — the whole value is threading those names through consistently so the pieces wire together:

```
create request message ──► Business Service ──► DTL transform ──► BPL process
   (typed request)           (ingests data)       (field mapping)   (runs DTL, %Save()s target)
```

## Do NOT hand-write the pipeline classes — the backend generates them deterministically

**The four component classes (request message, DTL, BPL, Business Service) are generated for you by `sco_generate_integration_classes`. You do NOT author their ObjectScript.** This is deliberate: hand-authored classes repeatedly shipped subtle, compile-passing-but-runtime-fatal bugs (a stray `Storage` block, `%CSV.Reader` which doesn't exist, a `<call>` to the DTL, an undeclared `context` property, `create="new"`, a guessed `TargetConfigName` setting). The generator owns the class structure and the production config-item settings, all compile-tested — so those whole classes of bug cannot happen.

Your job in Agent mode is to drive the sequence: give the generator the deploy payload, then compile the returned sources, register the returned config items, and enable them. You call:
- `sco_generate_integration_classes` — **read-only**; resolves the target class, finds its key index, and returns the class sources (in compile order) + the production config-item specs (in add order). This replaces reading the per-component reference files and writing `.cls` by hand.
- **compile-class** skill / `sco_compile_class` — compile each returned class source in the order given.
- **manage-production** skill / `sco_add_config_item` / `sco_enable_config_item` — register the returned config items (disabled), then enable them.

The per-component reference files ([message.md](references/message.md), [business-service.md](references/business-service.md), [dtl.md](references/dtl.md), [bpl.md](references/bpl.md)) document what the generator produces and WHY — read them only if you need to explain a class to the user or debug a genuine generator gap. **In the normal deploy flow you never write these classes yourself.** If a chat-only flow ever needs a class the generator can't produce, that's the rare exception where you'd consult a reference and hand-author — but for any pipeline described by a deploy payload, use the generator.

## Paths and data files live in the user's SCO environment — never read them yourself
Every file path in this flow (a File adapter's poll directory, an SFTP/FTP drop, an S3 key, an SSH key file, a sample CSV the user mentions) refers to the filesystem of the **user's running SCO instance** — a container or host you do **not** have access to. Do not use Read/Glob/Grep/ls/`find` or any local filesystem or shell tool to open, inspect, search for, or validate these paths, and do not look for a sample data file to infer columns from. There is nothing to find locally, and attempting it wastes a turn and can surface a misleading "file not found". **Trust the path exactly as the user gives it** — drop it verbatim into the generated adapter setting. The only inputs you actively verify are the SCO **target class and its properties** (Step 2), which you check through the read-only `sco_*` tools against the running instance — never against local files. If you need the source field/column names, **ask the user** (Step 1); do not derive them by reading a file.

## The mapping contract (why name-threading matters)

The components only wire together if they share these names exactly. Establish them once in Step 1 and reuse them **verbatim** everywhere — a single mismatched string produces a flow that compiles but silently routes nothing, or a DTL that fails with `<CLASS DOES NOT EXIST>`.

| Shared value | Flows through |
|---|---|
| `requestClass` (e.g. `SC.Workbench.Integration{id}.Message.{IntegrationName}Request`) | the message the BS sends → the BP's `request` → the DTL's `sourceClass` |
| `targetClass` (pre-existing, e.g. `SC.Data.Customer`) | the DTL's `targetClass` → the class the BP `%Save()`s |
| `bpConfigName` = **full BP class name** (e.g. `SC.Workbench.Integration{id}.BP.{IntegrationName}Process`) | the BS's `targetHost` → the BP's config-item Name in the production |

The BS sends `requestClass` to `bpConfigName`; the BP hands `requestClass` to the DTL, which maps it onto `targetClass` and saves it.

**Why `bpConfigName` is the full class name, not the short `{IntegrationName}Process`:** when a host is added to a production without an explicit `Name`, SCO defaults its config Name to the full class name. Our `manage-production` step adds the BP with `name = bpConfigName`, and the BS's `targetHost` points at that same string — so the wiring matches with no manual rename. Never reference the BP by a shortened name.

## Workbench-owned classes: per-integration package, ownership, and idempotency (read before naming anything)
Every class this flow generates lives under a **per-integration Workbench package keyed by the integration id** — `SC.Workbench.Integration{id}.*`, where `{id}` is the integration's stable identity (the `id` from the UI's deploy payload; in a chat-only flow, a short identifier you derive). Within that package the four components use fixed sub-packages so the set is predictable and easy to find/delete as a unit:

| Component | Class name |
|---|---|
| Business Service (`bsConfigName`) | `SC.Workbench.Integration{id}.BS.{IntegrationName}Service` |
| Business Process (`bpConfigName`) | `SC.Workbench.Integration{id}.BP.{IntegrationName}Process` |
| DTL (`dtlClass`) | `SC.Workbench.Integration{id}.DTL.{IntegrationName}Transformation` |
| Request message (`requestClass`) | `SC.Workbench.Integration{id}.Message.{IntegrationName}Request` |

This keeps Workbench-created interop classes separate from SCO's own (`SC.Core.*`) so we only ever overwrite our own, AND — because every integration has its own `Integration{id}` package — **two different integrations can never collide on a class name**, and the whole set for one integration is exactly `SC.Workbench.Integration{id}.*`. **Never generate an interop class into `SC.Core.*` or into another integration's `Integration{id}` package.**

**`{IntegrationName}` must be a legal ObjectScript class-name segment** — it becomes part of the class name, so it must contain no whitespace or special characters (letters and digits only, starting with a letter; ObjectScript identifier rules). If the user's integration name doesn't qualify, **derive a sanitized equivalent for them** (strip/replace illegal characters, PascalCase the words — e.g. "ERP Orders → SalesOrder" becomes `ErpOrders`) and tell them the name you'll use. `{id}` comes from the deploy payload verbatim and is likewise already identifier-safe.

**One data integration = one `Integration{id}` package (BS + message + DTL + BP), and edits reuse it.** Because the package encodes the integration id:
- **Re-deploying / editing the same integration** regenerates and recompiles the **same class names** (same `{id}`, same `{IntegrationName}`) — an intended overwrite; you're updating the pipeline the user already has.
- **A different integration** gets a different `{id}`, so its package differs — its class names are automatically unique. There is no cross-integration name collision to disambiguate.

### Existence check before every compile (mandatory)
For each class you're about to generate, call `sco_resolve_class { name }` first:
- **Does not exist** → safe to create.
- **Exists and is this integration's own class** (same `SC.Workbench.Integration{id}.*` package — the classes you created last time) → safe to overwrite; you're editing.
- **Exists but is NOT under this integration's `Integration{id}` package** → something is off (you should never collide, since the id namespaces every class). Do **not** overwrite it. Re-confirm the integration `id` and `{IntegrationName}` with the user rather than clobbering an unrelated class.

Never skip this check — compiling a class silently overwrites any existing class of that name.

## The deploy payload is authoritative (when invoked from the Deploy button)

Almost always you are invoked from the workbench **Deploy** button, which hands you a complete `Pipeline definition` JSON block in the prompt. **When that payload is present it is the source of truth — read every value from it and do NOT re-ask the user for anything it already contains** (the wizard already collected it, including whether the file has a header row). Only fall back to the "ask the user" prompts in Step 1 for a **chat-only** flow where no payload was given, or to resolve a genuine conflict/ambiguity in the payload.

The payload shape:

```json
{
  "id": "1a2b",                       // integration id → namespaces every class as SC.Workbench.Integration{id}.*
  "name": "Sales Orders",             // display name; sanitize to a legal identifier for {IntegrationName}
  "adapter": "File",                  // File | SFTP | FTP | SQL | Cloud
  "service": { /* Step-1 source config, adapter-specific — see business-service.md */ },
  "process": {
    "hasHeader": true,                // ← this IS the headerRow decision; do not re-ask. true → map by column name, false → Column{n} by position
    "targetClass": "SC.Data.SalesOrder",   // fully-qualified existing SCO class (still VERIFY it in Step 2)
    "mappings": [                     // the field mappings → request-message properties AND DTL assigns
      { "sourceField": "region", "sourceType": "string", "transform": null, "transformArgs": {}, "targetProperty": "region" }
    ]
  }
}
```

- `service.*` carries only the chosen adapter's source config (e.g. `filePath`/`fileSpec` for File; `host`/`port`/`path`/`fileSpec`/`credentials` for FTP/SFTP; `bucket`/`region`/`credentialsFile`/`blobPrefix`/`blobPattern` for Cloud; `dsn`/`credentials`/`query`/`keyField`/`driverClass`/`driverClasspath` for SQL). Credentials arrive as an **entry name only** — never a username/password (Step 4 / business-service.md). For Cloud, `blobPattern` is the **full relative blob key** (e.g. `Test/locations.csv`), NOT the leaf filename — the adapter matches it against the whole key (see business-service.md, "BlobNamePrefix vs BlobNamePattern"); the generator emits `blobPrefix`/`blobPattern` verbatim, so pass them as the wizard built them. For SQL, `service.keyField` is the SOURCE table's key column (auto-detected from the source schema) that becomes the GenericService `KeyFieldName` for row-tracking, and `service.driverClass` / `service.driverClasspath` select the JDBC driver + its staged JAR for the source DB (SCO or PostgreSQL) → `JDBCDriver` / `JDBCClasspath`. The generator handles all of these; you don't set them.
- `process.hasHeader` maps 1:1 to the `headerRow` concept used by message.md and business-service.md. Trust it; don't ask.
- **Source retention is a fixed generator default, not a payload field.** The pipeline always ingests each source once and leaves the original in place, so the generated Business Service always sets `DeleteFromServer = 0` (File/FTP/SFTP) or `DeleteAfterDownload = 0` (Cloud) — see business-service.md, "Process once, keep the source." The payload carries no delete/keep flag; don't look for one, and only deviate (move/archive/delete) if the user explicitly asks in chat.
- `process.mappings[]` defines both the `requestClass` properties (one per distinct `sourceField`, typed by `sourceType`) and the DTL assigns (`transform`/`transformArgs` per dtl.md). `targetProperty` is still verified against the real class in Step 2.

Take `service` paths verbatim (they live in the user's SCO environment — see the note above); the only thing you actively verify is the `targetClass` and its properties (Step 2).

## Step 1 — Establish the integration identity and mapping

**If a deploy payload was given, read these from it (above) and skip the questions — go straight to Step 2.** Only in a chat-only flow (no payload) do you ask the user for the following. Offer defaults derived from `IntegrationName` so they only have to override what they care about. Do not proceed until every **[REQUIRED]** value is known.

**[REQUIRED]**
- `id` — the integration id (from the UI deploy payload; in a chat-only flow, derive a short identifier-safe id). This namespaces every class as `SC.Workbench.Integration{id}.*`.
- `IntegrationName` — a base name (e.g. `Customer`, `ErpOrders`). Drives the default class names below. It becomes part of the class name, so it **must be a legal ObjectScript identifier** (letters/digits, starting with a letter, no whitespace or special characters). If the user's name isn't legal, sanitize it for them (e.g. "ERP Orders → SalesOrder" → `ErpOrders`) and tell them the name you'll use.
- `targetClass` — the fully-qualified existing SCO class the data maps into (e.g. `SC.Data.Customer`). This is **verified** in Step 2, not generated.
- `adapterType` — how data comes in: `File`, `SFTP`, `FTP`, `SQL`, `Cloud` (S3), or `None`. See [references/business-service.md](references/business-service.md) for what each needs. (Other adapters exist in SCO but are not covered here — if the user needs one, say it's not yet supported and stop.)
  - **File / SFTP / FTP / Cloud ingest a single CSV file only.** These adapters support **CSV** as the only data format, and the pipeline is built around one CSV source (for Cloud/S3, exactly one CSV object). If the user asks to ingest a different format (JSON, XML, fixed-width, Excel, a multi-file batch, etc.), say it's not supported yet and stop. (SQL reads a query result set, not a file.)
  - Also collect the adapter's path(s) here (poll directory + file spec, SFTP host/path/credentials, S3 bucket/key, etc.). Take every path **as given** — it lives in the user's SCO environment, so don't try to open or verify it locally (see the note above); just record it for the adapter setting.
- **field mappings** — the list of source→target field pairs the DTL performs (plus any transforms like uppercase, date reformat, substring), which also defines the `requestClass` properties (one per distinct source field). Get these **from the user** — ask them to list the source fields/columns. Do not attempt to read or sniff a sample data file to infer them; you can't reach the user's files, and the user knows their layout.

- `headerRow` — does the source file have a header row?
   - If yes: ask the user for the exact column names. Message properties use those names verbatim.
   - If no: Columns are identified by one-based positional indices, Process according to the rules defined in [references/message.md](references/message.md).

**Derived defaults from `id` + `IntegrationName`** (present these; let the user accept or override the name). All Workbench-owned, under the per-integration package `SC.Workbench.Integration{id}.*`:
- `requestClass` = `SC.Workbench.Integration{id}.Message.{IntegrationName}Request`
- `dtlClass`     = `SC.Workbench.Integration{id}.DTL.{IntegrationName}Transformation`
- `bpConfigName` = `SC.Workbench.Integration{id}.BP.{IntegrationName}Process` (this is the BP's full class name AND its production config-item name)
- `bsConfigName` = `SC.Workbench.Integration{id}.BS.{IntegrationName}Service` (the BS's full class name AND its production config-item name)

If the user gave no name at all, derive a sensible default from the target class short-name (e.g. `SC.Data.Customer` → `Customer`) rather than blocking. `targetClass` is **not** derived — the user supplies it.

Present a **summary** (the integration id, all four class names + the field mapping) and ask: *"Does this pipeline definition look correct?"* Do not proceed until confirmed.

Then run the **existence check** (above) on `requestClass`, `dtlClass`, `bpConfigName`, and (for non-SQL) `bsConfigName`. Only after names are settled do you generate/compile in the following steps.

## Step 2 — Generate the pipeline classes with `sco_generate_integration_classes`

Call `sco_generate_integration_classes { definition }`, passing the deploy-payload definition verbatim (`id`, `name`, `adapter`, `service`, `process` with `hasHeader`/`targetClass`/`mappings`). This ONE read-only call does everything that used to be Steps 2–6 by hand — and it does the parts that used to break:

- **Resolves the target class** (accepts a SQL table name too) and returns the real `className`. If the target doesn't exist it fails with `candidates` — show them and ask which class the user meant; don't proceed.
- **Verifies every mapped `targetProperty`** exists on the class. If any is missing it fails and lists the real `availableProperties` — fix the mapping (or use `sco_match_property` to find the right name, confirming with the user) and retry. This prevents the DTL compile `<CLASS DOES NOT EXIST>` / `#5490`.
- **Finds the upsert key index** (the target's natural-key `<index>Open` method) and threads it into the BPL, or falls back to insert-only with a `warnings[]` entry you must relay.
- **Generates all class sources** — request message, DTL, BPL, and (for File/FTP/SFTP/Cloud) the Business Service — plus the **production config-item specs**. Everything is compile-tested and free of the recurring hand-authoring bugs (`Storage` block, `%CSV.Reader`, `<call>` to the DTL, undeclared `context`, `create="new"`, guessed config settings).

The tool returns:
```
{ integrationName, classNames, keyIndex, keyRequestProp,
  classes:    [ { role, className, source } … ],   // in COMPILE order; source is null for the SQL Business Service
  configItems:[ { className, name, poolSize, settings, reuseIfExists?, note } … ], // in ADD order (all added disabled)
  warnings:   [ … ] }                              // relay these (e.g. insert-only fallback)
```

**Do not hand-edit the returned sources.** If a mapped field looks wrong, fix the *definition* and regenerate — don't patch the generated ObjectScript.

**Foreign keys (handled for you):** `sco_generate_integration_classes` detects the target's foreign keys that this pipeline writes and returns them in `foreignKeys[]` plus a `warnings[]` entry for each. **RELAY those warnings to the user** — they name the referenced (parent) table whose rows must exist first (e.g. "load `SC.Data.Location` before this, or rows are skipped with `#5829`"). This is a data prerequisite the user controls (the parent rows must exist), NOT something to fix by loosening the target class. The generated BPL already logs each `#5829` skip with the exact missing reference + value, so the user can see which parent rows are absent.

## Step 3 — Compile the returned classes (in the order given)

For each entry in `classes` (skip any whose `source` is null — that's the SQL Business Service, which has no class), call `sco_compile_class { className, source }` using the source **exactly as returned**. The order is already correct: request message → DTL → BPL → Business Service (the DTL has a compile-time dependency on the message + the pre-existing target class, so order matters). The target class already exists — do not compile it.

Report each compile result honestly. If one fails, quote the compiler error and stop — a generator gap is a bug worth surfacing, not something to paper over by editing the source. (In practice these compile cleanly; the whole point of the generator is that they do.)

## Step 8 — Register ALL hosts on the production (disabled), as one phase

Deploy is a **single automatic action**: there is no separate "Create" step the user runs first, and you do **not** ask whether to start. Once the classes compiled (Steps 3–7), register the hosts on the active production and then, in Step 9, enable them — all in this one turn.

**Phase the production changes: add EVERY host FIRST (all disabled), THEN enable them (Step 9) — never interleave add-then-enable per host.** Add the Business Process AND the Business Service (for SQL: the JavaGateway AND the GenericService) as disabled config items, completing all adds before any enable. Why: enabling a Business Service the instant it's added would start it polling before the Business Process it routes to has even been registered, so inbound records hit a missing/stopped target. Adding everything disabled first means the whole pipeline exists on the production before anything starts moving data, and the Step-9 enable order (BP before BS) then brings it up safely. This ordering also keeps each production reconcile a cheap no-op (a disabled add restarts nothing), so the adds don't churn other hosts.

Register each entry in the `configItems` array the generator returned (Step 2), in the given order, with the **manage-production** skill (`sco_add_config_item`). Pass each item's `className`, `name`, `poolSize`, and `settings` **exactly as returned** — do NOT invent or add settings (a guessed setting like `TargetConfigName` is exactly what broke a past deploy). Leave `enabled` unset so every item is added disabled; enabling is Step 9.

1. Find the active production with `sco_production_status`; you need its name. If none is running, tell the user and stop before adding (there's nothing to add to). Pass that `productionName` to each add.
2. For each `configItems` entry, in order:
   - If it has `reuseIfExists: true` (the shared SQL `JavaGateway`), FIRST call `sco_list_config_items { productionName }` and skip the add if an item of that `name` already exists; otherwise add it.
   - Otherwise add it: `sco_add_config_item { productionName, className, name, poolSize, settings }` (settings is `[]` for file-family hosts — every connection value is compiled into the class `OnInit()`; non-empty only for the SQL GenericService/JavaGateway).

**Config items are keyed by NAME, not by class** — `sco_add_config_item` upserts by `name`, so re-deploying the same integration updates its items in place (the names are namespaced by `Integration{id}`, so they never collide with another pipeline). Add every item before enabling any (the phasing above).

## Step 9 — Enable the hosts (automatic — do NOT ask)

Deploy starts the pipeline automatically; there is **no yes/no prompt**. Immediately after registering the hosts, enable them through the **manage-production** skill (`sco_enable_config_item`). The **order matters — Business Process first, then the service (Business Service / SQL GenericService) LAST**:

1. **Enable the Business Process** first — it's the first entry in `configItems` (`classNames.bpConfigName`). The BP is the target the service routes to; if the service starts while the BP is still down, inbound records arrive with nowhere to go and error out or queue against a stopped target.
2. **Enable the inbound service LAST** — the last `configItems` entry (the Business Service `classNames.bsConfigName`, or for SQL the GenericService of the same name). It's the trigger: once enabled it starts polling/ingesting immediately, so it must come only after the BP is up. (The shared `JavaGateway`, if you added it, needs no enable step for this flow.)

**Do NOT retry an enable that the tool reported `ok: true`.** `sco_enable_config_item` returns success even when the message mentions `ErrJobNotStopped` / a reload timeout (the item IS enabled — the live reload just couldn't stop some OTHER slow host within 10s) or "was already enabled." Relay that message and move on. Re-calling enable only produces a confusing "already enabled" error and extra production churn. Only a genuine `ok: false` means the item is not enabled.

Once both are enabled the pipeline is live and ingesting.

## Step 10 — Report the wiring and outcome

Print the wiring map and the outcome. Adapt to the adapter family:

```
Business Service : {bsConfigName}   (on {productionName}, ENABLED)
   └─ sends {requestClass}  ──►  targetHost = {bpConfigName}
Business Process : {bpConfigName}   (on {productionName}, ENABLED)
   └─ runs {dtlClass}.Transform(request, .target)  →  %Save()s {targetClass}
DTL              : {dtlClass}   ({requestClass} ──► {targetClass})
```

Then tell the user plainly: which classes compiled, which hosts were registered, and that the pipeline is now **enabled and ingesting**. Per the honesty rule, if any step was skipped or any compile/add/enable failed, say so explicitly — do not report success.

**Report the outcome to the workbench UI.** If this run was started from a workbench button (the prompt carries an `integration id`), call `ui_report_status { target: <integration id>, phase: "deployed", ok, detail }` so the pipeline's status badge reflects the REAL result. Because Deploy is now a single automatic action (compile → register → enable), report the **one** `deployed` phase once everything succeeded: `ok: true` only if every class compiled AND the hosts were registered and enabled; otherwise `ok: false` with a short `detail` naming what failed. Report the failure truthfully (`ok: false`) if you had to stop early at any stage; the UI reverts the badge and shows your `detail`.

## Deleting a pipeline — confirm the full set, then remove everything it registered

Because every class for an integration lives under `SC.Workbench.Integration{id}.*`, you can find the whole set precisely from the `id` — you don't have to guess. Deletion has two parts: the **production config items** (required — so nothing keeps polling and no orphan hosts linger) and the **generated classes** (this integration's `Integration{id}` package).

**Step A — gather what this integration owns.**
- **Config items:** call `sco_list_config_items { productionName }` and pick this integration's `bpConfigName` and `bsConfigName` (for SQL, the GenericService item). Note whether the shared `JavaGateway` is present.
- **Java Gateway ref-count (SQL only):** count items whose class is `EnsLib.SQL.Service.GenericService` **excluding this integration's own** — if any other SQL service remains, the gateway must be KEPT; only if none remain would it be removed.
- **Classes:** the four classes under `SC.Workbench.Integration{id}.*` — `{IntegrationName}Service` (BS), `{IntegrationName}Process` (BP), `{IntegrationName}Transformation` (DTL), `{IntegrationName}Request` (Message). (For SQL there is no BS class.)

**Step B — confirm with the user BEFORE removing anything (mandatory).** Show a concrete list of exactly what will be removed and ask the user to confirm (use `ask_user_question` with a yes/no). Make it explicit and double-checkable, e.g.:

```
Deleting integration "{name}" (id {id}) will:
  Unconfigure from production {productionName}:
    - Business Process host : {bpConfigName}
    - Business Service host : {bsConfigName}          (SQL: the GenericService item)
    - JavaGateway           : KEPT (2 other SQL pipelines still use it)  |  REMOVED (last SQL pipeline)
  Delete these SCO classes (package SC.Workbench.Integration{id}.*):
    - {requestClass}
    - {dtlClass}
    - {bpConfigName}
    - {bsConfigName}                                   (non-SQL only)
Proceed?
```

Do **not** remove or delete anything until the user confirms. If they decline, stop and leave everything in place.

**Step C — after confirmation, remove in order.**
1. **Production items** with `sco_remove_config_item { productionName, name }` (safe no-op if already gone):
   - the **Business Process** (`bpConfigName`),
   - the **Business Service** (`bsConfigName`) — for SQL, the GenericService item,
   - the **`JavaGateway`** ONLY if the ref-count above found no other SQL service (last SQL pipeline). Otherwise leave it.
2. **Classes** — delete this integration's own `SC.Workbench.Integration{id}.*` classes (per the compile-class / class-delete tooling). Only ever delete classes inside this integration's `Integration{id}` package — never a shared or `SC.Core.*` class, and never another integration's package.

Report which items were unconfigured, which classes were deleted, and — for a SQL pipeline — whether `JavaGateway` was kept (still in use) or removed (last SQL pipeline).

If this delete was started from a workbench button (the prompt carries an `integration id`), finish by calling `ui_report_status { target: <integration id>, phase: "deleted", ok: true }` once the items are removed, so the workbench drops the pipeline from the list only after the real cleanup. If the user declined or cleanup failed, call it with `ok: false` and a `detail` so the row stays and the reason is surfaced.
