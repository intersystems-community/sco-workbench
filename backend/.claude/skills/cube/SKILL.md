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
