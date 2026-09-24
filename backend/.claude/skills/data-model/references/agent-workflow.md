# Agent-mode Data Model workflow

The SCO Data Model (custom objects + attributes) is managed through the Workbench
UI and the SCO `scmodel` REST API. There is **no `sco_*` tool** that creates a
custom object or adds an attribute — those go through the app's `scmodel` proxy
routes, driven by the Data Model page's forms — so Agent mode cannot perform the
creation directly against SCO the way it builds a cube or a KPI.

## What to do in Agent mode
1. **Explain the flow using [object-definition.md](object-definition.md).** Tell
   the user exactly what a custom object/attribute is, the fields it needs
   (objectName, description, attributes with name / dataType / required /
   description), how to relate objects via a `Foreign key to <ObjectName>`
   description, and that the SCO API is **create-only** (no update/delete).
   Any description you SUGGEST must stay inside the characters SCO accepts — no
   `-`, `:` or `%` (see the description-characters section of object-definition.md),
   or the user's Save fails with a bare "Invalid description".
2. **Hand the actual creation to the UI.** Ask the user (with `ask_user_question`)
   whether they'd like to be walked through creating it. Point them at the **Data
   Model** page: the **+** button in the Objects list creates a custom object; the
   pencil/edit button on a selected object adds a custom attribute. Suggest they
   switch the assistant to **Guided** mode, where you co-pilot those forms field
   by field (see the guided workflow).
3. **Do NOT** attempt schema `sco_*` tools to fabricate the object — the Data
   Model is not created by importing a hand-written class here; it's created
   through the scmodel API so SCO owns the class generation and cataloguing.

## Read-only understanding
If the user only wants to UNDERSTAND an existing object/attribute/relationship,
answer from the UI CONTEXT and object-definition.md — name the concrete object,
its attributes, and any foreign-key relationships shown — rather than a generic
definition. You don't need any tool for that.
