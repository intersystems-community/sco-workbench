---
name: cube
description: Build, create, deploy, or understand an SCO Analytics/DeepSee BI cube (dimensions, measures, hierarchies, levels; aggregate data by region/time/status). Use whenever the user wants to build/create a cube, understand what a cube or its fields mean, or get walked through the cube form. Works in BOTH modes and adapts, in Agent mode it generates + compiles + builds the cube in SCO via the sco_* tools; in Guided mode it teaches and co-pilots the Analytics Cubes form via the ui_* tools while the user clicks Build.
---

# Cube skill (mode-aware)

This one skill handles cubes in both operating modes. The turn is prefixed with a
`[SESSION MODE: agent]` or `[SESSION MODE: guided]` marker, and the system prompt
already puts you in the matching persona. **Route on that mode — read exactly one
workflow file, then follow it:**

- **`[SESSION MODE: agent]`** → the worker path: you build the cube directly in
  SCO with the `sco_*` tools. Read **[references/agent-workflow.md](references/agent-workflow.md)** and follow it.
- **`[SESSION MODE: guided]`** → the teacher path: you never touch SCO; you
  explain each field and co-pilot the Analytics Cubes form with the `ui_*` tools
  while the user clicks Build. Read **[references/guided-workflow.md](references/guided-workflow.md)** and follow it.

If the mode marker is somehow absent, infer it from which tools you're permitted
(the permission gate allows `sco_*` only in Agent mode and `ui_*` only in Guided
mode) — but it should always be present.

## Ask before you build: recommend, don't assume (both modes)
When the user asks for a cube without saying what's in it ("build me a cube",
"create a cube for manufacturing orders"), **do not pick the measures and dimensions
yourself** and do not generate, fill, or build a default cube. A cube's measures and
dimensions are the user's analysis questions; guessing them gives a cube that answers
the wrong ones and has to be rebuilt. Ask, and make it easy to answer with
recommendations drawn from their real data:

1. **The source class.** If the user didn't name one, ask which data the cube is
   about (`ask_user_question`), offering real classes: `availableSourceClasses` in
   Guided mode, `sco_list_data_objects` in Agent mode. Never invent one.
2. **Read what that class actually holds** before recommending anything:
   `sco_list_properties` (with types) and `sco_suggest_dimension_sources` (related
   entities reachable through CubeUtil getters). Both are read-only, so both modes may
   call them. In Guided mode, setting `sourceClass` also returns the property list.
3. **Ask for measures and dimensions in ONE `ask_user_question` call**, one question
   each, `multiSelect: true`, 3-4 options each, built only from step 2. Put your best
   pick first with "(Recommended)" in its label, and give each option a one-line
   `description` in business terms:
   - **Measures:** a named record count ("Order count": COUNT, no source); a SUM or
     AVG of a numeric property ("Total quantity"); a duration from a CubeUtil helper
     ("Average lead time, hours": `getDateTimeDiffInHours(start, end)`). Follow
     "Measures" below: numeric sources only, never `uid`.
   - **Dimensions:** a status or category property ("By order status"); a date as a
     Year → Month → Day time dimension ("By planned end date"); a related entity's
     label ("By work location country"); a number or date comparison as ranges
     ("Overdue / upcoming", "Early / on time / late").
   Propose the cube name (`<Source>Cube`, e.g. `MfgOrderCube`) in your message rather
   than asking for it; the user can rename it.
4. **Build only what they picked.** In Guided mode, opening the form and setting the
   name and source class before asking is fine, but add measures and dimensions only
   after they answer. Then tell them what you built and what else they could add.

**Ask only about what's missing.** If the user named measures but not dimensions
(or the reverse), ask only about the missing part. If they named everything, don't
ask; build it. If they explicitly hand you the choice ("you decide", "use sensible
defaults", "surprise me"), build your recommended set without asking, and say what
you chose and why.

## Ranges come first for status and bucket dimensions (both modes)
Ranges (a level's `rangeExpression`) are the default way to turn a value into
categories. **Before defining any data level, check whether its categories come from
a number or a date comparison.** If they do:
1. The level's source returns the NUMBER: a numeric property, or an expression that
   returns a number. Prefer an existing `SC.Core.Util.CubeUtil` helper, e.g.
   `getHoursLate(targetValue, actualValue)`, `getDateTimeDiffInHours(fromTime, toTime)`,
   `getDaysBefore(targetDate)`, `getDaysPastExpiration(uid)`; confirm with `sco_list_methods`.
2. The labels go in `rangeExpression`, e.g. `(,-8):Early;[-8,8]:OnTime;(8,):Late;`.
3. Confirm the cut-offs and labels with the user (`ask_user_question` with suggested cut-offs).

Typical requests: early / on time / late, aging (0–30, 31–60, 61–90, 90+ days),
expiry (Expired / Expiring / Good), stock level (Out / Low / OK / Overstock), order
value or quantity tiers (Small / Medium / Large), lead-time bands. Also suggest ranges
when the user wants to break down by a raw numeric property (value, quantity, hours):
without ranges, every distinct number becomes its own member.

**Never use `$SELECT` (or `$S`, `$CASE`, If/Else) in a `sourceExpression`**, for labels
or for null checks. Labels come from ranges. Missing values become null, and
`nullReplacement` names them (Agent mode).

Ranges are not allowed on `time`/`age` dimensions or on non-numeric properties.

## Measures: counting records, and a type that fits the source (both modes)
**Counting records needs no source.** Every cube already has `%COUNT` (the number of
records), so don't propose a measure just to count rows. If the user asks for a named
count ("order count", "number of shipments"), make a measure with aggregate `COUNT`,
type `integer`, and **no source at all**: no `sourceProperty` (leave it empty, or in
Guided mode set it to `""`) and no `sourceExpression`. It counts every record.
**Never use `uid`** (or any id or text property) as a measure source: a COUNT of `uid`
is just the row count, and as a number it fails on every row.

**The measure `type` must fit what its source returns**, checked BEFORE you set it:
the property's type (`sourcePropertyTypes` in Guided mode, `sco_list_properties` in
Agent mode) or, for a `##class(X).method(...)` expression, the method's return type
(`sco_list_methods`).

| Measure type | Source must be |
|---|---|
| `integer` / `number` | numeric: `%Integer`, `%Numeric`, `%Double`, `%Decimal`, … (or `%Boolean`) |
| `date` | `%Date` only; a `%DateTime`/`%TimeStamp` builds into wrong numbers |
| `boolean` | `%Boolean` or an integer |

Don't make `string`/`text` measures: SCO compiles them only with `COUNT`, and that
reads empty. Text belongs in a dimension. `COUNT`, `SUM` and `AVG` need type
`integer` or `number`.

A mismatch compiles but builds empty or broken, so the workbench refuses it at
Compile and names the measure. In Guided mode a mismatching `ui_set_field` is
applied but its result says "won't build yet": fix the other field before moving on.

## A time dimension is ALWAYS Year → Month → Day (both modes, no exceptions)
The single most common mistake is shipping a time dimension with one or two levels.
When the user asks for a time/date dimension — "add a dimension for order placed
date", "break this down by time" — they are asking for a **drill-down**, and a
dimension that stops at Year can only answer year-scale questions. Adding the rest
later means editing, recompiling, and REBUILDING the cube.

So a `time` dimension gets **three levels in one hierarchy, by default, without
being asked**:

| Level `name` | `timeFunction` |
|---|---|
| `Year`  | `Year` |
| `Month` | `MonthYear` |
| `Day`   | `DayMonthYear` |

Copy those three values EXACTLY as written. They are accepted in both modes, and
none of them is the obvious guess: there is no `YearNumber`, no plain `Month`, no
plain `Day`. A month or day level is scoped within its year — that is what makes
the drill-down work — hence `MonthYear` and `DayMonthYear`.

Beyond those three the accepted set is **mode-specific**, so don't carry a list
across from memory: in Guided mode the truth is the form's Time Function dropdown
(and a rejected `ui_set_field` hands you the valid options back — read them rather
than trying another guess), and in Agent mode it is the set in
[references/cube-definition.md](references/cube-definition.md). `QuarterYear` is
valid in both.

Insert `QuarterYear` between Year and Month when the user thinks in quarters. Use a
different set ONLY when the user explicitly asks for one — then say which levels you
built and why. Do not ask "shall I add Month and Day too?"; build all three, then
tell them the drill-down path they now have and that they can drop a level if they
don't want it.

## Shared background (both modes)
Regardless of mode, [references/cube-definition.md](references/cube-definition.md)
explains what a cube is, what every field means (source class, measures, data vs
time dimensions, hierarchies, levels), and gives worked example cube definitions.
Read it when you need to explain a field or shape a definition; the mode-specific
workflow file above tells you what to DO with that understanding.

## Breaking down by something the source class doesn't hold (read this before writing
## any `sourceExpression`)
When the user asks to break down by a RELATED entity — "by location", "by customer",
"by product" — the value is not on the source class. `SC.Data.*` classes point at each
other with plain `%String` foreign keys (`siteLocationId`), so arrow traversal does NOT
work, and the labels you can actually reach are only those `SC.Core.Util.CubeUtil`
already provides a getter for (for a location: country and state — there is no
`getLocationName`). Such a request is therefore ambiguous AND constrained, and the
answer is to put the REAL options to the user.

Call **`sco_suggest_dimension_sources` `{ className }`** — one read-only call returns
the class's direct properties, its references, its soft foreign keys each paired with
the getters that can read through them (as paste-ready expressions), and the foreign
keys nothing can reach. Then follow
**[references/dimension-sources.md](references/dimension-sources.md)**, which has the
full ladder and the "ask which label" protocol. This applies in **both modes** (the
tool is read-only, so Guided may call it too).
