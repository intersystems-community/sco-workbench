# KPI definition reference

Shared reference for what an SCO Business KPI is, what each field means, and
example definitions. Used by both the agent and guided KPI workflows (see
`references/agent-workflow.md` and `references/guided-workflow.md`).

## What a KPI is
A Business KPI is a metric computed over an Analytics cube plus a rule for when
it's a concern. The definition maps 1:1 onto the SCO classes
`SC.Core.Analytics.KPI.KpiDefinition` (top-level fields) and
`SC.Core.Analytics.KPI.DeepseeKpiSpec` (the cube spec). It's created/updated
through the SCO KPI REST API (`SC.Core.API.KPI.KpiApiImpl`,
`/api/{ns}/scbi/v1/kpi/definitions`). Field by field — explain what each means
for the KPI in front of the user, not in the abstract:

Top-level (KpiDefinition):
- **name** — unique KPI id, no spaces (e.g. `SupplyShipmentLateVsRequested`). The key SCO stores it under; creating with an existing name is rejected.
- **label** — human display name shown in the UI (e.g. "Supply Shipment Late vs Requested").
- **description** — one line on what the KPI measures.
- **type** — the KPI engine; here it's always `DeepSee` (computed from a cube via MDX). (The class also allows SQL/ObjectScript types, but the Workbench only builds DeepSee KPIs.)
- **baseObject** — the source object short-name behind the drill-through "Related Records" list (e.g. `SupplyShipment`). It resolves to `SC.Core.API.Data.{baseObject}ApiImpl`, so it must be one of those API classes. In the UI it's auto-filled from the cube's source class.
- **status** — `Active` or `Inactive`.
- **watchingThreshold** (yellow) / **warningThreshold** (red) — numeric alert levels: when the KPI value crosses them the UI flags it watching/warning.
- **issueKpi** — if true, each impacted record can raise an Issue (feeds the Issue workflow). If false, the KPI is display-only.
- **defaultIssueSeverity** — 1–5 severity for raised issues (1 = most critical … 5 = least); only meaningful when `issueKpi` is true.
- **analysisService** — optional BPL service name for issue resolution/recommendation; only when `issueKpi` is true.

Cube spec (DeepseeKpiSpec):
- **cube** — the cube the KPI reads (e.g. `SupplyShipmentCube`). Required.
- **kpiMeasure** — the cube measure that's aggregated. `%COUNT` (the cube's built-in row count) for "how many records match", or a named measure (e.g. a SUM measure like `totalOrderValue`) for a value. Which named measures exist depends on the chosen cube.
- **valueType** — `raw` (a plain count/measure) or `percentage` (numerator ÷ denominator). Required. (`DeepseeKpiSpec.isPercentageType()` gates the base-condition logic.)
- **kpiConditions** — the list of MDX filters that define the records the KPI counts (the numerator). Required — a KPI needs at least one. Multiple conditions are AND-combined.
- **baseConditions** — the denominator population, used **only** when valueType is `percentage`. The numerator is then (baseConditions AND kpiConditions); the value is numerator ÷ denominator.
- **kpiDimensions** — break the value down / drill by carrier, supplier, region, etc. Each has `name` (API param name), `label` (display), and `cubeDimension` (the MDX path into the cube). Optional.

## MDX condition syntax
A condition is an MDX member: `[dimension].[hierarchy].[level].&[key]`. For
example `[quantityStatus].[H1].[status].&[BelowMinimum]` means "the quantityStatus
dimension's status level equals BelowMinimum". A `.&[<null>]` key means "is null"
(e.g. `[actualTimeOfArrival].[H1].[value].&[<null>]` = "has not arrived yet").
The dimension/level names come from the chosen cube's definition.

### Current release supports only a single member key or the null key
For the current SCO release, a condition may use **only** a single member key
(`[dimension].[hierarchy].[level].&[key]`) or the null key (`.&[<null>]`).
Everything else the MDX grammar allows — combining members with AND/OR, negating
with EXCEPT, member sets `{…}`, member ranges, `.MEMBERS`, and aggregate
comparisons built from FILTER/AGGREGATE — requires **SCO 1.8.0** and must not be
composed yet. Those forms save without error but the KPI returns no value at run
time (validation is structural only; the failure surfaces at KPI value/listing
time, not at save). To express more than one filter, add **separate condition
entries** — each `kpiConditions.N`/`baseConditions.N` entry is its own filter
clause, AND-combined — rather than combining them in one string.

### The `&[key]` MUST be a real member key — look it up, never guess
The `&[key]` part is not free text and it is **not** the level name made
human-readable. It is one of the actual member keys stored in that cube level,
and SCO matches it literally: a key that isn't a real member yields a KPI that
silently returns nothing (it filters to an empty set), so a guessed or
"humanized" key is a broken KPI, not a cosmetic slip. In particular, do **not**
derive the key from the level name — `[quantityStatus].[H1].[status]` does NOT
imply a key `&[Status]` or `&[QuantityStatus]`; the real keys might be
`&[OutOfStock]`, `&[BelowMinimum]`, `&[InStock]`, and you cannot know which
without reading them.

**So before writing any condition that pins a member, read that level's real
members with the `sco_cube_members` tool** (available in both modes) and use one
of the keys it returns verbatim:
1. `sco_cube_detail { cubeName }` gives the cube's dimensions and, for each, its
   levels with each level's MDX spec (e.g. `[quantityStatus].[H1].[status]`).
2. `sco_cube_members { cube, dimension, level }` — pass the dimension name and,
   for a multi-level dimension, the level's MDX spec — returns every member of
   that level with its display `name` and its `key`. Build the condition as
   `<levelSpec>.&[<key>]` using a key from that list.

**When the user must choose which member to filter on, offer the REAL members.**
Read them with `sco_cube_members`, then ask with `ask_user_question` listing the
actual member names as the options (the user can always type their own value, so
you don't need an "Other" option). Do NOT present variations of one guessed name
(the plain word, the word capitalized, the word humanized) — those are not real
choices and mislead the user. Offer the members that actually exist plus the
freedom to type one, the same way the cube dimension member picker works
elsewhere in the workbench. The only key you write without looking it up is the
special `&[<null>]` (is-null) sentinel.

**When `sco_cube_members` returns NO real members** — an empty list, or only the
`<null>` member — there is nothing to offer and nothing to verify a key against.
This happens when the cube's source data has no values for that level yet. Do NOT
fall back to guessing a key (do NOT write `&[out-of-stock]`, `&[YourStatusValue]`,
or any invented value): a guessed key here is exactly the silent-empty-KPI trap,
and it also hides from the user that the dimension is empty. Instead tell the user
plainly that this dimension currently has no member values in the data, so you
can't list options — then ask them (with `ask_user_question`, or in prose in
Guided mode) to TYPE the exact member key their data will use, and write the
condition with the value they give. Make it explicit that they may type a value
because there is nothing to pick from. If they don't know it yet, leave the
condition unset rather than filling a placeholder.

## Example definitions
Complete KPI definition JSON bodies — the exact shape the REST API accepts. They
come from a reference/testing environment; a given instance may have different
KPIs, so treat these as illustrative patterns, not a promise of what's deployed.

### Example 1 — count of records matching a condition, raises issues
```json
{
  "name": "InventoryOutOfStock",
  "label": "Inventory Out Of Stock",
  "description": "Inventory out of Stock",
  "type": "DeepSee",
  "baseObject": "ConsolidatedInventory",
  "status": "Active",
  "issueKpi": true,
  "defaultIssueSeverity": 3,
  "deepseeKpiSpec": {
    "namespace": "SC",
    "cube": "ConsolidatedInventoryCube",
    "kpiMeasure": "%COUNT",
    "valueType": "raw",
    "kpiConditions": ["[quantityStatus].[H1].[status].&[OutOfStock]"],
    "kpiDimensions": [
      { "name": "country", "label": "Inventory Location Country", "cubeDimension": "[locationHierarchy].[H1].[country]" },
      { "name": "productCategory", "label": "Product Category", "cubeDimension": "[productCategory].[H1].[category]" },
      { "name": "productBrand", "label": "Product brand", "cubeDimension": "[productBrand].[H1].[brand]" }
    ]
  }
}
```
A **raw `%COUNT`** KPI: it counts inventory rows whose `quantityStatus` level equals `OutOfStock` (the one `kpiConditions` entry). Because `issueKpi` is true, each matching record can raise an Issue at severity 3. The `kpiDimensions` are breakdown axes — the UI can split the count by country, product category, or brand.

### Example 2 — a summed monetary value, with thresholds
```json
{
  "name": "SalesRevenueYTD",
  "label": "Revenue YTD",
  "description": "Sales revenue for the current year",
  "type": "DeepSee",
  "baseObject": "SalesOrder",
  "status": "Active",
  "watchingThreshold": 499999,
  "warningThreshold": 1000000,
  "issueKpi": false,
  "deepseeKpiSpec": {
    "namespace": "SC",
    "cube": "SalesOrderCube",
    "kpiMeasure": "totalOrderValue",
    "valueType": "raw",
    "kpiConditions": ["[orderPlacedDate].[H1].[Year].&[2025]"],
    "kpiDimensions": [
      { "name": "region", "label": "Order Region", "cubeDimension": "[salesRegion].[H1].[salesRegion]" },
      { "name": "month", "label": "Order Placed Month", "cubeDimension": "[orderPlacedDate].[H1].[Month]" }
    ]
  }
}
```
Here `kpiMeasure` is the named cube measure **`totalOrderValue`** (a SUM), not `%COUNT`, so the KPI is a dollar amount rather than a row count. The single condition filters to the 2025 order year. `issueKpi` is false (display-only), and the thresholds turn the tile yellow above 499,999 and red above 1,000,000.

### Example 3 — conditions plus `baseConditions`
```json
{
  "name": "ExpectedEarlyDeliverySupplyShipment",
  "label": "Supply Shipment with Expected Early Delivery",
  "description": "Supply shipments which is expected to be delivered early",
  "type": "DeepSee",
  "baseObject": "SupplyShipment",
  "status": "Active",
  "watchingThreshold": 5,
  "warningThreshold": 10,
  "issueKpi": true,
  "defaultIssueSeverity": 2,
  "deepseeKpiSpec": {
    "namespace": "SC",
    "cube": "SupplyShipmentCube",
    "kpiMeasure": "%COUNT",
    "valueType": "raw",
    "kpiConditions": [
      "[actualTimeOfArrival].[H1].[value].&[<null>]",
      "[estimatedVsRequestedDelivery].[H1].[status].&[Early]"
    ],
    "baseConditions": ["[actualTimeOfArrival].[H1].[value].&[<null>]"],
    "kpiDimensions": [
      { "name": "carrier", "label": "Carrier", "cubeDimension": "[carrier].[H1].[name]" },
      { "name": "supplier", "label": "Supplier", "cubeDimension": "[supplier].[H1].[name]" },
      { "name": "toCountry", "label": "Ship to country", "cubeDimension": "[shipToLocation].[H1].[country]" }
    ]
  }
}
```
Two AND-combined `kpiConditions`: shipments that have **not** arrived yet (`actualTimeOfArrival` is `<null>`) **and** are predicted `Early`. It defines `baseConditions` (not-yet-arrived shipments) as the population of interest. Note `valueType` is still `raw`, so the result is a plain count and `baseConditions` acts only as scoping here — `baseConditions` becomes a true denominator only when `valueType` is `percentage`.

## The `parent` dimension field — do NOT set it
`SC.Core.Analytics.KPI.KpiDimension` has a `parent` property (documented "in case
of hierarchy, a month dimension will have parent dimension year"), but it is
**reserved and currently unused** — no code in the SCO framework reads it
(dimension handling in `SC.Core.API.KPI.KpiApiImpl` uses only `name` and
`cubeDimension`). The Workbench form does not expose it, and the REST API ignores
it. So if a user asks about `parent`: explain it's a placeholder for future
hierarchical drilldown, has no effect today, and there's nothing to fill in.
Don't invent a use for it.
