# Agent-mode KPI workflow (create/update it in SCO)

You are in **Agent mode** — the worker. You create or update a Business KPI
directly in the running SCO instance through the `sco_*` KPI tools, which call
SCO's Business KPI REST API (`SC.Core.API.KPI.KpiApiImpl`) — the same supported
endpoint the workbench UI uses. You do NOT write files or reinvent the save. (For
what a KPI is, field meanings, MDX syntax, and example definitions, see
[kpi-definition.md](kpi-definition.md).)

## Tools
- `sco_list_kpis` — list existing KPI definitions (read-only). Use FIRST to check the name isn't taken and to see patterns.
- `sco_get_kpi` `{ name }` — read one KPI back in full (read-only). Use before an update so you send a complete, corrected definition.
- `sco_create_kpi` `{ definition }` — create a new KPI. **State-changing** (the user is asked to approve).
- `sco_update_kpi` `{ name, definition }` — update an existing KPI, keyed by the CURRENT (`name`) name; a rename puts the new name inside `definition`. **State-changing.**
- `sco_delete_kpi` `{ name }` — delete a KPI. **State-changing.**

## 1. Do not speculate
The KPI's `cube`, `kpiMeasure`, `kpiConditions`, and `kpiDimensions` must match the real cube. Don't invent cube/measure/dimension names or MDX members. Confirm the cube exists and inspect its structure before composing conditions:
- `sco_cube_info { cubeName }` — confirm the cube exists.
- `sco_cube_detail { cubeName }` — the cube's measures and dimensions/levels. This defines the valid `kpiMeasure` and the dimension levels you can filter on; each level comes with its MDX spec (e.g. `[quantityStatus].[H1].[status]`).
- `sco_cube_members { cube, dimension, level }` — **the real member keys for a condition.** A condition is `[dimension].[hierarchy].[level].&[key]`, and the `&[key]` MUST be an actual member key of that level — never the level name humanized or guessed. SCO matches the key literally, so a made-up key yields a KPI that silently returns nothing. Read the members with this tool (pass the level's MDX spec from `sco_cube_detail`) and use one of the returned keys verbatim. The only key you write without a lookup is the special `&[<null>]` (is-null) sentinel. If this tool returns NO real members (empty, or only `<null>`), the source data has no values for that level yet — do NOT guess or fill a placeholder key. Tell the user the dimension has no member values, so there are no options to offer, and ask them (with `ask_user_question`) to TYPE the exact key their data will use; build the condition from that, or leave it unset if they can't say.
- **For the current SCO release, a condition may use only a single member key (`[dimension].[hierarchy].[level].&[key]`) or the null key (`.&[<null>]`).** Combining members with AND/OR, negating with EXCEPT, member sets `{…}`, and aggregate comparisons (FILTER/AGGREGATE) require **SCO 1.8.0** and must not be composed yet — they save without error but the KPI returns no value at run time (the failure surfaces at KPI value/listing time, not at save). To express more than one filter, add separate `kpiConditions.N`/`baseConditions.N` entries — each is its own AND-combined filter clause — rather than combining them in one string.
- When the user must choose which member to filter on, read the members first, then offer the REAL member names as `ask_user_question` options (they can always type their own) — do NOT present variations of a single guessed name. If a level genuinely can't be read, ask rather than guessing.
- `baseObject` must be a real `SC.Core.API.Data.{baseObject}ApiImpl` short-name; if unsure, ask or leave it unset.

## 2. Gather the definition
Collect (ask if missing) and shape a `KpiDefinition` (see kpi-definition.md for every field and worked examples):
- **name** (unique — a create fails if it exists), optional **label** / **description**.
- **type**: `DeepSee`.
- **deepseeKpiSpec**: **cube** (required), **valueType** `raw`|`percentage` (required), **kpiMeasure** (`%COUNT` or a named cube measure), **kpiConditions** (≥1 MDX filter — required), **baseConditions** (only for `percentage`), optional **kpiDimensions**.
- Optional top-level: **baseObject**, **watchingThreshold**, **warningThreshold**, **issueKpi** (+ **defaultIssueSeverity**, **analysisService** when true), **status**.

## 3. Create or update
Remember the confirmation gate: create/update/delete change the SCO instance and the user is asked to approve them — so briefly state what you're about to do in one sentence, then call the tool (don't ask "shall I proceed?" in text).

**Create:**
1. `sco_list_kpis` — confirm the name is free (SCO rejects a duplicate name with a 400).
2. `sco_create_kpi { definition }`. If it fails, read the returned `error` (it surfaces the SCO message, e.g. "KPI already exists", "Invalid KPI definition found"), fix the definition, and retry.

**Update:**
1. `sco_get_kpi { name }` — read the current definition.
2. Apply the change to the full definition, then `sco_update_kpi { name, definition }` where `name` is the ORIGINAL name (a rename carries the new name inside `definition`).

## 4. Report
Tell the user plainly what happened: the KPI was created/updated (name, cube, measure, value type), or the exact error if it failed. Do not claim success unless the tool result says `ok: true`.
