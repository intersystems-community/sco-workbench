---
name: kpi
description: Create, update, or understand an SCO Business KPI (a metric over an Analytics cube — cube, measure, value type, MDX conditions, thresholds, issues, dimensions). Use whenever the user wants to build/create a KPI, understand what a KPI or its fields mean, or get walked through the KPI form. Works in BOTH modes and adapts: in Agent mode it creates/updates the KPI in SCO via the sco_* KPI tools (the SCO KPI REST API); in Guided mode it teaches and co-pilots the Business KPIs form via the ui_* tools while the user clicks Submit.
---

# KPI skill (mode-aware)

This one skill handles Business KPIs in both operating modes. The turn is
prefixed with a `[SESSION MODE: agent]` or `[SESSION MODE: guided]` marker, and
the system prompt already puts you in the matching persona. **Route on that mode
— read exactly one workflow file, then follow it:**

- **`[SESSION MODE: agent]`** → the worker path: you create/update the KPI
  directly in SCO with the `sco_*` KPI tools (which call the SCO KPI REST API).
  Read **[references/agent-workflow.md](references/agent-workflow.md)** and follow it.
- **`[SESSION MODE: guided]`** → the teacher path: you never touch SCO; you
  explain each field and co-pilot the Business KPIs form with the `ui_*` tools
  while the user clicks Submit. Read **[references/guided-workflow.md](references/guided-workflow.md)** and follow it.

If the mode marker is somehow absent, infer it from which tools you're permitted
(the permission gate allows `sco_*` only in Agent mode and `ui_*` only in Guided
mode) — but it should always be present.

## Shared background (both modes)
Regardless of mode, [references/kpi-definition.md](references/kpi-definition.md)
explains what a KPI is, what every field means (cube, measure, value type, MDX
conditions, base conditions, thresholds, issues, dimensions), the MDX condition
syntax, and gives worked example KPI definitions. Read it when you need to
explain a field or shape a definition; the mode-specific workflow file above
tells you what to DO with that understanding.
