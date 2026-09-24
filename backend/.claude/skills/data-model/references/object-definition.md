# SCO Data Model — objects & attributes (field reference)

The **Data Model** feature (also called "Resources" in the code) lets a user
browse the SCO data model and CREATE custom objects and custom attributes
through the SCO `scmodel` REST API. This file explains what everything means so
you can teach it and shape a good new object; the workflow files say what to DO.

## What is an object?
An **object** is a persisted data entity in the SCO data model — the Workbench
surfaces each as a row in the left "Objects" list, backed by an SCO class (its
`className`, e.g. `SC.Data.SalesOrder`). Built-in SCO objects ship with the
instance; **custom objects** are ones a user adds here. Each object has:
- **objectName** — the short, human name shown in the list and used as the id in
  the API path (e.g. `SalesOrder`). Choose a clear PascalCase noun; it must be
  unique among objects.
- **className** — the fully-qualified SCO class the object maps to. For custom
  objects this is derived by the SCO API; the user does not type a class name.
- **description** — a one-line explanation of what the object models.
- **attributes** — the fields on the object (see below).

## What is an attribute?
An **attribute** is one field on an object (a class property). Each has:
- **name** — the property name (e.g. `orderValue`, `customerId`). Prefer
  lowerCamelCase to match the SCO convention; it must be unique on the object.
- **dataType** — one of the Workbench's offered types: **String, Integer,
  Boolean, Numeric, DateTime, Date**. Pick the narrowest type that fits (an
  amount → Numeric, a count → Integer, a flag → Boolean, a timestamp → DateTime).
- **required** — whether the field must have a value. Only mark required when the
  object is meaningless without it.
- **description** — what the field holds. This field is ALSO how relationships
  are expressed (see below), so write it well.
- **isCustom** — set by the system: true for attributes added through the
  Workbench, false for built-in ones. The user does not set this.

## Descriptions: the characters SCO accepts (write within this set)
SCO validates every object and attribute **description** against an allow-list and
rejects the whole create with `400 "Invalid description for <name>"` — naming no
character, so the user cannot tell what went wrong. The allow-list is:

> letters, digits, spaces, and only these marks: `,` `.` `"` `?` `!` `(` `)` `/` `;` `#` `'` `&`

Everything else is rejected. The ones that trip up a natural-sounding description
most often are **`-` (hyphen/dash), `:` (colon) and `%` (percent)** — also `_`, `*`,
`+`, `=`, `@`, `$`, `[ ]`, `{ }`, `<` `>`, `|`, `~`, `` ` ``, and any line break.

**So write every description you generate inside that set from the start** — never
produce one and leave the user to hit the 400. Rephrase instead of reaching for a
rejected mark:

| Don't write | Write instead |
| --- | --- |
| `out-of-stock flag` | `flag for out of stock items` |
| `1-5 reliability rating` | `reliability rating from 1 to 5` |
| `90% of target` | `90 percent of target` |
| `Note: set by the loader` | `Note. Set by the loader` |
| `e-mail address` | `email address` |
| `Order date (YYYY-MM-DD)` | `Order date in YYYY MM DD form` |
| `read-only` / `built-in` | `read only` / `built in` |

A hyphenated product name or code the user gave you verbatim is the one case worth
raising: keep the meaning but drop the hyphen (`SKU-A12` → `SKU A12`), and say in a
short sentence that SCO doesn't accept dashes in a description yet, so you wrote it
without one. Don't silently mangle an identifier the user cares about — and don't
put the dash in "to be safe"; the create fails outright.

This is an SCO-side validation bug (**SC-2647**), not a rule worth teaching as
good practice. Keep the explanation to one line if it comes up, and drop this topic
entirely once a description containing a dash saves successfully.

## Relationships (the ER diagram)
The Workbench derives the **ER diagram** relationships from attribute
descriptions: if an attribute's description contains the phrase
`foreign key to <ObjectName>` (case-insensitive) and `<ObjectName>` is another
object in the model, the Workbench draws an edge from this object to that one.
So to relate a new object to an existing one, add an attribute like
`customerId : Integer` with description `"Foreign key to Customer"`. Explain this
to the user when they want two objects linked — the link lives in the wording of
the description, not a separate field.

## Create-only — no update or delete
The SCO `scmodel` API is **create-only**. You can:
- **create a custom object** (with its initial attributes), and
- **add a custom attribute** to an existing object.

There is **no API to rename/update or delete** an object or attribute, and no way
to edit a built-in object. Set expectations accordingly: tell the user to get the
name and type right before saving, because it can't be changed afterward here.
Never imply an edit/delete capability the feature doesn't have.

## Worked example — a custom object
A "Supplier" object a user might create:
- objectName: `Supplier`
- description: `A vendor that fulfills supply shipments.`
- attributes:
  - `name` — String, required, "Supplier company name."
  - `country` — String, "ISO country code of the supplier's HQ."
  - `rating` — Integer, "Reliability rating from 1 to 5." — written the long way round
    on purpose: a dash is rejected, see the description-characters section above.
  - `active` — Boolean, "Whether the supplier is currently used."

## Worked example — a custom attribute (creating a relationship)
Adding a field to an existing `SupplyShipment` object that links it to `Supplier`:
- name: `supplierId`
- dataType: `Integer`
- required: true
- description: `Foreign key to Supplier` ← this makes the ER diagram draw
  `SupplyShipment → Supplier`.
