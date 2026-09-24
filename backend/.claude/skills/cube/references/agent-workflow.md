# Agent-mode cube workflow (build it in SCO)

You are in **Agent mode** — the worker. You generate a cube definition, deploy it
to the running SCO container (namespace configured by the backend), and build it.
You do this through the `sco_*` tools — never by writing files or calling SCO
directly. (For what a cube is and example definitions, see
[cube-definition.md](cube-definition.md).)

## 1. Do not speculate
Do not invent or guess class names or property names. Verify them against SCO with the schema tools (see §3.5); if something still can't be determined, ask the user. The cube is only useful if it maps to real fields on a real persistent class.

## 2. Decide whether a cube is warranted
A cube is an SCO pre-computed multidimensional model over a persistent source class. It defines:
- **Dimensions / Hierarchies / Levels** — how records are grouped/sliced (e.g. Region > Country > City).
- **Measures** — numeric aggregations over those groups (SUM, COUNT, AVG, MIN, MAX).

Create a cube when the user wants to analyze aggregated data across many records, slice/filter by categories (time, geography, status, type), or build pivots/dashboards/KPIs. If the request is a one-off record lookup, a cube is not needed — say so.

## 3. Gather the definition
Collect from the user (ask if missing):
- **cubeName** — the short cube name and class-segment (e.g. `SalesOrderCube`). The generator always deploys Workbench cubes under the `SC.Workbench.Cube.*` package, so the generated class is **`SC.Workbench.Cube.{cubeName}`** — this is fixed, you do not choose or change the package. (SCO's own built-in cubes live under `SC.Core.Analytics.Cube.*` and are read-only; never generate into that package.) The DeepSee cube name — the `<cube name=...>` you pass to `sco_build_cube` — is the short `cubeName`, not the full class name.
- **sourceClass** — the fully-qualified persistent class the cube reads, used verbatim (e.g. `SC.Data.SalesOrder`).
- **dimensions** — each with a name, `type` (usually `data`; `time` for dates), and one or more hierarchies of levels; each level maps to a `sourceProperty`.
  - **A `time` dimension gets THREE levels by default — Year, Month, Day — in one hierarchy** (`timeFunction` `Year`, `MonthYear`, `DayMonthYear`; `Month`/`Day` are not valid functions). A time dimension exists to drill down through time, and a lone Year level can only answer year-scale questions — adding the rest later means editing and rebuilding the cube. Add `QuarterYear` when the user thinks in quarters, and go coarser only if they ask. Each level still needs its own unique `factNumber`. See [cube-definition.md](cube-definition.md).
- **measures** — each with a name, `factName`, `aggregate`, `type`, and a `sourceProperty` (or `sourceExpression`).

## 3.5 VERIFY THE SCHEMA FIRST (mandatory — do this before generating anything)
Do NOT guess class or property names. Verify them against the running SCO instance using the read-only
schema tools (these do not change SCO and need no confirmation). This prevents failed-compile guessing loops.

1. **Resolve the source class** with `sco_resolve_class` `{ name }`.
   - SCO **SQL table names use underscores** (`SC_Data.SalesOrder`) but **ObjectScript class names use dots**
     (`SC.Data.SalesOrder`). Users often give the SQL name — the tool maps it to the real class. Always use the
     returned `className` (not the user's input) as the cube `sourceClass`.
   - The default SCO data model lives under `SC.Data.*`, but users may have custom classes — never assume.
   - If `exists` is false, show the returned `candidates` and ask the user which class they meant. Do not proceed.
2. **List the class's properties** with `sco_list_properties` `{ className }`. Use this as the source of truth for
   the exact property names and casing (e.g. the property is `orderValue`, not `OrderValue`).
3. **For every dimension/measure property the user named**, confirm it appears in that list. If a name isn't an exact
   match, call `sco_match_property` `{ className, requested }` and **confirm the closest suggestion with the user**
   before using it. Never silently substitute.
4. **Where does each level's data come from?** If the user named a plain property, use it. If they named something
   that is NOT a property of the source class — a related entity ("by location", "by customer", "by product") — the
   value lives on another record reached by a foreign key, and the reachable labels are only those
   `SC.Core.Util.CubeUtil` has a getter for. Call **`sco_suggest_dimension_sources` `{ className }`** and follow
   **[dimension-sources.md](dimension-sources.md)** — it has the full ladder (direct property → arrow traversal →
   CubeUtil getter → hand-written guarded expression), the "ask the user WHICH label" protocol, and the mandatory
   null-guard for a custom lookup. Do not invent an expression before reading it.

### factNumber rule (critical)
Every `factNumber` across ALL levels and measures MUST be unique and start at **2** (fact 1 is reserved for the source record). Assign them sequentially. The generator rejects duplicates or values below 2.

## 4. Generate → review → compile → build
Follow this order, and remember the confirmation gate: the compile and build steps change the SCO instance and the user will be asked to approve them.

1. **`sco_generate_cube_cls`** — pass the cube definition. This is read-only; it returns the `className` and the `.cls` source. Show the user a short summary (dimensions, measures) — optionally the source if they want it.
2. **`sco_compile_class`** — pass that `className` and `source` to import + compile into SCO. If it fails, read the returned `errors`/`console`, explain the problem, fix the definition, and regenerate.
3. **`sco_build_cube`** — pass the `cubeName` (the `<cube name=...>`, i.e. the same `cubeName` you generated with) to populate the cube.
4. **`sco_cube_info`** — confirm `exists: true` and report the `factCount` to the user.

## 5. Report
Tell the user the outcome plainly: the class compiled, the cube built, and how many facts it now holds — or the exact error if any step failed.
