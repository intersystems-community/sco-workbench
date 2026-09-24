---
name: data-integration
description: Create, build, or understand an SCO Interoperability data pipeline that ingests external data (file, SFTP/FTP, SQL query, or S3) and maps it onto an existing SCO persistent class. Use whenever the user wants to build/wire up/automate an ingestion flow or ETL into SCO (e.g. "ingest this CSV of customers into SC.Data.Customer", "poll an SFTP folder into SCO", "load orders from a database into my order class"), or wants help understanding the Data Integration wizard. Works in BOTH modes and adapts - in Agent mode a single automatic Deploy generates the whole component chain (request message → Business Service → DTL → BPL process), compiles it into SCO, registers the hosts on the production, and starts (enables) the pipeline; in Guided mode it explains the Data Integration wizard (what each source type, page, and field means) and fills in Step 1's connection details for the user via ui_set_field, while the user does the file uploads, the Step-2/3 data entity and mapping, and the final Save and Deploy themselves. Do NOT use it for one-off record lookups, for building analytics cubes (use the cube skill), or for deploying a single standalone class (use compile-class).
---

# Data-integration skill (mode-aware)

This one skill handles data-integration pipelines in both operating modes. The
turn is prefixed with a `[SESSION MODE: agent]` or `[SESSION MODE: guided]`
marker, and the system prompt already puts you in the matching persona. **Route
on that mode — read exactly one workflow file, then follow it:**

- **`[SESSION MODE: agent]`** → the worker path: Deploy is one automatic action.
  You do NOT hand-write the pipeline classes — `sco_generate_integration_classes`
  deterministically generates the four components (message → Business Service →
  DTL → BPL) and the production config-item specs from the deploy payload. You
  then compile the returned sources (`sco_compile_class`), register the returned
  config items disabled, and enable them (BP first, service last) via the
  compile-class / manage-production skills. Read
  **[references/agent-workflow.md](references/agent-workflow.md)** and follow it.
- **`[SESSION MODE: guided]`** → the teacher path: you never CHANGE SCO. You
  **explain** the **Data Integration** wizard — what each source type, page, and field
  means — and you co-pilot **Step 1 (Data Source) only**: when the user gives you their
  connection details you fill those fields with `ui_set_field`. Everything else stays
  theirs — the file/key/credential **uploads** (`ui_set_field` refuses those paths, and
  a typed one would point at a file that doesn't exist), the Step-2 data entity, the
  Step-3 mapping, and the final Save / Deploy. Read
  **[references/guided-workflow.md](references/guided-workflow.md)** and follow it.

If the mode marker is somehow absent, infer it from which tools you're permitted
(the permission gate allows `sco_*` only in Agent mode and `ui_*` only in Guided
mode) — but it should always be present.

## Shared background (both modes)
A data-integration pipeline is an SCO Interoperability flow with four
components that must share names consistently:

```
request message ──► Business Service ──► DTL transform ──► BPL process
  (typed request)     (ingests data)       (field mapping)   (runs DTL, %Save()s target)
```

The component generators are reference files, read the one you need:
[references/message.md](references/message.md) (request message),
[references/business-service.md](references/business-service.md) (inbound BS + adapter),
[references/dtl.md](references/dtl.md) (field-mapping DTL),
[references/bpl.md](references/bpl.md) (BPL process). The agent workflow uses these
to generate real classes; the guided workflow uses them as background to explain
what each wizard step will ultimately produce.

Workbench-created interop classes live under a **per-integration package keyed by
the integration id** — `SC.Workbench.Integration{id}.*` (never `SC.Core.*`), with
fixed sub-packages: `.BS.{IntegrationName}Service`, `.BP.{IntegrationName}Process`,
`.DTL.{IntegrationName}Transformation`, `.Message.{IntegrationName}Request`. One
data integration owns exactly one `Integration{id}` package — see the agent
workflow for the naming/sanitization/idempotency and deletion rules.
