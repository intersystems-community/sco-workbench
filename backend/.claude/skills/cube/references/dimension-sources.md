# Where a level's data comes from (both modes)

A dimension level needs a SOURCE. There are only four kinds, and picking the right one
is where most cube mistakes happen:

| Source | When | Example |
| --- | --- | --- |
| `sourceProperty` | the value is a property of the source class | `sourceProperty="salesRegion"` |
| `sourceProperty` with arrow traversal | the property IS a reference (`isReference: true`) | `sourceProperty="customer->name"` |
| `sourceExpression` calling a CubeUtil getter | the value lives on a RELATED record reached by a soft foreign key | `sourceExpression="##class(SC.Core.Util.CubeUtil).getLocationCountry(%source.siteLocationId)"` |
| `sourceExpression` written by hand | no getter exists (last resort) | see "No getter exists" below |
| `timeFunction` | a date broken into Year / Quarter / Month … | `timeFunction="MonthYear"` |

## The problem: "break down by location"

Take *"create a product inventory cube broken down by location"*. `SC.Data.ProductInventory`
has **no** `location` property. What it has is `siteLocationId` — a plain `%String`
holding a location's `uid`. Two things follow:

1. **Arrow traversal does not work.** The property is not a reference, so
   `siteLocationId->name` is invalid. A level `sourceExpression` is the only route.
2. **"by location" is ambiguous, and the choices are not yours to invent.** It could
   mean the location's country, state, name, city… but only the labels
   `SC.Core.Util.CubeUtil` already has a getter for are actually reachable. For a
   location that is **country** and **state** — there is no `getLocationName`.

So the user has to choose, from the real options. Never silently pick one, and never
break down by the raw id (`siteLocationId`) as if that were what they asked for — a
column of uids is not a "location" breakdown.

## The protocol

**1. Ask the instance, don't guess.** Call
`sco_suggest_dimension_sources { className }`. In ONE call it returns, for the source
class:

- `directProperties` — scalar properties: a plain `sourceProperty` breakdown.
- `references` — real object references: arrow traversal is available.
- `foreignKeys` — each soft foreign key with the CubeUtil getters that can read
  through it, as **paste-ready `expression` strings** (the argument is already wired to
  `%source.<theForeignKey>`).
- `baseRowHelpers` — getters keyed on the row's OWN `uid` (e.g.
  `getInventoryProductCategory(%source.uid)`). Note these take the BASE row's uid, not
  a foreign key — passing the wrong one compiles and returns the wrong record's field.
- `unreachable` — foreign keys with NO getter at all. Read this: it is the signal that
  the "no getter exists" path below is required.

This works in **both modes** — it is read-only, so Guided mode may call it too.

**2. If the requested breakdown is a direct property, just use it.** `by status`,
`by salesRegion` — no expression, no question.

**3. If it names a RELATED entity, put the real choices to the user.** Use
`ask_user_question` with the concrete attributes the tool returned, e.g. for "by
location" on ProductInventory:

- *Location country* — `getLocationCountry(%source.siteLocationId)`
- *Location state* — `getLocationState(%source.siteLocationId)`
- and, if they might have meant the site's own field, *Location number*
  (`locationNumber`, a direct property of the inventory row)

Say what each one is, in business terms. Do NOT list a label the tool didn't return
(there is no `getLocationName`, so do not offer "location name" as if it were free).
If the user asks for a label with no getter, go to step 5 and tell them it needs a
custom expression.

**4. If more than one foreign key fits the same entity, ask which.** `SC.Data.SalesShipment`
has both `originLocationId` and `destinationLocationId`; "by location" cannot be
resolved without knowing which end the user means.

**5. No getter exists → say so.** Only after the tool has shown the entity in
`unreachable`, or the user wants a label no getter provides. Do not hand-write a
lookup with `$SELECT` or any other conditional. Offer the raw foreign-key property as
the level instead, and tell the user that a readable label needs a new helper method
in SCO.

**6. Whenever an expression references another class, verify that class.** Any
`##class(...)` call or property read in a `sourceExpression` must be checked with
`sco_list_properties` / `sco_list_methods` before you generate it, so the names are
real rather than guessed.

## Bucketing a number into labels

A getter that returns a NUMBER can still be a data dimension: put it in
`sourceExpression` and add a `rangeExpression` to bucket it, e.g. hours-late into
OnTime/Late:

```
sourceExpression="##class(SC.Core.Util.CubeUtil).getSOLateDeliveryHours(%source.uid, %source.requestedDeliveryDate)"
rangeExpression="(,24]:OnTime;(24,):Late;"
```

## Mode notes

- **Agent mode**: apply the ladder above, then generate/compile/build as usual.
- **Guided mode**: the same ladder, but you fill the form instead of generating a class.
  A level's expression goes in the level's own `sourceExpression` field — set the
  level's `srcKind` to `expression` first (the form shows a Source Property dropdown or
  a Source Expression box depending on it). You still ask the user the step-3 question;
  they click Build.
