---
name: data-model
description: Create or understand an SCO custom data-model object or attribute (the Data Model / Resources feature — objects, their attributes, data types, required flags, and the ER relationships between objects). Use whenever the user wants to create a custom object, add a custom attribute to an object, or understand what an object/attribute/relationship means. Works in BOTH modes and adapts, in Guided mode it teaches and co-pilots the Data Model page (Add Custom Object / Add Custom Attribute) via the ui_* tools while the user clicks Save; the SCO scmodel API is create-only, so there is no update/delete.
---

# Data Model skill (mode-aware)

This one skill handles the SCO Data Model (custom objects + attributes) in both
operating modes. The turn is prefixed with a `[SESSION MODE: agent]` or
`[SESSION MODE: guided]` marker, and the system prompt already puts you in the
matching persona. **Route on that mode — read exactly one workflow file, then
follow it:**

- **`[SESSION MODE: guided]`** → the teacher path: you never touch SCO; you
  explain what an object/attribute is and co-pilot the **Data Model** page
  (Add Custom Object / Add Custom Attribute) with the `ui_*` tools while the user
  clicks Save. Read **[references/guided-workflow.md](references/guided-workflow.md)** and follow it.
- **`[SESSION MODE: agent]`** → read **[references/agent-workflow.md](references/agent-workflow.md)**.
  Note: the Data Model is managed through the Workbench UI + the SCO `scmodel`
  API; there is no `sco_*` tool that creates objects, so Agent mode explains the
  flow and defers the actual creation to the user in the UI.

If the mode marker is somehow absent, infer it from which tools you're permitted
(the permission gate allows `sco_*` only in Agent mode and `ui_*` only in Guided
mode) — but it should always be present.

## Shared background (both modes)
Regardless of mode, [references/object-definition.md](references/object-definition.md)
explains what an object and attribute are, what every field means (object name,
description, attributes with name / data type / required / description), **which
characters SCO accepts in a description** (it rejects `-`, `:` and `%` — write
around them, never hand the user a description that fails at Save), how the
Workbench derives ER relationships from foreign-key descriptions, and the
**create-only** nature of the SCO scmodel API (no update or delete of objects or
attributes). Read it when you need to explain a field or shape a new object; the
mode-specific workflow file above tells you what to DO with that understanding.
